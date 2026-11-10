import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Kysely } from 'kysely';
import type { RandomSource, Time } from 'pgstencil';
import {
  Billing,
  BillingError,
  type BillingConfig,
  type BillingDB,
  type Stripe,
} from '@pgstencil/stripe';
import type { createAuthApp } from '@pgstencil/auth';

/** Optional billing for the example: the server owns customer, prices and return URLs. */
export interface BillingOptions {
  stripe: Stripe;
  config: Omit<BillingConfig, 'origin'>;
  time: Time;
  random: RandomSource;
}

const JSON_BODY_BYTES = 8192;
const WEBHOOK_BODY_BYTES = 1024 * 1024;

/**
 * Billing routes on top of `createAuthApp`, keyed by the signed-in user's ID.
 * Every route except the Stripe webhook needs a live session; the POSTs also
 * need this exact Origin and a JSON body, so a cross-site form cannot reach them.
 */
export function addBillingRoutes(
  auth: ReturnType<typeof createAuthApp>,
  origin: string,
  options: BillingOptions,
) {
  // Billing qualifies every table with its own schema, so it shares the pool.
  const billing = new Billing(
    auth.db as unknown as Kysely<BillingDB>,
    options.stripe,
    options.time,
    options.random,
    { ...options.config, origin },
  );
  const app: Hono = auth.app;
  const failure = (c: Context, error: unknown) =>
    error instanceof BillingError
      ? c.json({ message: error.message }, error.status as 400)
      : c.json(
          { message: 'Billing unavailable. Please try again shortly.' },
          503,
        );
  /** The billing owner and the email Checkout should prefill, or null when signed out. */
  const owner = async (c: Context) => {
    const session = await auth.auth.api.getSession({
      headers: c.req.raw.headers,
    });
    if (!session) return null;
    const { id, email, emailVerified } = session.user;
    // A provider-only account's internal address is unverified and never shared.
    return { id, email: emailVerified ? email : null };
  };
  app.get('/billing', (c) => c.html(billingHtml));
  app.get('/billing.js', (c) =>
    c.body(billingScript, 200, {
      'content-type': 'text/javascript; charset=utf-8',
    }),
  );
  app.get('/api/billing', async (c) => {
    const user = await owner(c);
    if (!user) return c.json({ message: 'Sign in first' }, 401);
    try {
      await billing.account(user.id, user.email);
      const operation = c.req.query('checkout');
      if (operation) await billing.confirmCheckout(user.id, operation);
      else await billing.reconcile(user.id);
      return c.json(await billing.status(user.id));
    } catch (error) {
      return failure(c, error);
    }
  });
  app.use('/api/billing/*', bodyLimit({ maxSize: JSON_BODY_BYTES }));
  app.use('/api/billing/*', async (c, next) => {
    if (c.req.method !== 'POST') return next();
    if (c.req.header('origin') !== origin)
      return c.json({ message: 'Request not accepted' }, 403);
    if (
      c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json'
    )
      return c.json({ message: 'JSON required' }, 415);
    return next();
  });
  app.post('/api/billing/checkout', async (c) => {
    const user = await owner(c);
    if (!user) return c.json({ message: 'Sign in first' }, 401);
    const body: unknown = await c.req.json().catch(() => null);
    const plan = (body as { plan?: unknown } | null)?.plan;
    if (typeof plan !== 'string')
      return c.json({ message: 'Choose a plan' }, 400);
    try {
      return c.json({
        url: (await billing.checkout(user.id, user.email, plan)).url,
      });
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post('/api/billing/portal', async (c) => {
    const user = await owner(c);
    if (!user) return c.json({ message: 'Sign in first' }, 401);
    try {
      return c.json({ url: await billing.portal(user.id) });
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post('/api/billing/cancel-checkout', async (c) => {
    const user = await owner(c);
    if (!user) return c.json({ message: 'Sign in first' }, 401);
    try {
      await billing.cancelCheckout(user.id);
      return c.json(await billing.status(user.id));
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post(
    '/api/stripe/webhook',
    bodyLimit({
      maxSize: WEBHOOK_BODY_BYTES,
      onError: (c) => c.body(null, 413),
    }),
    async (c) => {
      // Reject before reading: an unsigned request never reaches the parser.
      const signature = c.req.header('stripe-signature');
      if (!signature) return c.body(null, 400);
      try {
        // The raw bytes: a re-serialized body would no longer match its signature.
        await billing.webhook(
          Buffer.from(await c.req.arrayBuffer()),
          signature,
        );
        return c.body(null, 200);
      } catch (error) {
        return c.body(
          null,
          error instanceof BillingError ? (error.status as 400) : 503,
        );
      }
    },
  );
  return billing;
}

const billingHtml = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Billing</title>
<main><h1>Billing</h1><p id="status" role="status">Loading…</p>
<div id="plans" hidden><button data-plan="monthly">Start monthly trial</button> <button data-plan="yearly">Start yearly trial</button></div>
<button id="cancel" hidden>Cancel open checkout</button> <button id="portal" hidden>Manage billing</button>
<p><a href="/">Back to sign in</a></p></main>
<script type="module" src="/billing.js"></script></html>`;

const billingScript = `
const status = document.querySelector('#status'), plans = document.querySelector('#plans');
const portal = document.querySelector('#portal'), cancel = document.querySelector('#cancel');
const post = async (path, body = {}) => {
  const response = await fetch('/api/billing/' + path, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body)});
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || 'Request failed');
  return data;
};
const show = (data) => {
  const sub = data.subscription;
  status.textContent = data.access
    ? 'Plan: ' + data.plan + ' (' + sub.status + ') until ' + new Date(data.accessUntil).toLocaleDateString()
    : data.trialDays ? 'Start a ' + data.trialDays + '-day trial; provide a card at checkout.' : 'Choose a plan.';
  plans.hidden = data.access; portal.hidden = !sub; cancel.hidden = data.access;
};
const act = (action) => async (event) => { try { await action(event); } catch (error) { status.textContent = error.message; } };
for (const button of plans.querySelectorAll('button'))
  button.onclick = act(async () => location.assign((await post('checkout', {plan: button.dataset.plan})).url));
portal.onclick = act(async () => location.assign((await post('portal')).url));
cancel.onclick = act(async () => show(await post('cancel-checkout')));
const response = await fetch('/api/billing' + location.search);
const data = await response.json();
if (response.status === 401) status.textContent = 'Sign in first.';
else if (!response.ok) status.textContent = data.message;
else { show(data); if (location.search) history.replaceState(null, '', '/billing'); }`;

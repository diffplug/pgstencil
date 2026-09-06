import type { Billing } from '@pgstencil/stripe';
import { date, escape, hidden, page } from './views.ts';

export function billingPage(
  state: Awaited<ReturnType<Billing['status']>>,
  csrf: string,
  trialDays: number,
  showInbox: boolean,
) {
  const current = state.subscription;
  const deadline = state.accessUntil ? date(state.accessUntil) : null;
  const status = current
    ? `<p class="intro">${escape(state.plan)} · ${escape(current.status)}</p><p>${state.access ? 'Access available' : 'Access unavailable'}${deadline ? ` · Current access period ends ${escape(deadline)}` : ''}.</p>${current.cancel_at_period_end ? '<p>Your subscription will cancel at the end of this period.</p>' : ''}`
    : '<p class="intro">Choose a plan to start your subscription.</p><p>Signing in does not start the trial.</p>';
  const offer =
    current?.status === 'trialing'
      ? '<p>Your card will be charged when the trial ends unless you cancel first.</p>'
      : state.trialEligible && trialDays > 0
        ? `<p>Your ${trialDays}-day free trial starts after you provide a card in Checkout. Stripe will charge the selected plan when the trial ends unless you cancel first.</p>`
        : '<p>Payment is due when you subscribe. Your free trial has already been used.</p>';
  const form = (path: string, label: string, extra = '') =>
    `<form method="post" action="${path}">${hidden('csrf', csrf)}${extra}<button type="submit">${label}</button></form>`;
  return page(
    'Billing',
    `${status}${offer}<p>Monthly billing or a discounted yearly plan. Checkout shows the exact price and renewal terms before you confirm.</p>
<div class="providers">${form('/billing/checkout', 'Choose monthly', hidden('plan', 'monthly'))}${form('/billing/checkout', 'Choose yearly', hidden('plan', 'yearly'))}</div>
${current ? form('/billing/portal', 'Manage billing') : ''}
${form('/billing/cancel-checkout', 'Cancel an unfinished checkout')}
<p><a href="/account">Return to account</a></p>`,
    showInbox,
  );
}

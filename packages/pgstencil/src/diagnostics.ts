import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Time } from './time.ts';

export type DiagnosticEvent =
  | 'request.completed'
  | 'request.failed'
  | 'auth.oauth.stage'
  | 'auth.oauth.failed'
  | 'auth.login.succeeded'
  | 'auth.rejected'
  | 'auth.logout'
  | 'email.delivery.succeeded'
  | 'email.delivery.failed'
  | 'billing.webhook.received'
  | 'billing.webhook.processed'
  | 'billing.webhook.failed';
const providers = [
  'google',
  'apple',
  'facebook',
  'github',
  'microsoft',
] as const;
const stages = [
  'state',
  'token_exchange',
  'key_fetch',
  'id_token',
  'profile',
  'callback',
  'database',
  'transport',
] as const;
const reasons = [
  'missing_state',
  'invalid_browser_binding',
  'expired_state',
  'invalid_state',
  'provider_mismatch',
  'linking_disabled',
  'session_mismatch',
  'state_replayed',
  'provider_cancelled',
  'provider_error',
  'missing_id_token',
  'missing_nonce',
  'id_token_rejected',
  'provider_claims_rejected',
  'invalid_provider_subject',
  'profile_unavailable',
  'reserved_email',
  'unverified_email',
  'mailbox_proof_required',
  'rate_limited',
  'request_rejected',
  'upstream_failure',
  'unexpected_error',
] as const;
const operations = [
  'auth.social.start',
  'auth.oauth.callback',
  'auth.email.send',
  'auth.email.verify',
  'auth.session',
  'auth.logout',
  'auth.accounts',
  'auth.csrf',
  'auth.other',
  'health',
  'ready',
  'providers',
  'inbox',
  'api.other',
  'static',
] as const;
const errorTypes = [
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'AbortError',
  'TimeoutError',
] as const;
const errorCodes = [
  'ERR_JWT_EXPIRED',
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JWKS_TIMEOUT',
  'ERR_JOSE_ALG_NOT_ALLOWED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  '23505',
  '23503',
  '40001',
  '40P01',
  '53300',
  '57P01',
  'invalid_client',
  'invalid_grant',
  'invalid_request',
  'unauthorized_client',
  'access_denied',
] as const;
export interface DiagnosticFields {
  provider?: (typeof providers)[number] | undefined;
  stage?: (typeof stages)[number] | undefined;
  reason?: (typeof reasons)[number] | undefined;
  operation?: (typeof operations)[number] | undefined;
  status?: number | undefined;
  durationMs?: number | undefined;
  errorType?: (typeof errorTypes)[number] | undefined;
  errorCode?: (typeof errorCodes)[number] | undefined;
  httpStatus?: number | undefined;
  providerCode?: number | undefined;
  stripeEventId?: string | undefined;
  hasSubject?: boolean | undefined;
  hasTenant?: boolean | undefined;
  hasObjectId?: boolean | undefined;
  nonceMatches?: boolean | undefined;
  audienceMatches?: boolean | undefined;
  issuerMatches?: boolean | undefined;
  expired?: boolean | undefined;
  issuedInFuture?: boolean | undefined;
  algorithmMatches?: boolean | undefined;
}
export interface DiagnosticRecord extends DiagnosticFields {
  source: 'pgstencil';
  version: 1;
  event: DiagnosticEvent;
  level: 'info' | 'warn' | 'error';
  timestamp: string;
  requestId?: string;
  revision?: string;
}
export interface DiagnosticOptions {
  sink?: (record: DiagnosticRecord) => void;
  time?: Time;
  revision?: string;
  requestId?: () => string;
}
const contexts = new AsyncLocalStorage<DiagnosticOptions & { id?: string }>();
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const enums = {
  provider: providers,
  stage: stages,
  reason: reasons,
  operation: operations,
  errorType: errorTypes,
  errorCode: errorCodes,
};
const numbers = ['status', 'httpStatus', 'providerCode', 'durationMs'] as const;
const booleans = [
  'hasSubject',
  'hasTenant',
  'hasObjectId',
  'nonceMatches',
  'audienceMatches',
  'issuerMatches',
  'expired',
  'issuedInFuture',
  'algorithmMatches',
] as const;
const events: DiagnosticEvent[] = [
  'request.completed',
  'request.failed',
  'auth.oauth.stage',
  'auth.oauth.failed',
  'auth.login.succeeded',
  'auth.rejected',
  'auth.logout',
  'email.delivery.succeeded',
  'email.delivery.failed',
  'billing.webhook.received',
  'billing.webhook.processed',
  'billing.webhook.failed',
];

/** Deliberately reconstruct records: callers cannot smuggle arbitrary error bodies or fields into logs. */
export function diagnostic(
  event: DiagnosticEvent,
  fields: DiagnosticFields = {},
) {
  const context = contexts.getStore();
  if (!context || !events.includes(event)) return;
  try {
    const level =
      fields.reason === 'provider_cancelled'
        ? 'info'
        : event.endsWith('.failed') || (fields.status ?? 0) >= 500
          ? 'error'
          : event === 'auth.rejected' || (fields.status ?? 0) >= 400
            ? 'warn'
            : 'info';
    const record: DiagnosticRecord = {
      source: 'pgstencil',
      version: 1,
      event,
      level,
      timestamp: (context.time?.now() ?? new Date()).toISOString(),
    };
    if (context.id && uuid.test(context.id)) record.requestId = context.id;
    if (context.revision && /^[a-f0-9]{40}$/.test(context.revision))
      record.revision = context.revision;
    const target = record as unknown as Record<string, unknown>;
    for (const [key, values] of Object.entries(enums)) {
      const value = (fields as Record<string, unknown>)[key];
      if (
        typeof value === 'string' &&
        (values as readonly string[]).includes(value)
      )
        target[key] = value;
    }
    if (
      fields.stripeEventId &&
      /^evt_[a-zA-Z0-9]{1,128}$/.test(fields.stripeEventId)
    )
      record.stripeEventId = fields.stripeEventId;
    for (const key of numbers) {
      const value = fields[key];
      if (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= 86_400_000
      )
        target[key] = Math.round(value);
    }
    for (const key of booleans)
      if (typeof fields[key] === 'boolean') target[key] = fields[key];
    (context.sink ?? ((entry) => console[entry.level](JSON.stringify(entry))))(
      record,
    );
  } catch {
    /* Logging must never change authentication or payment outcomes. */
  }
}

/** Error messages, stacks, causes, SQL, request and response bodies are never serialized. */
export function diagnosticError(error: unknown): DiagnosticFields {
  try {
    if (!error || typeof error !== 'object') return {};
    const data = error as Record<string, unknown>;
    const result: DiagnosticFields = {};
    if (errorTypes.includes(data.name as (typeof errorTypes)[number]))
      result.errorType = data.name as DiagnosticFields['errorType'];
    const code = data.code ?? data.error;
    if (errorCodes.includes(code as (typeof errorCodes)[number]))
      result.errorCode = code as DiagnosticFields['errorCode'];
    if (
      typeof data.status === 'number' &&
      Number.isInteger(data.status) &&
      data.status >= 400 &&
      data.status <= 599
    )
      result.httpStatus = data.status;
    if (
      Array.isArray(data.error_codes) &&
      typeof data.error_codes[0] === 'number' &&
      Number.isInteger(data.error_codes[0]) &&
      data.error_codes[0] >= 0 &&
      data.error_codes[0] <= 86_400_000
    )
      result.providerCode = data.error_codes[0];
    for (const key of ['httpStatus', 'providerCode'] as const)
      if (
        typeof data[key] === 'number' &&
        Number.isInteger(data[key]) &&
        data[key] >= 0 &&
        data[key] <= 86_400_000
      )
        result[key] = data[key];
    return result;
  } catch {
    return {};
  }
}
export function diagnosticRequestId() {
  return contexts.getStore()?.id;
}
export function withDiagnostics<T>(
  options: DiagnosticOptions,
  run: () => T,
): T {
  return contexts.run(options, run);
}
export function requestOperation(
  request: Request,
): DiagnosticFields['operation'] {
  const path = new URL(request.url).pathname;
  const known: Record<string, DiagnosticFields['operation']> = {
    '/api/auth/sign-in/social': 'auth.social.start',
    '/api/auth/link-social': 'auth.social.start',
    '/api/auth/email-otp/send-verification-otp': 'auth.email.send',
    '/api/auth/sign-in/email-otp': 'auth.email.verify',
    '/api/auth/get-session': 'auth.session',
    '/api/auth/sign-out': 'auth.logout',
    '/api/auth/list-accounts': 'auth.accounts',
    '/api/auth/csrf': 'auth.csrf',
    '/api/health': 'health',
    '/api/ready': 'ready',
    '/api/providers': 'providers',
  };
  if (Object.hasOwn(known, path)) return known[path];
  if (path.startsWith('/api/auth/callback/')) return 'auth.oauth.callback';
  if (path.startsWith('/api/auth/')) return 'auth.other';
  if (path.startsWith('/dev/') || path.startsWith('/api/dev/')) return 'inbox';
  return path.startsWith('/api/') ? 'api.other' : 'static';
}
/** One server-generated correlation ID per request; incoming IDs/URLs are not trusted or logged. */
export function observeRequest(
  request: Request,
  options: DiagnosticOptions,
  handle: () => Promise<Response>,
): Promise<Response> {
  const existing = contexts.getStore();
  if (existing?.id) return handle();
  const candidate = options.requestId?.() ?? randomUUID();
  const id = uuid.test(candidate) ? candidate : randomUUID();
  return contexts.run({ ...options, id }, async () => {
    const operation = requestOperation(request);
    const started = options.time?.now().getTime() ?? Date.now();
    let response: Response;
    try {
      response = await handle();
    } catch (error) {
      diagnostic('request.failed', {
        operation,
        reason: 'unexpected_error',
        ...diagnosticError(error),
      });
      response = Response.json(
        { message: 'Temporarily unavailable. Please try again.' },
        { status: 503, headers: { 'cache-control': 'no-store' } },
      );
    }
    if (operation !== 'static' || response.status >= 400)
      diagnostic('request.completed', {
        operation,
        status: response.status,
        durationMs: Math.max(
          0,
          (options.time?.now().getTime() ?? Date.now()) - started,
        ),
      });
    const headers = new Headers(response.headers);
    headers.set('x-request-id', id);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });
}

import {
  createBetterAuthWorker,
  type BetterAuthWorkerBindings,
} from '@pgstencil/auth/better-auth-workers';
export interface Bindings extends BetterAuthWorkerBindings {
  SESSION_POLICY?: 'single' | 'multiple';
  EMAIL: { fetch(request: Request): Promise<Response> };
}
export default {
  fetch(request: Request, env: Bindings) {
    return createBetterAuthWorker<Bindings>({
      sessionPolicy: env.SESSION_POLICY ?? 'multiple',
      email: (bindings) => ({
        async send(message) {
          const response = await bindings.EMAIL.fetch(
            new Request('https://email.internal/send', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(message),
            }),
          );
          if (!response.ok) throw new Error('Email delivery failed');
        },
      }),
    }).fetch(request, env);
  },
};

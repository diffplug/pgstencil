import { Hono, type Context, type Env } from 'hono';
import { createAuthFetch, HttpError } from './fetch.ts';

export type AuthFetch = ReturnType<typeof createAuthFetch>;
/** The factory may acquire request-scoped services from Hono context variables. */
export function createAuthHono<E extends Env = Env>(
  factory: AuthFetch | ((context: Context<E>) => AuthFetch),
) {
  const app = new Hono<E>();
  app.onError(
    (error) =>
      new Response(
        JSON.stringify({
          error:
            error instanceof HttpError
              ? error.message
              : 'Sign-in is temporarily unavailable. Please try again.',
        }),
        {
          status: error instanceof HttpError ? error.status : 503,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
          },
        },
      ),
  );
  app.all('*', async (c) => {
    const api = typeof factory === 'function' ? factory(c) : factory;
    return (await api.handle(c.req.raw)) ?? c.notFound();
  });
  return app;
}

import { createEmailApp } from './auth.ts';
import { oauthFromEnvironment } from './oauth.ts';

export interface Bindings {
  HYPERDRIVE: { connectionString: string };
  APP_ORIGIN: string;
  AUTH_SECRET: string;
  SESSION_POLICY?: 'single' | 'multiple';
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  APPLE_CLIENT_ID?: string;
  APPLE_CLIENT_SECRET?: string;
  FACEBOOK_CLIENT_ID?: string;
  FACEBOOK_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** A service binding owns delivery; tests bind this to the in-memory inbox. */
  EMAIL: { fetch(request: Request): Promise<Response> };
}

export default {
  async fetch(request: Request, env: Bindings) {
    const app = createEmailApp({
      databaseUrl: env.HYPERDRIVE.connectionString,
      origin: env.APP_ORIGIN,
      secret: env.AUTH_SECRET,
      sessionPolicy: env.SESSION_POLICY ?? 'multiple',
      oauth: oauthFromEnvironment({
        ...env,
        HYPERDRIVE: undefined,
        EMAIL: undefined,
      }),
      // Cloudflare supplies this header; ignore user-controlled forwarding headers.
      ipAddressHeaders: ['cf-connecting-ip'],
      email: {
        async send(message) {
          const response = await env.EMAIL.fetch(
            new Request('https://email.internal/send', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(message),
            }),
          );
          if (!response.ok) throw new Error('Email delivery failed');
        },
      },
    });
    try {
      return await app.app.fetch(request);
    } finally {
      await app.close();
    }
  },
};

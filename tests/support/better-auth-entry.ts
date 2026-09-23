import { createEmailApp } from '../../examples/better-auth/src/auth.ts';
import { deterministicScope } from '../../packages/auth/src/better-auth-testing.ts';
import type { Time, RandomSource } from 'pgstencil';

export function createDeterministicApp(
  options: Parameters<typeof createEmailApp>[0] & {
    time: Time;
    random: RandomSource;
    outboundFetch?: typeof fetch;
  },
) {
  const app = deterministicScope.run(options, () => createEmailApp(options));
  return {
    close: app.close,
    // env carries the Node socket (`incoming`) that the client IP is read from.
    fetch: (request: Request, env?: object) =>
      deterministicScope.run(options, () => app.app.fetch(request, env)),
    // Deliberately crosses async boundaries to test independent concurrent app contexts.
    probe: () =>
      deterministicScope.run(options, async () => {
        const before = Date.now();
        await new Promise((done) => setTimeout(done, 5));
        return {
          before,
          after: new Date().getTime(),
          uuid: crypto.randomUUID(),
        };
      }),
  };
}

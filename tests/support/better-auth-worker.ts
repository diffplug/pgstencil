import worker, {
  type Bindings,
} from '../../examples/better-auth/src/worker.ts';
import { DevTime, DevRandom } from 'pgstencil';
import { deterministicScope } from './scoped-globals.ts';
const context = {
  time: new DevTime(),
  random: new DevRandom('better-auth-worker'),
};
export default {
  async fetch(
    request: Request,
    env: Bindings & {
      OAUTH_TEST?: { fetch(request: Request): Promise<Response> };
    },
  ) {
    if (
      new URL(request.url).pathname === '/__test/time' &&
      request.method === 'POST'
    ) {
      context.time.set(await request.text());
      return new Response('ok');
    }
    return deterministicScope.run(
      {
        ...context,
        ...(env.OAUTH_TEST
          ? {
              outboundFetch: (input: RequestInfo | URL, init?: RequestInit) =>
                env.OAUTH_TEST!.fetch(new Request(input, init)),
            }
          : {}),
      },
      () => worker.fetch(request, env),
    );
  },
};

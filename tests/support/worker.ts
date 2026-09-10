import { DevTime, DevRandom } from '../../packages/pgstencil/src/index.ts';
import { createAuthWorker } from '../../packages/auth/src/workers.ts';
import type { EmailMessage } from '../../packages/pgstencil/src/email.ts';
const time = new DevTime();
const app = createAuthWorker({
  time,
  random: new DevRandom('worker-test'),
  email: () => ({
    async send(message: EmailMessage) {
      const response = await fetch('https://inbox.test/send', {
        method: 'POST',
        body: JSON.stringify(message),
      });
      if (!response.ok) throw new Error('Test email delivery failed');
    },
  }),
});
// Control routes exist only in this test bundle; the production entry has none.
export default {
  async fetch(request: Request, env: Parameters<typeof app.fetch>[1]) {
    if (new URL(request.url).pathname === '/__test/time') {
      time.set(await request.text());
      return new Response('ok');
    }
    return app.fetch(request, env);
  },
};

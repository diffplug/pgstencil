import {
  createBetterAuthWorker,
  type BetterAuthWorkerBindings,
} from '@pgstencil/auth/better-auth-workers';
import { postmarkEmail } from '@pgstencil/auth/postmark';

/**
 * The deployable Workers entry (`wrangler.jsonc`). `worker.ts` is the same
 * application with an EMAIL service binding, which the Workers tests replace.
 */
interface Env extends BetterAuthWorkerBindings {
  POSTMARK_SERVER_TOKEN: string;
  EMAIL_FROM: string;
}
export default createBetterAuthWorker<Env>({
  email: (env) => postmarkEmail(env.POSTMARK_SERVER_TOKEN, env.EMAIL_FROM),
  // Postmark sends from its own `from` argument; this keeps a renderer's input
  // and any other transport on the same address.
  emailFrom: (env) => env.EMAIL_FROM,
});

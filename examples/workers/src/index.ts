import {
  createAuthWorker,
  type AuthWorkerBindings,
} from '@pgstencil/auth/workers';
import { postmarkEmail } from '@pgstencil/auth/postmark';

interface Env extends AuthWorkerBindings {
  POSTMARK_SERVER_TOKEN: string;
  EMAIL_FROM: string;
}
export default createAuthWorker<Env>({
  email: (env) => postmarkEmail(env.POSTMARK_SERVER_TOKEN, env.EMAIL_FROM),
});

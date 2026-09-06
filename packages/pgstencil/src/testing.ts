import { DevTime } from './time.ts';
import { DevRandom } from './random.ts';
import { EmailDev } from './email.ts';
import { allocateDatabase } from './database.ts';
/** Owns independent infrastructure; callers register close() with their test runner. */
export async function createTestContext(
  options: { seed?: string; now?: string; migrations?: string } = {},
) {
  const database = await allocateDatabase(options.migrations);
  const time = new DevTime(options.now);
  const random = new DevRandom(options.seed);
  const email = new EmailDev(time);
  let closed = false;
  return {
    database,
    time,
    random,
    email,
    async close() {
      if (closed) return;
      closed = true;
      email.close();
      await database.close();
    },
  };
}

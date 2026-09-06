import { fixture, login } from '../integration/helpers.ts';
const f = await fixture();
try {
  await login(f);
  process.send!({
    origin: f.app.origin,
    name: f.database.name,
    hash: f.database.hash,
  });
  await new Promise<void>((resolve) => {
    process.once('message', () => resolve());
  });
} finally {
  await f.close();
  process.disconnect!();
}

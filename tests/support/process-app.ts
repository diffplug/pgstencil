import { fixture, signUp } from './fixture-app.ts';
const f = await fixture();
try {
  await signUp(f);
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

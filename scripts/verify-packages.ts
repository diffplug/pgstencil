import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectRoot } from '../packages/pgstencil/src/paths.ts';

const directory = await mkdtemp(join(tmpdir(), 'pgstencil-packed-'));
await mkdir(join(directory, 'vendor'));
const dependencies: Record<string, string> = {};
for (const name of ['pgstencil', '@pgstencil/auth', '@pgstencil/stripe']) {
  const file = `${name.replace('@', '').replace('/', '-')}-0.1.0.tgz`;
  await cp(
    join(projectRoot, 'dist/packages', file),
    join(directory, 'vendor', file),
  );
  dependencies[name] = `file:./vendor/${file}`;
}
await writeFile(
  join(directory, 'package.json'),
  JSON.stringify(
    {
      name: 'packed-consumer',
      private: true,
      type: 'module',
      packageManager: 'pnpm@10.30.1',
      dependencies,
      pnpm: { overrides: dependencies },
      devDependencies: { '@types/node': '24.13.3', typescript: '5.9.3' },
    },
    null,
    2,
  ),
);
await writeFile(
  join(directory, 'verify.ts'),
  `import { DevTime, DevRandom, EmailDev } from 'pgstencil';
import { allocateDatabase, connectDatabase, readMigrations, migrate } from 'pgstencil/database';
import { Auth, type AuthDB } from '@pgstencil/auth';
import { authMigrations } from '@pgstencil/auth/migrations';
import { createAuthHttp } from '@pgstencil/auth/http';
import { Billing, type BillingDB } from '@pgstencil/stripe';
import { billingMigrations } from '@pgstencil/stripe/migrations';
import { createStripeDev } from '@pgstencil/stripe/testing';
import { strict as assert } from 'node:assert';
const lease = await allocateDatabase([authMigrations, billingMigrations]);
const db = connectDatabase<AuthDB>(lease.url);
const billingDb = connectDatabase<BillingDB>(lease.url);
const time = new DevTime(); const random = new DevRandom(); const email = new EmailDev(time);
const dev = await createStripeDev(time, random);
try {
  const auth = new Auth({ db, time, random, email, origin: 'https://consumer.test', secret: 'packed-consumer-secret-at-least-32' });
  const flow = await auth.newFlow();
  assert.equal((await auth.send(flow, 'packed@example.test', 'local')).ok, true);
  const message = await email.next(); const code = message.text.match(/code is (\\d{4}) (\\d{4})/)!.slice(1).join('');
  const result = await auth.verify((await auth.pending(flow.cookie))!, 'code', code, undefined, 'local');
  assert.ok(result.ok); const session = await auth.session(result.session); assert.ok(session);
  const billing = new Billing(billingDb, dev.stripe, time, random, { prices: dev.prices, trialDays: 14, webhookSecret: dev.webhookSecret, live: false, origin: 'https://consumer.test' });
  await billing.checkout(session.user_id, session.email, 'monthly');
  assert.equal((await billing.status(session.user_id)).access, false);
  dev.completeCheckout([...dev.checkouts.keys()][0]!);
  for (const event of dev.events) { const signed = dev.signed(event); await billing.webhook(signed.body, signed.signature); }
  assert.equal((await billing.status(session.user_id)).access, true);
  assert.equal(typeof createAuthHttp, 'function');
  await migrate(lease.url, await readMigrations([authMigrations, billingMigrations]));
  console.log('Packed imports, declarations, Compose/SQL assets, email login and card-required trial passed.');
} finally { await db.destroy(); await billingDb.destroy(); await dev.close(); await lease.close(); email.close(); }
`,
);
await writeFile(
  join(directory, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      target: 'ES2023',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      skipLibCheck: true,
      outDir: 'out',
    },
    include: ['verify.ts'],
  }),
);
execFileSync('pnpm', ['install', '--ignore-scripts'], {
  cwd: directory,
  stdio: 'inherit',
});
execFileSync('pnpm', ['exec', 'tsc'], { cwd: directory, stdio: 'inherit' });
// Share only Docker service state, never workspace code or module resolution.
execFileSync(process.execPath, ['out/verify.js'], {
  cwd: directory,
  stdio: 'inherit',
  env: { ...process.env, PGSTENCIL_PROJECT_ROOT: projectRoot },
});
console.log(`Independent installed consumer: ${directory}`);

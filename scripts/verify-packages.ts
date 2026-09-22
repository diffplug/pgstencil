import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectRoot } from '../packages/pgstencil/src/paths.ts';

const directory = await mkdtemp(join(tmpdir(), 'pgstencil-packed-'));
await mkdir(join(directory, 'vendor'));
const dependencies: Record<string, string> = {};
// The consumer owns every shared library, at the version this workspace tests.
const peers: Record<string, string> = {};
for (const name of ['pgstencil', '@pgstencil/auth', '@pgstencil/stripe']) {
  const packageDirectory = name === 'pgstencil' ? name : name.split('/')[1]!;
  const manifest = JSON.parse(
    await readFile(
      join(projectRoot, 'packages', packageDirectory, 'package.json'),
      'utf8',
    ),
  ) as { version: string; peerDependencies?: Record<string, string> };
  const file = `${name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`;
  await cp(
    join(projectRoot, 'dist/packages', file),
    join(directory, 'vendor', file),
  );
  dependencies[name] = `file:./vendor/${file}`;
  for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
    if (peer === 'pgstencil') continue;
    const installed = JSON.parse(
      await readFile(
        join(
          projectRoot,
          'packages',
          packageDirectory,
          'node_modules',
          peer,
          'package.json',
        ),
        'utf8',
      ),
    ) as { version: string };
    peers[peer] = installed.version;
  }
}
await writeFile(
  join(directory, 'package.json'),
  JSON.stringify(
    {
      name: 'packed-consumer',
      private: true,
      type: 'module',
      packageManager: 'pnpm@10.30.1',
      dependencies: { ...dependencies, ...peers },
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
import { betterAuthMigrations } from '@pgstencil/auth/better-auth-migrations';
import { createAuthApp } from '@pgstencil/auth/better-auth';
import { deterministicScope } from '@pgstencil/auth/better-auth-testing';
import { createAuthHttp } from '@pgstencil/auth/http';
import { Billing, type BillingDB } from '@pgstencil/stripe';
import { billingMigrations } from '@pgstencil/stripe/migrations';
import { createStripeDev } from '@pgstencil/stripe/testing';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
for (const name of ['pgstencil', '@pgstencil/auth', '@pgstencil/stripe']) {
  const entry = import.meta.resolve(name);
  const manifest = JSON.parse(readFileSync(new URL('../package.json', entry), 'utf8'));
  assert.equal(manifest.name, name);
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.repository.url, 'git+https://github.com/diffplug/pgstencil.git');
  assert.ok(readFileSync(new URL('../LICENSE', entry), 'utf8').startsWith('MIT License'));
}
assert.ok(readFileSync(new URL('compose.yaml', import.meta.resolve('pgstencil/database')), 'utf8').includes('integresql'));
const lease = await allocateDatabase([authMigrations, billingMigrations, betterAuthMigrations]);
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
  await migrate(lease.url, await readMigrations([authMigrations, billingMigrations, betterAuthMigrations]));
  const modern = createAuthApp({databaseUrl:lease.url,origin:'https://consumer.test',secret:'packed-consumer-secret-at-least-32',email,sessionPolicy:'single'});
  try {
    const csrfResponse = await modern.app.fetch(new Request('https://consumer.test/api/auth/csrf'));
    const csrf = (await csrfResponse.json()).csrf;
    const cookie = csrfResponse.headers.getSetCookie().map((v) => v.split(';')[0]).join('; ');
    const post = (path: string, body: object) => modern.app.fetch(new Request('https://consumer.test/api/auth/' + path, {method:'POST',headers:{origin:'https://consumer.test',cookie,'x-csrf-token':csrf,'content-type':'application/json','x-pgstencil-client-ip':'127.0.0.1'},body:JSON.stringify(body)}));
    assert.equal((await post('email-otp/send-verification-otp',{email:'modern@example.test',type:'sign-in'})).status,200);
    const otp = (await email.next()).text.match(/\\b\\d{8}\\b/)![0];
    const signedIn = await post('sign-in/email-otp',{email:'modern@example.test',otp});
    assert.equal(signedIn.status,200);
    assert.ok(signedIn.headers.getSetCookie()[0].startsWith('__Host-pgstencil.session_token='));
    assert.equal((await signedIn.json()).token,undefined);
    assert.equal(typeof deterministicScope.run,'function');
  } finally { await modern.close(); }
  console.log('Packed imports, declarations, SQL assets, legacy/Better Auth login and card-required trial passed.');
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
// A shared library outside pgstencil's range, or one nothing provides, fails
// the install instead of only warning.
await writeFile(
  join(directory, '.npmrc'),
  'auto-install-peers=false\nstrict-peer-dependencies=true\n',
);
execFileSync('pnpm', ['install', '--ignore-scripts'], {
  cwd: directory,
  stdio: 'inherit',
});
// A consumer proves which source it runs from this file alone; prove it here too.
const head = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: projectRoot,
  encoding: 'utf8',
}).trim();
for (const name of ['pgstencil', '@pgstencil/auth', '@pgstencil/stripe']) {
  const file = join(directory, 'node_modules', name, 'dist/provenance.json');
  const provenance = JSON.parse(await readFile(file, 'utf8')) as {
    commit?: string;
    dirty?: boolean;
  };
  if (provenance.commit !== head)
    throw new Error(
      `${name} was packed from ${provenance.commit}, not ${head} (${file})`,
    );
  if (provenance.dirty)
    throw new Error(`${name} was packed from a modified tree (${file})`);
}
execFileSync('pnpm', ['exec', 'tsc'], { cwd: directory, stdio: 'inherit' });
// Share only Docker service state, never workspace code or module resolution.
execFileSync(process.execPath, ['out/verify.js'], {
  cwd: directory,
  stdio: 'inherit',
  env: { ...process.env, PGSTENCIL_PROJECT_ROOT: projectRoot },
});
console.log(`Independent installed consumer: ${directory}`);

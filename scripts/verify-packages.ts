import { execFileSync } from 'node:child_process';
import {
  cp,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectRoot } from '../packages/pgstencil/src/paths.ts';

const directory = await mkdtemp(join(tmpdir(), 'pgstencil-packed-'));
await mkdir(join(directory, 'vendor'));
const { packageManager } = JSON.parse(
  await readFile(join(projectRoot, 'package.json'), 'utf8'),
) as { packageManager: string };
const { version: typescriptVersion } = JSON.parse(
  await readFile(
    join(projectRoot, 'node_modules/typescript/package.json'),
    'utf8',
  ),
) as { version: string };
interface Manifest {
  version: string;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}
const readManifest = async (path: string) =>
  JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) as Manifest;
const dependencies: Record<string, string> = {};
// The consumer owns every shared library, at the version this workspace tests.
const peers: Record<string, string> = {};
// Optional peers only the tooling entry points load (PACKAGES.md -> Dependencies),
// plus the peers they bring.
const toolingPeers: Record<string, string> = {};
for (const name of ['pgstencil', '@pgstencil/auth', '@pgstencil/stripe']) {
  const packageDirectory = name === 'pgstencil' ? name : name.split('/')[1]!;
  const modules = join(
    projectRoot,
    'packages',
    packageDirectory,
    'node_modules',
  );
  const manifest = await readManifest(
    join(projectRoot, 'packages', packageDirectory),
  );
  const file = `${name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`;
  await cp(
    join(projectRoot, 'dist/packages', file),
    join(directory, 'vendor', file),
  );
  dependencies[name] = `file:./vendor/${file}`;
  for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
    if (peer === 'pgstencil') continue;
    const installed = await readManifest(join(modules, peer));
    if (!manifest.peerDependenciesMeta?.[peer]?.optional) {
      peers[peer] = installed.version;
      continue;
    }
    toolingPeers[peer] = installed.version;
    // node-pg-migrate peers on pg, which this workspace provides as pgstencil's own.
    for (const inner of Object.keys(installed.peerDependencies ?? {}))
      if (!installed.peerDependenciesMeta?.[inner]?.optional)
        toolingPeers[inner] ??= (
          await readManifest(join(modules, inner))
        ).version;
  }
}
// A tooling peer's own peer that is also a shared library (kysely-codegen's
// kysely) is the application's runtime copy, not a second devDependency.
for (const name of Object.keys(peers)) delete toolingPeers[name];
// An application that imports only runtime entry points, installed the way it
// deploys: none of the tooling may land, even with peers auto-installed.
const runtime = await mkdtemp(join(tmpdir(), 'pgstencil-runtime-'));
await cp(join(directory, 'vendor'), join(runtime, 'vendor'), {
  recursive: true,
});
await writeFile(
  join(runtime, 'package.json'),
  JSON.stringify({
    name: 'runtime-consumer',
    private: true,
    type: 'module',
    packageManager,
    dependencies: { ...dependencies, ...peers },
  }),
);
await writeFile(
  join(runtime, 'pnpm-workspace.yaml'),
  JSON.stringify({
    overrides: dependencies,
    strictPeerDependencies: true,
    peerDependencyRules: { allowAny: ['pgstencil'] },
  }),
);
execFileSync('pnpm', ['install', '--prod', '--ignore-scripts'], {
  cwd: runtime,
  stdio: 'inherit',
});
// Named independently of the manifests, so a tooling package that moves back to
// dependencies still counts as a leak.
const tooling = JSON.parse(
  await readFile(join(projectRoot, 'scripts/tooling-peers.json'), 'utf8'),
) as string[];
const runtimePackages = new Set(
  (await readdir(join(runtime, 'node_modules/.pnpm')))
    .filter((entry) => entry.lastIndexOf('@') > 0)
    .map((entry) => entry.replace(/_.*/, '')),
);
const leaked = tooling.filter((peer) =>
  [...runtimePackages].some((entry) =>
    entry.startsWith(`${peer.replace('/', '+')}@`),
  ),
);
if (leaked.length)
  throw new Error(
    `A production install of the packages includes ${leaked.join(', ')} (${runtime})`,
  );
console.log(
  `Runtime-only consumer: ${runtimePackages.size} packages, none of ${tooling.join(', ')} (${runtime})`,
);
await writeFile(
  join(directory, 'package.json'),
  JSON.stringify(
    {
      name: 'packed-consumer',
      private: true,
      type: 'module',
      packageManager,
      dependencies: { ...dependencies, ...peers },
      devDependencies: {
        ...toolingPeers,
        '@types/node': '24.13.3',
        typescript: typescriptVersion,
      },
    },
    null,
    2,
  ),
);
// The installed `pgstencil` command reads this, naming package sources by
// their installed paths the way an application does.
await writeFile(
  join(directory, 'pgstencil.json'),
  JSON.stringify({
    migrations: [
      'node_modules/@pgstencil/auth/better-auth-migrations',
      'node_modules/@pgstencil/stripe/migrations',
    ],
  }),
);
await writeFile(
  join(directory, 'verify.ts'),
  `import { DevTime, DevRandom, EmailDev } from 'pgstencil';
import { allocateDatabase, connectDatabase, readMigrations, migrate } from 'pgstencil/database';
import { createAuthApp } from '@pgstencil/auth';
import { betterAuthMigrations } from '@pgstencil/auth/better-auth-migrations';
import { createBetterAuthWorker } from '@pgstencil/auth/better-auth-workers';
import { deterministicScope } from '@pgstencil/auth/better-auth-testing';
import { postmarkEmail } from '@pgstencil/auth/postmark';
import { Billing, type BillingDB } from '@pgstencil/stripe';
import { billingMigrations } from '@pgstencil/stripe/migrations';
import { createStripeDev } from '@pgstencil/stripe/testing';
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const pgstencilVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.resolve('pgstencil')), 'utf8')).version;
for (const name of ['pgstencil', '@pgstencil/auth', '@pgstencil/stripe']) {
  const entry = import.meta.resolve(name);
  const manifest = JSON.parse(readFileSync(new URL('../package.json', entry), 'utf8'));
  assert.equal(manifest.name, name);
  if (name !== 'pgstencil') assert.equal(manifest.peerDependencies.pgstencil, '^' + pgstencilVersion);
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.repository.url, 'git+https://github.com/diffplug/pgstencil.git');
  assert.ok(readFileSync(new URL('../LICENSE', entry), 'utf8').startsWith('MIT License'));
}
assert.ok(readFileSync(new URL('compose.yaml', import.meta.resolve('pgstencil/database')), 'utf8').includes('integresql'));
const sources = [betterAuthMigrations, billingMigrations];
const lease = await allocateDatabase(sources);
const billingDb = connectDatabase<BillingDB>(lease.url);
const time = new DevTime(); const random = new DevRandom(); const email = new EmailDev(time);
const dev = await createStripeDev(time, random);
try {
  await migrate(lease.url, await readMigrations(sources));
  // The installed bin, run by node from dist without tsx, against this project's
  // own pgstencil.json and the leased database.
  const cliEnv: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: lease.url };
  delete cliEnv.PGSTENCIL_PROJECT_ROOT;
  const pgstencil = (...args: string[]) => execFileSync('node_modules/.bin/pgstencil', args, { env: cliEnv, encoding: 'utf8' });
  const status = pgstencil('status');
  const rows = status.split('\\n');
  for (const file of await readMigrations(sources)) assert.ok(rows.some((row) => row.includes(file.name) && row.includes("'applied'")), status);
  assert.doesNotMatch(status, /pending/);
  assert.equal(pgstencil('validate').trim(), 'Applied SQL migration contents match.');
  const unknown = spawnSync('node_modules/.bin/pgstencil', ['up'], { env: cliEnv, encoding: 'utf8' });
  assert.equal(unknown.status, 2); assert.match(unknown.stderr, /Usage: pgstencil <command>/);
  const auth = createAuthApp({databaseUrl:lease.url,origin:'https://consumer.test',secret:'packed-consumer-secret-at-least-32',email,sessionPolicy:'single'});
  try {
    const csrfResponse = await auth.app.fetch(new Request('https://consumer.test/api/auth/csrf'));
    const csrf = (await csrfResponse.json()).csrf;
    const csrfCookie = csrfResponse.headers.getSetCookie().map((v) => v.split(';')[0]).join('; ');
    const post = (path: string, body: object) => auth.app.fetch(new Request('https://consumer.test/api/auth/' + path, {method:'POST',headers:{origin:'https://consumer.test',cookie:csrfCookie,'x-csrf-token':csrf,'content-type':'application/json'},body:JSON.stringify(body)}),{incoming:{socket:{remoteAddress:'127.0.0.1'}}});
    assert.equal((await post('email-otp/send-verification-otp',{email:'packed@example.test',type:'sign-in'})).status,200);
    const otp = (await email.next()).text.match(/\\b\\d{8}\\b/)![0];
    const signedIn = await post('sign-in/email-otp',{email:'packed@example.test',otp});
    assert.equal(signedIn.status,200);
    const sessionCookie = signedIn.headers.getSetCookie()[0]!.split(';')[0]!;
    assert.ok(sessionCookie.startsWith('__Host-pgstencil.session_token='));
    assert.equal((await signedIn.json()).token,undefined);
    const session = await auth.auth.api.getSession({headers:new Headers({cookie:sessionCookie})});
    assert.ok(session); assert.equal(session.user.email,'packed@example.test');
    const billing = new Billing(billingDb, dev.stripe, time, random, { prices: dev.prices, trialDays: 14, webhookSecret: dev.webhookSecret, live: false, origin: 'https://consumer.test' });
    await billing.checkout(session.user.id, session.user.email, 'monthly');
    assert.equal((await billing.status(session.user.id)).access, false);
    dev.completeCheckout([...dev.checkouts.keys()][0]!);
    for (const event of dev.events) { const signed = dev.signed(event); await billing.webhook(signed.body, signed.signature); }
    assert.equal((await billing.status(session.user.id)).access, true);
  } finally { await auth.close(); }
  assert.equal(typeof createBetterAuthWorker({email:() => postmarkEmail('token','signin@consumer.test')}).fetch,'function');
  assert.equal(typeof deterministicScope.run,'function');
  console.log('Packed imports, declarations, SQL assets, the pgstencil command, Better Auth login and card-required trial passed.');
} finally { await billingDb.destroy(); await dev.close(); await lease.close(); email.close(); }
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
// the install instead of only warning. pnpm 12 reads these settings from the
// workspace file rather than package.json or .npmrc.
await writeFile(
  join(directory, 'pnpm-workspace.yaml'),
  JSON.stringify({
    overrides: dependencies,
    autoInstallPeers: false,
    strictPeerDependencies: true,
    // A file: tarball peer is reported by its path rather than its version.
    // verify.ts checks the packed pgstencil peer range explicitly.
    peerDependencyRules: { allowAny: ['pgstencil'] },
  }),
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
// The packed generators, with the consumer's kysely-codegen, must reproduce
// this workspace's committed schema dump and declarations byte for byte.
execFileSync(join(directory, 'node_modules/.bin/pgstencil'), ['verify'], {
  cwd: directory,
  stdio: 'inherit',
  env: { ...process.env, PGSTENCIL_PROJECT_ROOT: projectRoot },
});
console.log(`Independent installed consumer: ${directory}`);

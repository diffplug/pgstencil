import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { generateTypes } from './generate-types.ts';
import {
  activeDatabases,
  allocateDatabase,
  appliedMigrations,
  clearTemplates,
  ensureServices,
  developmentDatabase,
  developmentDatabaseName,
  queryDatabase,
  migrate,
  readMigrations,
  validateMigrations,
  defaultMigrations,
  projectRoot,
  projectName,
  stateDirectory,
  type Services,
} from '../packages/pgstencil/src/database.ts';
import { billingMigrations } from '../packages/stripe/src/migrations.ts';
const migrations = [defaultMigrations, billingMigrations];
const exec = promisify(execFile);
const command = process.argv[2];
const statePath = join(stateDirectory, 'services.json');
const typesFile = 'examples/login/src/db.generated.ts';
const schemaFile = join(projectRoot, 'examples/login/schema.sql');
/**
 * `unreachableIsIdle` is only for `stop`, which reads a recorded stack that may
 * already be down. gc/reset run against a stack we just started, so there a
 * failed query is a real fault and must surface.
 */
async function requireIdle(
  services: Services,
  unreachableIsIdle = false,
): Promise<void> {
  const active = unreachableIsIdle
    ? await activeDatabases(services).catch(() => [])
    : await activeDatabases(services);
  if (active.length)
    throw new Error(
      'Applications/databases are still in use; stop them before cleanup',
    );
}
if (command === 'create') {
  const label = process.argv[3];
  if (!label || !/^[a-z][a-z0-9_]*$/.test(label))
    throw new Error('Supply a snake_case migration name');
  const files = await readMigrations(migrations);
  const next = String(
    Math.max(...files.map((f) => Number(f.name.split('_')[0]))) + 1,
  ).padStart(3, '0');
  const path = join(defaultMigrations, `${next}_${label}.sql`);
  await writeFile(path, '-- Up Migration\n\n-- Down Migration\n', {
    flag: 'wx',
  });
  console.log(path);
} else if (
  command === 'types' ||
  command === 'schema' ||
  command === 'verify'
) {
  // One lease covers both generators; `verify` checks each is up to date.
  const verify = command === 'verify' || process.argv.includes('--verify');
  const lease = await allocateDatabase(migrations);
  try {
    if (command !== 'schema')
      console.log(await generateTypes(lease.url, typesFile, verify));
    if (command !== 'types') {
      const services = await ensureServices();
      const result = await exec(
        'docker',
        [
          'exec',
          services.postgresContainer,
          'pg_dump',
          '-U',
          'pgstencil',
          '-d',
          lease.name,
          '--schema-only',
          '--no-owner',
          '--no-privileges',
          '--restrict-key=pgstencil',
        ],
        { maxBuffer: 4_000_000 },
      );
      const schema = result.stdout.replace(/^-- Dumped .*\n/gm, '');
      if (verify) {
        if ((await readFile(schemaFile, 'utf8')) !== schema)
          throw new Error('Schema dump is stale; run pnpm db:schema');
      } else await writeFile(schemaFile, schema);
    }
  } finally {
    await lease.close();
  }
} else if (command === 'stop') {
  // Read the recorded stack rather than starting one just to shut it down.
  const state: Services | undefined = await readFile(statePath, 'utf8')
    .then((text) => JSON.parse(text) as Services)
    .catch(() => undefined);
  if (state) await requireIdle(state, true);
  await exec('docker', ['compose', '-p', projectName, 'down'], {
    cwd: projectRoot,
  });
  await rm(statePath, { force: true });
} else if (command === 'gc' || command === 'reset') {
  const services = await ensureServices();
  await requireIdle(services);
  if (command === 'reset') {
    await queryDatabase(
      services.postgresUrl,
      `DROP DATABASE IF EXISTS ${developmentDatabaseName}`,
    );
    await developmentDatabase(true, migrations);
  } else await clearTemplates(services);
} else if (
  command === 'status' ||
  command === 'migrate' ||
  command === 'validate'
) {
  const url = process.env.DATABASE_URL ?? (await developmentDatabase(false));
  const files = await readMigrations(migrations);
  if (command === 'migrate') await migrate(url, files);
  else if (command === 'validate') {
    await validateMigrations(url, files);
    console.log('Applied SQL migration contents match.');
  } else {
    const applied = new Set(await appliedMigrations(url));
    console.table(
      files.map((file) => ({
        name: file.name,
        status: applied.has(file.name) ? 'applied' : 'pending',
      })),
    );
  }
} else throw new Error('Unknown database command');

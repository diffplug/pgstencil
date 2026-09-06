import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  allocateDatabase,
  ensureServices,
  developmentDatabase,
  queryDatabase,
  migrate,
  readMigrations,
  validateMigrations,
  defaultMigrations,
  projectRoot,
  projectName,
  stateDirectory,
} from '../packages/pgstencil/src/database.ts';
const exec = promisify(execFile);
const command = process.argv[2];
if (command === 'create') {
  const label = process.argv[3];
  if (!label || !/^[a-z][a-z0-9_]*$/.test(label))
    throw new Error('Supply a snake_case migration name');
  const files = await readMigrations(defaultMigrations);
  const next = String(
    Math.max(...files.map((f) => Number(f.name.split('_')[0]))) + 1,
  ).padStart(3, '0');
  const path = join(defaultMigrations, `${next}_${label}.sql`);
  await writeFile(path, '-- Up Migration\n\n-- Down Migration\n', {
    flag: 'wx',
  });
  console.log(path);
} else if (command === 'types' || command === 'schema') {
  const lease = await allocateDatabase();
  try {
    if (command === 'types') {
      const args = [
        'exec',
        'kysely-codegen',
        '--url',
        'env(DATABASE_URL)',
        '--out-file',
        'examples/login/src/db.generated.ts',
        '--include-pattern',
        'public.(users|login_flows|login_challenges|sessions|rate_limits)',
      ];
      if (process.argv.includes('--verify')) args.push('--verify');
      const result = await exec('pnpm', args, {
        cwd: projectRoot,
        env: { ...process.env, DATABASE_URL: lease.url },
      });
      console.log(result.stdout.trim());
    } else {
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
      const path = join(projectRoot, 'examples/login/schema.sql');
      if (process.argv.includes('--verify')) {
        if ((await readFile(path, 'utf8')) !== schema)
          throw new Error('Schema dump is stale; run pnpm db:schema');
      } else await writeFile(path, schema);
    }
  } finally {
    await lease.close();
  }
} else if (command === 'stop' || command === 'gc' || command === 'reset') {
  const services = await ensureServices();
  const active = await queryDatabase(
    services.postgresUrl,
    "SELECT datname FROM pg_stat_activity WHERE datname <> 'postgres' AND backend_type='client backend' AND (datname LIKE 'integresql_%' OR datname='pgstencil_dev')",
  );
  if (active.length)
    throw new Error(
      'Applications/databases are still in use; stop them before cleanup',
    );
  if (command === 'stop') {
    await exec('docker', ['compose', '-p', projectName, 'down'], {
      cwd: projectRoot,
    });
    await rm(join(stateDirectory, 'services.json'), { force: true });
  } else if (command === 'reset') {
    await queryDatabase(
      services.postgresUrl,
      'DROP DATABASE IF EXISTS pgstencil_dev',
    );
    await developmentDatabase();
  } else {
    const result = await fetch(
      `${services.integresqlUrl}/api/v1/admin/templates`,
      { method: 'DELETE' },
    );
    if (!result.ok)
      throw new Error(`IntegreSQL cleanup failed: ${result.status}`);
    await queryDatabase(
      services.postgresUrl,
      'TRUNCATE pgstencil_ready_templates',
    );
  }
} else if (
  command === 'status' ||
  command === 'migrate' ||
  command === 'validate'
) {
  const url = process.env.DATABASE_URL ?? (await developmentDatabase(false));
  const files = await readMigrations(defaultMigrations);
  if (command === 'migrate') await migrate(url, files);
  else if (command === 'validate') {
    await validateMigrations(url, files);
    console.log('Applied SQL migration contents match.');
  } else {
    const [history] = await queryDatabase(
      url,
      "SELECT to_regclass('public.pgmigrations') AS name",
    );
    const applied = history?.name
      ? await queryDatabase<{ name: string }>(
          url,
          'SELECT name FROM pgmigrations ORDER BY id',
        )
      : [];
    console.table(
      files.map((file) => ({
        name: file.name,
        status: applied.some((row) => `${row.name}.sql` === file.name)
          ? 'applied'
          : 'pending',
      })),
    );
  }
} else throw new Error('Unknown database command');

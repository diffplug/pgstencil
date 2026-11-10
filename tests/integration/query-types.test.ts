import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from 'vitest';
import {
  allocateDatabase,
  projectRoot,
  queryDatabase,
} from '../../packages/pgstencil/src/database.ts';
import { generateTypes } from '../../packages/pgstencil/src/codegen.ts';
import { fixtureMigrations } from '../support/fixture-app.ts';

test('regenerated types include new tables and make renamed-column queries fail compilation', async ({
  onTestFinished,
}) => {
  const lease = await allocateDatabase(fixtureMigrations);
  onTestFinished(() => lease.close());
  // A workspace package directory, so the generated file resolves kysely.
  const consumerState = join(projectRoot, 'examples/better-auth/.pgstencil');
  await mkdir(consumerState, { recursive: true });
  const directory = await mkdtemp(join(consumerState, 'types-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const definitions = join(directory, 'db.ts');
  const target = { out: definitions, include: 'public.*' };
  const query = join(directory, 'query.ts');
  await writeFile(
    query,
    "import {Kysely} from 'kysely';\nimport type {DB} from './db.ts';\ndeclare const db: Kysely<DB>;\ndb.selectFrom('users').select('email');\n",
  );
  const diagnostics = () => {
    const result = spawnSync(
      process.execPath,
      [
        join(projectRoot, 'node_modules/typescript/bin/tsc'),
        query,
        '--ignoreConfig',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--target',
        'ES2023',
        '--strict',
        '--noEmit',
        '--skipLibCheck',
        '--allowImportingTsExtensions',
        '--pretty',
        'false',
      ],
      { encoding: 'utf8' },
    );
    if (result.error) throw result.error;
    const output = result.stdout + result.stderr;
    const errors = output
      .split(/(?=^.*error TS\d+:)/m)
      .filter((diagnostic) => /error TS\d+:/.test(diagnostic));
    if (result.status !== 0 && errors.length === 0)
      throw new Error(`TypeScript exited with ${result.status}: ${output}`);
    return errors;
  };
  await generateTypes(lease.url, target);
  expect(diagnostics()).toEqual([]);
  // pgstencil's bookkeeping tables are never an application's types.
  expect(await readFile(definitions, 'utf8')).not.toMatch(
    /pgmigrations|pgstencil_migration_files/,
  );
  await queryDatabase(
    lease.url,
    'ALTER TABLE users RENAME COLUMN email TO primary_email; CREATE TABLE profiles (id text PRIMARY KEY)',
  );
  await expect(generateTypes(lease.url, target, true)).rejects.toThrow(
    'is stale; run pgstencil types',
  );
  await generateTypes(lease.url, target);
  expect(await readFile(definitions, 'utf8')).toContain('profiles: Profiles');
  await expect(generateTypes(lease.url, target, true)).resolves.toBe(false);
  const errors = diagnostics();
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain('"email"');
  await writeFile(
    query,
    (await readFile(query, 'utf8')).replace(
      "select('email')",
      "select('primary_email')",
    ),
  );
  expect(diagnostics()).toEqual([]);
});

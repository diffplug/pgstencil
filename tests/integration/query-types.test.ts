import { mkdir, mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { test, expect } from 'vitest';
import {
  allocateDatabase,
  projectRoot,
  queryDatabase,
} from '../../packages/pgstencil/src/database.ts';
import { generateTypes } from '../../scripts/generate-types.ts';

test('regenerated types include new tables and make renamed-column queries fail compilation', async ({
  onTestFinished,
}) => {
  const lease = await allocateDatabase();
  onTestFinished(() => lease.close());
  const consumerState = join(projectRoot, 'examples/login/.pgstencil');
  await mkdir(consumerState, { recursive: true });
  const directory = await mkdtemp(join(consumerState, 'types-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const definitions = join(directory, 'db.ts');
  const query = join(directory, 'query.ts');
  await writeFile(
    query,
    "import {Kysely} from 'kysely';\nimport type {DB} from './db.ts';\ndeclare const db: Kysely<DB>;\ndb.selectFrom('users').select('email');\n",
  );
  const diagnostics = () =>
    ts
      .getPreEmitDiagnostics(
        ts.createProgram([query], {
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          target: ts.ScriptTarget.ES2023,
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          allowImportingTsExtensions: true,
        }),
      )
      .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  await generateTypes(lease.url, definitions);
  expect(diagnostics()).toEqual([]);
  await queryDatabase(
    lease.url,
    'ALTER TABLE users RENAME COLUMN email TO primary_email; CREATE TABLE profiles (id text PRIMARY KEY)',
  );
  await generateTypes(lease.url, definitions);
  expect(await readFile(definitions, 'utf8')).toContain('profiles: Profiles');
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

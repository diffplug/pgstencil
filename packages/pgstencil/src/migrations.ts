import { createHash } from 'node:crypto';
import { readdir, readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
export interface MigrationFile {
  name: string;
  content: string;
  hash: string;
}
export async function readMigrations(
  directory: string,
): Promise<MigrationFile[]> {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  if (!names.length) throw new Error(`No SQL migrations in ${directory}`);
  return Promise.all(
    names.map(async (name) => {
      if (!/^\d+_[a-z0-9_]+\.sql$/.test(name))
        throw new Error(`Expected numbered SQL migration: ${name}`);
      const content = await readFile(join(directory, name), 'utf8');
      return {
        name,
        content,
        hash: createHash('sha256').update(content).digest('hex'),
      };
    }),
  );
}
export function migrationFingerprint(
  files: MigrationFile[],
  configuration = '',
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        configuration,
        files: files.map((f) => [f.name, f.hash]),
      }),
    )
    .digest('hex');
}
async function validateClient(
  client: pg.Client,
  files: MigrationFile[],
): Promise<void> {
  const exists = await client.query(
    "SELECT to_regclass('public.pgmigrations') AS history, to_regclass('public.pgstencil_migration_files') AS manifest",
  );
  if (!exists.rows[0].history) return;
  const applied = await client.query<{ name: string }>(
    'SELECT name FROM pgmigrations ORDER BY id',
  );
  if (!applied.rows.length) return;
  if (!exists.rows[0].manifest)
    throw new Error('Applied migrations have no checksum manifest');
  const manifest = await client.query<{ name: string; hash: string }>(
    'SELECT name, hash FROM pgstencil_migration_files',
  );
  for (const item of applied.rows) {
    const file = files.find((f) => f.name.replace(/\.sql$/, '') === item.name);
    const saved = manifest.rows.find((f) => f.name === file?.name);
    if (!file || saved?.hash !== file.hash)
      throw new Error(`Applied migration changed or missing: ${item.name}`);
  }
}
export async function validateMigrations(
  url: string,
  files: MigrationFile[],
): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await validateClient(client, files);
  } finally {
    await client.end();
  }
}
export async function migrate(
  url: string,
  files: MigrationFile[],
): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let temporary: string | undefined;
  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtext('pgstencil-migrations'))",
    );
    await validateClient(client, files);
    await client.query(
      'CREATE TABLE IF NOT EXISTS pgstencil_migration_files (name text PRIMARY KEY, hash text NOT NULL)',
    );
    // Persist expected bytes before executing: an interrupted runner cannot hide a later edit.
    for (const file of files)
      await client.query(
        'INSERT INTO pgstencil_migration_files VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET hash=excluded.hash',
        [file.name, file.hash],
      );
    temporary = await mkdtemp(join(tmpdir(), 'pgstencil-migrations-'));
    for (const file of files)
      await writeFile(join(temporary, file.name), file.content);
    await runner({
      dbClient: client,
      dir: temporary,
      direction: 'up',
      migrationsTable: 'pgmigrations',
      checkOrder: true,
      singleTransaction: true,
      log: () => {},
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: console.error,
      },
    });
  } finally {
    await client.end();
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

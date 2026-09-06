import { createHash } from 'node:crypto';
import { readdir, readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { withClient } from './postgres.ts';
export interface MigrationFile {
  /** Ordering is enforced within each directory; package sources evolve independently. */
  source: string;
  name: string;
  content: string;
  hash: string;
}
export async function readMigrations(
  directory: string | readonly string[],
): Promise<MigrationFile[]> {
  if (typeof directory !== 'string') {
    const files = (await Promise.all(directory.map(readMigrations)))
      .flat()
      .sort((a, b) => a.name.localeCompare(b.name));
    if (new Set(files.map((file) => file.name)).size !== files.length)
      throw new Error('Migration sources contain duplicate filenames');
    return files;
  }
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
        source: directory,
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
const APPLIED_SQL = 'SELECT name FROM pgmigrations ORDER BY id';
/** node-pg-migrate records migration names without the .sql suffix. */
const fileNameOf = (appliedName: string): string => `${appliedName}.sql`;
/** SQL migration file names already applied to this database, in order. */
export async function appliedMigrations(url: string): Promise<string[]> {
  return withClient(url, async (client) => {
    const history = await client.query(
      "SELECT to_regclass('public.pgmigrations') AS name",
    );
    if (!history.rows[0].name) return [];
    const applied = await client.query<{ name: string }>(APPLIED_SQL);
    return applied.rows.map((row) => fileNameOf(row.name));
  });
}
async function validateClient(
  client: pg.Client,
  files: MigrationFile[],
): Promise<void> {
  const exists = await client.query(
    "SELECT to_regclass('public.pgmigrations') AS history, to_regclass('public.pgstencil_migration_files') AS manifest",
  );
  if (!exists.rows[0].history) return;
  const applied = (await client.query<{ name: string }>(APPLIED_SQL)).rows.map(
    (row) => fileNameOf(row.name),
  );
  if (!applied.length) return;
  if (!exists.rows[0].manifest)
    throw new Error('Applied migrations have no checksum manifest');
  const manifest = await client.query<{ name: string; hash: string }>(
    'SELECT name, hash FROM pgstencil_migration_files',
  );
  const expected = new Map(files.map((file) => [file.name, file.hash]));
  const saved = new Map(manifest.rows.map((row) => [row.name, row.hash]));
  for (const name of applied)
    if (!expected.has(name) || saved.get(name) !== expected.get(name))
      throw new Error(`Applied migration changed or missing: ${name}`);
  // Each source must be an append-only history. A newly installed package can
  // have lower numbers than an application's already-applied migrations.
  const groups = new Map<string, MigrationFile[]>();
  for (const file of files) {
    const group = groups.get(file.source) ?? [];
    group.push(file);
    groups.set(file.source, group);
  }
  for (const group of groups.values()) {
    const names = group.map((file) => file.name);
    const history = applied.filter((name) => names.includes(name));
    if (history.some((name, index) => names[index] !== name))
      throw new Error(
        `Migration order changed within source: ${group[0]!.source}`,
      );
  }
}
export async function validateMigrations(
  url: string,
  files: MigrationFile[],
): Promise<void> {
  await withClient(url, (client) => validateClient(client, files));
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
    await client.query(
      'INSERT INTO pgstencil_migration_files SELECT * FROM unnest($1::text[],$2::text[]) ON CONFLICT (name) DO UPDATE SET hash=excluded.hash',
      [files.map((f) => f.name), files.map((f) => f.hash)],
    );
    temporary = await mkdtemp(join(tmpdir(), 'pgstencil-migrations-'));
    await Promise.all(
      files.map((file) => writeFile(join(temporary!, file.name), file.content)),
    );
    await runner({
      dbClient: client,
      dir: temporary,
      direction: 'up',
      migrationsTable: 'pgmigrations',
      // validateClient enforces order per source rather than globally.
      checkOrder: false,
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

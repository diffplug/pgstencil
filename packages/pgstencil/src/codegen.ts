import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { importPeer } from './peer.ts';
import { projectRoot } from './paths.ts';
import type { TypesTarget } from './config.ts';

/** pgstencil's own bookkeeping tables, never part of an application's types. */
const BOOKKEEPING = new Set(['pgmigrations', 'pgstencil_migration_files']);

const loadCodegen = (entry: string) =>
  importPeer('kysely-codegen', entry, () => import('kysely-codegen'));

/** Fails, naming `entry` as the command that needs it, when kysely-codegen is absent. */
export async function requireCodegen(entry: string): Promise<void> {
  await loadCodegen(entry);
}

/** Kysely declarations for one `types` target, generated from the database at `url`. */
export async function renderTypes(
  url: string,
  target: Omit<TypesTarget, 'out'>,
): Promise<string> {
  const { Cli } = await loadCodegen('pgstencil types');
  return new Cli().generate({
    url,
    dialect: 'postgres',
    logLevel: 'silent',
    // Rendered in memory; generateTypes compares and writes the file itself.
    outFile: null,
    includePattern: target.include,
    excludePattern: target.exclude ?? null,
    ...(target.defaultSchema ? { defaultSchemas: [target.defaultSchema] } : {}),
    async postprocess({ metadata }) {
      metadata.tables = metadata.tables.filter(
        (table) =>
          !(
            (table.schema ?? 'public') === 'public' &&
            BOOKKEEPING.has(table.name)
          ),
      );
      return metadata;
    },
  });
}

/**
 * Writes `target.out`, or with `verify` throws when it differs from what the
 * database at `url` generates. Returns whether the file was (or would be) changed.
 */
export async function generateTypes(
  url: string,
  target: TypesTarget,
  verify = false,
): Promise<boolean> {
  const output = await renderTypes(url, target);
  const current = await readFile(target.out, 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
  if (current === output) return false;
  const name = relative(projectRoot, target.out);
  if (verify)
    throw new Error(
      current === undefined
        ? `${name} is missing; run pgstencil types`
        : `${name} is stale; run pgstencil types`,
    );
  await mkdir(dirname(target.out), { recursive: true });
  await writeFile(target.out, output);
  return true;
}

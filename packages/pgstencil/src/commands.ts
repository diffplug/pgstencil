import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import {
  activeDatabases,
  allocateDatabase,
  appliedMigrations,
  clearTemplates,
  composeFile,
  developmentDatabase,
  developmentDatabaseName,
  ensureServices,
  migrate,
  projectConfig,
  projectName,
  projectRoot,
  queryDatabase,
  readMigrations,
  stateDirectory,
  validateMigrations,
  type DatabaseLease,
  type Services,
} from './database.ts';
import { insideNodeModules, insideRoot, withExtraSources } from './config.ts';
import { generateTypes, requireCodegen } from './codegen.ts';
import type { Command } from './arguments.ts';

const exec = promisify(execFile);
const statePath = join(stateDirectory, 'services.json');
const sources = projectConfig.migrations;
const shown = (path: string) => relative(projectRoot, path) || '.';

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

/** `fallback` when the path does not exist; any other failure surfaces. */
const absent =
  <T>(fallback: T) =>
  (error: NodeJS.ErrnoException): T => {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  };

/** Numbers of the SQL files in `directory`; an absent directory has none. */
async function numbers(directory: string): Promise<string[]> {
  const names = await readdir(directory).catch(absent<string[]>([]));
  return names.flatMap((name) => /^(\d+)_.*\.sql$/.exec(name)?.[1] ?? []);
}

async function create(label: string, directory?: string): Promise<void> {
  const target =
    directory === undefined
      ? sources[sources.length - 1]!
      : insideRoot(projectRoot, directory, '--in');
  if (insideNodeModules(projectRoot, target))
    throw new Error(
      `Refusing to write into ${shown(target)}, which is inside node_modules and belongs to an installed package; add your own migrations directory as the last source in pgstencil.json, or pass --in <dir>`,
    );
  if (!sources.includes(target))
    console.error(
      `Note: ${shown(target)} is not a migration source in pgstencil.json; add it there to apply this migration.`,
    );
  // One sequence across every source, so a filename never collides.
  const taken = (
    await Promise.all([...new Set([...sources, target])].map(numbers))
  ).flat();
  const next = String(
    Math.max(0, ...taken.map((number) => Number(number))) + 1,
  ).padStart(Math.max(3, ...taken.map((number) => number.length)), '0');
  await mkdir(target, { recursive: true });
  const path = join(target, `${next}_${label}.sql`);
  await writeFile(path, '-- Up Migration\n\n-- Down Migration\n', {
    flag: 'wx',
  });
  console.log(path);
}

async function dumpSchema(lease: DatabaseLease): Promise<string> {
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
    { maxBuffer: 16_000_000 },
  );
  return result.stdout.replace(/^-- Dumped .*\n/gm, '');
}

/** Writes or verifies the schema dump; returns a problem instead of throwing under `verify`. */
async function schema(
  lease: DatabaseLease,
  file: string,
  verify: boolean,
): Promise<string | undefined> {
  const dump = await dumpSchema(lease);
  const current = await readFile(file, 'utf8').catch(absent(undefined));
  if (current === dump) {
    console.log(`${shown(file)} is up to date`);
    return undefined;
  }
  if (verify)
    return `${shown(file)} is ${current === undefined ? 'missing' : 'stale'}; run pgstencil schema`;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, dump);
  console.log(`Wrote ${shown(file)}`);
  return undefined;
}

async function types(lease: DatabaseLease, verify: boolean): Promise<string[]> {
  const problems: string[] = [];
  for (const target of projectConfig.types) {
    try {
      const changed = await generateTypes(lease.url, target, verify);
      console.log(
        changed
          ? `Wrote ${shown(target.out)}`
          : `${shown(target.out)} is up to date`,
      );
    } catch (error) {
      if (!verify) throw error;
      problems.push((error as Error).message);
    }
  }
  return problems;
}

/** schema, types and verify: each generator against one disposable database. */
async function generate(
  command: 'schema' | 'types' | 'verify',
  verify: boolean,
): Promise<void> {
  const file = projectConfig.schema;
  const wantSchema = command !== 'types';
  const wantTypes = command !== 'schema';
  if (command === 'schema' && file === undefined)
    throw new Error('pgstencil.json has no "schema" path to write the dump to');
  if (command === 'types' && projectConfig.types.length === 0)
    throw new Error('pgstencil.json has no "types" entries to generate');
  if (
    command === 'verify' &&
    file === undefined &&
    projectConfig.types.length === 0
  )
    throw new Error(
      'pgstencil.json has neither a "schema" path nor "types" entries to verify',
    );
  // Fail on a missing peer before building a database.
  if (wantTypes && projectConfig.types.length)
    await requireCodegen(`pgstencil ${command}`);
  const lease = await allocateDatabase(sources);
  const problems: string[] = [];
  try {
    if (wantSchema && file !== undefined) {
      const problem = await schema(lease, file, verify);
      if (problem) problems.push(problem);
    }
    if (wantTypes) problems.push(...(await types(lease, verify)));
  } finally {
    await lease.close();
  }
  if (problems.length) throw new Error(problems.join('\n'));
}

/** DATABASE_URL, or undefined when it is unset or empty. */
const databaseUrl = () => process.env.DATABASE_URL || undefined;

async function inspect(
  command: 'status' | 'validate' | 'migrate',
  also: readonly string[],
  requireDatabaseUrl: boolean,
) {
  const directories = withExtraSources(projectRoot, sources, also);
  // Set but empty is how a workflow sees a secret it lost. Falling back to the
  // development database there would migrate a throwaway and report success.
  if (process.env.DATABASE_URL === '')
    throw new Error(
      'DATABASE_URL is set but empty, which usually means a missing secret; unset it to use the development database',
    );
  if (requireDatabaseUrl && !databaseUrl())
    throw new Error(
      'DATABASE_URL is unset, and --require-database-url refuses to fall back to the development database',
    );
  const url = databaseUrl() ?? (await developmentDatabase(false));
  const files = await readMigrations(directories);
  if (command === 'validate') {
    await validateMigrations(url, files);
    console.log('Applied SQL migration contents match.');
    return;
  }
  const applied = new Set(await appliedMigrations(url));
  if (command === 'status') {
    console.table(
      files.map((file) => ({
        name: file.name,
        source: shown(file.source),
        status: applied.has(file.name) ? 'applied' : 'pending',
      })),
    );
    return;
  }
  await migrate(url, files);
  const pending = files.filter((file) => !applied.has(file.name));
  console.log(
    pending.length
      ? `Applied ${pending.map((file) => file.name).join(', ')}`
      : 'No pending migrations.',
  );
}

/** Runs one parsed command; failures throw. */
export async function runCommand(command: Command): Promise<void> {
  switch (command.name) {
    case 'help':
      return;
    case 'create':
      return create(command.label, command.in);
    case 'schema':
    case 'types':
      return generate(command.name, command.verify);
    case 'verify':
      return generate('verify', true);
    case 'status':
    case 'validate':
    case 'migrate':
      return inspect(
        command.name,
        command.also ?? [],
        command.requireDatabaseUrl ?? false,
      );
    case 'stop': {
      // Read the recorded stack rather than starting one just to shut it down.
      const state: Services | undefined = await readFile(statePath, 'utf8')
        .then((text) => JSON.parse(text) as Services)
        .catch(() => undefined);
      if (state) await requireIdle(state, true);
      await exec(
        'docker',
        ['compose', '-p', projectName, '-f', composeFile, 'down'],
        { cwd: projectRoot },
      );
      await rm(statePath, { force: true });
      return;
    }
    case 'gc':
    case 'reset': {
      if (command.name === 'reset' && databaseUrl())
        throw new Error(
          `DATABASE_URL is set, but reset only ever recreates the development database (${developmentDatabaseName}) and never the database DATABASE_URL names; unset DATABASE_URL to reset the development database`,
        );
      const services = await ensureServices();
      await requireIdle(services);
      if (command.name === 'gc') return clearTemplates(services);
      await queryDatabase(
        services.postgresUrl,
        `DROP DATABASE IF EXISTS ${developmentDatabaseName}`,
      );
      await developmentDatabase(true, sources);
      return;
    }
  }
}

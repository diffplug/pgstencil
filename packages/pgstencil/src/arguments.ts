/** An environment file named by `--env-file` or `--env-file-if-exists`. */
export interface EnvFile {
  path: string;
  /** From `--env-file-if-exists`: a missing file is skipped. */
  optional: boolean;
}

/** The `pgstencil` command line, parsed without touching configuration or Docker. */
export type Command = (
  | {
      name: 'status' | 'validate' | 'migrate';
      /** `--also` directories, as given, in order. */
      also?: string[];
      requireDatabaseUrl?: true;
    }
  | { name: 'verify' | 'reset' | 'gc' | 'stop' }
  | { name: 'create'; label: string; in?: string }
  | { name: 'schema' | 'types'; verify: boolean }
  | { name: 'help' }
) & {
  /** Global `--env-file` and `--env-file-if-exists` options, in order. */
  envFiles?: EnvFile[];
};

export const usage = `Usage: pgstencil <command> [options]

Commands:
  status                      List applied and pending migrations
  validate                    Check applied migrations still match their SQL files
  migrate                     Apply pending migrations
  create <name> [--in <dir>]  Add an empty numbered migration to <dir>, by default
                              the last configured source; never inside node_modules
  schema [--verify]           Write, or verify, the schema dump
  types [--verify]            Write, or verify, the Kysely declarations
  verify                      Verify the schema dump and declarations together
  reset                       Recreate the development database
  gc                          Clear cached test templates when no database is in use
  stop                        Stop this project's services when no database is in use
  help                        Show this message

Options for status, validate and migrate:
  --also <dir>                Read <dir> as one more migration source, after the
                              configured ones, for this run only; repeatable
  --require-database-url      Fail when DATABASE_URL is unset instead of using the
                              development database

Options for every command:
  --env-file <path>           Load environment variables from <path> before reading
                              configuration; variables already set win, and a later
                              file wins over an earlier one; repeatable
  --env-file-if-exists <path> The same, skipping a file that does not exist

status, validate and migrate use DATABASE_URL when it is set, otherwise the
development database; a DATABASE_URL that is set but empty is refused, since it
usually means a missing secret. reset only ever recreates the development
database, so it refuses to run while DATABASE_URL is set. schema, types and
verify use a disposable database built from the configured migrations.
Configuration is read from pgstencil.json in PGSTENCIL_PROJECT_ROOT, or the
current directory.`;

/**
 * Loads `--env-file` and `--env-file-if-exists` files with Node's precedence:
 * the environment wins over every file, and a later file over an earlier one.
 * `process.loadEnvFile` never overwrites a variable, so load the last first.
 * Node itself also checks these flags after a script name: it exits on a
 * missing `--env-file` before pgstencil runs, but never loads the file.
 */
export function loadEnvFiles(files: readonly EnvFile[]): void {
  for (const file of [...files].reverse()) {
    try {
      process.loadEnvFile(file.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!file.optional)
        throw new Error(`--env-file ${file.path} does not exist`, {
          cause: error,
        });
    }
  }
}

/** A command line pgstencil cannot run; the CLI prints it with the usage text. */
export class UsageError extends Error {
  override name = 'UsageError';
}

const INSPECT = new Set(['status', 'validate', 'migrate']);
const PLAIN = new Set(['verify', 'reset', 'gc', 'stop']);
const LABEL = /^[a-z][a-z0-9_]*$/;

function noArguments(name: string, rest: readonly string[]): void {
  if (rest.length)
    throw new UsageError(
      `${name} takes no arguments, got ${rest.map((arg) => JSON.stringify(arg)).join(' ')}`,
    );
}

/**
 * Reads `--<option> <value>` or `--<option>=<value>` at `argv[index]`; returns
 * the value and the index of its last argument, or undefined for another argument.
 */
function valueOption(
  argv: readonly string[],
  index: number,
  option: string,
  what: string,
): [string, number] | undefined {
  const arg = argv[index]!;
  if (arg !== option && !arg.startsWith(option + '=')) return undefined;
  const value = arg === option ? argv[++index] : arg.slice(option.length + 1);
  if (!value || value.startsWith('-'))
    throw new UsageError(`${option} needs ${what}`);
  return [value, index];
}

/** Parse `argv` (without the node and script paths) into a command. */
export function parseArguments(argv: readonly string[]): Command {
  // Global options may appear anywhere on the command line.
  const envFiles: EnvFile[] = [];
  const remaining: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    let found: [string, number] | undefined;
    for (const option of ['--env-file', '--env-file-if-exists'])
      if ((found = valueOption(argv, index, option, 'a path'))) {
        envFiles.push({
          path: found[0],
          optional: option === '--env-file-if-exists',
        });
        index = found[1];
        break;
      }
    if (!found) remaining.push(argv[index]!);
  }
  const command = parseCommand(remaining);
  return envFiles.length ? { ...command, envFiles } : command;
}

function parseCommand(argv: readonly string[]): Command {
  const [name, ...rest] = argv;
  if (name === undefined) throw new UsageError('Missing command');
  if (name === 'help' || name === '--help' || name === '-h') {
    noArguments(name, rest);
    return { name: 'help' };
  }
  if (PLAIN.has(name)) {
    noArguments(name, rest);
    return { name: name as 'verify' };
  }
  if (INSPECT.has(name)) {
    const also: string[] = [];
    let requireDatabaseUrl = false;
    for (let index = 0; index < rest.length; index++) {
      const found = valueOption(rest, index, '--also', 'a directory');
      if (found) {
        also.push(found[0]);
        index = found[1];
      } else if (rest[index] === '--require-database-url') {
        if (requireDatabaseUrl)
          throw new UsageError('--require-database-url given twice');
        requireDatabaseUrl = true;
      } else
        throw new UsageError(
          `${name} accepts only --also <dir> and --require-database-url, got ${JSON.stringify(rest[index])}`,
        );
    }
    return {
      name: name as 'status',
      ...(also.length ? { also } : {}),
      ...(requireDatabaseUrl ? { requireDatabaseUrl: true } : {}),
    };
  }
  if (name === 'schema' || name === 'types') {
    const flags = new Set(rest);
    const unknown = rest.filter((arg) => arg !== '--verify');
    if (unknown.length || flags.size !== rest.length)
      throw new UsageError(
        `${name} accepts only --verify, got ${rest.map((arg) => JSON.stringify(arg)).join(' ')}`,
      );
    return { name, verify: flags.has('--verify') };
  }
  if (name === 'create') {
    let label: string | undefined;
    let directory: string | undefined;
    for (let index = 0; index < rest.length; index++) {
      const arg = rest[index]!;
      if (arg === '--in' || arg.startsWith('--in=')) {
        if (directory !== undefined) throw new UsageError('--in given twice');
        directory = arg === '--in' ? rest[++index] : arg.slice('--in='.length);
        if (!directory || directory.startsWith('-'))
          throw new UsageError('--in needs a directory');
      } else if (arg.startsWith('-'))
        throw new UsageError(`create does not accept ${arg}`);
      else if (label !== undefined)
        throw new UsageError(`create takes one name, got ${label} and ${arg}`);
      else label = arg;
    }
    if (label === undefined)
      throw new UsageError('create needs a snake_case migration name');
    if (!LABEL.test(label))
      throw new UsageError(
        `Migration names are snake_case (a lowercase letter, then lowercase letters, digits or _): ${label}`,
      );
    return directory === undefined
      ? { name, label }
      : { name, label, in: directory };
  }
  throw new UsageError(`Unknown command: ${name}`);
}

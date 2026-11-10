/** The `pgstencil` command line, parsed without touching configuration or Docker. */
export type Command =
  | {
      name:
        'status' | 'validate' | 'migrate' | 'verify' | 'reset' | 'gc' | 'stop';
    }
  | { name: 'create'; label: string; in?: string }
  | { name: 'schema' | 'types'; verify: boolean }
  | { name: 'help' };

export const usage = `Usage: pgstencil <command> [options]

Commands:
  status                      List applied and pending migrations
  validate                    Check applied migrations still match their SQL files
  migrate                     Apply pending migrations
  create <name> [--in <dir>]  Add an empty numbered migration to <dir>, by default
                              the last configured source
  schema [--verify]           Write, or verify, the schema dump
  types [--verify]            Write, or verify, the Kysely declarations
  verify                      Verify the schema dump and declarations together
  reset                       Recreate the development database
  gc                          Clear cached test templates when no database is in use
  stop                        Stop this project's services when no database is in use
  help                        Show this message

status, validate and migrate use DATABASE_URL when it is set, otherwise the
development database. schema, types and verify use a disposable database built
from the configured migrations. Configuration is read from pgstencil.json in
PGSTENCIL_PROJECT_ROOT, or the current directory.`;

/** A command line pgstencil cannot run; the CLI prints it with the usage text. */
export class UsageError extends Error {
  override name = 'UsageError';
}

const PLAIN = new Set([
  'status',
  'validate',
  'migrate',
  'verify',
  'reset',
  'gc',
  'stop',
]);
const LABEL = /^[a-z][a-z0-9_]*$/;

function noArguments(name: string, rest: readonly string[]): void {
  if (rest.length)
    throw new UsageError(
      `${name} takes no arguments, got ${rest.map((arg) => JSON.stringify(arg)).join(' ')}`,
    );
}

/** Parse `argv` (without the node and script paths) into a command. */
export function parseArguments(argv: readonly string[]): Command {
  const [name, ...rest] = argv;
  if (name === undefined) throw new UsageError('Missing command');
  if (name === 'help' || name === '--help' || name === '-h') {
    noArguments(name, rest);
    return { name: 'help' };
  }
  if (PLAIN.has(name)) {
    noArguments(name, rest);
    return { name: name as 'status' };
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

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The configuration file's name, read from the project root. */
export const configFileName = 'pgstencil.json';

/** One `types` entry of `pgstencil.json`, with `out` resolved to an absolute path. */
export interface TypesTarget {
  /** Absolute path of the generated declarations file. */
  out: string;
  /** kysely-codegen `--include-pattern`; `public.*` when omitted. */
  include: string;
  /** kysely-codegen `--exclude-pattern`, if any. pgstencil's own tables are always left out. */
  exclude?: string;
  /** kysely-codegen `--default-schema`: tables in it are named without a schema prefix. */
  defaultSchema?: string;
}

/** `pgstencil.json`, validated and resolved against the project root. */
export interface ProjectConfig {
  /** Absolute migration source directories, in configured order. */
  migrations: readonly string[];
  /** Absolute path of the schema dump, if configured. */
  schema?: string;
  types: readonly TypesTarget[];
}

const TOP_LEVEL = ['migrations', 'schema', 'types'] as const;
const TYPES_KEYS = ['out', 'include', 'exclude', 'defaultSchema'] as const;

/**
 * Resolve `configured` against `root`, refusing a path that leaves it
 * lexically. `what` names the setting in the error, e.g. `pgstencil.json schema`.
 */
export function insideRoot(
  root: string,
  configured: string,
  what: string,
): string {
  const path = resolve(root, configured);
  const fromRoot = relative(root, path);
  if (
    fromRoot === '..' ||
    fromRoot.startsWith('..' + sep) ||
    isAbsolute(fromRoot)
  )
    throw new Error(`${what} must stay inside the project root: ${configured}`);
  return path;
}

/**
 * `configured` followed by each `--also` directory, resolved against `root`
 * under the same inside-the-project-root rule; a directory that is already a
 * source is refused rather than read twice.
 */
export function withExtraSources(
  root: string,
  configured: readonly string[],
  also: readonly string[],
): readonly string[] {
  const sources = [...configured];
  for (const directory of also) {
    const path = insideRoot(root, directory, '--also');
    if (sources.includes(path))
      throw new Error(`--also ${directory} is already a migration source`);
    sources.push(path);
  }
  return sources;
}

/** True when `path`, relative to `root`, passes through a `node_modules` directory. */
export function insideNodeModules(root: string, path: string): boolean {
  return relative(root, path).split(sep).includes('node_modules');
}

const describe = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value;

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(
      `${configFileName} ${field} must be a non-empty string, not ${describe(value)}`,
    );
  return value;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(
      `${configFileName} ${field} must be an object, not ${describe(value)}`,
    );
  return value as Record<string, unknown>;
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length)
    throw new Error(
      `${configFileName} ${field} has unknown ${unknown.length === 1 ? 'key' : 'keys'} ${unknown.map((key) => JSON.stringify(key)).join(', ')}; expected ${allowed.join(', ')}`,
    );
}

function unique(paths: readonly string[], root: string, field: string): void {
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path))
      throw new Error(
        `${configFileName} ${field} lists ${relative(root, path)} more than once`,
      );
    seen.add(path);
  }
}

/** Validate a parsed `pgstencil.json` and resolve its paths against `root`. */
export function parseConfig(root: string, value: unknown): ProjectConfig {
  const config = object(value, 'top level');
  onlyKeys(config, TOP_LEVEL, 'top level');
  const sources =
    config.migrations === undefined ? ['migrations'] : config.migrations;
  const list = typeof sources === 'string' ? [sources] : sources;
  if (!Array.isArray(list) || list.length === 0)
    throw new Error(
      `${configFileName} migrations must be a directory or a non-empty list of directories, not ${Array.isArray(list) ? 'an empty list' : describe(list)}`,
    );
  const migrations = list.map((entry: unknown, index) => {
    const field =
      typeof sources === 'string' ? 'migrations' : `migrations[${index}]`;
    return insideRoot(root, text(entry, field), `${configFileName} ${field}`);
  });
  unique(migrations, root, 'migrations');
  const types = config.types === undefined ? [] : config.types;
  if (!Array.isArray(types))
    throw new Error(
      `${configFileName} types must be a list of { out, include?, exclude?, defaultSchema? }, not ${describe(types)}`,
    );
  const targets = types.map((entry: unknown, index): TypesTarget => {
    const field = `types[${index}]`;
    const target = object(entry, field);
    onlyKeys(target, TYPES_KEYS, field);
    if (target.out === undefined)
      throw new Error(`${configFileName} ${field} needs an "out" path`);
    const resolved: TypesTarget = {
      out: insideRoot(
        root,
        text(target.out, `${field}.out`),
        `${configFileName} ${field}.out`,
      ),
      include:
        target.include === undefined
          ? 'public.*'
          : text(target.include, `${field}.include`),
    };
    if (target.exclude !== undefined)
      resolved.exclude = text(target.exclude, `${field}.exclude`);
    if (target.defaultSchema !== undefined)
      resolved.defaultSchema = text(
        target.defaultSchema,
        `${field}.defaultSchema`,
      );
    return resolved;
  });
  unique(
    targets.map((target) => target.out),
    root,
    'types',
  );
  const parsed: ProjectConfig = {
    migrations: Object.freeze(migrations),
    types: Object.freeze(targets),
  };
  if (config.schema !== undefined)
    parsed.schema = insideRoot(
      root,
      text(config.schema, 'schema'),
      `${configFileName} schema`,
    );
  return parsed;
}

/** Read `pgstencil.json` from `root`; an absent file means every default. */
export function readConfig(root: string): ProjectConfig {
  const file = join(root, configFileName);
  if (!existsSync(file)) return parseConfig(root, {});
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`, {
      cause: error,
    });
  }
  return parseConfig(root, value);
}

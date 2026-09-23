import { createHash } from 'node:crypto';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
/** Workspace paths, kept free of heavy imports so light scripts can use them. */
export const projectRoot = resolve(
  process.env.PGSTENCIL_PROJECT_ROOT ?? process.cwd(),
);
const configFile = join(projectRoot, 'pgstencil.json');
const config = existsSync(configFile)
  ? (JSON.parse(readFileSync(configFile, 'utf8')) as { migrations?: string })
  : {};
/** Resolve a configured migrations directory, refusing one outside the project root. */
export function migrationsDirectory(root: string, configured: string) {
  const directory = resolve(root, configured);
  const path = relative(root, directory);
  if (path === '..' || path.startsWith('..' + sep) || isAbsolute(path))
    throw new Error(
      `pgstencil.json migrations must stay inside the project root: ${configured}`,
    );
  return directory;
}
export const defaultMigrations = migrationsDirectory(
  projectRoot,
  config.migrations ?? 'migrations',
);
export const stateDirectory = join(projectRoot, '.pgstencil');
export const composeFile = existsSync(join(projectRoot, 'compose.yaml'))
  ? join(projectRoot, 'compose.yaml')
  : fileURLToPath(new URL('./compose.yaml', import.meta.url));
export const projectName = `pgstencil-${createHash('sha256').update(projectRoot).digest('hex').slice(0, 12)}`;

import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configFileName, insideRoot, readConfig } from './config.ts';
export {
  configFileName,
  parseConfig,
  readConfig,
  type ProjectConfig,
  type TypesTarget,
} from './config.ts';
/** Workspace paths, kept free of heavy imports so light scripts can use them. */
export const projectRoot = resolve(
  process.env.PGSTENCIL_PROJECT_ROOT ?? process.cwd(),
);
/** Resolve a configured migrations directory, refusing one outside the project root. */
export function migrationsDirectory(root: string, configured: string) {
  return insideRoot(root, configured, `${configFileName} migrations`);
}
/** The project's `pgstencil.json`, or every default when it has none. */
export const projectConfig = readConfig(projectRoot);
/** The configured migration sources, in order; `["migrations"]` by default. */
export const defaultMigrations: readonly string[] = projectConfig.migrations;
export const stateDirectory = join(projectRoot, '.pgstencil');
export const composeFile = existsSync(join(projectRoot, 'compose.yaml'))
  ? join(projectRoot, 'compose.yaml')
  : fileURLToPath(new URL('./compose.yaml', import.meta.url));
export const projectName = `pgstencil-${createHash('sha256').update(projectRoot).digest('hex').slice(0, 12)}`;

import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
/** Workspace paths, kept free of heavy imports so light scripts can use them. */
export const projectRoot = resolve(import.meta.dirname, '../../..');
export const stateDirectory = join(projectRoot, '.pgstencil');
export const composeFile = join(projectRoot, 'compose.yaml');
export const projectName = `pgstencil-${createHash('sha256').update(projectRoot).digest('hex').slice(0, 12)}`;

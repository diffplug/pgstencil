import { execFileSync } from 'node:child_process';
import { projectRoot } from '../packages/pgstencil/src/paths.ts';

// One process so `pnpm packages:pack -- --allow-dirty` reaches the build's argv;
// pnpm appends script arguments to the end of a compound shell command instead.
await import('./build-packages.ts');
execFileSync(
  'pnpm',
  [
    '--filter',
    'pgstencil',
    '--filter',
    '@pgstencil/auth',
    '--filter',
    '@pgstencil/stripe',
    '-r',
    'pack',
    '--pack-destination',
    'dist/packages',
  ],
  { cwd: projectRoot, stdio: 'inherit' },
);

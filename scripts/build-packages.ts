import { execFileSync } from 'node:child_process';
import { cp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRoot } from '../packages/pgstencil/src/paths.ts';

await rm(join(projectRoot, '.build'), { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    join(projectRoot, 'node_modules/typescript/bin/tsc'),
    '-p',
    'tsconfig.build.json',
  ],
  { cwd: projectRoot, stdio: 'inherit' },
);
for (const name of ['pgstencil', 'auth', 'stripe']) {
  const destination = join(projectRoot, 'packages', name, 'dist');
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(
    join(projectRoot, 'LICENSE'),
    join(projectRoot, 'packages', name, 'LICENSE'),
  );
  await cp(join(projectRoot, '.build', name, 'src'), destination, {
    recursive: true,
  });
}
await cp(
  join(projectRoot, 'compose.yaml'),
  join(projectRoot, 'packages/pgstencil/dist/compose.yaml'),
);

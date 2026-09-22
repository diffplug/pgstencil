import { execFileSync } from 'node:child_process';
import { cp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRoot } from '../packages/pgstencil/src/paths.ts';

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' }).trim();
// Only the inputs that reach a tarball; an untracked editor file elsewhere is not dirt.
const buildInputs = [
  'packages',
  'scripts',
  'tsconfig.json',
  'tsconfig.build.json',
  'pnpm-lock.yaml',
  'compose.yaml',
  'LICENSE',
  'package.json',
];
const allowDirty = process.argv.includes('--allow-dirty');
const dirty = git('status', '--porcelain', '--', ...buildInputs);
if (dirty && !allowDirty)
  throw new Error(
    `Refusing to build packages from a modified tree; commit, stash or pass --allow-dirty:\n${dirty}`,
  );
const commit = git('rev-parse', 'HEAD');
if (!/^[0-9a-f]{40}$/.test(commit))
  throw new Error(`Expected a 40-character commit, got ${commit}`);
// No timestamp: the archive stays byte-identical for one commit.
const provenance =
  JSON.stringify({ commit, ...(dirty ? { dirty: true } : {}) }, null, 2) + '\n';

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
  await writeFile(join(destination, 'provenance.json'), provenance);
}
await cp(
  join(projectRoot, 'compose.yaml'),
  join(projectRoot, 'packages/pgstencil/dist/compose.yaml'),
);

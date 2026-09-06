import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { withProcessLock } from '../packages/pgstencil/src/lock.ts';
import {
  projectRoot,
  stateDirectory,
} from '../packages/pgstencil/src/paths.ts';
await withProcessLock(
  join(stateDirectory, 'snapshot-update.lock'),
  async () => {
    const child = spawn(
      process.execPath,
      [
        join(projectRoot, 'node_modules/vitest/vitest.mjs'),
        'run',
        ...process.argv.slice(2),
      ],
      {
        cwd: projectRoot,
        stdio: 'inherit',
        env: { ...process.env, PGSTENCIL_UPDATE: '1' },
      },
    );
    const [code] = await once(child, 'exit');
    process.exitCode = typeof code === 'number' ? code : 1;
  },
);

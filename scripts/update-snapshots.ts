import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { withProcessLock } from '../packages/pgstencil/src/lock.ts';
const root = join(import.meta.dirname, '..');
await withProcessLock(
  join(root, '.pgstencil', 'snapshot-update.lock'),
  async () => {
    const child = spawn(
      process.execPath,
      [
        join(root, 'node_modules/vitest/vitest.mjs'),
        'run',
        ...process.argv.slice(2),
      ],
      {
        cwd: root,
        stdio: 'inherit',
        env: { ...process.env, PGSTENCIL_UPDATE: '1' },
      },
    );
    const [code] = await once(child, 'exit');
    process.exitCode = typeof code === 'number' ? code : 1;
  },
);

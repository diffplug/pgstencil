import { open, readFile, rm, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
export async function withProcessLock<T>(
  path: string,
  action: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + 180_000;
  while (true) {
    try {
      const file = await open(path, 'wx', 0o600);
      await file.writeFile(String(process.pid));
      await file.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = Number(await readFile(path, 'utf8').catch(() => ''));
      if (owner > 0) {
        try {
          process.kill(owner, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
            await rm(path, { force: true });
            continue;
          }
        }
      }
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for ${path}`);
      await delay(100);
    }
  }
  try {
    return await action();
  } finally {
    await rm(path, { force: true });
  }
}

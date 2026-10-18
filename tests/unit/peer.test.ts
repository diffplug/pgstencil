import { test, expect } from 'vitest';
import { importPeer } from '../../packages/pgstencil/src/peer.ts';

test('A missing optional peer names itself and the entry point that needs it', async () => {
  const name = 'pgstencil-absent-peer';
  await expect(
    importPeer(name, 'pgstencil/database', () => import(name)),
  ).rejects.toThrow(
    'pgstencil/database needs the optional peer dependency "pgstencil-absent-peer". Add it to your project, for example: pnpm add -D pgstencil-absent-peer',
  );
});

test('A peer that is installed but cannot load its own dependency keeps the original error', async () => {
  const broken = Object.assign(
    new Error(
      "Cannot find package 'docker-modem' imported from testcontainers",
    ),
    { code: 'ERR_MODULE_NOT_FOUND' },
  );
  await expect(
    importPeer('testcontainers', 'pgstencil/database', () =>
      Promise.reject(broken),
    ),
  ).rejects.toBe(broken);
});

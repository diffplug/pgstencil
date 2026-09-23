import { test, expect } from 'vitest';
import { join, resolve } from 'node:path';
import { migrationsDirectory } from '../../packages/pgstencil/src/paths.ts';

test('pgstencil.json migrations path must stay inside the project root', () => {
  const root = resolve('/work/app');
  expect(migrationsDirectory(root, 'migrations')).toBe(
    join(root, 'migrations'),
  );
  expect(migrationsDirectory(root, 'packages/auth/migrations')).toBe(
    join(root, 'packages/auth/migrations'),
  );
  expect(migrationsDirectory(root, './db/../sql')).toBe(join(root, 'sql'));
  expect(migrationsDirectory(root, '..migrations')).toBe(
    join(root, '..migrations'),
  );
  for (const escape of [
    '..',
    '../elsewhere',
    '../../etc',
    'migrations/../../app-sibling',
    resolve('/tmp/migrations'),
  ])
    expect(() => migrationsDirectory(root, escape), escape).toThrow(
      'inside the project root',
    );
});

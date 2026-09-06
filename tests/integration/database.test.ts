import { test, expect } from 'vitest';
import {
  allocateDatabase,
  queryDatabase,
  readMigrations,
  defaultMigrations,
  validateMigrations,
  migrate,
  prepareTemplate,
} from '../../packages/pgstencil/src/database.ts';
test('warm templates produce isolated writable databases', async () => {
  const a = await allocateDatabase();
  const b = await allocateDatabase();
  try {
    expect(a.name).not.toBe(b.name);
    expect(a.hash).toBe(b.hash);
    await queryDatabase(
      a.url,
      "INSERT INTO users VALUES ('a','alice@example.test','2020-01-01')",
    );
    expect(await queryDatabase(b.url, 'SELECT * FROM users')).toEqual([]);
    expect((await prepareTemplate()).hash).toBe(a.hash);
    const files = await readMigrations(defaultMigrations);
    await validateMigrations(a.url, files);
    const changed = files.map((f) => ({ ...f, hash: 'changed' }));
    await expect(validateMigrations(a.url, changed)).rejects.toThrow(
      'changed or missing',
    );
    await migrate(a.url, files);
    expect(await queryDatabase(a.url, 'SELECT email FROM users')).toEqual([
      { email: 'alice@example.test' },
    ]);
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});

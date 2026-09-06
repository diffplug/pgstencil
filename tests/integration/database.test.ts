import { test, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('SQL upgrades preserve data and failed template initialization is recoverable', async ({
  onTestFinished,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'pgstencil-upgrade-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, '001_auth.sql'),
    await readFile(join(defaultMigrations, '001_auth.sql')),
  );
  const existing = await allocateDatabase(directory);
  onTestFinished(() => existing.close());
  await queryDatabase(
    existing.url,
    "INSERT INTO users VALUES ('existing','returning@example.test','2020-01-01')",
  );
  await writeFile(
    join(directory, '002_display_name.sql'),
    '-- Up Migration\nALTER TABLE users ADD COLUMN display_name text;\n-- Down Migration\nALTER TABLE users DROP COLUMN display_name;\n',
  );
  const upgraded = await prepareTemplate(directory);
  expect(upgraded.hash).not.toBe(existing.hash);
  await migrate(existing.url, await readMigrations(directory));
  expect(
    await queryDatabase(existing.url, 'SELECT email, display_name FROM users'),
  ).toEqual([{ email: 'returning@example.test', display_name: null }]);
  await writeFile(
    join(directory, '003_failure.sql'),
    '-- Up Migration\nCREATE TABLE should_rollback (id int);\nSELECT 1/0;\n-- Down Migration\nDROP TABLE should_rollback;\n',
  );
  const broken = await readMigrations(directory);
  await expect(migrate(existing.url, broken)).rejects.toThrow(
    'division by zero',
  );
  expect(
    await queryDatabase(
      existing.url,
      "SELECT to_regclass('should_rollback') AS name",
    ),
  ).toEqual([{ name: null }]);
  await expect(prepareTemplate(directory)).rejects.toThrow('division by zero');
  await writeFile(
    join(directory, '003_failure.sql'),
    '-- Up Migration\nCREATE TABLE should_rollback (id int);\n-- Down Migration\nDROP TABLE should_rollback;\n',
  );
  const recovered = await allocateDatabase(directory);
  onTestFinished(() => recovered.close());
  expect(
    await queryDatabase(recovered.url, 'SELECT * FROM should_rollback'),
  ).toEqual([]);
  await migrate(existing.url, await readMigrations(directory));
  expect(await queryDatabase(existing.url, 'SELECT email FROM users')).toEqual([
    { email: 'returning@example.test' },
  ]);
});

test('OAuth migration preserves existing email accounts and sessions', async ({
  onTestFinished,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'pgstencil-oauth-upgrade-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, '001_auth.sql'),
    await readFile(join(defaultMigrations, '001_auth.sql')),
  );
  const database = await allocateDatabase(directory);
  onTestFinished(() => database.close());
  await queryDatabase(
    database.url,
    "INSERT INTO users VALUES ('existing', 'returning@example.test', '2020-01-01')",
  );
  await queryDatabase(
    database.url,
    "INSERT INTO sessions VALUES ('existing-token-hash', 'existing', 'csrf-hash', '2020-01-01', '2020-01-02', NULL)",
  );
  const before = await queryDatabase(
    database.url,
    'SELECT * FROM sessions JOIN users ON users.id = sessions.user_id',
  );
  await migrate(database.url, await readMigrations(defaultMigrations));
  expect(
    await queryDatabase(
      database.url,
      'SELECT * FROM sessions JOIN users ON users.id = sessions.user_id',
    ),
  ).toEqual(before);
  expect(
    await queryDatabase(database.url, 'SELECT * FROM oauth_identities'),
  ).toEqual([]);
  expect(
    await queryDatabase(database.url, 'SELECT * FROM oauth_flows'),
  ).toEqual([]);
});

import { test, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allocateDatabase,
  queryDatabase,
  readMigrations,
  validateMigrations,
  migrate,
  prepareTemplate,
} from '../../packages/pgstencil/src/database.ts';
import { fixtureMigrations } from '../support/fixture-app.ts';

test('shared SQL sources upgrade independently while each history stays append-only', async ({
  onTestFinished,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'pgstencil-sources-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const shared = join(directory, 'package');
  const application = join(directory, 'application');
  await cp(fixtureMigrations, shared, { recursive: true });
  await mkdir(application);
  await writeFile(
    join(application, '100_domain.sql'),
    '-- Up Migration\nCREATE TABLE profiles (user_id text PRIMARY KEY REFERENCES users(id), label text);\n-- Down Migration\nDROP TABLE profiles;',
  );
  const sources = [shared, application];
  const lease = await allocateDatabase(sources);
  onTestFinished(() => lease.close());
  await queryDatabase(
    lease.url,
    "INSERT INTO users VALUES ('u', 'upgrade@example.test', '2020-01-01'); INSERT INTO profiles VALUES ('u', 'preserved')",
  );
  const next =
    Math.max(
      ...(await readMigrations(shared)).map((file) =>
        Number(file.name.split('_')[0]),
      ),
    ) + 1;
  await writeFile(
    join(shared, `${String(next).padStart(3, '0')}_package_display.sql`),
    '-- Up Migration\nALTER TABLE users ADD COLUMN display_name text;\n-- Down Migration\nALTER TABLE users DROP COLUMN display_name;',
  );
  await migrate(lease.url, await readMigrations(sources));
  expect(
    await queryDatabase(
      lease.url,
      'SELECT label, display_name FROM profiles JOIN users ON users.id=profiles.user_id',
    ),
  ).toEqual([{ label: 'preserved', display_name: null }]);
  await writeFile(
    join(application, '099_backfill.sql'),
    '-- Up Migration\nSELECT 1;\n-- Down Migration\nSELECT 1;',
  );
  await expect(
    migrate(lease.url, await readMigrations(sources)),
  ).rejects.toThrow('order changed within source');
  await expect(readMigrations([shared, shared])).rejects.toThrow(
    'duplicate filenames',
  );
});
test('warm templates produce isolated writable databases', async () => {
  const a = await allocateDatabase(fixtureMigrations);
  const b = await allocateDatabase(fixtureMigrations);
  try {
    expect(a.name).not.toBe(b.name);
    expect(a.hash).toBe(b.hash);
    await queryDatabase(
      a.url,
      "INSERT INTO users VALUES ('a','alice@example.test','2020-01-01')",
    );
    expect(await queryDatabase(b.url, 'SELECT * FROM users')).toEqual([]);
    expect((await prepareTemplate(fixtureMigrations)).hash).toBe(a.hash);
    const files = await readMigrations(fixtureMigrations);
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
    join(directory, '001_users.sql'),
    await readFile(join(fixtureMigrations, '001_users.sql')),
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

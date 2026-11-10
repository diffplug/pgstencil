import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadEnvFiles,
  parseArguments,
  usage,
} from '../../packages/pgstencil/src/arguments.ts';
import { projectRoot } from '../../packages/pgstencil/src/paths.ts';

const cli = join(projectRoot, 'packages/pgstencil/src/cli.ts');

/** Runs the command as the root scripts do, against a project of its own. */
function pgstencil(root: string | undefined, ...argv: string[]) {
  return pgstencilWith({}, root, ...argv);
}

/**
 * `pgstencil` with `extra` variables over an environment without DATABASE_URL;
 * an `undefined` value removes the variable.
 */
function pgstencilWith(
  extra: Record<string, string | undefined>,
  root: string | undefined,
  ...argv: string[]
) {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  if (root) env.PGSTENCIL_PROJECT_ROOT = root;
  for (const [name, value] of Object.entries(extra))
    if (value === undefined) delete env[name];
    else env[name] = value;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', cli, ...argv],
    {
      cwd: projectRoot,
      env,
      encoding: 'utf8',
    },
  );
  if (result.error) throw result.error;
  return result;
}

test('commands parse into what they run', () => {
  for (const name of [
    'status',
    'validate',
    'migrate',
    'verify',
    'reset',
    'gc',
    'stop',
  ])
    expect(parseArguments([name])).toEqual({ name });
  for (const help of ['help', '--help', '-h'])
    expect(parseArguments([help])).toEqual({ name: 'help' });
  expect(parseArguments(['schema'])).toEqual({ name: 'schema', verify: false });
  expect(parseArguments(['types', '--verify'])).toEqual({
    name: 'types',
    verify: true,
  });
  expect(parseArguments(['create', 'add_profile'])).toEqual({
    name: 'create',
    label: 'add_profile',
  });
  expect(
    parseArguments(['create', '--in', 'server/sql', 'add_profile']),
  ).toEqual({ name: 'create', label: 'add_profile', in: 'server/sql' });
  expect(parseArguments(['create', 'add_profile', '--in=server/sql'])).toEqual({
    name: 'create',
    label: 'add_profile',
    in: 'server/sql',
  });
});

test('status, validate and migrate take --also sources and --require-database-url', () => {
  for (const name of ['status', 'validate', 'migrate'] as const) {
    expect(parseArguments([name, '--require-database-url'])).toEqual({
      name,
      requireDatabaseUrl: true,
    });
    expect(
      parseArguments([
        name,
        '--also',
        'preview/sql',
        '--require-database-url',
        '--also=more',
      ]),
    ).toEqual({
      name,
      also: ['preview/sql', 'more'],
      requireDatabaseUrl: true,
    });
  }
});

test('--env-file and --env-file-if-exists are global, in order, anywhere on the line', () => {
  expect(
    parseArguments([
      '--env-file',
      '.env',
      'migrate',
      '--env-file-if-exists=.env.local',
      '--also',
      'preview',
    ]),
  ).toEqual({
    name: 'migrate',
    also: ['preview'],
    envFiles: [
      { path: '.env', optional: false },
      { path: '.env.local', optional: true },
    ],
  });
  expect(
    parseArguments([
      'create',
      'add_profile',
      '--env-file=a',
      '--env-file',
      'b',
    ]),
  ).toEqual({
    name: 'create',
    label: 'add_profile',
    envFiles: [
      { path: 'a', optional: false },
      { path: 'b', optional: false },
    ],
  });
  expect(parseArguments(['reset', '--env-file-if-exists', '.env'])).toEqual({
    name: 'reset',
    envFiles: [{ path: '.env', optional: true }],
  });
});

test('bad command lines are usage errors', () => {
  for (const [argv, message] of [
    [[], 'Missing command'],
    [['up'], 'Unknown command: up'],
    [['--verify'], 'Unknown command: --verify'],
    [
      ['status', 'now'],
      'status accepts only --also <dir> and --require-database-url, got "now"',
    ],
    [['verify', '--verify'], 'verify takes no arguments'],
    [['schema', '--write'], 'schema accepts only --verify, got "--write"'],
    [['types', '--verify', '--verify'], 'types accepts only --verify'],
    [['create'], 'create needs a snake_case migration name'],
    [['create', 'AddProfile'], 'Migration names are snake_case'],
    [['create', '001_profile'], 'Migration names are snake_case'],
    [['create', 'a', 'b'], 'create takes one name, got a and b'],
    [['create', 'a', '--in'], '--in needs a directory'],
    [['create', 'a', '--in', '--force'], '--in needs a directory'],
    [['create', 'a', '--in', 'x', '--in', 'y'], '--in given twice'],
    [['create', 'a', '--force'], 'create does not accept --force'],
    [['status', '--also'], '--also needs a directory'],
    [
      ['migrate', '--also', '--require-database-url'],
      '--also needs a directory',
    ],
    [['validate', '--also='], '--also needs a directory'],
    [
      ['migrate', '--require-database-url', '--require-database-url'],
      '--require-database-url given twice',
    ],
    [
      ['migrate', '--force'],
      'migrate accepts only --also <dir> and --require-database-url, got "--force"',
    ],
    [['status', 'preview'], 'status accepts only --also <dir>'],
    [['reset', '--require-database-url'], 'reset takes no arguments'],
    [['verify', '--also', 'x'], 'verify takes no arguments'],
    [['create', 'a', '--also', 'x'], 'create does not accept --also'],
    [['--env-file'], '--env-file needs a path'],
    [['status', '--env-file', '--also'], '--env-file needs a path'],
    [['status', '--env-file-if-exists='], '--env-file-if-exists needs a path'],
    [['--env-file', '.env'], 'Missing command'],
  ] as const)
    expect(() => parseArguments(argv), argv.join(' ')).toThrow(message);
});

test('the command prints usage and exits non-zero on a bad command line', () => {
  for (const argv of [
    [],
    ['up'],
    ['create', 'Bad'],
    ['status', 'x'],
    ['migrate', '--al', 'x'],
    ['migrate', '--also'],
    ['reset', '--require-database-url'],
    ['--env-file'],
  ]) {
    const result = pgstencil(undefined, ...argv);
    expect(result.status, argv.join(' ')).toBe(2);
    expect(result.stderr).toContain(usage);
    expect(result.stdout).toBe('');
  }
  const help = pgstencil(undefined, 'help');
  expect(help.status).toBe(0);
  expect(help.stdout.trim()).toBe(usage);
});

test('a broken pgstencil.json fails the command with its message, but not help', async ({
  onTestFinished,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'pgstencil-cli-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'pgstencil.json'), '{"migration": "sql"}');
  const result = pgstencil(root, 'create', 'add_profile');
  expect(result.status).toBe(1);
  expect(result.stderr.trim()).toBe(
    'pgstencil create: pgstencil.json top level has unknown key "migration"; expected migrations, schema, types',
  );
  expect(pgstencil(root, 'help').status).toBe(0);
});

test('create numbers one above every source and writes into the last by default', async ({
  onTestFinished,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'pgstencil-cli-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'vendor/sql'), { recursive: true });
  await writeFile(join(root, 'vendor/sql/007_vendor.sql'), '');
  await writeFile(
    join(root, 'pgstencil.json'),
    JSON.stringify({ migrations: ['vendor/sql', 'app/sql'] }),
  );
  // The application's own source need not exist yet.
  const first = pgstencil(root, 'create', 'add_profile');
  expect(first.stderr).toBe('');
  expect(first.status).toBe(0);
  expect(first.stdout.trim()).toBe(join(root, 'app/sql/008_add_profile.sql'));
  expect(
    await readFile(join(root, 'app/sql/008_add_profile.sql'), 'utf8'),
  ).toBe('-- Up Migration\n\n-- Down Migration\n');
  const into = pgstencil(root, 'create', 'scratch', '--in', 'scratch');
  expect(into.status).toBe(0);
  expect(into.stdout.trim()).toBe(join(root, 'scratch/009_scratch.sql'));
  expect(into.stderr).toContain('scratch is not a migration source');
  const outside = pgstencil(root, 'create', 'escape', '--in', '../elsewhere');
  expect(outside.status).toBe(1);
  expect(outside.stderr.trim()).toBe(
    'pgstencil create: --in must stay inside the project root: ../elsewhere',
  );
  expect(await readdir(join(root, 'app/sql'))).toEqual(['008_add_profile.sql']);
});

test('create refuses to write inside node_modules, by default or with --in', async ({
  onTestFinished,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'pgstencil-cli-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const installed = 'node_modules/@pgstencil/auth/better-auth-migrations';
  await mkdir(join(root, installed), { recursive: true });
  await writeFile(join(root, installed, '001_auth.sql'), '');
  await writeFile(
    join(root, 'pgstencil.json'),
    JSON.stringify({ migrations: [installed] }),
  );
  const refusal = (target: string) =>
    `pgstencil create: Refusing to write into ${target}, which is inside node_modules and belongs to an installed package; add your own migrations directory as the last source in pgstencil.json, or pass --in <dir>`;
  const byDefault = pgstencil(root, 'create', 'add_profile');
  expect(byDefault.status).toBe(1);
  expect(byDefault.stderr.trim()).toBe(refusal(installed));
  const named = pgstencil(
    root,
    'create',
    'add_profile',
    '--in',
    'vendor/../node_modules/other',
  );
  expect(named.status).toBe(1);
  expect(named.stderr.trim()).toBe(refusal('node_modules/other'));
  expect(await readdir(join(root, installed))).toEqual(['001_auth.sql']);
  const own = pgstencil(root, 'create', 'add_profile', '--in', 'migrations');
  expect(own.status).toBe(0);
  expect(own.stdout.trim()).toBe(join(root, 'migrations/002_add_profile.sql'));
});

test('status, validate and migrate refuse a bad --also source or a missing DATABASE_URL before any database', async ({
  onTestFinished,
}) => {
  // No pgstencil.json and no Docker needed: every refusal comes first.
  const root = await mkdtemp(join(tmpdir(), 'pgstencil-cli-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  for (const name of ['status', 'validate', 'migrate']) {
    const outside = pgstencil(root, name, '--also', '../preview');
    expect(outside.status).toBe(1);
    expect(outside.stderr.trim()).toBe(
      `pgstencil ${name}: --also must stay inside the project root: ../preview`,
    );
    const twice = pgstencil(root, name, '--also', './migrations');
    expect(twice.stderr.trim()).toBe(
      `pgstencil ${name}: --also ./migrations is already a migration source`,
    );
    const unset = pgstencilWith({}, root, name, '--require-database-url');
    expect(unset.status).toBe(1);
    expect(unset.stderr.trim()).toBe(
      `pgstencil ${name}: DATABASE_URL is unset, and --require-database-url refuses to fall back to the development database`,
    );
    // A lost secret arrives as an empty string: refused with or without the flag.
    for (const flags of [[], ['--require-database-url']]) {
      const empty = pgstencilWith({ DATABASE_URL: '' }, root, name, ...flags);
      expect(empty.status, flags.join(' ')).toBe(1);
      expect(empty.stderr.trim()).toBe(
        `pgstencil ${name}: DATABASE_URL is set but empty, which usually means a missing secret; unset it to use the development database`,
      );
    }
  }
});

test('reset refuses while DATABASE_URL is set, since it only resets the development database', async ({
  onTestFinished,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'pgstencil-cli-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const result = pgstencilWith(
    { DATABASE_URL: 'postgres://deploy.example.test/app' },
    root,
    'reset',
  );
  expect(result.status).toBe(1);
  expect(result.stderr.trim()).toBe(
    'pgstencil reset: DATABASE_URL is set, but reset only ever recreates the development database (pgstencil_dev) and never the database DATABASE_URL names; unset DATABASE_URL to reset the development database',
  );
});

test('--env-file loads before configuration, and the environment and later files win', async ({
  onTestFinished,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'pgstencil-cli-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  // Two projects told apart by the error their broken configuration gives.
  for (const name of ['first', 'second']) {
    await mkdir(join(directory, name));
    await writeFile(
      join(directory, name, 'pgstencil.json'),
      JSON.stringify({ [name]: true }),
    );
  }
  // status, which only reads, so a regression cannot write into this checkout.
  const broken = (name: string) =>
    `pgstencil status: pgstencil.json top level has unknown key "${name}"; expected migrations, schema, types`;
  const file = async (name: string, text: string) => {
    await writeFile(join(directory, name), text);
    return join(directory, name);
  };
  const first = await file(
    'first.env',
    `PGSTENCIL_PROJECT_ROOT=${join(directory, 'first')}\n`,
  );
  const second = await file(
    'second.env',
    `PGSTENCIL_PROJECT_ROOT=${join(directory, 'second')}\nDATABASE_URL=postgres://deploy.example.test/app\n`,
  );
  const run = (env: Record<string, string | undefined>, ...argv: string[]) => {
    const result = pgstencilWith(env, undefined, ...argv);
    return { status: result.status, stderr: result.stderr.trim() };
  };
  const unrooted = { PGSTENCIL_PROJECT_ROOT: undefined };
  // PGSTENCIL_PROJECT_ROOT comes from the file, so configuration loads after it.
  expect(run(unrooted, '--env-file', first, 'status')).toEqual({
    status: 1,
    stderr: broken('first'),
  });
  // A later file wins over an earlier one, as with node --env-file.
  expect(
    run(unrooted, 'status', `--env-file=${first}`, '--env-file', second),
  ).toEqual({ status: 1, stderr: broken('second') });
  // A variable already in the environment wins over every file.
  expect(
    run(
      { PGSTENCIL_PROJECT_ROOT: join(directory, 'first') },
      '--env-file',
      second,
      'status',
    ),
  ).toEqual({ status: 1, stderr: broken('first') });
  // DATABASE_URL from a file counts as set.
  const deploy = await file(
    'deploy.env',
    'DATABASE_URL=postgres://deploy.example.test/app\n',
  );
  expect(
    run({ PGSTENCIL_PROJECT_ROOT: directory }, '--env-file', deploy, 'reset')
      .stderr,
  ).toContain('pgstencil reset: DATABASE_URL is set');
  const missing = join(directory, 'missing.env');
  expect(() =>
    loadEnvFiles([
      { path: missing, optional: true },
      { path: missing, optional: false },
    ]),
  ).toThrow(`--env-file ${missing} does not exist`);
  expect(() => loadEnvFiles([{ path: missing, optional: true }])).not.toThrow();
  // Node 24 checks --env-file after the script name too, and exits 9 with
  // its own message before pgstencil runs; either way the command fails.
  const absent = run(unrooted, '--env-file', missing, 'status');
  expect([1, 9]).toContain(absent.status);
  expect(absent.stderr).toMatch(
    new RegExp(`${missing}(: not found| does not exist)`),
  );
  const optional = run(
    unrooted,
    '--env-file-if-exists',
    missing,
    '--env-file-if-exists',
    first,
    'status',
  );
  expect(optional.status).toBe(1);
  expect(optional.stderr).toContain(broken('first'));
});

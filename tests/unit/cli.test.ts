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
  parseArguments,
  usage,
} from '../../packages/pgstencil/src/arguments.ts';
import { projectRoot } from '../../packages/pgstencil/src/paths.ts';

const cli = join(projectRoot, 'packages/pgstencil/src/cli.ts');

/** Runs the command as the root scripts do, against a project of its own. */
function pgstencil(root: string | undefined, ...argv: string[]) {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  if (root) env.PGSTENCIL_PROJECT_ROOT = root;
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

test('bad command lines are usage errors', () => {
  for (const [argv, message] of [
    [[], 'Missing command'],
    [['up'], 'Unknown command: up'],
    [['--verify'], 'Unknown command: --verify'],
    [['status', 'now'], 'status takes no arguments, got "now"'],
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
  ] as const)
    expect(() => parseArguments(argv), argv.join(' ')).toThrow(message);
});

test('the command prints usage and exits non-zero on a bad command line', () => {
  for (const argv of [[], ['up'], ['create', 'Bad'], ['status', 'x']]) {
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

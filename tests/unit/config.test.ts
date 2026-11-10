import { test, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  parseConfig,
  readConfig,
} from '../../packages/pgstencil/src/config.ts';
import {
  defaultMigrations,
  projectRoot,
} from '../../packages/pgstencil/src/paths.ts';

const root = resolve('/work/app');
const parse = (value: unknown) => parseConfig(root, value);

test('an empty configuration uses the migrations directory and generates nothing', () => {
  expect(parse({})).toEqual({
    migrations: [join(root, 'migrations')],
    types: [],
  });
});

test('migrations is a directory or an ordered list of directories', () => {
  expect(parse({ migrations: 'db/sql' }).migrations).toEqual([
    join(root, 'db/sql'),
  ]);
  expect(
    parse({
      migrations: [
        'node_modules/@pgstencil/auth/better-auth-migrations',
        'node_modules/@pgstencil/stripe/migrations',
        './server/migrations',
      ],
    }).migrations,
  ).toEqual([
    join(root, 'node_modules/@pgstencil/auth/better-auth-migrations'),
    join(root, 'node_modules/@pgstencil/stripe/migrations'),
    join(root, 'server/migrations'),
  ]);
  expect(Object.isFrozen(parse({}).migrations)).toBe(true);
});

test('this repository configures the example sources, its schema dump and billing types', () => {
  expect(defaultMigrations).toEqual([
    join(projectRoot, 'packages/auth/better-auth-migrations'),
    join(projectRoot, 'packages/stripe/migrations'),
  ]);
  expect(readConfig(projectRoot)).toEqual({
    migrations: defaultMigrations,
    schema: join(projectRoot, 'examples/better-auth/schema.sql'),
    types: [
      {
        out: join(projectRoot, 'packages/stripe/src/db.generated.ts'),
        include: 'pgstencil_billing.*',
        defaultSchema: 'pgstencil_billing',
      },
    ],
  });
});

test('malformed migrations are refused with the offending entry named', () => {
  expect(() => parse({ migrations: [] })).toThrow(
    'pgstencil.json migrations must be a directory or a non-empty list of directories, not an empty list',
  );
  expect(() => parse({ migrations: 3 })).toThrow('not number');
  expect(() => parse({ migrations: null })).toThrow('not null');
  expect(() => parse({ migrations: ['a', ''] })).toThrow(
    'pgstencil.json migrations[1] must be a non-empty string',
  );
  expect(() => parse({ migrations: ['a', { dir: 'b' }] })).toThrow(
    'pgstencil.json migrations[1] must be a non-empty string, not object',
  );
  expect(() => parse({ migrations: ['sql', './sql'] })).toThrow(
    'pgstencil.json migrations lists sql more than once',
  );
});

test('every configured path must stay inside the project root', () => {
  for (const escape of ['..', '../shared', 'a/../../b', resolve('/tmp/sql')]) {
    expect(() => parse({ migrations: escape }), escape).toThrow(
      `pgstencil.json migrations must stay inside the project root: ${escape}`,
    );
    expect(() => parse({ migrations: ['sql', escape] }), escape).toThrow(
      'pgstencil.json migrations[1] must stay inside the project root',
    );
    expect(() => parse({ schema: escape }), escape).toThrow(
      'pgstencil.json schema must stay inside the project root',
    );
    expect(() => parse({ types: [{ out: escape }] }), escape).toThrow(
      'pgstencil.json types[0].out must stay inside the project root',
    );
  }
});

test('unknown keys are refused, at the top level and in types entries', () => {
  expect(() => parse({ migration: 'sql' })).toThrow(
    'pgstencil.json top level has unknown key "migration"; expected migrations, schema, types',
  );
  expect(() => parse({ a: 1, b: 2 })).toThrow('unknown keys "a", "b"');
  expect(() =>
    parse({ types: [{ out: 'db.ts', outFile: 'db.ts', schema: 'x' }] }),
  ).toThrow(
    'pgstencil.json types[0] has unknown keys "outFile", "schema"; expected out, include, exclude, defaultSchema',
  );
});

test('the configuration itself must be an object', () => {
  for (const [value, kind] of [
    [null, 'null'],
    [[], 'an array'],
    ['sql', 'string'],
  ] as const)
    expect(() => parse(value)).toThrow(
      `pgstencil.json top level must be an object, not ${kind}`,
    );
});

test('types entries default include to public.* and keep only what was given', () => {
  expect(
    parse({
      schema: 'schema.sql',
      types: [
        { out: 'src/db.generated.ts' },
        {
          out: 'src/billing.generated.ts',
          include: 'pgstencil_billing.*',
          exclude: 'pgstencil_billing.events',
          defaultSchema: 'pgstencil_billing',
        },
      ],
    }),
  ).toEqual({
    migrations: [join(root, 'migrations')],
    schema: join(root, 'schema.sql'),
    types: [
      { out: join(root, 'src/db.generated.ts'), include: 'public.*' },
      {
        out: join(root, 'src/billing.generated.ts'),
        include: 'pgstencil_billing.*',
        exclude: 'pgstencil_billing.events',
        defaultSchema: 'pgstencil_billing',
      },
    ],
  });
});

test('malformed types entries are refused with the offending field named', () => {
  expect(() => parse({ types: { out: 'db.ts' } })).toThrow(
    'pgstencil.json types must be a list of { out, include?, exclude?, defaultSchema? }, not object',
  );
  expect(() => parse({ types: null })).toThrow('not null');
  expect(() => parse({ types: ['db.ts'] })).toThrow(
    'pgstencil.json types[0] must be an object, not string',
  );
  expect(() => parse({ types: [{ include: 'public.*' }] })).toThrow(
    'pgstencil.json types[0] needs an "out" path',
  );
  expect(() => parse({ types: [{ out: 'db.ts', include: '' }] })).toThrow(
    'pgstencil.json types[0].include must be a non-empty string',
  );
  expect(() =>
    parse({ types: [{ out: 'db.ts' }, { out: 'db.ts', defaultSchema: 1 }] }),
  ).toThrow('pgstencil.json types[1].defaultSchema must be a non-empty string');
  expect(() =>
    parse({ types: [{ out: 'db.ts' }, { out: './db.ts' }] }),
  ).toThrow('pgstencil.json types lists db.ts more than once');
  expect(() => parse({ schema: '' })).toThrow(
    'pgstencil.json schema must be a non-empty string',
  );
});

test('readConfig uses every default without a file and names a file that is not JSON', async ({
  onTestFinished,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'pgstencil-config-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  expect(readConfig(directory)).toEqual({
    migrations: [join(directory, 'migrations')],
    types: [],
  });
  await writeFile(join(directory, 'pgstencil.json'), '{ "migrations": ');
  expect(() => readConfig(directory)).toThrow(
    `${join(directory, 'pgstencil.json')} is not valid JSON`,
  );
});

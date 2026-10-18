/**
 * Keeps pgstencil's Docker, migration and snapshot tooling out of an
 * application's production install. See PACKAGES.md -> "Dependencies".
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repo = fileURLToPath(new URL('..', import.meta.url));

/**
 * Only `pgstencil/database`, `pgstencil/testing` and `pgstencil/snapshots` use
 * these. `packages:verify` reads the same list for its runtime-only install.
 */
const TOOLING = JSON.parse(
  readFileSync(join(repo, 'scripts/tooling-peers.json'), 'utf8'),
);

const packages = readdirSync(join(repo, 'packages')).map((name) => {
  const dir = join(repo, 'packages', name);
  return {
    dir,
    manifest: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')),
  };
});

test('tooling packages are optional peers of pgstencil, never installed with it', () => {
  for (const { manifest } of packages)
    for (const field of ['dependencies', 'optionalDependencies'])
      for (const name of TOOLING)
        assert.ok(
          !(name in (manifest[field] ?? {})),
          `${manifest.name} lists ${name} in ${field}, so every production install gets it; declare it an optional peer`,
        );
  const core = packages.find(({ manifest }) => manifest.name === 'pgstencil');
  for (const name of TOOLING) {
    assert.ok(
      core.manifest.peerDependencies?.[name],
      `pgstencil must declare ${name} as a peer`,
    );
    assert.equal(
      core.manifest.peerDependenciesMeta?.[name]?.optional,
      true,
      `pgstencil's ${name} peer must be optional`,
    );
  }
});

/** Every specifier esbuild follows, by kind, from one published entry point. */
async function tooling(entry) {
  const seen = [];
  const followed = Symbol('followed');
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'silent',
    absWorkingDir: repo,
    external: ['*.node'],
    plugins: [
      {
        name: 'tooling-reach',
        setup(build) {
          const pattern = new RegExp(`^(${TOOLING.join('|')})(/|$)`);
          build.onResolve({ filter: pattern }, (args) => {
            seen.push({
              name: args.path.match(pattern)[1],
              kind: args.kind,
              importer: relative(repo, args.importer),
            });
            return { path: args.path, external: true };
          });
          // Follow third-party code as well, so a private dependency that
          // imports tooling counts. A module it cannot resolve, such as an
          // optional database driver, stays external.
          build.onResolve({ filter: /^[^./]/ }, async (args) => {
            if (args.pluginData === followed) return undefined;
            const result = await build.resolve(args.path, {
              kind: args.kind,
              importer: args.importer,
              resolveDir: args.resolveDir,
              pluginData: followed,
            });
            return result.errors.length
              ? { path: args.path, external: true }
              : result;
          });
        },
      },
    ],
  });
  return seen;
}

const entries = packages.flatMap(({ dir, manifest }) =>
  Object.entries(manifest.exports).map(([subpath, file]) => ({
    name: join(manifest.name, subpath),
    file: join(dir, file),
  })),
);

test('no entry point statically reaches a tooling package', async () => {
  const reached = await Promise.all(
    entries.map(async ({ name, file }) => ({
      name,
      seen: await tooling(file),
    })),
  );
  const violations = reached.flatMap(({ name, seen }) =>
    seen
      .filter(({ kind }) => kind !== 'dynamic-import')
      .map(
        ({ name: tool, kind, importer }) =>
          `${name} reaches ${tool} by ${kind} in ${importer}; load it through importPeer`,
      ),
  );
  assert.deepEqual(violations, []);
  // The guard sees each tooling package from the entry points that need it,
  // so an esbuild or layout change cannot turn this test vacuous.
  const dynamic = new Set(
    reached.flatMap(({ seen }) => seen.map(({ name }) => name)),
  );
  assert.deepEqual([...dynamic].sort(), [...TOOLING].sort());
});

import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { createDeterministicApp } from './better-auth-entry.ts';

/**
 * Bundles `better-auth-entry.ts` with esbuild injecting the actual
 * `better-auth-testing` module file, so Date, Web Crypto and fetch inside the
 * bundle follow each app's own clock, random stream and outbound fetch.
 * `name` keeps concurrent test files from overwriting each other's output.
 */
export async function bundleDeterministicApp(name: string) {
  const result = await build({
    entryPoints: [resolve('tests/support/better-auth-entry.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    packages: 'bundle',
    external: [...builtinModules, 'node:*', 'pg-native'],
    inject: [resolve('packages/auth/src/better-auth-testing.ts')],
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
  await mkdir('.build', { recursive: true });
  const file = resolve(`.build/${name}.mjs`);
  await writeFile(file, result.outputFiles[0]!.text);
  return (await import(pathToFileURL(file).href)) as {
    createDeterministicApp: typeof createDeterministicApp;
  };
}

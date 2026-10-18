/**
 * Loads an optional peer dependency. Tooling entry points reach `testcontainers`,
 * `node-pg-migrate`, `cheerio` and `turndown` only through here, so a runtime
 * install never needs them and a tooling install that lacks one is told which
 * package to add. `scripts/runtime-deps.test.mjs` fails on a static import.
 */
export async function importPeer<T>(
  name: string,
  entry: string,
  load: () => Promise<T>,
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    // Only the peer itself being absent; a broken install of it surfaces as-is.
    const code = (error as { code?: unknown } | null)?.code;
    if (
      code === 'ERR_MODULE_NOT_FOUND' &&
      String((error as Error).message).includes(`'${name}'`)
    )
      throw new Error(
        `${entry} needs the optional peer dependency "${name}". Add it to your project, for example: pnpm add -D ${name}`,
        { cause: error },
      );
    throw error;
  }
}

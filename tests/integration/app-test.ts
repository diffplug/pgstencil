import { test } from 'vitest';
import { fixture, type Fixture } from './helpers.ts';
/**
 * The common case: one app, closed after the test. Kept out of helpers.ts so
 * that plain Node processes (tests/support/process-app.ts) can reuse the
 * helpers without importing the vitest runner.
 */
export const appTest = test.extend<{ f: Fixture }>({
  f: async ({}, use) => {
    const f = await fixture();
    await use(f);
    await f.close();
  },
});

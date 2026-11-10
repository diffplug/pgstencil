import { fork } from 'node:child_process';
import { once } from 'node:events';
import { test, expect } from 'vitest';
import { fixture, signUp, type Fixture } from '../support/fixture-app.ts';
import { captureEmail } from '../../packages/pgstencil/src/snapshots.ts';

test('twenty live applications isolate ports, databases, time, random state and email', async ({
  onTestFinished,
}) => {
  const apps: Fixture[] = [];
  onTestFinished(async () => {
    await Promise.all(apps.map((app) => app.close()));
  });
  const started = performance.now();
  await Promise.all(
    Array.from({ length: 20 }, async () => {
      apps.push(await fixture());
    }),
  );
  expect(new Set(apps.map((f) => f.app.origin)).size).toBe(20);
  expect(new Set(apps.map((f) => f.database.name)).size).toBe(20);
  expect(new Set(apps.map((f) => f.database.hash)).size).toBe(1);
  const signups = await Promise.all(apps.map((f) => signUp(f)));
  // Same inputs produce the same email and IDs regardless of scheduling.
  expect(
    new Set(
      signups.map((signup, i) =>
        captureEmail(signup.message, apps[i]!.app.origin),
      ),
    ).size,
  ).toBe(1);
  expect(new Set(signups.map((signup) => signup.user.id)).size).toBe(1);
  apps[0]!.time.advanceHours(24);
  apps[0]!.random.bytes(100);
  expect(apps[1]!.time.now().toISOString()).toBe('2020-01-01T00:00:00.000Z');
  expect(apps[1]!.random.bytes(32)).toEqual(apps[2]!.random.bytes(32));
  await Promise.all(
    apps.map(async (f, i) => {
      await f.app.db
        .insertInto('users')
        .values({
          id: 'isolation',
          email: `user${i}@example.test`,
          created_at: f.time.now(),
        })
        .execute();
      expect(
        await f.app.db
          .selectFrom('users')
          .select('email')
          .orderBy('email')
          .execute(),
      ).toEqual([
        { email: 'alice@example.test' },
        { email: `user${i}@example.test` },
      ]);
      f.email.assertNoUnread();
      expect(f.email.all()).toHaveLength(1);
    }),
  );
  await signUp(apps[1]!, 'bob@example.test');
  expect(
    (await apps[1]!.client.get('/users').expect(200)).body.map(
      (user: { email: string }) => user.email,
    ),
  ).toEqual(['alice@example.test', 'bob@example.test', 'user1@example.test']);
  expect(
    await apps[0]!.app.db
      .selectFrom('users')
      .select('email')
      .where('email', '=', 'bob@example.test')
      .execute(),
  ).toEqual([]);
  expect(apps[0]!.email.all()).toHaveLength(1);
  console.info(
    `20 concurrent apps, isolated writes and email: ${Math.round(performance.now() - started)}ms`,
  );
});

test('independent Node processes share a template and own different live databases', async ({
  onTestFinished,
}) => {
  const children = Array.from({ length: 2 }, () =>
    fork(new URL('../support/process-app.ts', import.meta.url), [], {
      execArgv: ['--import', 'tsx'],
      silent: true,
    }),
  );
  onTestFinished(() => {
    for (const child of children) if (child.exitCode === null) child.kill();
  });
  const results = await Promise.all(
    children.map(async (child) => {
      let stderr = '';
      child.stderr!.on('data', (chunk) => {
        stderr += String(chunk);
      });
      return await new Promise<{ origin: string; name: string; hash: string }>(
        (resolve, reject) => {
          child.once('message', (message) =>
            resolve(message as { origin: string; name: string; hash: string }),
          );
          child.once('error', reject);
          child.once('exit', (code) =>
            reject(new Error(`Child exited ${code}: ${stderr}`)),
          );
        },
      );
    }),
  );
  expect(results[0]!.name).not.toBe(results[1]!.name);
  expect(results[0]!.origin).not.toBe(results[1]!.origin);
  expect(results[0]!.hash).toBe(results[1]!.hash);
  await Promise.all(
    children.map(async (child) => {
      const done = once(child, 'exit');
      child.send('close');
      expect((await done)[0]).toBe(0);
    }),
  );
});

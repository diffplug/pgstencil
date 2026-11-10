import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import {
  decimalCode,
  token,
  type EmailSender,
  type RandomSource,
  type Time,
} from '../../packages/pgstencil/src/index.ts';
import { connectDatabase } from '../../packages/pgstencil/src/postgres.ts';
import { createTestContext } from '../../packages/pgstencil/src/testing.ts';

/** The infrastructure tests' own schema, independent of any auth package. */
export const fixtureMigrations = fileURLToPath(
  new URL('../fixtures/migrations/', import.meta.url),
);
export interface FixtureDB {
  users: { id: string; email: string; created_at: Date };
}

/**
 * The smallest application that consumes everything a test context injects:
 * its database URL, clock, random source and email sender. `POST /users`
 * stores a user and emails a welcome code; `GET /users` lists the emails.
 */
export async function startFixtureApp(options: {
  databaseUrl: string;
  time: Time;
  random: RandomSource;
  email: EmailSender;
}) {
  const db = connectDatabase<FixtureDB>(options.databaseUrl);
  const server = createServer((req, res) => {
    void handle(req).then(
      ({ status, body }) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      },
      () => {
        res.writeHead(500).end();
      },
    );
  });
  async function handle(
    req: IncomingMessage,
  ): Promise<{ status: number; body: unknown }> {
    if (req.url === '/users' && req.method === 'GET')
      return {
        status: 200,
        body: await db
          .selectFrom('users')
          .select(['id', 'email', 'created_at'])
          .orderBy('email')
          .execute(),
      };
    if (req.url === '/users' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += String(chunk);
      const { email } = JSON.parse(raw) as { email: string };
      const user = {
        id: token(options.random, 16),
        email,
        created_at: options.time.now(),
      };
      await db.insertInto('users').values(user).execute();
      const code = decimalCode(options.random);
      await options.email.send({
        to: [email],
        from: 'fixture@example.test',
        subject: 'Welcome',
        text: `Your code is ${code}. Joined ${user.created_at.toISOString()}.`,
        html: `<p>Your code is <b>${code}</b>.</p><p><a href="${origin}/users/${user.id}">Your profile</a></p>`,
      });
      return { status: 201, body: user };
    }
    return { status: 404, body: { message: 'Not found' } };
  }
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP address');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    db,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await db.destroy();
    },
  };
}

/** A leased database, injected clock/random/outbox, and a live fixture app on them. */
export async function fixture() {
  const context = await createTestContext({ migrations: fixtureMigrations });
  try {
    const app = await startFixtureApp({
      databaseUrl: context.database.url,
      time: context.time,
      random: context.random,
      email: context.email,
    });
    return {
      ...context,
      app,
      client: request(app.origin),
      async close() {
        await app.close();
        await context.close();
      },
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Signs up `email` and reads the welcome message it sent. */
export async function signUp(f: Fixture, email = 'alice@example.test') {
  const response = await f.client.post('/users').send({ email }).expect(201);
  return {
    user: response.body as { id: string },
    message: await f.email.next(),
  };
}

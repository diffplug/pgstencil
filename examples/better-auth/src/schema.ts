import { getMigrations } from 'better-auth/db/migration';
import { connectDatabase } from 'pgstencil/postgres';
import { authOptions } from './auth.ts';

/** Generate SQL for review; never run Better Auth's automatic migrations at request time. */
export async function schemaChanges(databaseUrl: string) {
  const database = connectDatabase(databaseUrl);
  try {
    return await getMigrations(
      authOptions({
        database,
        origin: 'https://example.test',
        secret: 'schema-generation-only-not-a-production-secret',
        email: {
          async send() {
            throw new Error('Schema generation cannot send mail');
          },
        },
      }),
    );
  } finally {
    await database.destroy();
  }
}

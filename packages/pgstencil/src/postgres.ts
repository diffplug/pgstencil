import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
export function connectDatabase<DB>(url: string): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: url, max: 2 }),
    }),
  });
}
export async function queryDatabase<
  Row extends pg.QueryResultRow = pg.QueryResultRow,
>(url: string, text: string, values: unknown[] = []): Promise<Row[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<Row>(text, values)).rows;
  } finally {
    await client.end();
  }
}

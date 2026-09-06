import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
export function connectDatabase<DB>(url: string): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: url, max: 2 }),
    }),
  });
}
/** Runs one action on a fresh connection and always closes it. */
export async function withClient<T>(
  url: string,
  action: (client: pg.Client) => Promise<T>,
  options: Omit<pg.ClientConfig, 'connectionString'> = {},
): Promise<T> {
  const client = new pg.Client({ ...options, connectionString: url });
  try {
    await client.connect();
    return await action(client);
  } finally {
    await client.end();
  }
}
export async function queryDatabase<
  Row extends pg.QueryResultRow = pg.QueryResultRow,
>(url: string, text: string, values: unknown[] = []): Promise<Row[]> {
  return withClient(
    url,
    async (client) => (await client.query<Row>(text, values)).rows,
  );
}

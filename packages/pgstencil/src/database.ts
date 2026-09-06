import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import {
  DockerComposeEnvironment,
  Wait,
  type StartedDockerComposeEnvironment,
} from 'testcontainers';
import pg from 'pg';
import { queryDatabase } from './postgres.ts';
export { connectDatabase, queryDatabase } from './postgres.ts';
import {
  migrate,
  migrationFingerprint,
  readMigrations,
  type MigrationFile,
} from './migrations.ts';
import { withProcessLock } from './lock.ts';
export {
  migrate,
  migrationFingerprint,
  readMigrations,
  validateMigrations,
} from './migrations.ts';
export interface Services {
  project: string;
  postgresUrl: string;
  integresqlUrl: string;
  postgresContainer: string;
}
export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}
interface Allocation {
  id: number;
  database: { config: DatabaseConfig };
}
export const projectRoot = resolve(import.meta.dirname, '../../..');
export const defaultMigrations = join(projectRoot, 'examples/login/migrations');
export const stateDirectory = join(projectRoot, '.pgstencil');
export const projectName = `pgstencil-${createHash('sha256').update(projectRoot).digest('hex').slice(0, 12)}`;
let servicesPromise: Promise<Services> | undefined;
let environment: StartedDockerComposeEnvironment | undefined;
export function ensureServices(): Promise<Services> {
  servicesPromise ??= withProcessLock(
    join(stateDirectory, 'services.lock'),
    async () => {
      const statePath = join(stateDirectory, 'services.json');
      try {
        const state = JSON.parse(await readFile(statePath, 'utf8')) as Services;
        const client = new pg.Client({
          connectionString: state.postgresUrl,
          connectionTimeoutMillis: 1000,
        });
        try {
          await client.connect();
          await client.query('SELECT 1');
          const response = await fetch(
            `${state.integresqlUrl}/api/v1/templates/pgstencil-readiness/tests`,
            { signal: AbortSignal.timeout(1000) },
          );
          if (response.status === 404) return state;
        } finally {
          await client.end();
        }
      } catch {
        /* Stale or absent state: reattach/start through Compose. */
      }
      environment = await new DockerComposeEnvironment(
        projectRoot,
        'compose.yaml',
      )
        .withAutoCleanup(false)
        .withNoRecreate()
        .withProjectName(projectName)
        .withStartupTimeout(120_000)
        .withWaitStrategy('postgres-1', Wait.forHealthCheck())
        .withWaitStrategy(
          'integresql-1',
          Wait.forHttp(
            '/api/v1/templates/pgstencil-readiness/tests',
            5000,
          ).forStatusCode(404),
        )
        .up();
      const postgres = environment.getContainer('postgres-1');
      const integre = environment.getContainer('integresql-1');
      const state: Services = {
        project: projectName,
        postgresUrl: `postgresql://pgstencil:pgstencil-local-only@${postgres.getHost()}:${postgres.getMappedPort(5432)}/postgres`,
        integresqlUrl: `http://${integre.getHost()}:${integre.getMappedPort(5000)}`,
        postgresContainer: postgres.getId(),
      };
      await mkdir(stateDirectory, { recursive: true });
      await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
      return state;
    },
  ).catch((error) => {
    servicesPromise = undefined;
    throw error;
  });
  return servicesPromise;
}
async function api(
  services: Services,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<Response> {
  return fetch(`${services.integresqlUrl}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
}
async function requireOk(response: Response): Promise<void> {
  if (!response.ok)
    throw new Error(`IntegreSQL ${response.status}: ${await response.text()}`);
}
function hostUrl(services: Services, config: DatabaseConfig): string {
  const url = new URL(services.postgresUrl);
  url.pathname = `/${config.database}`;
  return url.toString();
}
export async function prepareTemplate(
  directory = defaultMigrations,
): Promise<{ services: Services; hash: string; files: MigrationFile[] }> {
  const services = await ensureServices();
  const files = await readMigrations(directory);
  const hash = migrationFingerprint(
    files,
    await readFile(join(projectRoot, 'compose.yaml'), 'utf8'),
  ).slice(0, 32);
  // A PG session lock also releases on process death, allowing safe recovery of an unfinished initializer.
  const admin = new pg.Client({ connectionString: services.postgresUrl });
  await admin.connect();
  try {
    await admin.query('SELECT pg_advisory_lock(hashtext($1))', [
      `pgstencil-template-${hash}`,
    ]);
    // Different migration fingerprints can initialize concurrently. Serialize
    // the catalog DDL as well: IF NOT EXISTS alone is not a concurrency lock.
    await admin.query('BEGIN');
    await admin.query(
      "SELECT pg_advisory_xact_lock(hashtext('pgstencil-catalog'))",
    );
    await admin.query(
      'CREATE TABLE IF NOT EXISTS pgstencil_ready_templates (hash text PRIMARY KEY)',
    );
    await admin.query('COMMIT');
    let response = await api(services, '/templates', 'POST', { hash });
    if (response.status === 423) {
      const ready = await admin.query(
        'SELECT hash FROM pgstencil_ready_templates WHERE hash=$1',
        [hash],
      );
      if (ready.rowCount) {
        await requireOk(await api(services, `/templates/${hash}`, 'PUT'));
        return { services, hash, files };
      }
      await requireOk(await api(services, `/templates/${hash}`, 'DELETE'));
      response = await api(services, '/templates', 'POST', { hash });
    }
    await admin.query('DELETE FROM pgstencil_ready_templates WHERE hash=$1', [
      hash,
    ]);
    await requireOk(response);
    const template = (await response.json()) as {
      database: { config: DatabaseConfig };
    };
    try {
      await migrate(hostUrl(services, template.database.config), files);
      await admin.query(
        'INSERT INTO pgstencil_ready_templates VALUES ($1) ON CONFLICT DO NOTHING',
        [hash],
      );
      await requireOk(await api(services, `/templates/${hash}`, 'PUT'));
    } catch (error) {
      await api(services, `/templates/${hash}`, 'DELETE').catch(() => {});
      throw error;
    }
  } finally {
    await admin.end();
  }
  return { services, hash, files };
}
export async function allocateDatabase(
  directory = defaultMigrations,
): Promise<DatabaseLease> {
  const { services, hash } = await prepareTemplate(directory);
  const response = await api(services, `/templates/${hash}/tests`);
  await requireOk(response);
  const allocation = (await response.json()) as Allocation;
  const url = hostUrl(services, allocation.database.config);
  const lifetime = new pg.Client({ connectionString: url });
  await lifetime.connect();
  let closed = false;
  return {
    url,
    name: allocation.database.config.database,
    hash,
    id: allocation.id,
    async close() {
      if (closed) return;
      closed = true;
      await lifetime.end();
      await requireOk(
        await api(
          services,
          `/templates/${hash}/tests/${allocation.id}/recreate`,
          'POST',
        ),
      );
    },
  };
}
export interface DatabaseLease {
  url: string;
  name: string;
  hash: string;
  id: number;
  close(): Promise<void>;
}
export async function developmentDatabase(
  applyMigrations = true,
): Promise<string> {
  const services = await ensureServices();
  const name = 'pgstencil_dev';
  await withProcessLock(join(stateDirectory, 'dev-db.lock'), async () => {
    const found = await queryDatabase(
      services.postgresUrl,
      'SELECT 1 FROM pg_database WHERE datname=$1',
      [name],
    );
    if (!found.length)
      await queryDatabase(
        services.postgresUrl,
        'CREATE DATABASE pgstencil_dev',
      );
  });
  const url = new URL(services.postgresUrl);
  url.pathname = `/${name}`;
  if (applyMigrations)
    await migrate(url.toString(), await readMigrations(defaultMigrations));
  return url.toString();
}

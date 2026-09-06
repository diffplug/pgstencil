import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import {
  DockerComposeEnvironment,
  Wait,
  type StartedDockerComposeEnvironment,
} from 'testcontainers';
import pg from 'pg';
import { queryDatabase, withClient } from './postgres.ts';
export { connectDatabase, queryDatabase, withClient } from './postgres.ts';
import { migrate, migrationFingerprint, readMigrations } from './migrations.ts';
import { withProcessLock } from './lock.ts';
import {
  composeFile,
  projectName,
  projectRoot,
  stateDirectory,
  defaultMigrations,
} from './paths.ts';
export {
  appliedMigrations,
  migrate,
  migrationFingerprint,
  readMigrations,
  validateMigrations,
} from './migrations.ts';
export {
  composeFile,
  projectName,
  projectRoot,
  stateDirectory,
  defaultMigrations,
} from './paths.ts';
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
interface DatabaseHandle {
  database: { config: DatabaseConfig };
}
interface Allocation extends DatabaseHandle {
  id: number;
}
export const developmentDatabaseName = 'pgstencil_dev';
/** IntegreSQL has no health endpoint; an unknown template answers 404 once it is up. */
const READINESS_PATH = '/templates/pgstencil-readiness/tests';
let servicesPromise: Promise<Services> | undefined;
let environment: StartedDockerComposeEnvironment | undefined;
export function ensureServices(): Promise<Services> {
  servicesPromise ??= withProcessLock(
    join(stateDirectory, 'services.lock'),
    async () => {
      const statePath = join(stateDirectory, 'services.json');
      try {
        const state = JSON.parse(await readFile(statePath, 'utf8')) as Services;
        // Independent probes: check both services at once, not one after the other.
        const [, response] = await Promise.all([
          withClient(state.postgresUrl, (client) => client.query('SELECT 1'), {
            connectionTimeoutMillis: 1000,
          }),
          fetch(`${state.integresqlUrl}/api/v1${READINESS_PATH}`, {
            signal: AbortSignal.timeout(1000),
          }),
        ]);
        if (response.status === 404) return state;
      } catch {
        /* Stale or absent state: reattach/start through Compose. */
      }
      environment = await new DockerComposeEnvironment(
        dirname(composeFile),
        basename(composeFile),
      )
        .withAutoCleanup(false)
        .withNoRecreate()
        .withProjectName(projectName)
        .withStartupTimeout(120_000)
        .withWaitStrategy('postgres-1', Wait.forHealthCheck())
        .withWaitStrategy(
          'integresql-1',
          Wait.forHttp(`/api/v1${READINESS_PATH}`, 5000).forStatusCode(404),
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
/** Issues one IntegreSQL API call; `path` is relative to /api/v1. */
export async function api(
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
export async function requireOk(response: Response): Promise<void> {
  if (!response.ok)
    throw new Error(`IntegreSQL ${response.status}: ${await response.text()}`);
}
function hostUrl(services: Services, database: string): string {
  const url = new URL(services.postgresUrl);
  url.pathname = `/${database}`;
  return url.toString();
}
let composeSource: Promise<string> | undefined;
export async function prepareTemplate(
  directory: string | readonly string[] = defaultMigrations,
): Promise<{ services: Services; hash: string }> {
  // Independent reads; vitest reruns the process when either input changes.
  const [services, files, compose] = await Promise.all([
    ensureServices(),
    readMigrations(directory),
    (composeSource ??= readFile(composeFile, 'utf8')),
  ]);
  const hash = migrationFingerprint(files, compose).slice(0, 32);
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
        return { services, hash };
      }
      await requireOk(await api(services, `/templates/${hash}`, 'DELETE'));
      response = await api(services, '/templates', 'POST', { hash });
    }
    await admin.query('DELETE FROM pgstencil_ready_templates WHERE hash=$1', [
      hash,
    ]);
    await requireOk(response);
    const template = (await response.json()) as DatabaseHandle;
    try {
      await migrate(
        hostUrl(services, template.database.config.database),
        files,
      );
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
  return { services, hash };
}
export async function allocateDatabase(
  directory: string | readonly string[] = defaultMigrations,
): Promise<DatabaseLease> {
  const { services, hash } = await prepareTemplate(directory);
  const response = await api(services, `/templates/${hash}/tests`);
  await requireOk(response);
  const allocation = (await response.json()) as Allocation;
  const url = hostUrl(services, allocation.database.config.database);
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
  directory: string | readonly string[] = defaultMigrations,
): Promise<string> {
  const services = await ensureServices();
  await withProcessLock(join(stateDirectory, 'dev-db.lock'), async () => {
    await withClient(services.postgresUrl, async (client) => {
      const found = await client.query(
        'SELECT 1 FROM pg_database WHERE datname=$1',
        [developmentDatabaseName],
      );
      if (!found.rows.length)
        await client.query(`CREATE DATABASE ${developmentDatabaseName}`);
    });
  });
  const url = hostUrl(services, developmentDatabaseName);
  if (applyMigrations) await migrate(url, await readMigrations(directory));
  return url;
}
/** Databases pgstencil owns that currently have client connections. */
export async function activeDatabases(services: Services): Promise<string[]> {
  const rows = await queryDatabase<{ datname: string }>(
    services.postgresUrl,
    "SELECT datname FROM pg_stat_activity WHERE datname <> 'postgres' AND backend_type='client backend' AND (datname LIKE 'integresql_%' OR datname=$1)",
    [developmentDatabaseName],
  );
  return rows.map((row) => row.datname);
}
/** Drops every IntegreSQL template together with pgstencil's record of them. */
export async function clearTemplates(services: Services): Promise<void> {
  await requireOk(await api(services, '/admin/templates', 'DELETE'));
  await queryDatabase(
    services.postgresUrl,
    'TRUNCATE pgstencil_ready_templates',
  );
}

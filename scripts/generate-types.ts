import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
const exec = promisify(execFile);
export async function generateTypes(
  url: string,
  outfile: string,
  verify = false,
): Promise<string> {
  const args = [
    'exec',
    'kysely-codegen',
    '--url',
    'env(DATABASE_URL)',
    '--out-file',
    outfile,
    '--dialect',
    'postgres',
    '--include-pattern',
    'public.*',
    '--exclude-pattern',
    'public.(pgmigrations|pgstencil_migration_files)',
  ];
  if (verify) args.push('--verify');
  const result = await exec('pnpm', args, {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, DATABASE_URL: url },
  });
  return result.stdout.trim();
}

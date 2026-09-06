import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { projectRoot } from '../packages/pgstencil/src/paths.ts';
const exec = promisify(execFile);
export async function generateTypes(
  url: string,
  outfile: string,
  verify = false,
): Promise<string> {
  const args = [
    // Running the bin directly skips a pnpm process launch (~280ms per call).
    join(projectRoot, 'node_modules/kysely-codegen/dist/cli/bin.js'),
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
  const result = await exec(process.execPath, args, {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_URL: url },
  });
  return result.stdout.trim();
}

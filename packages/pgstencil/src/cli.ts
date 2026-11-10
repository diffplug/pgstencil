#!/usr/bin/env node
/**
 * The `pgstencil` command. Arguments are parsed before pgstencil.json or any
 * tooling peer loads, so `pgstencil help` and usage errors work in a project
 * whose configuration is broken.
 */
import { parseArguments, usage, UsageError } from './arguments.ts';

/** Runs the command line `argv` and returns the process exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  let command;
  try {
    command = parseArguments(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`pgstencil: ${error.message}\n\n${usage}`);
    return 2;
  }
  if (command.name === 'help') {
    console.log(usage);
    return 0;
  }
  try {
    const { runCommand } = await import('./commands.ts');
    await runCommand(command);
    return 0;
  } catch (error) {
    console.error(`pgstencil ${command.name}: ${(error as Error).message}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));

/**
 * `agent-loop` CLI entry point.
 *
 * commander parses argv and dispatches to one of five subcommands. Each
 * command lives in its own module and returns a Promise<number> (exit code).
 * The handler here awaits that, calls process.exit() with the code.
 */

import { Command } from 'commander';
import { start } from './commands/start.js';
import { list } from './commands/list.js';
import { inspect } from './commands/inspect.js';
import { stop } from './commands/stop.js';
import { status } from './commands/status.js';

async function main(argv: string[]): Promise<number> {
  const program = new Command();
  program
    .name('agent-loop')
    .description('Orchestrator for autonomous coding agents')
    .version('0.0.1');

  program
    .command('start')
    .description('Start a new run against a target repo')
    .requiredOption('--spec <name>', 'Name of a registered spec')
    .requiredOption('--target <path>', 'Path to the target git repo')
    .action(async (opts) => {
      process.exit(await start({ spec: opts.spec, target: opts.target }));
    });

  program
    .command('list')
    .description('List all runs and their phases')
    .action(async () => {
      process.exit(await list());
    });

  program
    .command('inspect <runId>')
    .description("Show a run's full history (spec, verdicts, events)")
    .action(async (runId: string) => {
      process.exit(await inspect(runId));
    });

  program
    .command('stop')
    .description('Touch the STOP file to halt the loop between phases')
    .option('--clear', 'Remove an existing STOP file instead', false)
    .action(async (opts) => {
      process.exit(await stop({ clear: Boolean(opts.clear) }));
    });

  program
    .command('status')
    .description('Show the current non-terminal run, if any')
    .action(async () => {
      process.exit(await status());
    });

  await program.parseAsync(argv);
  return 0;
}

main(process.argv).catch((err) => {
  process.stderr.write(`agent-loop: ${String(err)}\n`);
  process.exit(2);
});

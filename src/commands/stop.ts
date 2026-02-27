import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getServerStatus, stopServer } from '../utils/process-manager.js';

export function createStopCommand(): Command {
  const cmd = new Command('stop');
  
  cmd
    .description('Stop the running llama-server')
    .option('-f, --force', 'Force stop (SIGKILL)')
    .action(async (options) => {
      try {
        await runStop(options.force);
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exit(1);
      }
    });
  
  return cmd;
}

async function runStop(force = false): Promise<void> {
  const status = getServerStatus();
  
  if (!status.running) {
    console.log(chalk.yellow('Server is not running'));
    return;
  }
  
  console.log(chalk.cyan(`Stopping server (PID: ${status.pid})...`));
  
  const spinner = ora(force ? 'Force stopping...' : 'Stopping...').start();
  
  try {
    await stopServer(force);
    spinner.succeed(chalk.green('Server stopped successfully'));
  } catch (err) {
    spinner.fail(chalk.red('Failed to stop server'));
    throw err;
  }
}

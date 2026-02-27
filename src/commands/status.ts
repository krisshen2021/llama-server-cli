import { Command } from 'commander';
import chalk from 'chalk';
import { basename } from 'path';
import { getServerStatus, getLogFile, readLastLogs } from '../utils/process-manager.js';

export function createStatusCommand(): Command {
  const cmd = new Command('status');
  
  cmd
    .description('Show llama-server status')
    .option('-l, --logs [lines]', 'Show last N lines of logs', '20')
    .action(async (options) => {
      try {
        await runStatus(options);
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exit(1);
      }
    });
  
  return cmd;
}

async function runStatus(options: { logs?: string }): Promise<void> {
  const status = getServerStatus();
  
  console.log();
  console.log(chalk.cyan('=== llama-server Status ==='));
  console.log();
  
  if (!status.running) {
    console.log(chalk.yellow('  Status:  ') + chalk.red('Not running'));
    console.log();
    console.log(chalk.gray(`Use ${chalk.white('lsc start')} to start the server`));
    return;
  }
  
  console.log(chalk.yellow('  Status:  ') + chalk.green('Running'));
  console.log(chalk.yellow('  PID:     ') + chalk.white(status.pid));
  console.log(chalk.yellow('  Model:   ') + chalk.white(basename(status.model || '')));
  console.log(chalk.yellow('  Port:    ') + chalk.white(status.port));
  
  if (status.startTime) {
    const uptime = formatUptime(Date.now() - status.startTime.getTime());
    console.log(chalk.yellow('  Uptime:  ') + chalk.white(uptime));
  }
  
  console.log(chalk.yellow('  URL:     ') + chalk.blue(`http://localhost:${status.port}`));
  console.log(chalk.yellow('  Logs:    ') + chalk.gray(getLogFile()));
  
  // 显示日志
  if (options.logs) {
    const lines = parseInt(options.logs) || 20;
    const logs = readLastLogs(lines);
    
    if (logs) {
      console.log();
      console.log(chalk.cyan(`=== Last ${lines} lines of logs ===`));
      console.log();
      console.log(chalk.gray(logs));
    }
  }
  
  console.log();
  console.log(chalk.gray(`Use ${chalk.white('lsc stop')} to stop the server`));
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

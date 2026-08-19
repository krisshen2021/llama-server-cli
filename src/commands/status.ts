import { Command } from 'commander';
import chalk from 'chalk';
import { basename } from 'path';
import { getServerStatus, getLogFile, readLastLogs } from '../utils/process-manager.js';
import { parseIntOpt } from '../utils/server-options.js';
import { formatUptime } from '../utils/format.js';

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

async function runStatus(options: { logs?: string | boolean }): Promise<void> {
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
  
  // 经代理启动时对外服务端口是代理端口;只展示内部端口会引导调用方绕过代理(请求日志窗口收不到流量)
  const viaProxy = status.proxy === true && typeof status.publicPort === 'number';
  console.log(chalk.yellow('  Status:  ') + chalk.green('Running'));
  console.log(chalk.yellow('  PID:     ') + chalk.white(status.pid));
  console.log(chalk.yellow('  Model:   ') + chalk.white(basename(status.model || '')));
  console.log(chalk.yellow('  Port:    ') + chalk.white(viaProxy ? `${status.publicPort} (proxy → ${status.port} internal)` : status.port));
  
  if (status.startTime) {
    const uptime = formatUptime(Date.now() - status.startTime.getTime());
    console.log(chalk.yellow('  Uptime:  ') + chalk.white(uptime));
  }
  
  console.log(chalk.yellow('  URL:     ') + chalk.blue(`http://localhost:${viaProxy ? status.publicPort : status.port}`));
  console.log(chalk.yellow('  Logs:    ') + chalk.gray(getLogFile()));
  
  // 显示日志
  if (options.logs) {
    // --logs 不带值时 commander 给 true,回退默认 20 行
    const lines = options.logs === true ? 20 : parseIntOpt(options.logs);
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

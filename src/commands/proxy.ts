import { Command } from 'commander';
import chalk from 'chalk';
import { startRequestLogger } from '../utils/request-logger.js';
import { parseIntOpt } from '../utils/server-options.js';
import { getExpandedConfig } from '../utils/config-manager.js';

// proxy 命令是 request-logger 的薄封装:转发/日志实现统一在 utils/request-logger.ts
export function createProxyCommand(): Command {
  const cmd = new Command('proxy');

  cmd
    .description('Start a proxy server to log requests to llama-server')
    .option('-p, --port <port>', 'Proxy listen port', parseIntOpt)
    .option('-t, --target <url>', 'Target llama-server URL')
    .option('--no-body', 'Do not show request body')
    .option('--show-response', 'Show response body')
    .option('--max-body <length>', 'Max body length to display', parseIntOpt)
    .action(async (options) => {
      try {
        const config = getExpandedConfig();
        // 默认:代理监听 defaultPort+1(8081),转发到 defaultPort(8080)上已在跑的 llama-server
        const listenPort: number = options.port ?? config.defaultPort + 1;
        const targetUrl = new URL(options.target ?? `http://127.0.0.1:${config.defaultPort}`);
        // 转发引擎只讲明文 HTTP,https 目标只会在每请求时 502,提前报清原因
        if (targetUrl.protocol !== 'http:') {
          throw new Error(`--target must use http:// (got ${targetUrl.protocol}//; TLS targets are not supported)`);
        }
        // IPv6 字面量的 hostname 带方括号('[::1]'),http.request/DNS 需要裸地址
        const targetHost = targetUrl.hostname.replace(/^\[|\]$/g, '');

        await startRequestLogger({
          listenPort,
          targetHost,
          targetPort: targetUrl.port ? Number(targetUrl.port) : 80,
          showBody: options.body !== false,
          showResponse: options.showResponse ?? false,
          // 未传 --max-body 时不覆盖,沿用 request-logger 默认 4000
          ...(options.maxBody !== undefined ? { maxBodyLength: options.maxBody } : {}),
        });
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exit(1);
      }
    });

  return cmd;
}

import { Command } from 'commander';
import chalk from 'chalk';
import http from 'http';
import { URL } from 'url';

interface ProxyOptions {
  port: string;
  target: string;
  showBody: boolean;
  showResponse: boolean;
  maxBodyLength: number;
}

export function createProxyCommand(): Command {
  const cmd = new Command('proxy');
  
  cmd
    .description('Start a proxy server to log requests to llama-server')
    .option('-p, --port <port>', 'Proxy listen port', '8081')
    .option('-t, --target <url>', 'Target llama-server URL', 'http://127.0.0.1:8080')
    .option('--no-body', 'Do not show request body')
    .option('--no-response', 'Do not show response body')
    .option('--max-body <length>', 'Max body length to display', '2000')
    .action(async (options) => {
      try {
        await runProxy({
          port: options.port,
          target: options.target,
          showBody: options.body !== false,
          showResponse: options.response !== false,
          maxBodyLength: parseInt(options.maxBody) || 2000,
        });
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exit(1);
      }
    });
  
  return cmd;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + chalk.gray(`... (${str.length - maxLen} more chars)`);
}

function formatJson(str: string): string {
  try {
    const obj = JSON.parse(str);
    return JSON.stringify(obj, null, 2);
  } catch {
    return str;
  }
}

function formatTimestamp(): string {
  const now = new Date();
  return chalk.gray(`[${now.toLocaleTimeString()}]`);
}

async function runProxy(options: ProxyOptions): Promise<void> {
  const targetUrl = new URL(options.target);
  let requestCount = 0;
  
  const server = http.createServer((req, res) => {
    const reqId = ++requestCount;
    const startTime = Date.now();
    
    let requestBody = '';
    
    req.on('data', (chunk) => {
      requestBody += chunk.toString();
    });
    
    req.on('end', () => {
      // 打印请求信息
      console.log();
      console.log(chalk.cyan('═'.repeat(60)));
      console.log(`${formatTimestamp()} ${chalk.green('REQUEST')} #${reqId} ${chalk.yellow(req.method)} ${chalk.white(req.url)}`);
      console.log(chalk.cyan('─'.repeat(60)));
      
      // 打印请求头
      const contentType = req.headers['content-type'] || '';
      console.log(chalk.gray('Headers:'));
      console.log(chalk.gray(`  Content-Type: ${contentType}`));
      console.log(chalk.gray(`  Content-Length: ${req.headers['content-length'] || 0}`));
      
      // 打印请求体
      if (options.showBody && requestBody) {
        console.log();
        console.log(chalk.yellow('Request Body:'));
        const formatted = formatJson(requestBody);
        console.log(truncate(formatted, options.maxBodyLength));
      }
      
      // 转发请求到 llama-server
      const proxyReq = http.request({
        hostname: targetUrl.hostname,
        port: targetUrl.port || 80,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: targetUrl.host,
        },
      }, (proxyRes) => {
        const elapsed = Date.now() - startTime;
        
        // 收集响应
        let responseBody = '';
        const isStreaming = proxyRes.headers['content-type']?.includes('text/event-stream');
        
        proxyRes.on('data', (chunk) => {
          responseBody += chunk.toString();
          res.write(chunk);
        });
        
        proxyRes.on('end', () => {
          res.end();
          
          // 打印响应信息
          console.log();
          console.log(chalk.cyan('─'.repeat(60)));
          const statusColor = proxyRes.statusCode === 200 ? chalk.green : chalk.red;
          console.log(`${formatTimestamp()} ${chalk.magenta('RESPONSE')} #${reqId} ${statusColor(proxyRes.statusCode)} (${elapsed}ms)`);
          
          if (options.showResponse && responseBody && !isStreaming) {
            console.log();
            console.log(chalk.yellow('Response Body:'));
            const formatted = formatJson(responseBody);
            console.log(truncate(formatted, options.maxBodyLength));
          } else if (isStreaming) {
            console.log(chalk.gray(`  (streaming response, ${responseBody.length} bytes total)`));
          }
          
          console.log(chalk.cyan('═'.repeat(60)));
        });
        
        // 转发响应头
        res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
      });
      
      proxyReq.on('error', (err) => {
        console.error(chalk.red(`  Proxy error: ${err.message}`));
        res.writeHead(502);
        res.end('Bad Gateway');
      });
      
      // 发送请求体
      if (requestBody) {
        proxyReq.write(requestBody);
      }
      proxyReq.end();
    });
  });
  
  server.listen(parseInt(options.port), () => {
    console.log();
    console.log(chalk.cyan('=== LSC Proxy Server ==='));
    console.log();
    console.log(chalk.yellow('  Listening:  ') + chalk.white(`http://127.0.0.1:${options.port}`));
    console.log(chalk.yellow('  Target:     ') + chalk.white(options.target));
    console.log(chalk.yellow('  Show Body:  ') + chalk.white(options.showBody ? 'yes' : 'no'));
    console.log(chalk.yellow('  Show Resp:  ') + chalk.white(options.showResponse ? 'yes' : 'no'));
    console.log();
    console.log(chalk.gray('Press Ctrl+C to stop'));
    console.log();
    console.log(chalk.green('Waiting for requests...'));
  });
  
  // 保持运行
  await new Promise(() => {});
}

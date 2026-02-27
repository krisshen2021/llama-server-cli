import http from 'http';
import chalk from 'chalk';

export type LogCallback = (message: string, type?: 'info' | 'request' | 'response' | 'error') => void;

export interface RequestLoggerOptions {
  listenPort: number;
  targetPort: number;
  targetHost: string;
  showBody: boolean;
  showResponse: boolean;
  maxBodyLength: number;
  onLog?: LogCallback; // 日志回调，用于 TUI
}

const DEFAULT_OPTIONS: RequestLoggerOptions = {
  listenPort: 8080,
  targetPort: 8081,
  targetHost: '127.0.0.1',
  showBody: true,
  showResponse: false,
  maxBodyLength: 4000,
  onLog: undefined,
};

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + chalk.gray(`\n... (${str.length - maxLen} more chars)`);
}

function formatJson(str: string, indent = 2): string {
  try {
    const obj = JSON.parse(str);
    // 对于 messages 数组，特殊处理以便更好地显示
    if (obj.messages && Array.isArray(obj.messages)) {
      const summary = {
        ...obj,
        messages: obj.messages.map((m: any) => ({
          role: m.role,
          content: typeof m.content === 'string' 
            ? (m.content.length > 200 ? m.content.slice(0, 200) + '...' : m.content)
            : m.content,
        })),
      };
      return JSON.stringify(summary, null, indent);
    }
    return JSON.stringify(obj, null, indent);
  } catch {
    return str;
  }
}

function formatTimestamp(): string {
  const now = new Date();
  return chalk.gray(`[${now.toLocaleTimeString()}]`);
}

export function createRequestLogger(options: Partial<RequestLoggerOptions> = {}): http.Server {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let requestCount = 0;

  // 日志输出函数：支持回调或直接 console
  const log = (msg: string, type: 'info' | 'request' | 'response' | 'error' = 'info') => {
    if (opts.onLog) {
      opts.onLog(msg, type);
    } else {
      console.log(msg);
    }
  };

  const server = http.createServer((req, res) => {
    const reqId = ++requestCount;
    const startTime = Date.now();

    let requestBody = '';

    req.on('data', (chunk) => {
      requestBody += chunk.toString();
    });

    req.on('end', () => {
      // 构建请求日志
      const lines: string[] = [];
      lines.push(`═══ REQUEST #${reqId} ═══`);
      lines.push(`${formatTimestamp()} ${req.method} ${req.url}`);

      // 解析请求体摘要
      if (opts.showBody && requestBody) {
        try {
          const body = JSON.parse(requestBody);
          if (body.model) lines.push(`  model: ${body.model}`);
          if (body.max_tokens) lines.push(`  max_tokens: ${body.max_tokens}`);
          if (body.temperature !== undefined) lines.push(`  temperature: ${body.temperature}`);
          if (body.stream !== undefined) lines.push(`  stream: ${body.stream}`);
          
          if (body.messages && Array.isArray(body.messages)) {
            lines.push(`  messages: (${body.messages.length} items)`);
            body.messages.forEach((m: any, i: number) => {
              const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
              const preview = content.length > 80 ? content.slice(0, 80) + '...' : content;
              lines.push(`    [${i}] ${m.role}: ${preview.replace(/\n/g, '\\n')}`);
            });
          }
        } catch {
          lines.push(`  body: ${truncate(requestBody, 200)}`);
        }
      }

      log(lines.join('\n'), 'request');

      // 转发请求到 llama-server
      const proxyReq = http.request(
        {
          hostname: opts.targetHost,
          port: opts.targetPort,
          path: req.url,
          method: req.method,
          headers: {
            ...req.headers,
            host: `${opts.targetHost}:${opts.targetPort}`,
          },
        },
        (proxyRes) => {
          const elapsed = Date.now() - startTime;
          const isStreaming = proxyRes.headers['content-type']?.includes('text/event-stream');

          let responseBody = '';
          let tokenCount = 0;

          proxyRes.on('data', (chunk) => {
            responseBody += chunk.toString();
            res.write(chunk);
            
            if (isStreaming) {
              const chunkLines = chunk.toString().split('\n');
              for (const line of chunkLines) {
                if (line.startsWith('data: ') && !line.includes('[DONE]')) {
                  try {
                    const data = JSON.parse(line.slice(6));
                    if (data.choices?.[0]?.delta?.content) {
                      tokenCount++;
                    }
                  } catch {}
                }
              }
            }
          });

          proxyRes.on('end', () => {
            res.end();

            // 构建响应日志
            const respLines: string[] = [];
            const status = proxyRes.statusCode || 500;
            respLines.push(`─── RESPONSE #${reqId} ───`);
            respLines.push(`${formatTimestamp()} ${status} (${elapsed}ms)`);

            if (isStreaming) {
              respLines.push(`  streaming, ~${tokenCount} chunks`);
            } else {
              try {
                const resp = JSON.parse(responseBody);
                if (resp.usage) {
                  respLines.push(`  tokens: prompt=${resp.usage.prompt_tokens}, completion=${resp.usage.completion_tokens}`);
                }
                if (resp.choices?.[0]?.message?.content) {
                  const content = resp.choices[0].message.content;
                  const preview = content.length > 80 ? content.slice(0, 80) + '...' : content;
                  respLines.push(`  content: ${preview.replace(/\n/g, '\\n')}`);
                }
              } catch {}
            }

            log(respLines.join('\n'), 'response');
          });

          res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
        }
      );

      proxyReq.on('error', (err) => {
        log(`Proxy error: ${err.message}`, 'error');
        res.writeHead(502);
        res.end('Bad Gateway');
      });

      if (requestBody) {
        proxyReq.write(requestBody);
      }
      proxyReq.end();
    });
  });

  return server;
}

export function startRequestLogger(options: Partial<RequestLoggerOptions> = {}): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const server = createRequestLogger(opts);

    server.on('error', reject);

    server.listen(opts.listenPort, () => {
      console.log();
      console.log(chalk.cyan('=== Request Logger Enabled ==='));
      console.log(chalk.gray(`  Proxy listening on port ${opts.listenPort}, forwarding to ${opts.targetPort}`));
      console.log(chalk.gray(`  Set LSC_FULL_BODY=1 to see full request bodies`));
      console.log();
      resolve(server);
    });
  });
}

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
    let clientGone = false;
    let proxyReq: http.ClientRequest | undefined;

    // 客户端连接断开：标记并终止上游请求（如 llama-server 正在生成），避免无效工作
    res.on('close', () => {
      if (!res.writableEnded) {
        clientGone = true;
        proxyReq?.destroy();
      }
    });
    res.on('error', (err) => {
      log(`Client connection error: ${err.message}`, 'error');
    });

    // 以 Buffer 数组收集请求体：多字节 UTF-8 字符可能跨 TCP chunk，
    // 逐 chunk toString 会把字符拆成 U+FFFD，破坏转发内容的字节一致性
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (clientGone || res.destroyed) return; // 客户端已断开，不再转发

      const body = Buffer.concat(chunks);
      chunks.length = 0; // 释放 chunk 引用，长响应期间不再占用内存

      // 构建请求日志
      const lines: string[] = [];
      lines.push(`═══ REQUEST #${reqId} ═══`);
      lines.push(`${formatTimestamp()} ${req.method} ${req.url}`);

      // 解析请求体摘要（完整解码仅存在于本帧内，不进入任何闭包）
      if (opts.showBody && body.length > 0) {
        const bodyStr = body.toString('utf8');
        try {
          const parsed = JSON.parse(bodyStr);
          if (parsed.model) lines.push(`  model: ${parsed.model}`);
          if (parsed.max_tokens) lines.push(`  max_tokens: ${parsed.max_tokens}`);
          if (parsed.temperature !== undefined) lines.push(`  temperature: ${parsed.temperature}`);
          if (parsed.stream !== undefined) lines.push(`  stream: ${parsed.stream}`);

          if (parsed.messages && Array.isArray(parsed.messages)) {
            lines.push(`  messages: (${parsed.messages.length} items)`);
            parsed.messages.forEach((m: any, i: number) => {
              const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
              const preview = content.length > 80 ? content.slice(0, 80) + '...' : content;
              lines.push(`    [${i}] ${m.role}: ${preview.replace(/\n/g, '\\n')}`);
            });
          }
        } catch {
          // 非 JSON 请求体按 maxBodyLength 截断展示(CLI --max-body 可控)
          lines.push(`  body: ${truncate(bodyStr, opts.maxBodyLength)}`);
        }
      }

      log(lines.join('\n'), 'request');

      // 转发请求到 llama-server：转发 Buffer 本体，content-length 按实际字节数设置
      const headers: http.OutgoingHttpHeaders = {
        ...req.headers,
        host: `${opts.targetHost}:${opts.targetPort}`,
      };
      delete headers['transfer-encoding']; // body 已收全，改用显式 content-length
      if (body.length > 0) {
        headers['content-length'] = body.length;
      } else {
        delete headers['content-length'];
      }

      proxyReq = http.request(
        {
          hostname: opts.targetHost,
          port: opts.targetPort,
          path: req.url,
          method: req.method,
          headers,
        },
        (proxyRes) => {
          const elapsed = Date.now() - startTime;
          const isStreaming = proxyRes.headers['content-type']?.includes('text/event-stream');

          // 仅在 showResponse 且非流式时收集响应体（仅展示用）；
          // 流式响应只统计 chunk 数，收集的 body 永远不会被读取，不攒内存
          const respChunks: Buffer[] = [];
          let tokenCount = 0;

          proxyRes.on('data', (chunk: Buffer) => {
            if (opts.showResponse && !isStreaming) respChunks.push(chunk);
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
            } else if (opts.showResponse && respChunks.length > 0) {
              const responseBody = Buffer.concat(respChunks).toString('utf8');
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
              } catch {
                // 非 JSON 响应体按 maxBodyLength 截断展示(CLI --max-body 可控)
                respLines.push(`  body: ${truncate(responseBody, opts.maxBodyLength)}`);
              }
            }

            log(respLines.join('\n'), 'response');
          });

          // 上游响应中途出错（如 llama-server 进程崩溃），销毁客户端连接，避免进程崩溃
          proxyRes.on('error', (err) => {
            if (clientGone) {
              log(`─── RESPONSE #${reqId} aborted: client disconnected`, 'info');
            } else {
              log(`Upstream response error: ${err.message}`, 'error');
            }
            if (!res.writableEnded) res.destroy();
          });

          res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
        }
      );

      proxyReq.on('error', (err) => {
        if (clientGone || res.destroyed) return; // 客户端已断开，只需静默清理
        log(`Proxy error: ${err.message}`, 'error');
        if (!res.headersSent) res.writeHead(502);
        if (!res.writableEnded) res.end(`Proxy error: ${err.message}`);
      });

      if (body.length > 0) {
        proxyReq.write(body);
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
      console.log();
      resolve(server);
    });
  });
}

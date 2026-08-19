import http from 'http';
import https from 'https';

export interface HttpRequestOptions {
  headers?: Record<string, string>;
  timeout?: number;          // 默认 30s 空闲超时
  maxRedirects?: number;     // 默认 5
  token?: string;            // Bearer token,仅发往可信域名
}

export interface HttpRequestHandlers {
  onResponse: (res: http.IncomingMessage) => void;
  onError: (err: Error) => void;
}

// 调用方句柄:destroy() 先经 onError 通知(仅一次)再杀掉当前在途 hop,
// 重定向链上后续 hop 同样受其控(如 hf-api 的响应超上限中止)
export interface HttpRequestHandle {
  destroy: (err?: Error) => void;
}

export function isTrustedHost(hostname: string): boolean {
  return hostname === 'huggingface.co'
    || hostname.endsWith('.huggingface.co')
    || hostname === 'hf.co'
    || hostname.endsWith('.hf.co');
}

// 统一的 request 封装:每跳空闲超时、重定向上限、token 域名校阅、重定向响应体消费
// 每个 hop 都由本函数自己 end()(这些 GET 永远没有请求体);
// 任意 hop 的错误都经 onError 上抛且仅一次;onResponse 交付后响应流归调用方
export function httpRequestWithRedirects(
  url: string,
  options: HttpRequestOptions,
  handlers: HttpRequestHandlers,
): HttpRequestHandle {
  let currentReq: http.ClientRequest | null = null;
  let settled = false;

  const fail = (err: Error): void => {
    if (settled) return;
    settled = true;
    handlers.onError(err);
  };

  const doRequest = (target: string, redirects: number): void => {
    if (settled) return;
    const u = new URL(target);
    const headers = { ...options.headers };
    if (options.token && isTrustedHost(u.hostname)) {
      headers['Authorization'] = `Bearer ${options.token}`;
    }
    // http 分支仅供本地回环测试;生产 URL 均为 https
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(target, { headers }, (res) => {
      if (settled) {
        res.resume();
        return;
      }
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume(); // 消费响应体,释放 socket
        if (redirects >= (options.maxRedirects ?? 5)) {
          fail(new Error('Too many redirects'));
          return;
        }
        // Location 由服务器控制,畸形值会让 new URL 抛 TypeError,路由到 onError 而不是崩溃
        let next: string;
        try {
          next = new URL(res.headers.location, target).toString();
        } catch {
          fail(new Error('Invalid redirect location'));
          return;
        }
        doRequest(next, redirects + 1);
        return;
      }
      handlers.onResponse(res);
    });
    currentReq = req;
    req.on('error', fail);
    req.setTimeout(options.timeout ?? 30_000, () => {
      req.destroy(new Error('Request timed out'));
    });
    req.end();
  };

  doRequest(url, 0);

  return {
    destroy: (err?: Error): void => {
      // 先通知再杀 socket:调用方主动中止也能拿到错误原因
      fail(err ?? new Error('Request aborted'));
      currentReq?.destroy();
    },
  };
}

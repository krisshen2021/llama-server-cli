import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { httpRequestWithRedirects, isTrustedHost } from './http.js';

// 本地回环测试服务器
interface TestServer {
  url: string;
  close: () => Promise<void>;
}

async function startTestServer(handler: http.RequestListener): Promise<TestServer> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// 走完整请求并收集响应体(短超时,失败快速暴露而不是挂死测试)
function fetchBody(
  url: string,
  options: { token?: string; timeout?: number } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    httpRequestWithRedirects(url, { timeout: 2000, ...options }, {
      onResponse: (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        res.on('error', reject);
      },
      onError: reject,
    });
  });
}

describe('httpRequestWithRedirects', () => {
  let server: TestServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('无重定向:直接返回响应体', async () => {
    server = await startTestServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello');
    });
    const r = await fetchBody(`${server.url}/x`);
    expect(r.status).toBe(200);
    expect(r.body).toBe('hello');
  });

  it('302 重定向链:跟随并返回最终响应体', async () => {
    server = await startTestServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/final' });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end('final-body');
    });
    const r = await fetchBody(`${server.url}/redirect`);
    expect(r.status).toBe(200);
    expect(r.body).toBe('final-body');
  });

  it('重定向循环:报 Too many redirects,不挂起', async () => {
    server = await startTestServer((_req, res) => {
      res.writeHead(302, { location: '/loop' });
      res.end();
    });
    await expect(fetchBody(`${server.url}/loop`)).rejects.toThrow('Too many redirects');
  });

  it('畸形 Location:报 Invalid redirect location,不崩溃', async () => {
    server = await startTestServer((_req, res) => {
      res.writeHead(302, { location: 'http://[::1' });
      res.end();
    });
    await expect(fetchBody(`${server.url}/bad-location`)).rejects.toThrow('Invalid redirect location');
  });

  it('第二跳超时(慢响应):onError 收到 Request timed out,不崩溃', async () => {
    server = await startTestServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/slow' });
        res.end();
        return;
      }
      // /slow 永不写响应,socket 保持挂起
    });
    await expect(fetchBody(`${server.url}/redirect`, { timeout: 100 }))
      .rejects.toThrow('Request timed out');
  });

  it('调用方 destroy 中止重定向链:onError 恰好一次,带调用方错误', async () => {
    server = await startTestServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/slow' });
        res.end();
        return;
      }
      // /slow 永不写响应,socket 保持挂起
    });
    let errorCount = 0;
    await new Promise<void>((resolve) => {
      const handle = httpRequestWithRedirects(`${server.url}/redirect`, { timeout: 5000 }, {
        onResponse: () => {},
        onError: (err) => {
          errorCount++;
          expect(err.message).toBe('caller abort');
          resolve();
        },
      });
      // 等第一跳的 302 被 follow、第二跳挂起后再中止
      setTimeout(() => handle.destroy(new Error('caller abort')), 50);
    });
    // 再等一拍:确认 socket 销毁没有引发第二次 onError
    await new Promise((r) => setTimeout(r, 100));
    expect(errorCount).toBe(1);
  });

  it('token 不发给不可信主机(本地回环)', async () => {
    let authSeen: string | undefined;
    server = await startTestServer((req, res) => {
      authSeen = req.headers.authorization;
      res.writeHead(200);
      res.end('ok');
    });
    await fetchBody(`${server.url}/`, { token: 'secret-token' });
    expect(authSeen).toBeUndefined();
  });
});

describe('isTrustedHost', () => {
  it('可信域名', () => {
    expect(isTrustedHost('huggingface.co')).toBe(true);
    expect(isTrustedHost('api.huggingface.co')).toBe(true);
    expect(isTrustedHost('hf.co')).toBe(true);
    expect(isTrustedHost('cdn.hf.co')).toBe(true);
  });

  it('不可信域名(含形似域名)', () => {
    expect(isTrustedHost('evilhuggingface.co')).toBe(false);
    expect(isTrustedHost('huggingface.co.evil.com')).toBe(false);
    expect(isTrustedHost('hf.co.evil.com')).toBe(false);
    expect(isTrustedHost('127.0.0.1')).toBe(false);
  });
});

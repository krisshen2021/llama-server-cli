import { describe, it, expect } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { DownloadManager, planResume } from './downloader.js';

describe('planResume', () => {
  it('无本地字节:从头下载,truncate 模式', () => {
    expect(planResume(0, 200, 1000)).toEqual({ action: 'download', offset: 0, flags: 'w' });
  });

  it('有本地字节且服务器返回 206:从断点续传,append', () => {
    expect(planResume(400, 206, 1000)).toEqual({ action: 'download', offset: 400, flags: 'a' });
  });

  it('有本地字节但服务器忽略 Range 返回 200:截断重下', () => {
    expect(planResume(400, 200, 1000)).toEqual({ action: 'download', offset: 0, flags: 'w' });
  });

  it('期望大小未知时 206:仍按磁盘大小 append', () => {
    expect(planResume(400, 206, undefined)).toEqual({ action: 'download', offset: 400, flags: 'a' });
  });

  it('416 且本地已达期望大小:视为完成', () => {
    expect(planResume(1000, 416, 1000)).toEqual({ action: 'complete' });
  });

  it('416 但本地大小与期望不符:删除重下', () => {
    expect(planResume(1500, 416, 1000)).toEqual({ action: 'restart' });
    expect(planResume(0, 416, 1000)).toEqual({ action: 'restart' });
  });

  it('期望大小未知时 416:删除重下(无法确认完整)', () => {
    expect(planResume(1000, 416, undefined)).toEqual({ action: 'restart' });
  });

  it('本地字节 >= 期望大小(非 416):删除重下', () => {
    expect(planResume(1000, 200, 1000)).toEqual({ action: 'restart' });
  });

  it('本地字节恰好等于期望大小且 206:边界按 >= 处理,删除重下', () => {
    expect(planResume(1000, 206, 1000)).toEqual({ action: 'restart' });
  });
});

// --- 集成测试:localhost 服务器,验证取消/暂停/重试的调度行为 ---

const CHUNK = 64 * 1024;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await sleep(10);
  }
}

interface TestServer {
  url: string;
  getRequestCount: () => number;
  close: () => Promise<void>;
}

// 限速流式服务器;sabotageFirst 时第一个请求写两块后销毁 socket 模拟中途断连
async function startStreamingServer(size: number, sabotageFirst = false): Promise<TestServer> {
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    requestCount++;
    res.writeHead(200, { 'Content-Length': size, 'Content-Type': 'application/octet-stream' });
    res.on('error', () => {});

    if (sabotageFirst && requestCount === 1) {
      res.write(Buffer.alloc(CHUNK));
      res.write(Buffer.alloc(CHUNK));
      setTimeout(() => req.socket.destroy(), 30);
      return;
    }

    let sent = 0;
    const interval = setInterval(() => {
      const n = Math.min(CHUNK, size - sent);
      sent += n;
      if (sent >= size) {
        clearInterval(interval);
        res.end(Buffer.alloc(n));
      } else {
        res.write(Buffer.alloc(n));
      }
    }, 10);
    res.on('close', () => clearInterval(interval));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/model.gguf`,
    getRequestCount: () => requestCount,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

describe('DownloadManager 集成(本地服务器)', () => {
  it('cancelTasks 中途取消:不调度重试,服务器只收到一次请求', async () => {
    const size = 5 * 1024 * 1024;
    const srv = await startStreamingServer(size);
    const dir = mkdtempSync(join(tmpdir(), 'lsc-dl-'));
    try {
      const manager = new DownloadManager({ retryDelay: 50, retryCount: 3 });
      const id = manager.addTask({
        url: srv.url,
        destPath: join(dir, 'model.gguf'),
        filename: 'model.gguf',
        expectedSize: size,
      });
      const done = manager.start();

      await waitFor(() => srv.getRequestCount() === 1);
      await sleep(50); // 让流真正开始
      manager.cancelTasks([id]);
      await done;

      // 等远超 retryDelay,确认没有任何重试被调度
      await sleep(200);
      const task = manager.getTasks().find(t => t.id === id)!;
      expect(task.status).toBe('failed');
      expect(task.error).toBe('Cancelled');
      expect(srv.getRequestCount()).toBe(1);
    } finally {
      await srv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pause 中途暂停:不消耗重试;resume 后续传完成', async () => {
    const size = 5 * 1024 * 1024;
    const srv = await startStreamingServer(size);
    const dir = mkdtempSync(join(tmpdir(), 'lsc-dl-'));
    try {
      const manager = new DownloadManager({ retryDelay: 50, retryCount: 3 });
      const destPath = join(dir, 'model.gguf');
      const id = manager.addTask({
        url: srv.url,
        destPath,
        filename: 'model.gguf',
        expectedSize: size,
      });
      const done = manager.start();

      await waitFor(() => srv.getRequestCount() === 1);
      await sleep(50);
      manager.pause();

      // 超过 retryDelay,确认暂停没有触发重试
      await sleep(200);
      expect(srv.getRequestCount()).toBe(1);
      expect(manager.getTasks().find(t => t.id === id)!.status).toBe('paused');

      await manager.resume();
      await done;

      const task = manager.getTasks().find(t => t.id === id)!;
      expect(task.status).toBe('completed');
      // 恰好两次请求:首次 + 恢复(服务器忽略 Range → 截断重下)
      expect(srv.getRequestCount()).toBe(2);
      expect(statSync(destPath).size).toBe(size);
    } finally {
      await srv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('中途断连:req/res 双 error 也只调度一次重试并最终完成', async () => {
    const size = 2 * 1024 * 1024;
    const srv = await startStreamingServer(size, true);
    const dir = mkdtempSync(join(tmpdir(), 'lsc-dl-'));
    try {
      const manager = new DownloadManager({ retryDelay: 50, retryCount: 3 });
      const destPath = join(dir, 'model.gguf');
      const id = manager.addTask({
        url: srv.url,
        destPath,
        filename: 'model.gguf',
        expectedSize: size,
      });
      const done = manager.start();
      await done;

      const task = manager.getTasks().find(t => t.id === id)!;
      expect(task.status).toBe('completed');
      // 若一次断连调度了多个重试,这里会看到 >2 个请求
      expect(srv.getRequestCount()).toBe(2);
      expect(statSync(destPath).size).toBe(size);
    } finally {
      await srv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

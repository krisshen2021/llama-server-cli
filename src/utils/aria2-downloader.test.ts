import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import {
  parseAria2ProgressLine,
  isAria2Available,
  Aria2DownloadManager,
} from './aria2-downloader.js';
import type { DownloadMeta } from './download-meta.js';

describe('parseAria2ProgressLine', () => {
  it('标准行:MiB 尺寸 + CN + ETA', () => {
    const s = parseAria2ProgressLine('[#a1b2c3 266MiB/400MiB(66%) CN:16 DL:38MiB ETA:4s]');
    expect(s).not.toBeNull();
    expect(s!.downloadedBytes).toBe(266 * 1024 * 1024);
    expect(s!.totalBytes).toBe(400 * 1024 * 1024);
    expect(s!.speed).toBe(38 * 1024 * 1024);
    expect(s!.connections).toBe(16);
  });

  it('KiB 速度与 GiB 尺寸', () => {
    const s = parseAria2ProgressLine('[#ff00aa 1.5GiB/7.25GiB(20%) CN:8 DL:512KiB ETA:3h25m]');
    expect(s!.downloadedBytes).toBe(Math.round(1.5 * 1024 ** 3));
    expect(s!.totalBytes).toBe(Math.round(7.25 * 1024 ** 3));
    expect(s!.speed).toBe(512 * 1024);
    expect(s!.connections).toBe(8);
  });

  it('B 级小尺寸', () => {
    const s = parseAria2ProgressLine('[#00ff00 512B/2048B(25%) CN:1 DL:100B ETA:15s]');
    expect(s!.downloadedBytes).toBe(512);
    expect(s!.totalBytes).toBe(2048);
    expect(s!.speed).toBe(100);
  });

  it('DL:--(停滞)时速度为 0', () => {
    const s = parseAria2ProgressLine('[#a1b2c3 100KiB/400MiB(0%) CN:1 DL:--]');
    expect(s!.speed).toBe(0);
  });

  it('无 ETA 段也能解析', () => {
    const s = parseAria2ProgressLine('[#a1b2c3 10MiB/400MiB(2%) CN:16 DL:9MiB]');
    expect(s).not.toBeNull();
    expect(s!.downloadedBytes).toBe(10 * 1024 * 1024);
  });

  it('总大小未知(0B/0B):totalBytes 为 undefined', () => {
    const s = parseAria2ProgressLine('[#a1b2c3 0B/0B CN:1 DL:--]');
    expect(s).not.toBeNull();
    expect(s!.totalBytes).toBeUndefined();
  });

  it('非进度行返回 null', () => {
    expect(parseAria2ProgressLine('Download Results:')).toBeNull();
    expect(parseAria2ProgressLine('(OK):download completed.')).toBeNull();
    expect(parseAria2ProgressLine('')).toBeNull();
    expect(parseAria2ProgressLine('08/18 21:00:00 [NOTICE] Downloading 1 item(s)')).toBeNull();
  });
});

// 集成测试:真实 aria2c + 本地限速源,无 aria2c 的环境自动跳过
describe.skipIf(!isAria2Available())('Aria2DownloadManager(集成)', () => {
  const CHUNK = 256 * 1024;

  // 全局令牌桶限速(所有连接共享带宽,模拟真实链路瓶颈),
  // 否则多连接各自全速,测试文件 1s 内下完,--summary-interval=1 的读数行来不及出现
  function startThrottledServer(bytesPerSec: number, total: number): Promise<{ server: http.Server; port: number }> {
    const buf = Buffer.alloc(CHUNK, 7);
    let tokens = 0;
    const tickMs = 50;
    const bytesPerTick = (bytesPerSec * tickMs) / 1000;
    const tokenTimer = setInterval(() => { tokens += bytesPerTick; }, tickMs);
    const server = http.createServer((req, res) => {
      // 支持 aria2 分段下载的有界 Range(bytes=start-end),并回精确的 content-range
      let start = 0;
      let end = total - 1;
      const m = /bytes=(\d+)(?:-(\d+))?/.exec(req.headers.range ?? '');
      if (m) {
        start = parseInt(m[1], 10);
        if (m[2]) end = Math.min(parseInt(m[2], 10), total - 1);
      }
      if (start >= total || start > end) {
        res.writeHead(416, { 'content-range': `bytes */${total}` });
        res.end();
        return;
      }
      const status = m ? 206 : 200;
      const headers: Record<string, string | number> = { 'content-length': end - start + 1 };
      if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${total}`;
      res.writeHead(status, headers);
      let offset = start;
      const pump = () => {
        if (offset > end) { res.end(); return; }
        const n = Math.min(CHUNK, end - offset + 1);
        if (tokens < n) { setTimeout(pump, 10); return; }
        tokens -= n;
        res.write(n === CHUNK ? buf : buf.subarray(0, n));
        offset += n;
        setTimeout(pump, 0);
      };
      pump();
      req.on('close', () => res.destroy());
    });
    server.on('close', () => clearInterval(tokenTimer));
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, port: (server.address() as AddressInfo).port });
      });
    });
  }

  function makeTask(dir: string, port: number, total: number) {
    const destPath = join(dir, 'model.gguf');
    const meta: DownloadMeta = {
      url: `http://127.0.0.1:${port}/big.bin`,
      modelId: 'test/aria2',
      filename: 'model.gguf',
      expectedSize: total,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return { destPath, meta };
  }

  it('完整下载:进度事件带速度,完成后 partial/meta 清理', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lsc-aria2-'));
    const total = 8 * 1024 * 1024; // 8MB
    const { server, port } = await startThrottledServer(4 * 1024 * 1024, total);
    try {
      const { destPath, meta } = makeTask(dir, port, total);
      const m = new Aria2DownloadManager({ maxConcurrent: 1 });
      m.addTask({ url: meta.url, destPath, filename: meta.filename, expectedSize: total, meta });

      let sawSpeed = false;
      m.on('progress', (p) => {
        for (const t of p.tasks) if (t.speed > 0) sawSpeed = true;
      });

      await m.start();

      const task = m.getTasks()[0];
      expect(task.status).toBe('completed');
      expect(statSync(destPath).size).toBe(total);
      expect(existsSync(destPath + '.partial')).toBe(false);
      expect(existsSync(destPath + '.partial.aria2')).toBe(false);
      expect(existsSync(destPath + '.meta.json')).toBe(false);
      expect(sawSpeed).toBe(true);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('无 .aria2 控制文件的 partial(内置下载器遗留):按顺序前缀续传', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lsc-aria2-'));
    const total = 6 * 1024 * 1024;
    const { server, port } = await startThrottledServer(4 * 1024 * 1024, total);
    try {
      const { destPath, meta } = makeTask(dir, port, total);
      // 内置下载器的 partial:文件前 2MB 的连续前缀
      writeFileSync(destPath + '.partial', Buffer.alloc(2 * 1024 * 1024, 7));

      const m = new Aria2DownloadManager({ maxConcurrent: 1 });
      m.addTask({ url: meta.url, destPath, filename: meta.filename, expectedSize: total, meta });
      await m.start();

      const task = m.getTasks()[0];
      expect(task.status).toBe('completed');
      expect(statSync(destPath).size).toBe(total);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('pause 后立即 resume:同一任务不双开,跟踪不丢失(M1 回归)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lsc-aria2-'));
    const total = 12 * 1024 * 1024;
    const { server, port } = await startThrottledServer(4 * 1024 * 1024, total);
    try {
      const { destPath, meta } = makeTask(dir, port, total);
      // maxConcurrent 必须 >1:为 1 时容量检查先于双开拦截,测不出 M1 竞态
      const m = new Aria2DownloadManager({ maxConcurrent: 3 });
      m.addTask({ url: meta.url, destPath, filename: meta.filename, expectedSize: total, meta });
      const started = m.start();
      await new Promise(r => setTimeout(r, 400));

      // pause 后立刻 resume:旧进程 SIGTERM 未 close,不得双开同一任务
      m.pause();
      await m.resume();
      // 等旧进程 close 全部派发完;若无守卫,旧 close 已误删新进程的跟踪条目
      await new Promise(r => setTimeout(r, 500));

      // 第二次 pause:跟踪正常时新进程被杀、任务转 paused;
      // 跟踪丢失时 procs 为空,任务停留在 downloading(本断言即变红)
      m.pause();
      expect(m.getTasks()[0].status).toBe('paused');

      await m.resume();
      await started;

      const task = m.getTasks()[0];
      expect(task.status).toBe('completed');
      expect(statSync(destPath).size).toBe(total);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('取消任务:.partial 保留时控制文件不得删除(带洞 partial 离控即坏,M2 回归)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lsc-aria2-'));
    const total = 12 * 1024 * 1024;
    const { server, port } = await startThrottledServer(4 * 1024 * 1024, total);
    try {
      const { destPath, meta } = makeTask(dir, port, total);
      const m = new Aria2DownloadManager({ maxConcurrent: 1 });
      const id = m.addTask({ url: meta.url, destPath, filename: meta.filename, expectedSize: total, meta });
      const started = m.start();
      await new Promise(r => setTimeout(r, 500));
      m.cancelTasks([id]);
      await started;

      const task = m.getTasks()[0];
      expect(task.status).toBe('failed');
      expect(task.error).toBe('Cancelled');
      // .partial 保留(可续传)时,SIGTERM 优雅退出写出的控制文件也必须保留
      expect(existsSync(destPath + '.partial')).toBe(true);
      expect(existsSync(destPath + '.partial.aria2')).toBe(true);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('进程级失败(HTTP 500)按 retryCount 重调度并最终成功(m4 回归)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lsc-aria2-'));
    const total = 1024 * 1024;
    // aria2 对 HTTP 错误不重试(立即 exit 22),前 2 次 500 留给管理器级重试消化
    let requests = 0;
    const body = Buffer.alloc(total, 7);
    const server = http.createServer((req, res) => {
      requests++;
      if (requests <= 2) {
        res.writeHead(500);
        res.end('flaky');
        return;
      }
      res.writeHead(200, { 'content-length': total });
      res.end(body);
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      const { destPath, meta } = makeTask(dir, port, total);
      const m = new Aria2DownloadManager({ maxConcurrent: 1, retryCount: 2, retryDelay: 50 });
      m.addTask({ url: meta.url, destPath, filename: meta.filename, expectedSize: total, meta });
      await m.start();

      const task = m.getTasks()[0];
      expect(task.status).toBe('completed');
      expect(requests).toBeGreaterThanOrEqual(3);
      expect(statSync(destPath).size).toBe(total);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('expectedSize 未知(0)时也能正常完成(m7 回归)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lsc-aria2-'));
    const total = 2 * 1024 * 1024;
    const { server, port } = await startThrottledServer(4 * 1024 * 1024, total);
    try {
      const { destPath, meta } = makeTask(dir, port, total);
      const m = new Aria2DownloadManager({ maxConcurrent: 1 });
      m.addTask({ url: meta.url, destPath, filename: meta.filename, expectedSize: 0, meta });
      await m.start();

      const task = m.getTasks()[0];
      expect(task.status).toBe('completed');
      expect(statSync(destPath).size).toBe(total);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

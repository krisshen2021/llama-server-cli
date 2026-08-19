/**
 * aria2c 下载后端
 * 通过 spawn aria2c 子进程获得成熟的多连接下载(-x16)与断点续传
 * (-c + .aria2 控制文件),对外暴露与内置 DownloadManager 相同的接口,
 * 供工厂按配置二选一。
 *
 * 不设 --lowest-speed-limit:跨境/被 QoS 的线路上会出现全连接集体
 * 降速,慢连接踢换拿不到新配额,只会烧光 max-tries 把下载整死(exit 5);
 * 真正哑掉的连接由 aria2 默认超时(-t 60s)+ max-tries 兜底。
 *
 * 已知限制:aria2 会把 --header 的 Authorization 透传到重定向目标域名
 * (1.36 实测),所以配置了 hfToken 时工厂会回退内置下载器,
 * 本模块自身不接收/传递任何 token。
 */

import { EventEmitter } from 'events';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'fs';
import { basename, dirname } from 'path';
import { DownloadProgress, DownloadTask, DownloadManagerOptions } from './downloader.js';
import {
  getMetaPathForFile,
  writeDownloadMeta,
  deleteDownloadMeta,
  updateMetaTimestamp,
} from './download-meta.js';

// aria2 控制台读数行解析结果
export interface Aria2ProgressSample {
  downloadedBytes: number;
  totalBytes?: number;
  speed: number;        // bytes/sec,DL:-- 时为 0
  connections?: number;
}

const UNITS: Record<string, number> = {
  B: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
};

function sizeToBytes(value: string, unit: string): number {
  return Math.round(parseFloat(value) * (UNITS[unit] ?? 1));
}

// 形如: [#a1b2c3 266MiB/400MiB(66%) CN:16 DL:38MiB ETA:4s]
// 总大小未知时没有百分比段;CN/ETA 段可能缺失;DL 停滞时为 --
const PROGRESS_RE =
  /^\[#\S+ ([\d.]+)(B|KiB|MiB|GiB|TiB)\/([\d.]+)(B|KiB|MiB|GiB|TiB)(?:\(\d+%\))?(?: CN:(\d+))? DL:([\d.]+[A-Za-z]+|--)(?: ETA:[^\]]+)?\]$/;

export function parseAria2ProgressLine(line: string): Aria2ProgressSample | null {
  const m = PROGRESS_RE.exec(line.trim());
  if (!m) return null;
  const total = sizeToBytes(m[3], m[4]);
  let speed = 0;
  if (m[6] !== '--') {
    const sm = /^([\d.]+)([A-Za-z]+)$/.exec(m[6]);
    if (sm) speed = sizeToBytes(sm[1], sm[2]);
  }
  return {
    downloadedBytes: sizeToBytes(m[1], m[2]),
    totalBytes: total > 0 ? total : undefined,
    speed,
    connections: m[5] ? parseInt(m[5], 10) : undefined,
  };
}

// aria2c 是否可用(PATH 上找得到),结果缓存,一次进程只探测一次
let aria2AvailableCache: boolean | undefined;
export function isAria2Available(): boolean {
  if (aria2AvailableCache === undefined) {
    try {
      const r = spawnSync('aria2c', ['--version'], { stdio: 'ignore' });
      aria2AvailableCache = !r.error && r.status === 0;
    } catch {
      aria2AvailableCache = false;
    }
  }
  return aria2AvailableCache;
}

interface ActiveProc {
  proc: ChildProcess;
  intentionalStop: boolean; // pause/cancel 主动杀的,close 不算失败
  handled: boolean;         // error/close 可能先后触发,只处理一次
  stdoutBuf: string;
  stderrTail: string;
}

// 模块级退出钩子:所有 manager 实例共享一个 'exit' 监听。
// 每实例 once('exit') 会累积监听器(>10 触发 MaxListenersExceededWarning)
// 且闭包强引用实例阻碍 GC;进程退出时 SIGKILL 所有在跑 aria2 子进程(只能同步操作)
const liveManagers = new Set<Aria2DownloadManager>();
let sharedExitHookRegistered = false;
function ensureSharedExitHook(): void {
  if (sharedExitHookRegistered) return;
  sharedExitHookRegistered = true;
  process.once('exit', () => {
    for (const m of liveManagers) m.killAllProcsSync();
  });
}

export class Aria2DownloadManager extends EventEmitter {
  private tasks: Map<string, DownloadTask> = new Map();
  private procs: Map<string, ActiveProc> = new Map();
  private options: Required<DownloadManagerOptions>;
  private isPaused = false;
  private isCancelled = false;
  private settled = false;
  private settleResolver: (() => void) | null = null;

  constructor(options: DownloadManagerOptions = {}) {
    super();
    this.options = {
      maxConcurrent: options.maxConcurrent ?? 3,
      retryCount: options.retryCount ?? 3,
      retryDelay: options.retryDelay ?? 1000,
      chunkSize: options.chunkSize ?? 1024 * 1024,
    };
  }

  addTask(task: Omit<DownloadTask, 'id' | 'downloadedBytes' | 'status' | 'speed' | 'eta'>): string {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // 与内置一致:初始进度取磁盘 partial 大小(aria2 续传后会用读数行修正)
    const partialPath = task.destPath + '.partial';
    let downloadedBytes = 0;
    if (existsSync(partialPath)) {
      downloadedBytes = statSync(partialPath).size;
    }

    this.tasks.set(id, {
      ...task,
      id,
      downloadedBytes,
      status: 'pending',
      speed: 0,
      eta: 0,
    });
    return id;
  }

  // 与内置语义一致:resolve 时机为所有任务到达终态(完成/失败/取消)
  async start(): Promise<void> {
    this.isPaused = false;
    this.isCancelled = false;
    this.settled = false;
    ensureSharedExitHook();
    liveManagers.add(this);
    this.pumpQueue();
    if (this.settled) return;
    await new Promise<void>((resolve) => {
      this.settleResolver = resolve;
    });
  }

  pause(): void {
    this.isPaused = true;
    for (const [id, active] of this.procs) {
      active.intentionalStop = true;
      const task = this.tasks.get(id);
      if (task && task.status === 'downloading') {
        task.status = 'paused';
        // 暂停时强制写一次元数据时间戳(与内置一致)
        if (task.meta) {
          try {
            updateMetaTimestamp(getMetaPathForFile(task.destPath));
          } catch {}
        }
      }
      // SIGTERM 让 aria2 优雅退出并保存 .aria2 控制文件
      active.proc.kill('SIGTERM');
    }
    this.emitProgress();
  }

  async resume(): Promise<void> {
    if (!this.isPaused) return;
    for (const task of this.tasks.values()) {
      if (task.status === 'paused') task.status = 'pending';
    }
    this.isPaused = false;
    this.pumpQueue();
  }

  cancel(): void {
    this.isCancelled = true;
    for (const active of this.procs.values()) {
      active.intentionalStop = true;
      active.proc.kill('SIGTERM');
    }
    for (const task of this.tasks.values()) {
      if (task.status !== 'completed') {
        task.status = 'failed';
        task.error = 'Cancelled';
      }
    }
    this.emitProgress();
    this.maybeSettle();
  }

  cancelTasks(taskIds: string[]): void {
    for (const id of taskIds) {
      const active = this.procs.get(id);
      if (active) {
        active.intentionalStop = true;
        active.proc.kill('SIGTERM');
      }
      const task = this.tasks.get(id);
      if (task && task.status !== 'completed') {
        task.status = 'failed';
        task.error = 'Cancelled';
      }
    }
    this.emitProgress();
    this.maybeSettle();
  }

  getTasks(): DownloadTask[] {
    return Array.from(this.tasks.values());
  }

  // === 内部 ===

  // 模块级退出钩子的回调:SIGKILL 所有在跑子进程
  killAllProcsSync(): void {
    for (const active of this.procs.values()) {
      try {
        active.proc.kill('SIGKILL');
      } catch {}
    }
  }

  private pumpQueue(): void {
    if (!this.isPaused && !this.isCancelled) {
      const pending = Array.from(this.tasks.values()).filter(t => t.status === 'pending');
      for (const task of pending) {
        if (this.procs.size >= this.options.maxConcurrent) break;
        this.spawnTask(task);
      }
    }
    this.maybeSettle();
  }

  private maybeSettle(): void {
    if (this.settled || this.isPaused) return;
    // downloading 也算未终结:重试退避中的任务没有进程但随时会回 pending(对齐内置)
    const hasUnfinished = Array.from(this.tasks.values())
      .some(t => t.status === 'pending' || t.status === 'downloading');
    if (!hasUnfinished && this.procs.size === 0) {
      this.settled = true;
      liveManagers.delete(this);
      this.emit('complete', this.getTasks());
      this.settleResolver?.();
    }
  }

  private spawnTask(task: DownloadTask): void {
    // pause 的 SIGTERM 之后旧进程可能还没派发 close,此时 resume/pumpQueue
    // 不得为同一任务再开进程:否则 procs 条目被覆写,旧 close 误删新进程的
    // 跟踪条目 → 孤儿进程 + 提前 settle。旧 close 会触发 pumpQueue 重新调度
    if (this.procs.has(task.id)) return;

    task.status = 'downloading';
    task.startTime = Date.now();

    // 与内置一致:启动时写 meta,便于跨会话发现未完成任务
    if (task.meta) {
      try {
        writeDownloadMeta(getMetaPathForFile(task.destPath), task.meta);
      } catch {}
    }
    mkdirSync(dirname(task.destPath), { recursive: true });

    const partialPath = task.destPath + '.partial';
    // partial 已是完整文件且无 aria2 控制文件(内置下载器下完未收尾):
    // 跳过 aria2 直接收尾,避免 aria2 对已完成文件报 416/已存在类错误
    if (!existsSync(partialPath + '.aria2') && existsSync(partialPath) && task.expectedSize > 0) {
      if (statSync(partialPath).size === task.expectedSize) {
        this.finalizeTask(task);
        this.emitProgress();
        return;
      }
    }

    const args = [
      '-x', '16', '-s', '16', '-k', '1M', // 单文件最多 16 连接/16 段,最小分段 1MB
      '-c',                                // 续传(内置下载器的顺序 partial 也能接着下)
      '--file-allocation=none',
      '--max-tries=20',                    // 真哑连接(60s 无数据)重试 20 次,避免死链无限循环
      '--retry-wait=2',
      '--summary-interval=1',              // 每秒一行读数,驱动进度事件
      '--auto-save-interval=10',           // 控制文件每 10s 落盘(默认 60s):
                                           // 异常退出时位图最多损失 10s 进度,
                                           // 否则续传会从过期位图重下几十 GB
      '--auto-file-renaming=false',
      '--allow-overwrite=true',
      '--console-log-level=warn',
      '-d', dirname(task.destPath),
      '-o', basename(partialPath),
      task.url,
    ];

    const proc = spawn('aria2c', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const active: ActiveProc = { proc, intentionalStop: false, handled: false, stdoutBuf: '', stderrTail: '' };
    this.procs.set(task.id, active);

    proc.stdout!.on('data', (chunk: Buffer) => this.consumeOutput(task, active, chunk));
    proc.stderr!.on('data', (chunk: Buffer) => {
      active.stderrTail = (active.stderrTail + chunk.toString()).slice(-2000);
    });

    proc.on('error', (err) => {
      if (active.handled) return;
      active.handled = true;
      this.procs.delete(task.id);
      this.failTask(task, `aria2c spawn failed: ${err.message}`);
      this.pumpQueue();
    });

    proc.on('close', (code) => {
      if (active.handled) return;
      active.handled = true;
      this.procs.delete(task.id);

      if (active.intentionalStop) {
        // pause/cancel 主动终止:状态已设置。
        // 仅当 .partial 已被删(TUI 删除流程)才清理孤儿控制文件;
        // .partial 还在时绝不能删:aria2 多连接 partial 带空洞,失去控制文件后
        // 两个后端的续传都会按错误的偏移写入,静默损坏文件
        if (task.error === 'Cancelled' && !existsSync(partialPath)) {
          try { unlinkSync(partialPath + '.aria2'); } catch {}
        }
      } else if (code === 0) {
        this.finalizeTask(task);
      } else {
        // 进程级失败(DNS 抖动、max-tries 耗尽等):与内置后端一致做有限次重调度
        const retries = task.retries ?? 0;
        if (retries < this.options.retryCount) {
          task.retries = retries + 1;
          task.speed = 0;
          // 保持 downloading 直到退避结束(对齐内置):防止 close 末尾的即时
          // pumpQueue 零退避重发;maybeSettle 会把 downloading 视为未终结
          setTimeout(() => {
            if (task.status !== 'downloading') return; // 期间被 pause/cancel/删除
            task.status = 'pending';
            this.pumpQueue();
          }, this.options.retryDelay);
        } else {
          const tail = active.stderrTail.trim().split('\n').pop();
          this.failTask(task, `aria2c exited with code ${code}${tail ? `: ${tail}` : ''}`);
        }
      }
      this.emitProgress();
      this.pumpQueue();
    });
  }

  private consumeOutput(task: DownloadTask, active: ActiveProc, chunk: Buffer): void {
    active.stdoutBuf += chunk.toString();
    // aria2 读数行用 \r 刷新,管道输出可能是 \n,两种分隔都要切
    const lines = active.stdoutBuf.split(/\r\n|\r|\n/);
    active.stdoutBuf = lines.pop() ?? '';
    for (const line of lines) {
      const sample = parseAria2ProgressLine(line);
      if (!sample) continue;
      task.downloadedBytes = sample.downloadedBytes;
      task.speed = sample.speed;
      if (sample.totalBytes && !task.expectedSize) task.expectedSize = sample.totalBytes;
      const remaining = task.expectedSize - task.downloadedBytes;
      task.eta = task.speed > 0 && remaining > 0 ? remaining / task.speed : 0;
    }
    this.emitProgress();
  }

  private finalizeTask(task: DownloadTask): void {
    const partialPath = task.destPath + '.partial';
    try {
      // aria2 退出码 0 已保证完整,尺寸复核作为防线;
      // expectedSize 未知(0)时跳过,不误判
      const size = existsSync(partialPath) ? statSync(partialPath).size : 0;
      if (task.expectedSize > 0 && size !== task.expectedSize) {
        this.failTask(task, `size mismatch after download: expected ${task.expectedSize}, got ${size}`);
        return;
      }
      renameSync(partialPath, task.destPath);
      if (task.meta) {
        try {
          deleteDownloadMeta(getMetaPathForFile(task.destPath));
        } catch {}
      }
      task.downloadedBytes = task.expectedSize || size;
      task.status = 'completed';
      task.speed = 0;
      this.emit('task-complete', task);
    } catch (err) {
      this.failTask(task, (err as Error).message);
    }
  }

  private failTask(task: DownloadTask, message: string): void {
    task.status = 'failed';
    task.error = message;
    task.speed = 0;
    this.emit('task-failed', task, new Error(message));
  }

  private emitProgress(): void {
    const tasks = this.getTasks();
    let totalBytes = 0;
    let downloadedBytes = 0;
    let totalSpeed = 0;
    let completed = 0;
    for (const task of tasks) {
      totalBytes += task.expectedSize;
      downloadedBytes += task.downloadedBytes;
      totalSpeed += task.speed;
      if (task.status === 'completed') completed++;
    }
    const remaining = totalBytes - downloadedBytes;
    const progress: DownloadProgress = {
      tasks,
      totalBytes,
      downloadedBytes,
      speed: totalSpeed,
      eta: totalSpeed > 0 && remaining > 0 ? remaining / totalSpeed : 0,
      completed,
      total: tasks.length,
    };
    this.emit('progress', progress);
  }
}

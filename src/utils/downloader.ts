/**
 * 下载引擎
 * 支持断点续传、并发下载、进度回调
 */

import https from 'https';
import http from 'http';
import { createWriteStream, existsSync, statSync, renameSync, unlinkSync, mkdirSync, type WriteStream } from 'fs';
import { dirname } from 'path';
import { EventEmitter } from 'events';
import { loadConfig } from './config-manager.js';
import { isTrustedHost } from './http.js';
import { DownloadMeta, getMetaPathForFile, writeDownloadMeta, deleteDownloadMeta, updateMetaTimestamp } from './download-meta.js';

// 下载任务状态
export type DownloadStatus = 
  | 'pending' 
  | 'downloading' 
  | 'paused' 
  | 'verifying' 
  | 'completed' 
  | 'failed';

// 下载任务
export interface DownloadTask {
  id: string;
  url: string;
  destPath: string;
  filename: string;
  expectedSize: number;
  expectedSha256?: string;
  meta?: DownloadMeta;
  // 状态
  downloadedBytes: number;
  status: DownloadStatus;
  speed: number;        // bytes/sec
  eta: number;          // seconds
  error?: string;
  // 内部
  startTime?: number;
  lastUpdate?: number;
  lastBytes?: number;
  retries?: number;       // 已经历的重试次数(跨队列调度保留)
  lastMetaWrite?: number; // 上次写元数据时间戳的时间(节流用)
}

// 下载进度事件
export interface DownloadProgress {
  tasks: DownloadTask[];
  totalBytes: number;
  downloadedBytes: number;
  speed: number;
  eta: number;
  completed: number;
  total: number;
}

// 内置/aria2 两种下载后端的公共接口,TUI 只依赖这个形状
export interface DownloadManagerLike {
  addTask(task: Omit<DownloadTask, 'id' | 'downloadedBytes' | 'status' | 'speed' | 'eta'>): string;
  start(): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  cancel(): void;
  cancelTasks(taskIds: string[]): void;
  getTasks(): DownloadTask[];
  on(event: 'progress', listener: (progress: DownloadProgress) => void): unknown;
  off(event: 'progress', listener: (progress: DownloadProgress) => void): unknown;
}

// 下载管理器选项
export interface DownloadManagerOptions {
  maxConcurrent?: number;     // 最大并发数，默认 3
  retryCount?: number;        // 重试次数，默认 3
  retryDelay?: number;        // 重试延迟 ms，默认 1000
  chunkSize?: number;         // 块大小，默认 1MB
}

// 最大重定向次数
const MAX_REDIRECTS = 5;

// 续传决策结果
export type ResumePlan =
  | { action: 'download'; offset: number; flags: 'a' | 'w' }
  | { action: 'complete' }
  | { action: 'restart' }; // 删除 partial 后从头再试(消耗一次重试)

// 续传决策:offset 只信磁盘上的 partial 实际大小
export function planResume(partialSize: number, statusCode: number, expectedSize?: number): ResumePlan {
  if (statusCode === 416) {
    return expectedSize !== undefined && partialSize === expectedSize
      ? { action: 'complete' }
      : { action: 'restart' };
  }
  if (expectedSize !== undefined && partialSize >= expectedSize) {
    return { action: 'restart' };
  }
  if (partialSize > 0 && statusCode === 206) {
    return { action: 'download', offset: partialSize, flags: 'a' };
  }
  return { action: 'download', offset: 0, flags: 'w' };
}

// 获取 HF Token
function getHFToken(): string | undefined {
  try {
    const config = loadConfig() as any;
    return config.hfToken;
  } catch {
    return undefined;
  }
}

/**
 * 下载管理器
 * 事件：
 * - 'progress': 进度更新
 * - 'task-complete': 单个任务完成
 * - 'task-failed': 单个任务失败
 * - 'complete': 所有任务完成
 * - 'error': 全局错误
 */
export class DownloadManager extends EventEmitter {
  private tasks: Map<string, DownloadTask> = new Map();
  private activeDownloads: Map<string, { req: http.ClientRequest; abort: () => void }> = new Map();
  private options: Required<DownloadManagerOptions>;
  private isPaused: boolean = false;
  private isCancelled: boolean = false;
  private queueRunning: boolean = false;
  private pausePromise: Promise<void> | null = null;
  private pauseResolver: (() => void) | null = null;
  private progressInterval?: NodeJS.Timeout;
  
  constructor(options: DownloadManagerOptions = {}) {
    super();
    this.options = {
      maxConcurrent: options.maxConcurrent ?? 3,
      retryCount: options.retryCount ?? 3,
      retryDelay: options.retryDelay ?? 1000,
      chunkSize: options.chunkSize ?? 1024 * 1024, // 1MB
    };
  }

  /**
   * 取消指定任务
   */
  cancelTasks(taskIds: string[]): void {
    for (const id of taskIds) {
      const active = this.activeDownloads.get(id);
      if (active) {
        active.abort();
        this.activeDownloads.delete(id);
      }
      const task = this.tasks.get(id);
      if (task && task.status !== 'completed') {
        task.status = 'failed';
        task.error = 'Cancelled';
      }
    }
    this.emitProgress();
  }
  
  /**
   * 添加下载任务
   */
  addTask(task: Omit<DownloadTask, 'id' | 'downloadedBytes' | 'status' | 'speed' | 'eta'>): string {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    
    // 检查是否有已下载的部分
    const partialPath = task.destPath + '.partial';
    let downloadedBytes = 0;
    if (existsSync(partialPath)) {
      downloadedBytes = statSync(partialPath).size;
    }
    
    const fullTask: DownloadTask = {
      ...task,
      id,
      downloadedBytes,
      status: 'pending',
      speed: 0,
      eta: 0,
    };
    
    this.tasks.set(id, fullTask);
    return id;
  }
  
  /**
   * 开始下载所有任务
   */
  async start(): Promise<void> {
    this.isPaused = false;
    this.isCancelled = false;
    
    // 启动进度更新
    this.startProgressUpdates();
    
    // 处理队列
    await this.processQueue();
  }
  
  /**
   * 暂停所有下载
   */
  pause(): void {
    this.isPaused = true;
    if (!this.pausePromise) {
      this.pausePromise = new Promise((resolve) => {
        this.pauseResolver = resolve;
      });
    }
    
    // 中止所有活动下载
    for (const [id, download] of this.activeDownloads) {
      download.abort();
      const task = this.tasks.get(id);
      if (task) {
        task.status = 'paused';
        // 暂停时强制写一次元数据时间戳(绕过节流)
        if (task.meta) {
          try {
            updateMetaTimestamp(getMetaPathForFile(task.destPath));
          } catch {}
          task.lastMetaWrite = Date.now();
        }
      }
    }
    this.activeDownloads.clear();
    
    this.stopProgressUpdates();
    this.emitProgress();
  }
  
  /**
   * 恢复下载
   */
  async resume(): Promise<void> {
    if (!this.isPaused) return;
    
    // 将暂停的任务改回 pending
    for (const task of this.tasks.values()) {
      if (task.status === 'paused') {
        task.status = 'pending';
      }
    }
    
    this.isPaused = false;
    if (this.pauseResolver) {
      this.pauseResolver();
      this.pauseResolver = null;
      this.pausePromise = null;
    }

    this.startProgressUpdates();
  }
  
  /**
   * 取消所有下载
   */
  cancel(): void {
    this.isPaused = true;
    this.isCancelled = true;
    if (this.pauseResolver) {
      this.pauseResolver();
      this.pauseResolver = null;
      this.pausePromise = null;
    }
    
    // 中止所有活动下载
    for (const download of this.activeDownloads.values()) {
      download.abort();
    }
    this.activeDownloads.clear();
    
    // 标记所有任务为失败
    for (const task of this.tasks.values()) {
      if (task.status !== 'completed') {
        task.status = 'failed';
        task.error = 'Cancelled';
      }
    }
    
    this.stopProgressUpdates();
    this.emitProgress();
  }
  
  /**
   * 获取所有任务
   */
  getTasks(): DownloadTask[] {
    return Array.from(this.tasks.values());
  }
  
  /**
   * 处理下载队列
   */
  private async processQueue(): Promise<void> {
    // 暂停中不调度新下载(重试定时器到点也会调这里,暂停时直接返回)
    // 重入守卫:任何时候最多只有一个队列循环,避免每个重试定时器都叠加一个轮询循环
    if (this.isPaused || this.queueRunning) return;
    this.queueRunning = true;
    try {
      await this.runQueue();
    } finally {
      this.queueRunning = false;
    }
  }

  /**
   * 队列主循环:直到所有任务结束(或取消)才返回
   */
  private async runQueue(): Promise<void> {
    while (true) {
      if (this.isCancelled) {
        this.stopProgressUpdates();
        return;
      }

      if (this.isPaused) {
        if (this.pausePromise) {
          await this.pausePromise;
        }
        continue;
      }

      // 获取待处理的任务
      const pendingTasks = Array.from(this.tasks.values())
        .filter(t => t.status === 'pending');
      
      // 仍有 downloading 状态的任务(可能在重试等待中),不算完成
      const hasDownloading = Array.from(this.tasks.values())
        .some(t => t.status === 'downloading');
      
      // 计算可以启动多少个新下载
      const availableSlots = this.options.maxConcurrent - this.activeDownloads.size;
      
      if (pendingTasks.length === 0 && !hasDownloading && this.activeDownloads.size === 0) {
        // 所有任务完成
        this.stopProgressUpdates();
        this.emit('complete', this.getTasks());
        return;
      }
      
      // 启动新下载(重试次数随任务保留,避免无限重试)
      const tasksToStart = pendingTasks.slice(0, availableSlots);
      for (const task of tasksToStart) {
        this.startDownload(task, task.retries ?? 0);
      }
      
      // 等待一小段时间再检查
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  /**
   * 启动单个下载
   */
  private startDownload(task: DownloadTask, retryCount: number = 0, redirectCount: number = 0): void {
    task.status = 'downloading';
    task.startTime = Date.now();
    task.lastUpdate = Date.now();

    // 写入/更新元数据
    if (task.meta) {
      const metaPath = getMetaPathForFile(task.destPath);
      try {
        writeDownloadMeta(metaPath, task.meta);
      } catch {}
    }
    
    // 确保目录存在
    const dir = dirname(task.destPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    
    const partialPath = task.destPath + '.partial';
    
    // 续传 offset 只信磁盘上的 partial 实际大小,不信内存计数
    let partialSize = existsSync(partialPath) ? statSync(partialPath).size : 0;
    // aria2 多连接下载的 partial 可能带空洞(.aria2 控制文件存在为证),
    // 内置下载器按顺序追加会错位,作废重下
    const aria2ControlPath = partialPath + '.aria2';
    if (partialSize > 0 && existsSync(aria2ControlPath)) {
      try { unlinkSync(partialPath); } catch {}
      try { unlinkSync(aria2ControlPath); } catch {}
      partialSize = 0;
    }
    task.downloadedBytes = partialSize;
    task.lastBytes = partialSize;
    
    const urlObj = new URL(task.url);
    
    // 构建请求头
    const headers: Record<string, string> = {
      'User-Agent': 'lsc/1.0',
    };
    
    // 断点续传
    if (partialSize > 0) {
      headers['Range'] = `bytes=${partialSize}-`;
    }
    
    // HF Token 只发给可信主机,避免重定向把 token 带到第三方
    const token = getHFToken();
    if (token && isTrustedHost(urlObj.hostname)) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    
    const isHttps = urlObj.protocol === 'https:';
    const httpModule = isHttps ? https : http;
    
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers,
    };
    
    // writeStream 在响应回调里创建,abort 时一并销毁,避免 fd 泄漏
    let writeStream: WriteStream | null = null;
    // 本次尝试是否已终结:req/res 可能都发 error,abort 后 res 也会发 error("aborted"),
    // 用闭包标志保证每次尝试最多进一次错误/完成路径,避免重复调度重试
    let attemptSettled = false;
    
    const req = httpModule.request(options, (res) => {
      // 处理重定向
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        // 本次尝试到此为止
        attemptSettled = true;
        // 先消费响应体释放 socket,再 follow
        res.resume();
        this.activeDownloads.delete(task.id);
        const redirectUrl = res.headers.location;
        if (redirectUrl && redirectCount < MAX_REDIRECTS) {
          // Location 可能是相对路径,基于当前 URL 解析;畸形 Location 走错误路径而非崩溃
          let nextUrl: string;
          try {
            nextUrl = new URL(redirectUrl, task.url).toString();
          } catch {
            this.handleDownloadError(task, new Error('Invalid redirect location'), retryCount);
            return;
          }
          task.url = nextUrl;
          this.startDownload(task, retryCount, redirectCount + 1);
        } else {
          this.handleDownloadError(
            task,
            new Error(redirectUrl ? 'Too many redirects' : `HTTP ${res.statusCode}`),
            retryCount,
          );
        }
        return;
      }
      
      // 续传决策:416 / 超大 partial / 服务器忽略 Range 都在这里分流
      const plan = planResume(partialSize, res.statusCode ?? 0, task.expectedSize);
      
      if (plan.action === 'complete') {
        // 416 且本地已达期望大小:partial 已是完整文件,直接走完成路径
        attemptSettled = true;
        res.resume();
        this.activeDownloads.delete(task.id);
        this.finalizeDownload(task, partialPath, retryCount);
        return;
      }
      
      if (plan.action === 'restart') {
        // partial 损坏/超大/与期望不符:删除后消耗一次重试从头再来
        attemptSettled = true;
        res.resume();
        this.activeDownloads.delete(task.id);
        try {
          unlinkSync(partialPath);
        } catch {}
        task.downloadedBytes = 0;
        this.handleDownloadError(task, new Error('Stale partial file, restarting download'), retryCount);
        return;
      }
      
      // 检查状态码
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        attemptSettled = true;
        res.resume();
        this.activeDownloads.delete(task.id);
        this.handleDownloadError(task, new Error(`HTTP ${res.statusCode}`), retryCount);
        return;
      }
      
      task.downloadedBytes = plan.offset;
      task.lastBytes = plan.offset;
      
      // 创建写入流(append 续传 / truncate 重下,由 planResume 决定)
      writeStream = createWriteStream(partialPath, { flags: plan.flags });
      
      res.on('data', (chunk: Buffer) => {
        task.downloadedBytes += chunk.length;
      });
      
      // 响应流中途出错(socket reset 等):进重试路径,避免未处理异常崩溃
      res.on('error', (err) => {
        if (attemptSettled) return;
        attemptSettled = true;
        this.activeDownloads.delete(task.id);
        writeStream?.destroy();
        this.handleDownloadError(task, err, retryCount);
      });
      
      res.pipe(writeStream);
      
      writeStream.on('finish', () => {
        if (attemptSettled) return;
        attemptSettled = true;
        this.activeDownloads.delete(task.id);
        
        // 检查是否下载完整
        if (task.downloadedBytes >= task.expectedSize) {
          this.finalizeDownload(task, partialPath, retryCount);
        } else {
          // 下载不完整，重试
          this.handleDownloadError(task, new Error('Incomplete download'), retryCount);
        }
      });
      
      writeStream.on('error', (err) => {
        if (attemptSettled) return;
        attemptSettled = true;
        this.activeDownloads.delete(task.id);
        // 同时销毁响应流,避免写流失败后(如 ENOSPC)socket 继续空拉剩余数据
        res.destroy();
        this.handleDownloadError(task, err, retryCount);
      });
    });
    
    req.on('error', (err) => {
      if (attemptSettled) return;
      attemptSettled = true;
      this.activeDownloads.delete(task.id);
      writeStream?.destroy();
      this.handleDownloadError(task, err, retryCount);
    });
    
    // 空闲超时:连接停滞 60s 判定失败,进重试路径
    req.setTimeout(60_000, () => {
      req.destroy(new Error('Request timed out'));
    });
    
    // 保存请求引用以便取消
    this.activeDownloads.set(task.id, {
      req,
      abort: () => {
        // 标记本次尝试已终结:abort 引发的 req/res 后续 error 不再进错误路径
        attemptSettled = true;
        req.destroy();
        writeStream?.destroy();
      },
    });
    
    req.end();
  }
  
  /**
   * 下载完成:partial 转正、清理元数据、发完成事件
   */
  private finalizeDownload(task: DownloadTask, partialPath: string, retryCount: number): void {
    try {
      if (existsSync(task.destPath)) {
        unlinkSync(task.destPath);
      }
      renameSync(partialPath, task.destPath);
      task.status = 'completed';
      if (task.meta) {
        const metaPath = getMetaPathForFile(task.destPath);
        deleteDownloadMeta(metaPath);
      }
      this.emit('task-complete', task);
    } catch (err) {
      this.handleDownloadError(task, err as Error, retryCount);
    }
  }
  
  /**
   * 处理下载错误
   */
  private handleDownloadError(task: DownloadTask, error: Error, retryCount: number): void {
    if (retryCount < this.options.retryCount) {
      // 重试:到点无条件回到 pending 队列
      // (暂停时 processQueue 直接返回,恢复后由主循环捞起;已取消则不再重试)
      setTimeout(() => {
        // 已取消、或任务已不在 downloading(被暂停/取消/已完成/已有新尝试接管):不再重试
        if (this.isCancelled || task.status !== 'downloading') return;
        task.retries = retryCount + 1;
        task.status = 'pending';
        this.processQueue();
      }, this.options.retryDelay);
    } else {
      // 失败
      task.status = 'failed';
      task.error = error.message;
      this.emit('task-failed', task, error);
    }
  }
  
  /**
   * 启动进度更新
   */
  private startProgressUpdates(): void {
    if (this.progressInterval) return;
    
    this.progressInterval = setInterval(() => {
      this.updateSpeeds();
      this.emitProgress();
    }, 500);
  }
  
  /**
   * 停止进度更新
   */
  private stopProgressUpdates(): void {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = undefined;
    }
  }
  
  /**
   * 更新下载速度
   */
  private updateSpeeds(): void {
    const now = Date.now();
    
    for (const task of this.tasks.values()) {
      if (task.status === 'downloading' && task.lastUpdate && task.lastBytes !== undefined) {
        const timeDiff = (now - task.lastUpdate) / 1000;
        const bytesDiff = task.downloadedBytes - task.lastBytes;
        
        if (timeDiff > 0) {
          // 平滑速度计算
          const newSpeed = bytesDiff / timeDiff;
          task.speed = task.speed * 0.7 + newSpeed * 0.3;
          
          // 计算 ETA
          const remaining = task.expectedSize - task.downloadedBytes;
          task.eta = task.speed > 0 ? remaining / task.speed : 0;
        }
        
        task.lastUpdate = now;
        task.lastBytes = task.downloadedBytes;

        // 更新元数据时间戳(节流:距上次写入 < 10s 则跳过;完成/暂停时强制写)
        if (task.meta && (task.lastMetaWrite === undefined || now - task.lastMetaWrite >= 10_000)) {
          const metaPath = getMetaPathForFile(task.destPath);
          try {
            updateMetaTimestamp(metaPath);
          } catch {}
          task.lastMetaWrite = now;
        }
      }
    }
  }
  
  /**
   * 发送进度事件
   */
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
    const eta = totalSpeed > 0 ? remaining / totalSpeed : 0;
    
    const progress: DownloadProgress = {
      tasks,
      totalBytes,
      downloadedBytes,
      speed: totalSpeed,
      eta,
      completed,
      total: tasks.length,
    };
    
    this.emit('progress', progress);
  }
}

/**
 * 检查磁盘空间
 */
export async function checkDiskSpace(path: string, requiredBytes: number): Promise<{
  ok: boolean;
  available: number;
  required: number;
}> {
  try {
    const { execFileSync } = await import('child_process');
    const dir = dirname(path);
    
    // 确保目录存在
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    
    // 获取可用空间 (无 shell 调用，防止注入; -- 防止 dir 被解析为选项)
    const output = execFileSync('df', ['-B1', '--', dir], { encoding: 'utf-8' });
    // 取最后一行数据行，第 4 列为 Available
    const lines = output.trim().split('\n');
    const lastLine = lines[lines.length - 1];
    const available = parseInt(lastLine.trim().split(/\s+/)[3], 10);
    // 输出异常时走下方兜底 (视为空间充足)
    if (Number.isNaN(available)) {
      throw new Error(`unexpected df output: ${output}`);
    }
    
    return {
      ok: available >= requiredBytes,
      available,
      required: requiredBytes,
    };
  } catch {
    // 无法检测，假设空间足够
    return {
      ok: true,
      available: Infinity,
      required: requiredBytes,
    };
  }
}

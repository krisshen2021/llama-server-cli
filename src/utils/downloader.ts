/**
 * 下载引擎
 * 支持断点续传、并发下载、进度回调
 */

import https from 'https';
import http from 'http';
import { createWriteStream, existsSync, statSync, renameSync, unlinkSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { EventEmitter } from 'events';
import { loadConfig } from './config-manager.js';
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

// 下载管理器选项
export interface DownloadManagerOptions {
  maxConcurrent?: number;     // 最大并发数，默认 3
  retryCount?: number;        // 重试次数，默认 3
  retryDelay?: number;        // 重试延迟 ms，默认 1000
  chunkSize?: number;         // 块大小，默认 1MB
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
      
      // 计算可以启动多少个新下载
      const availableSlots = this.options.maxConcurrent - this.activeDownloads.size;
      
      if (pendingTasks.length === 0 && this.activeDownloads.size === 0) {
        // 所有任务完成
        this.stopProgressUpdates();
        this.emit('complete', this.getTasks());
        return;
      }
      
      // 启动新下载
      const tasksToStart = pendingTasks.slice(0, availableSlots);
      for (const task of tasksToStart) {
        this.startDownload(task);
      }
      
      // 等待一小段时间再检查
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  /**
   * 启动单个下载
   */
  private startDownload(task: DownloadTask, retryCount: number = 0): void {
    task.status = 'downloading';
    task.startTime = Date.now();
    task.lastUpdate = Date.now();
    task.lastBytes = task.downloadedBytes;

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
    
    // 构建请求头
    const headers: Record<string, string> = {
      'User-Agent': 'lsc/1.0',
    };
    
    // 断点续传
    if (task.downloadedBytes > 0) {
      headers['Range'] = `bytes=${task.downloadedBytes}-`;
    }
    
    // HF Token
    const token = getHFToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    
    const urlObj = new URL(task.url);
    const isHttps = urlObj.protocol === 'https:';
    const httpModule = isHttps ? https : http;
    
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers,
    };
    
    const req = httpModule.request(options, (res) => {
      // 处理重定向
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
        const redirectUrl = res.headers.location;
        if (redirectUrl) {
          task.url = redirectUrl;
          this.activeDownloads.delete(task.id);
          this.startDownload(task, retryCount);
          return;
        }
      }
      
      // 检查状态码
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        this.handleDownloadError(task, new Error(`HTTP ${res.statusCode}`), retryCount);
        return;
      }
      
      // 创建写入流（追加模式用于断点续传）
      const writeStream = createWriteStream(partialPath, {
        flags: task.downloadedBytes > 0 ? 'a' : 'w',
      });
      
      res.on('data', (chunk: Buffer) => {
        task.downloadedBytes += chunk.length;
      });
      
      res.pipe(writeStream);
      
      writeStream.on('finish', () => {
        this.activeDownloads.delete(task.id);
        
        // 检查是否下载完整
        if (task.downloadedBytes >= task.expectedSize) {
          // 重命名文件
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
        } else {
          // 下载不完整，重试
          this.handleDownloadError(task, new Error('Incomplete download'), retryCount);
        }
      });
      
      writeStream.on('error', (err) => {
        this.activeDownloads.delete(task.id);
        this.handleDownloadError(task, err, retryCount);
      });
    });
    
    req.on('error', (err) => {
      this.activeDownloads.delete(task.id);
      this.handleDownloadError(task, err, retryCount);
    });
    
    // 保存请求引用以便取消
    this.activeDownloads.set(task.id, {
      req,
      abort: () => req.destroy(),
    });
    
    req.end();
  }
  
  /**
   * 处理下载错误
   */
  private handleDownloadError(task: DownloadTask, error: Error, retryCount: number): void {
    if (retryCount < this.options.retryCount && !this.isPaused) {
      // 重试
      setTimeout(() => {
        if (!this.isPaused) {
          task.status = 'pending';
          this.startDownload(task, retryCount + 1);
        }
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

        // 更新元数据时间戳
        if (task.meta) {
          const metaPath = getMetaPathForFile(task.destPath);
          updateMetaTimestamp(metaPath);
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
 * 格式化速度
 */
export function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return bytesPerSec.toFixed(0) + ' B/s';
  if (bytesPerSec < 1024 * 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
  if (bytesPerSec < 1024 * 1024 * 1024) return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
  return (bytesPerSec / (1024 * 1024 * 1024)).toFixed(2) + ' GB/s';
}

/**
 * 格式化 ETA
 */
export function formatEta(seconds: number): string {
  if (seconds < 0 || !isFinite(seconds)) return '--:--';
  
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  } else {
    return `${secs}s`;
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
    const { execSync } = await import('child_process');
    const dir = dirname(path);
    
    // 确保目录存在
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    
    // 获取可用空间
    const output = execSync(`df -B1 "${dir}" | tail -1 | awk '{print $4}'`, {
      encoding: 'utf-8',
    });
    const available = parseInt(output.trim(), 10);
    
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

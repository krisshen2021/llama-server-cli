import { spawn, ChildProcess, execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';
import { ServerOptions, ServerStatus, PidFile } from '../types.js';
import { CONFIG_DIR, getExpandedConfig } from './config-manager.js';

const PID_FILE = join(CONFIG_DIR, 'server.pid');
const LOG_FILE = join(CONFIG_DIR, 'server.log');

// 检查进程是否存在
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 读取 PID 文件
function readPidFile(): PidFile | null {
  if (!existsSync(PID_FILE)) {
    return null;
  }
  
  try {
    const content = readFileSync(PID_FILE, 'utf-8');
    return JSON.parse(content) as PidFile;
  } catch {
    return null;
  }
}

// 写入 PID 文件
function writePidFile(data: PidFile): void {
  writeFileSync(PID_FILE, JSON.stringify(data, null, 2));
}

// 删除 PID 文件
function removePidFile(): void {
  if (existsSync(PID_FILE)) {
    unlinkSync(PID_FILE);
  }
}

// 获取服务器状态
export function getServerStatus(): ServerStatus {
  const pidData = readPidFile();
  
  if (!pidData) {
    return { running: false };
  }
  
  if (!isProcessRunning(pidData.pid)) {
    // 进程已不存在，清理 PID 文件
    removePidFile();
    return { running: false };
  }
  
  return {
    running: true,
    pid: pidData.pid,
    model: pidData.model,
    port: pidData.port,
    startTime: new Date(pidData.startTime),
  };
}

// 构建 llama-server 命令行参数
function buildServerArgs(options: ServerOptions): string[] {
  const args: string[] = [];
  
  // 模型文件
  args.push('-m', options.model);
  
  // mmproj（视觉投影）
  if (options.mmproj) {
    args.push('--mmproj', options.mmproj);
  }
  
  // 上下文大小
  args.push('-c', options.ctxSize.toString());
  
  // GPU 层数
  if (options.gpuLayers === 'auto') {
    args.push('-ngl', 'auto');
  } else {
    args.push('-ngl', options.gpuLayers.toString());
  }

  // 多卡张量分配
  if (options.tensorSplit) {
    args.push('-ts', options.tensorSplit);
  }

  // KV Cache 量化
  if (options.kvCacheType) {
    args.push('-ctk', options.kvCacheType);
    args.push('-ctv', options.kvCacheType);
  }
  
  // 主机和端口
  args.push('--host', options.host);
  args.push('--port', options.port.toString());
  
  // Jinja 模板
  if (options.jinja) {
    args.push('--jinja');
  }
  
  // Flash Attention
  args.push('-fa', options.flashAttn);
  
  // 思维预算
  if (options.reasoningBudget !== undefined) {
    args.push('--reasoning-budget', options.reasoningBudget.toString());
  }

  // 自定义 chat template
  if (options.chatTemplate) {
    let templatePath = options.chatTemplate;
    if (!isAbsolute(templatePath)) {
      if (templatePath.startsWith('templates/')) {
        templatePath = join(CONFIG_DIR, templatePath);
      } else {
        templatePath = join(dirname(options.model), templatePath);
      }
    }
    args.push('--chat-template-file', templatePath);
  }
  
  // 线程数
  if (options.threads) {
    args.push('-t', options.threads.toString());
  }
  
  // 批处理大小
  if (options.batchSize) {
    args.push('-b', options.batchSize.toString());
  }
  
  return args;
}

// 启动服务器
export function startServer(options: ServerOptions): Promise<{ pid: number; logFile: string }> {
  return new Promise((resolve, reject) => {
    const status = getServerStatus();
    
    if (status.running) {
      reject(new Error(`Server is already running (PID: ${status.pid}, Port: ${status.port})`));
      return;
    }
    
    const config = getExpandedConfig();
    const serverPath = config.llamaServerPath;
    
    if (!existsSync(serverPath)) {
      reject(new Error(`llama-server not found at: ${serverPath}`));
      return;
    }
    
    const args = buildServerArgs(options);
    
    // 打开日志文件
    const logFd = openSync(LOG_FILE, 'w');
    
    // 启动进程（后台运行）
    const child: ChildProcess = spawn(serverPath, args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    
    child.unref();
    closeSync(logFd);
    
    if (!child.pid) {
      reject(new Error('Failed to start server process'));
      return;
    }
    
    // 写入 PID 文件
    const pidData: PidFile = {
      pid: child.pid,
      model: options.model,
      port: options.port,
      startTime: new Date().toISOString(),
    };
    writePidFile(pidData);
    
    // 等待一小段时间确认进程启动成功
    setTimeout(() => {
      if (isProcessRunning(child.pid!)) {
        resolve({ pid: child.pid!, logFile: LOG_FILE });
      } else {
        removePidFile();
        reject(new Error('Server process exited immediately. Check logs: ' + LOG_FILE));
      }
    }, 1000);
  });
}

// 停止服务器
export function stopServer(force = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const status = getServerStatus();
    
    if (!status.running || !status.pid) {
      reject(new Error('Server is not running'));
      return;
    }
    
    try {
      // 发送终止信号
      process.kill(status.pid, force ? 'SIGKILL' : 'SIGTERM');
      
      // 等待进程终止
      let attempts = 0;
      const maxAttempts = 10;
      
      const checkInterval = setInterval(() => {
        attempts++;
        
        if (!isProcessRunning(status.pid!)) {
          clearInterval(checkInterval);
          removePidFile();
          resolve();
        } else if (attempts >= maxAttempts) {
          clearInterval(checkInterval);
          if (!force) {
            // 尝试强制终止
            try {
              process.kill(status.pid!, 'SIGKILL');
              removePidFile();
              resolve();
            } catch {
              reject(new Error('Failed to stop server'));
            }
          } else {
            reject(new Error('Failed to stop server'));
          }
        }
      }, 500);
    } catch (err) {
      removePidFile();
      reject(err);
    }
  });
}

// 获取日志文件路径
export function getLogFile(): string {
  return LOG_FILE;
}

// 读取最后 N 行日志
export function readLastLogs(lines = 50): string {
  if (!existsSync(LOG_FILE)) {
    return '';
  }
  
  try {
    const output = execSync(`tail -n ${lines} "${LOG_FILE}"`, { encoding: 'utf-8' });
    return output;
  } catch {
    return '';
  }
}

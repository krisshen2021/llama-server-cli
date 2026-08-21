import { spawn, spawnSync, ChildProcess, execSync } from 'child_process';
import { existsSync, unlinkSync, openSync, closeSync, readFileSync, writeFileSync, rmSync, mkdirSync, statSync } from 'fs';
import { join, dirname, basename, isAbsolute } from 'path';
import { ServerOptions, ServerStatus, PidFile } from '../types.js';
import { getConfigDir, getExpandedConfig } from './config-manager.js';
import { readJsonSafe, writeJsonAtomic } from './json-file.js';

export function getPidFilePath(): string {
  return join(getConfigDir(), 'server.pid');
}

export function getLogFilePath(): string {
  return join(getConfigDir(), 'server.log');
}

// 默认会话 KV 持久化目录(TUI 开关与 CLI 共用)
export function getDefaultSlotSavePath(): string {
  return join(getConfigDir(), 'slots');
}

// 启动互斥锁文件(与 PID 文件同目录)
function getLockFilePath(): string {
  return join(getConfigDir(), 'server.start.lock');
}

// 纯存活判断(不做进程身份校验):用于锁持有者等非 llama-server 进程
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM:进程存在但属其他用户 → 视为存活
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// 校验 PID 是否确为 llama-server,防止 PID 复用后误操作无关进程
export function isLlamaServerProcess(pid: number): boolean {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    // cmdline 以 NUL 分隔;只认 argv[0] 本身,避免路径中含 "llama-server" 字样的
    // 其他程序(如安装路径为 llama-server-cli 的 lsc 自身)被误判
    const argv0 = cmdline.split('\0')[0];
    if (basename(argv0) === 'llama-server') return true;
    // 兼容自定义二进制名:spawn 时 argv[0] 即配置的服务器二进制完整路径
    const serverPath = getExpandedConfig().llamaServerPath;
    return serverPath !== '' && argv0 === serverPath;
  } catch {
    return true; // 非 Linux 或无权限:回退到仅 kill(pid,0) 判断
  }
}

// 检查进程是否是运行中的 llama-server(含身份校验)
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return isLlamaServerProcess(pid);
  } catch (err) {
    // EPERM:进程存在但属其他用户 → 视为存活,不得删 PID 文件
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// 读取 PID 文件(损坏时 readJsonSafe 备份 .bak 并返回 null)
function readPidFile(): PidFile | null {
  return readJsonSafe<PidFile | null>(getPidFilePath(), null);
}

// 写入 PID 文件(原子写)
function writePidFile(data: PidFile): void {
  writeJsonAtomic(getPidFilePath(), data);
}

// 删除 PID 文件
function removePidFile(): void {
  if (existsSync(getPidFilePath())) {
    unlinkSync(getPidFilePath());
  }
}

// 获取服务器状态
export function getServerStatus(): ServerStatus {
  const pidData = readPidFile();
  
  if (!pidData) {
    return { running: false };
  }
  
  if (!isProcessRunning(pidData.pid)) {
    // 进程明确不存在(非 EPERM、非 PID 复用)，清理 PID 文件
    removePidFile();
    return { running: false };
  }
  
  return {
    running: true,
    pid: pidData.pid,
    model: pidData.model,
    port: pidData.port,
    startTime: new Date(pidData.startTime),
    proxy: pidData.proxy,
    publicPort: pidData.publicPort,
  };
}

// 锁龄上限:一次 start 持锁约 1s;超过即视为陈旧锁(kill -9 后 PID 被复用的兜底)
const LOCK_STALE_MS = 60_000;

// 简单锁文件:O_EXCL 创建,持锁进程死亡或锁过旧则视为陈旧锁接管
function acquireLock(lockPath: string): void {
  try {
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    return;
  } catch {
    // 锁已存在(或创建失败),进入陈旧判定与接管
  }

  let content = '';
  try {
    content = readFileSync(lockPath, 'utf8');
  } catch {
    // 读取失败(锁刚好被持有者释放):按陈旧处理,由下方原子创建仲裁
  }
  const holder = parseInt(content, 10);
  // 持有者是 lsc 进程而非 llama-server,存活判断用 isPidAlive(不做身份校验)
  let stale = isNaN(holder) || !isPidAlive(holder);
  if (!stale) {
    // 锁龄兜底:持有者"存活"但锁过旧(原持有者 kill -9 后 PID 被复用),同样视为陈旧
    try {
      stale = Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
    } catch {
      stale = true;
    }
  }
  if (!stale) {
    throw new Error('Another lsc start is in progress');
  }

  // rm + wx 创建非原子:两个进程可能同时判定陈旧;
  // 慢一步的创建撞 EEXIST 时转成友好错误。但残余风险仍在:
  // 后者的 rm 可能恰好删掉前者新建的锁,使双方最终都持锁——此处只降低撞锁概率,非严格互斥
  rmSync(lockPath, { force: true });
  try {
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Another lsc start is in progress');
    }
    throw new Error(`Failed to acquire start lock: ${(err as Error).message}`);
  }
}

function releaseLock(lockPath: string): void {
  rmSync(lockPath, { force: true });
}

// llama-server 最低构建号:--fit 于 b7410 引入(-ngl auto 于 b6325、--reasoning-budget 于 b5488 引入)
export const MIN_LLAMA_SERVER_BUILD = 7410;

// 从 `llama-server --version` 输出解析构建号
export function parseLlamaServerBuild(output: string): number | null {
  // 新格式(2026 起):"version: 0.1.1-dev (build 10472, commit 60eeeb608)" → 取括号内 build 号
  const buildMatch = output.match(/\(build\s+(\d+)/);
  if (buildMatch) return parseInt(buildMatch[1], 10);
  // 旧格式:"version: 8157 (2943210c1)" → version 后直接是构建号
  const legacyMatch = output.match(/version:\s*(\d+)/);
  return legacyMatch ? parseInt(legacyMatch[1], 10) : null;
}

// 探测 llama-server 构建号;失败返回 null(无法判定时不阻塞,由启动流程自己报错)
export function getLlamaServerBuild(serverPath: string): number | null {
  try {
    // --version 的信息流因版本而异(stdout/stderr 都可能),合并捕获
    const res = spawnSync(serverPath, ['--version'], { encoding: 'utf8', timeout: 5000 });
    return parseLlamaServerBuild(`${res.stdout ?? ''}\n${res.stderr ?? ''}`);
  } catch {
    return null;
  }
}

// 版本检查;返回 null 表示探测失败无法判定
export function checkLlamaServerVersion(serverPath: string): { build: number; supported: boolean } | null {
  const build = getLlamaServerBuild(serverPath);
  if (build === null) return null;
  return { build, supported: build >= MIN_LLAMA_SERVER_BUILD };
}

// 构建 llama-server 命令行参数
export function buildServerArgs(options: ServerOptions): string[] {
  const args: string[] = [];
  
  // 模型文件
  args.push('-m', options.model);

  // API 返回中的模型别名:/v1/models 与补全响应的 model 字段用它,避免向调用方暴露全路径
  args.push('--alias', basename(options.model).replace(/\.gguf$/i, ''));
  
  // mmproj（视觉投影）
  if (options.mmproj && options.useVision !== false) {
    args.push('--mmproj', options.mmproj);
  }
  
  // 上下文大小:'auto' 时不传 -c,由下方强制的 --fit on 按空闲显存自动调整
  if (options.ctxSize !== 'auto') {
    args.push('-c', options.ctxSize.toString());
  }
  
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

  // 适配显存 (fit)
  if (options.ctxSize === 'auto') {
    // auto ctx 离开 --fit 无意义,故强制 -fit on;即使显式 fit:false(配置矛盾)也以 auto 为准,
    // 与下方两个分支互斥,不会产生重复的 -fit 参数
    args.push('-fit', 'on');
  } else if (options.fit === false) {
    args.push('-fit', 'off');
  } else if (options.fit === true) {
    args.push('-fit', 'on');
  }

  // KV Cache 量化
  if (options.kvCacheType) {
    args.push('-ctk', options.kvCacheType);
    args.push('-ctv', options.kvCacheType);
  }
  
  // 主机和端口
  args.push('--host', options.host);
  args.push('--port', options.port.toString());

  // Prometheus 指标端点:TUI Resources 面板的解码速度依赖它;开销可忽略,常驻开启
  args.push('--metrics');
  
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

  // 投机解码(MTP/draft 模型)
  if (options.specType) {
    args.push('--spec-type', options.specType);
  }
  if (options.specModel) {
    args.push('--model-draft', options.specModel);
  }
  if (options.specDraftMax) {
    args.push('--spec-draft-n-max', String(options.specDraftMax));
  }

  // 并发槽位数:不设则交给 llama.cpp 默认(auto)
  if (options.parallelSlots) {
    args.push('-np', String(options.parallelSlots));
  }

  // 自定义 chat template
  if (options.chatTemplate) {
    let templatePath = options.chatTemplate;
    if (!isAbsolute(templatePath)) {
      if (templatePath.startsWith('templates/')) {
        templatePath = join(getConfigDir(), templatePath);
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

  // 批处理线程数
  if (options.threadsBatch !== undefined && options.threadsBatch !== 0) {
    args.push('-tb', options.threadsBatch.toString());
  }
  
  // 批处理大小
  if (options.batchSize) {
    args.push('-b', options.batchSize.toString());
  }

  // Prompt cache
  if (options.cachePrompt === false) {
    args.push('--no-cache-prompt');
  } else if (options.cachePrompt === true) {
    args.push('--cache-prompt');
  }

  if (options.cacheReuse !== undefined) {
    args.push('--cache-reuse', options.cacheReuse.toString());
  }

  // 会话 KV 持久化目录
  if (options.slotSavePath) {
    args.push('--slot-save-path', options.slotSavePath);
  }
  
  return args;
}

// ctxSize 'auto' 与 fit 的冲突检测:fit 无法调整用户显式锁定的 GPU 层数/多卡切分
// (llama.cpp fit.cpp:层数已设或 tensor split 跨多卡时跳过层数再分配,ctx 可能被压到
// 4096 下限仍照常启动,紧张显存下有 OOM 风险);返回 null 表示无冲突
export function ctxAutoFitConflict(options: ServerOptions): string | null {
  if (options.ctxSize !== 'auto') return null;
  if (typeof options.gpuLayers === 'number') {
    return 'ctxSize "auto" with fixed GPU layers degrades --fit (layers cannot be redistributed; ctx may shrink to the floor and risk OOM). Use -ngl auto for full auto-fit.';
  }
  if (options.tensorSplit) {
    return 'ctxSize "auto" with tensor split degrades --fit (multi-GPU split cannot be adjusted; ctx may shrink to the floor and risk OOM). Drop tensor split for full auto-fit.';
  }
  return null;
}

// 启动服务器;proxyInfo 存在时 PID 文件记录代理标志与对外端口(供 TUI 重连判断)
export function startServer(
  options: ServerOptions,
  proxyInfo?: { publicPort: number },
): Promise<{ pid: number; logFile: string }> {
  return new Promise((resolve, reject) => {
    // 互斥锁:防止并发 startServer 双双通过状态检查,PID 文件互相覆盖产生孤儿进程
    const lockPath = getLockFilePath();
    try {
      mkdirSync(getConfigDir(), { recursive: true });
      acquireLock(lockPath);
    } catch (err) {
      reject(err);
      return;
    }
    let lockHeld = true;
    const releaseLockIfHeld = (): void => {
      if (lockHeld) {
        lockHeld = false;
        releaseLock(lockPath);
      }
    };

    let settled = false;
    // 日志 fd 打开后替换为真正的关闭函数;同步异常路径用它避免 fd 泄漏
    let closeLogFd = (): void => {};
    // spawn 成功后记录子进程 pid 与 PID 文件写入状态;
    // 同步异常(如写 PID 文件失败)且无 PID 文件可跟踪时,用于杀死孤儿进程
    let spawnedPid: number | undefined;
    let pidFileWritten = false;

    try {
      const status = getServerStatus();
      
      if (status.running) {
        releaseLockIfHeld();
        reject(new Error(`Server is already running (PID: ${status.pid}, Port: ${status.port})`));
        return;
      }
      
      const config = getExpandedConfig();
      const serverPath = config.llamaServerPath;
      
      if (!existsSync(serverPath)) {
        releaseLockIfHeld();
        reject(new Error(`llama-server not found at: ${serverPath}`));
        return;
      }
      
      const args = buildServerArgs(options);

      // llama.cpp 不会自建 slot 保存目录,启动前确保其存在
      if (options.slotSavePath) {
        mkdirSync(options.slotSavePath, { recursive: true });
      }
      
      // 打开日志文件
      const logFd = openSync(getLogFilePath(), 'w');
      let logFdClosed = false;
      closeLogFd = (): void => {
        if (!logFdClosed) {
          logFdClosed = true;
          try { closeSync(logFd); } catch {}
        }
      };

      // 启动进程（后台运行）
      const child: ChildProcess = spawn(serverPath, args, {
        detached: true,
        stdio: ['ignore', logFd, logFd],
      });
      spawnedPid = child.pid;

      // spawn 失败(existsSync 通过但 EACCES/ENOEXEC 等)时 child 触发 'error';
      // 不监听会导致未捕获异常使进程崩溃,且泄漏已打开的 logFd
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        closeLogFd();
        if (pidFileWritten) removePidFile();
        releaseLockIfHeld();
        reject(new Error(`Failed to spawn llama-server: ${err.message}`));
      });
      
      child.unref();
      closeLogFd();
      
      // child.pid 为空说明 spawn 失败(EACCES/ENOEXEC 等),'error' 事件随后在下一拍触发,
      // 由上面的监听器拒绝并清理;这里不再同步拒绝,以免吞掉具体错误信息
      if (child.pid) {
        // 写入 PID 文件(带代理标志)
        const pidData: PidFile = {
          pid: child.pid,
          model: options.model,
          port: options.port,
          startTime: new Date().toISOString(),
        };
        if (proxyInfo) {
          pidData.proxy = true;
          pidData.publicPort = proxyInfo.publicPort;
        }
        writePidFile(pidData);
        pidFileWritten = true;
      }
      
      // 等待一小段时间确认进程启动成功
      // 这里用 isPidAlive:子进程是我们刚 spawn 的,身份无需再校验;
      // 若进程已死,Node 回收后 kill(pid,0) 抛 ESRCH
      setTimeout(() => {
        if (settled) return;
        settled = true;
        if (child.pid && isPidAlive(child.pid)) {
          releaseLockIfHeld();
          resolve({ pid: child.pid, logFile: getLogFilePath() });
        } else {
          if (pidFileWritten) removePidFile();
          releaseLockIfHeld();
          reject(new Error('Server process exited immediately. Check logs: ' + getLogFilePath()));
        }
      }, 1000);
    } catch (err) {
      // 同步异常(openSync EACCES/EMFILE、配置读取失败等):必须释放锁,否则长驻 TUI 中
      // 陈旧锁记录的是自身活 PID,陈旧接管判定持有者存活,后续每次启动都被误拒;
      // 同时置 settled 使已注册的异步回调(error 监听/定时器)不再重复清理
      settled = true;
      releaseLockIfHeld();
      closeLogFd();
      // 子进程已 spawn 但 PID 文件未写入(如 writePidFile ENOSPC/EACCES):
      // 进程脱离跟踪会成为孤儿,直接杀死
      if (spawnedPid !== undefined && !pidFileWritten) {
        try { process.kill(spawnedPid, 'SIGKILL'); } catch {}
      }
      reject(err);
    }
  });
}

// 轮询等待进程死亡:每 100ms 查一次,超时返回 false
async function waitForProcessDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return !isProcessRunning(pid);
}

// 停止服务器;sigtermTimeoutMs 为 SIGTERM 等待上限(默认 5s,测试可调短)
export async function stopServer(force = false, sigtermTimeoutMs = 5000): Promise<void> {
  const status = getServerStatus();
  
  if (!status.running || !status.pid) {
    throw new Error('Server is not running');
  }

  const pid = status.pid;
  
  // 发送终止信号;发送失败(如 EPERM)时保留 PID 文件,避免进程脱离管理成为孤儿
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      // 刚好在状态检查后退出:直接清理 PID 文件
      removePidFile();
      return;
    }
    throw err;
  }
  
  // 等待进程退出(force 时直接进 SIGKILL 死亡确认)
  if (!force && await waitForProcessDeath(pid, sigtermTimeoutMs)) {
    removePidFile();
    return;
  }
  
  if (!force) {
    // SIGTERM 无效,升级 SIGKILL
    try {
      process.kill(pid, 'SIGKILL');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        removePidFile();
        return;
      }
      throw err; // EPERM 等:保留 PID 文件
    }
  }
  
  // SIGKILL 后轮询确认死亡(每 100ms,最多 3s)再删 PID 文件;
  // 仍存活则报错且保留 PID 文件,避免服务器变成无跟踪的孤儿
  if (await waitForProcessDeath(pid, 3000)) {
    removePidFile();
    return;
  }
  throw new Error(`Failed to stop server: process ${pid} still alive after SIGKILL`);
}

// 获取日志文件路径
export function getLogFile(): string {
  return getLogFilePath();
}

// 读取最后 N 行日志
export function readLastLogs(lines = 50): string {
  if (!existsSync(getLogFilePath())) {
    return '';
  }

  try {
    const output = execSync(`tail -n ${lines} "${getLogFilePath()}"`, { encoding: 'utf-8' });
    return output;
  } catch {
    return '';
  }
}

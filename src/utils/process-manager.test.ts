import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { execSync, execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ServerOptions, PidFile } from '../types.js';
import { startServer, stopServer, getServerStatus, parseLlamaServerBuild, checkLlamaServerVersion, buildServerArgs, ctxAutoFitConflict, getDefaultSlotSavePath, MIN_LLAMA_SERVER_BUILD } from './process-manager.js';

// 身份校验依赖 /proc/<pid>/cmdline 与 argv[0],fake 需为真实 ELF(shell 脚本经 shebang
// 执行后 argv[0] 会变成解释器路径,无法通过校验);无编译器或非 Linux 时整组跳过
const canRun = (() => {
  if (process.platform !== 'linux') return false;
  try {
    execSync('cc --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!canRun)('process-manager', () => {
  let toolsDir: string;
  let fakeSleeper: string;   // 默认信号行为:SIGTERM 即死
  let fakeIgnorer: string;   // 忽略 SIGTERM:用于验证升级 SIGKILL
  let cfgDir: string;
  let pidPath: string;
  let lockPath: string;
  const origConfigDir = process.env.LSC_CONFIG_DIR;

  const makeOptions = (): ServerOptions => ({
    model: '/tmp/model.gguf',
    ctxSize: 4096,
    gpuLayers: 0,
    host: '127.0.0.1',
    port: 18081,
    jinja: false,
    flashAttn: 'auto',
    reasoningBudget: -1,
  });

  const writeConfig = (serverPath: string): void => {
    writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ llamaServerPath: serverPath, defaultPort: 18080 }));
  };

  // 等待进程真正消失:子进程是我们 spawn 的,死亡后先变僵尸,Node 异步回收(实测 ~200ms)
  const expectDead = async (pid: number): Promise<void> => {
    for (let i = 0; i < 30; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        return; // ESRCH:已被回收
      }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`process ${pid} still exists after 3s`);
  };

  beforeAll(() => {
    toolsDir = mkdtempSync(join(tmpdir(), 'lsc-pm-tools-'));
    fakeSleeper = join(toolsDir, 'llama-server');
    fakeIgnorer = join(toolsDir, 'llama-server-ignorer');
    const sleeperSrc = join(toolsDir, 'sleeper.c');
    writeFileSync(sleeperSrc, '#include <unistd.h>\nint main(void){for(;;)pause();return 0;}\n');
    execSync(`cc -O1 -o "${fakeSleeper}" "${sleeperSrc}"`);
    const ignorerSrc = join(toolsDir, 'ignorer.c');
    writeFileSync(ignorerSrc, '#include <signal.h>\n#include <unistd.h>\nint main(void){signal(SIGTERM,SIG_IGN);for(;;)pause();return 0;}\n');
    execSync(`cc -O1 -o "${fakeIgnorer}" "${ignorerSrc}"`);
  });

  afterAll(() => {
    if (origConfigDir === undefined) {
      delete process.env.LSC_CONFIG_DIR;
    } else {
      process.env.LSC_CONFIG_DIR = origConfigDir;
    }
    rmSync(toolsDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    cfgDir = mkdtempSync(join(tmpdir(), 'lsc-pm-cfg-'));
    process.env.LSC_CONFIG_DIR = cfgDir;
    pidPath = join(cfgDir, 'server.pid');
    lockPath = join(cfgDir, 'server.start.lock');
    writeConfig(fakeSleeper);
  });

  afterEach(async () => {
    // 兜底清理:测试遗留的 fake 服务器一律强停
    try { await stopServer(true); } catch {}
    rmSync(cfgDir, { recursive: true, force: true });
  });

  test('start→stop:PID 文件带 proxy 字段,停止后删除且进程死亡', { timeout: 15000 }, async () => {
    const result = await startServer(makeOptions(), { publicPort: 18080 });
    expect(result.pid).toBeGreaterThan(0);

    const pidData = JSON.parse(readFileSync(pidPath, 'utf8')) as PidFile;
    expect(pidData.pid).toBe(result.pid);
    expect(pidData.proxy).toBe(true);
    expect(pidData.publicPort).toBe(18080);
    expect(existsSync(lockPath)).toBe(false); // 成功路径锁已释放

    const status = getServerStatus();
    expect(status.running).toBe(true);
    expect(status.proxy).toBe(true);
    expect(status.publicPort).toBe(18080);

    await stopServer();
    expect(existsSync(pidPath)).toBe(false);
    await expectDead(result.pid);
  });

  test('并发双开:恰有一个成功(锁或 already-running 拒绝另一个)', { timeout: 15000 }, async () => {
    const [a, b] = await Promise.allSettled([startServer(makeOptions()), startServer(makeOptions())]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['fulfilled', 'rejected']);

    const rejected = [a, b].find(x => x.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.message).toMatch(/Another lsc start is in progress|already running/);

    await stopServer();
    expect(existsSync(pidPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });

  test('锁语义:活锁拒绝;死 PID 陈旧锁接管;锁龄兜底接管', { timeout: 15000 }, async () => {
    // 活持有者(本进程 PID)→ 拒绝
    writeFileSync(lockPath, String(process.pid));
    await expect(startServer(makeOptions())).rejects.toThrow('Another lsc start is in progress');

    // 陈旧锁(死 PID)→ 接管并正常启动
    writeFileSync(lockPath, '999999');
    const r1 = await startServer(makeOptions());
    expect(r1.pid).toBeGreaterThan(0);
    await stopServer();

    // 锁龄兜底:持有者存活但 mtime 超过 60s(kill -9 后 PID 复用的场景)→ 接管
    writeFileSync(lockPath, String(process.pid));
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath, old, old);
    const r2 = await startServer(makeOptions());
    expect(r2.pid).toBeGreaterThan(0);
    await stopServer();
  });

  test('SIGTERM 免疫进程:升级 SIGKILL,确认死亡后才删 PID 文件', { timeout: 15000 }, async () => {
    writeConfig(fakeIgnorer);
    const result = await startServer(makeOptions());
    expect(existsSync(pidPath)).toBe(true);

    // 缩短 SIGTERM 等待以加速测试;升级与死亡确认逻辑不变
    await stopServer(false, 300);
    expect(existsSync(pidPath)).toBe(false);
    await expectDead(result.pid);
  });

  test('写 PID 文件失败:拒绝并杀死已 spawn 的孤儿进程', { timeout: 15000 }, async () => {
    // 让 writeJsonAtomic 的 tmp 写入失败(EISDIR),触发 spawn 后的同步异常路径
    mkdirSync(pidPath + '.tmp');
    await expect(startServer(makeOptions())).rejects.toThrow();
    expect(existsSync(lockPath)).toBe(false); // 锁已释放
    expect(existsSync(pidPath)).toBe(false);

    // fake 进程应已被 catch 路径 SIGKILL(Node 回收有延迟,轮询等待)
    // 用 execFileSync 直跑 pgrep:execSync 的 sh 包装进程自身 cmdline 含匹配串,会误匹配
    let gone = false;
    for (let i = 0; i < 20; i++) {
      try {
        execFileSync('pgrep', ['-f', fakeSleeper], { stdio: 'pipe' });
      } catch {
        gone = true; // pgrep 无匹配时退出码非零
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    expect(gone).toBe(true);
  });
});

// buildServerArgs:纯函数(不传 chatTemplate 即不触碰文件系统),独立于上面的 skipIf 组
describe('buildServerArgs 投机解码参数', () => {
  const makeArgsOptions = (): ServerOptions => ({
    model: '/tmp/model.gguf',
    ctxSize: 4096,
    gpuLayers: 0,
    host: '127.0.0.1',
    port: 18081,
    jinja: false,
    flashAttn: 'auto',
    reasoningBudget: -1,
  });

  test('specType + specModel:输出 --spec-type 与 --model-draft', () => {
    const args = buildServerArgs({ ...makeArgsOptions(), specType: 'draft-mtp', specModel: '/x.gguf' });
    const typeIdx = args.indexOf('--spec-type');
    expect(typeIdx).toBeGreaterThanOrEqual(0);
    expect(args[typeIdx + 1]).toBe('draft-mtp');
    const modelIdx = args.indexOf('--model-draft');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(args[modelIdx + 1]).toBe('/x.gguf');
  });

  test('未设置时:不含投机解码参数', () => {
    const args = buildServerArgs(makeArgsOptions());
    expect(args).not.toContain('--spec-type');
    expect(args).not.toContain('--model-draft');
  });

  test('仅 specType:只输出 --spec-type', () => {
    const args = buildServerArgs({ ...makeArgsOptions(), specType: 'ngram-simple' });
    expect(args).toContain('--spec-type');
    expect(args).not.toContain('--model-draft');
  });

  test('--alias:取模型文件名去路径与扩展名', () => {
    const args = buildServerArgs({ ...makeArgsOptions(), model: '/models/org/repo/Qwen3.5-9B-Q4_K_M.gguf' });
    const idx = args.indexOf('--alias');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('Qwen3.5-9B-Q4_K_M');
  });
});

// ctxSize 'auto' 与 --fit 联动:纯函数,独立于上面的 skipIf 组
describe('buildServerArgs ctxSize auto 与 fit', () => {
  const makeFitOptions = (): ServerOptions => ({
    model: '/tmp/model.gguf',
    ctxSize: 4096,
    gpuLayers: 0,
    host: '127.0.0.1',
    port: 18081,
    jinja: false,
    flashAttn: 'auto',
    reasoningBudget: -1,
  });

  test("ctxSize 'auto':不传 -c,强制 -fit on", () => {
    const args = buildServerArgs({ ...makeFitOptions(), ctxSize: 'auto' });
    expect(args).not.toContain('-c');
    const fitIdx = args.indexOf('-fit');
    expect(fitIdx).toBeGreaterThanOrEqual(0);
    expect(args[fitIdx + 1]).toBe('on');
    expect(args.filter(a => a === '-fit')).toHaveLength(1);
  });

  test("ctxSize 'auto' + fit:false:矛盾配置下 auto 优先,仍 -fit on", () => {
    const args = buildServerArgs({ ...makeFitOptions(), ctxSize: 'auto', fit: false });
    expect(args).not.toContain('-c');
    expect(args).not.toContain('off');
    const fitIdx = args.indexOf('-fit');
    expect(fitIdx).toBeGreaterThanOrEqual(0);
    expect(args[fitIdx + 1]).toBe('on');
    expect(args.filter(a => a === '-fit')).toHaveLength(1);
  });

  test('ctxSize 数字 + fit 未定义:传 -c N 且不含 -fit(既有行为)', () => {
    const args = buildServerArgs(makeFitOptions());
    const cIdx = args.indexOf('-c');
    expect(cIdx).toBeGreaterThanOrEqual(0);
    expect(args[cIdx + 1]).toBe('4096');
    expect(args).not.toContain('-fit');
  });

  test('ctxAutoFitConflict:auto + 数字 gpuLayers → 警告', () => {
    const msg = ctxAutoFitConflict({ ...makeFitOptions(), ctxSize: 'auto', gpuLayers: 20 });
    expect(msg).toBeTruthy();
    expect(msg).toContain('-ngl auto');
  });

  test('ctxAutoFitConflict:auto + tensorSplit → 警告', () => {
    const msg = ctxAutoFitConflict({ ...makeFitOptions(), ctxSize: 'auto', gpuLayers: 'auto', tensorSplit: '1,1' });
    expect(msg).toBeTruthy();
    expect(msg).toContain('tensor split');
  });

  test("ctxAutoFitConflict:auto + gpuLayers 'auto' → null", () => {
    expect(ctxAutoFitConflict({ ...makeFitOptions(), ctxSize: 'auto', gpuLayers: 'auto' })).toBeNull();
  });

  test('ctxAutoFitConflict:数字 ctx + 数字 gpuLayers → null', () => {
    expect(ctxAutoFitConflict({ ...makeFitOptions(), gpuLayers: 20 })).toBeNull();
  });
});

// --slot-save-path:纯函数 + 路径助手,独立于上面的 skipIf 组
describe('buildServerArgs slot-save-path', () => {
  const makeSlotOptions = (): ServerOptions => ({
    model: '/tmp/model.gguf',
    ctxSize: 4096,
    gpuLayers: 0,
    host: '127.0.0.1',
    port: 18081,
    jinja: false,
    flashAttn: 'auto',
    reasoningBudget: -1,
  });

  test('设置时:输出 --slot-save-path <dir>', () => {
    const args = buildServerArgs({ ...makeSlotOptions(), slotSavePath: '/x' });
    const idx = args.indexOf('--slot-save-path');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('/x');
  });

  test('未设置时:不含 --slot-save-path', () => {
    expect(buildServerArgs(makeSlotOptions())).not.toContain('--slot-save-path');
  });

  test('getDefaultSlotSavePath:返回 <configDir>/slots(遵循 LSC_CONFIG_DIR)', () => {
    const orig = process.env.LSC_CONFIG_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'lsc-slot-'));
    try {
      process.env.LSC_CONFIG_DIR = dir;
      expect(getDefaultSlotSavePath()).toBe(join(dir, 'slots'));
    } finally {
      if (orig === undefined) {
        delete process.env.LSC_CONFIG_DIR;
      } else {
        process.env.LSC_CONFIG_DIR = orig;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 版本探测:纯函数,不依赖平台/编译器,独立于上面的 skipIf 组
describe('llama-server 版本探测', () => {
  test('解析标准 --version 输出', () => {
    expect(parseLlamaServerBuild('ggml_cuda_init: found 1 CUDA devices:\nversion: 8157 (2943210c1)\nbuilt with GNU 11.4.0 for Linux x86_64')).toBe(8157);
  });

  test('兼容不同格式的输出', () => {
    expect(parseLlamaServerBuild('version: 10472 (60eeeb608)')).toBe(10472);
    expect(parseLlamaServerBuild('llama-server version: 6000')).toBe(6000);
  });

  test('新版 semver 格式取括号内 build 号', () => {
    expect(parseLlamaServerBuild('version: 0.1.1-dev (build 10472, commit 60eeeb608)')).toBe(10472);
    expect(parseLlamaServerBuild('version: 0.1.0 (build 9999, commit abc1234)\nbuilt with GNU 11.4.0')).toBe(9999);
  });

  test('无法解析时返回 null', () => {
    expect(parseLlamaServerBuild('not a version output')).toBeNull();
    expect(parseLlamaServerBuild('')).toBeNull();
  });

  test('checkLlamaServerVersion 对真实/伪造二进制的判定', () => {
    // 伪造过旧版本:shell 脚本打印老版本号(探测只读输出,不需要 ELF)
    const dir = mkdtempSync(join(tmpdir(), 'lsc-ver-'));
    try {
      const fakeOld = join(dir, 'llama-server');
      writeFileSync(fakeOld, '#!/bin/sh\necho "version: 5000 (deadbeef)"\n', { mode: 0o755 });
      const old = checkLlamaServerVersion(fakeOld);
      expect(old).not.toBeNull();
      expect(old!.build).toBe(5000);
      expect(old!.supported).toBe(false);

      const fakeNew = join(dir, 'llama-server-new');
      writeFileSync(fakeNew, `#!/bin/sh\necho "version: ${MIN_LLAMA_SERVER_BUILD} (cafe)"\n`, { mode: 0o755 });
      expect(checkLlamaServerVersion(fakeNew)!.supported).toBe(true);

      // 不存在的二进制:探测失败返回 null(不阻塞)
      expect(checkLlamaServerVersion(join(dir, 'nonexistent'))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

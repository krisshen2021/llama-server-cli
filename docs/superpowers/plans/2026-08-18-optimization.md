# lsc 全面优化实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 lsc(llama-server-cli)约 30 项已确认缺陷(数据损坏、安全、性能、稳定性),并完成结构重构(单一默认值来源、消除重复实现、TUI 机械拆分、死代码清理)。

**Architecture:** 按"测试先行 → 高危修复 → 性能稳定性 → 结构重构"四阶段推进。新增 3 个纯逻辑模块(`utils/server-options.ts` 统一选项解析、`utils/json-file.ts` 原子 JSON 读写、`utils/http.ts` 带重定向/超时的 HTTP 助手),将下载续传决策提取为纯函数以便 TDD;TUI 只做机械式拆分,不改交互。

**Tech Stack:** TypeScript(ESM, strict)+ tsc 构建;新增 vitest(仅 devDependency);commander / blessed / inquirer 不变。

**Spec:** `docs/superpowers/specs/2026-08-18-optimization-design.md`

**执行约定:**
- 构建验证:`npm run build`(tsc strict 必须零错误);测试:`npx vitest run`
- 每个 Task 结束有 commit 步骤。**git 提交需用户事先授权**;未授权时跳过 commit 步骤,只完成代码与验证
- 本项目无 lint;代码风格遵循所在文件现有约定(注释中文、ESM 导入带 `.js` 后缀)

---

## 文件结构

新增:
- `src/utils/server-options.ts` — `命令行 ?? 预设 ?? config ?? 内置默认` 单点解析 + `parseIntOpt` 数字解析 helper
- `src/utils/json-file.ts` — `readJsonSafe`(损坏备份)+ `writeJsonAtomic`(tmp+rename)
- `src/utils/http.ts` — `httpRequestWithRedirects`(超时、重定向上限、token 域名校验)
- `src/tui/system-info.ts` — GPU/RAM 信息(带缓存),从 tui/index.ts 抽出
- `src/tui/dialogs.ts` — `confirmDialog` 公共确认对话框,从 tui/index.ts 抽出
- `src/utils/server-options.test.ts`、`src/utils/json-file.test.ts`、`src/utils/hf-api.test.ts`、`src/utils/downloader.test.ts`、`src/utils/config-manager.test.ts`、`vitest.config.ts`(或零配置)

修改:
- `src/utils/downloader.ts` — 续传决策纯函数 `planResume`、流 error 处理、超时、重定向、meta 写节流
- `src/utils/hf-api.ts` — 量化匹配降序、tree 递归+分页、接入 http.ts
- `src/utils/process-manager.ts` — PID 身份校验、死亡确认、锁、proxy 标志、spawn error
- `src/utils/config-manager.ts`、`src/utils/preset-manager.ts`、`src/utils/download-meta.ts` — 接入 json-file
- `src/utils/request-logger.ts` — Buffer 拼接、error 处理、headersSent、客户端断开
- `src/utils/model-recommender.ts` — availableVRAM、真实文件大小、层数钳制、getSystemInfo 缓存/异步
- `src/utils/model-scanner.ts` — mmproj 精确匹配、扫描容错
- `src/commands/start.ts` — 接入 server-options、`--no-vision` 生效、parseIntOpt
- `src/commands/proxy.ts` — 改为 request-logger 薄封装
- `src/commands/config.ts` — validKeys 单点 + hfToken
- `src/commands/preset.ts` — 默认值读 config
- `src/index.ts` — 版本号运行时读 package.json
- `src/tui/index.ts` — 性能、模态、编排回滚、退出清理;抽出 system-info/dialogs
- `src/types.ts` — 删除 `DEFAULT_SERVER_OPTIONS`
- `tsconfig.json` — 启用 4 个严格 flag
- 删除(需用户确认 `git rm`):`config.json`、`presets.json`、`patch-test-live.js`、`test-patch4.js`

---

## 阶段 0:测试安全网

### Task 1: vitest 接入

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `src/utils/json-file.test.ts`(首批测试随 Task 2 一起跑,本任务只搭架子)

- [ ] **Step 1: 安装 vitest**

```bash
npm install -D vitest
```

- [ ] **Step 2: 配置**

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
```

`package.json` scripts 增加:

```json
"test": "vitest run"
```

- [ ] **Step 3: 验证运行**

```bash
npx vitest run
```

预期:通过(0 个测试也算通过;若报 "No test files found" 退出码非 0,属正常,Task 2 后消失)

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "test: add vitest"
```

---

### Task 2: json-file.ts(原子写 + 损坏备份)— TDD

**Files:**
- Create: `src/utils/json-file.ts`
- Test: `src/utils/json-file.test.ts`

- [ ] **Step 1: 写失败测试**

`src/utils/json-file.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readJsonSafe, writeJsonAtomic } from './json-file.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lsc-json-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('readJsonSafe', () => {
  it('文件不存在时返回 fallback', () => {
    expect(readJsonSafe(join(dir, 'nope.json'), { a: 1 })).toEqual({ a: 1 });
  });

  it('正常解析 JSON', () => {
    const p = join(dir, 'ok.json');
    writeFileSync(p, '{"a":2}');
    expect(readJsonSafe(p, { a: 1 })).toEqual({ a: 2 });
  });

  it('JSON 损坏时备份 .bak 并返回 fallback', () => {
    const p = join(dir, 'bad.json');
    writeFileSync(p, '{corrupted');
    expect(readJsonSafe(p, { a: 1 })).toEqual({ a: 1 });
    expect(existsSync(p + '.bak')).toBe(true);
    expect(readFileSync(p + '.bak', 'utf8')).toBe('{corrupted');
  });
});

describe('writeJsonAtomic', () => {
  it('写入后可读回,且不残留 tmp 文件', () => {
    const p = join(dir, 'w.json');
    writeJsonAtomic(p, { b: 3 });
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ b: 3 });
    expect(existsSync(p + '.tmp')).toBe(false);
  });

  it('覆盖已存在文件', () => {
    const p = join(dir, 'w.json');
    writeFileSync(p, '{"old":true}');
    writeJsonAtomic(p, { b: 4 });
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ b: 4 });
  });
});
```

- [ ] **Step 2: 确认失败**

```bash
npx vitest run src/utils/json-file.test.ts
```

预期:FAIL(模块不存在)

- [ ] **Step 3: 实现**

`src/utils/json-file.ts`:

```ts
import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync } from 'fs';

// 读取 JSON 文件;解析失败时备份为 .bak 并返回 fallback,避免静默覆盖用户数据
export function readJsonSafe<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    try {
      copyFileSync(filePath, filePath + '.bak');
      console.error(`Warning: ${filePath} is corrupted, backed up to ${filePath}.bak`);
    } catch { /* 备份失败不阻塞 */ }
    return fallback;
  }
}

// 原子写入:先写 tmp 再 rename,防止中途崩溃留下半个文件
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, filePath);
}
```

- [ ] **Step 4: 确认通过**

```bash
npx vitest run src/utils/json-file.test.ts
```

预期:5 passed

- [ ] **Step 5: Commit**

```bash
git add src/utils/json-file.ts src/utils/json-file.test.ts
git commit -m "feat: atomic JSON read/write helpers with corrupt-file backup"
```

---

### Task 3: server-options.ts(单点选项解析 + parseIntOpt)— TDD

**Files:**
- Create: `src/utils/server-options.ts`
- Test: `src/utils/server-options.test.ts`

**背景:** 当前 `commands/start.ts:75` 用 `DEFAULT_SERVER_OPTIONS` 预填充,导致 `config.defaultX` 回退失效;`start.ts:84-94` 只复制 9 个预设字段;`--no-vision` 设置了却没进 finalOptions。本模块把解析收敛为一处:优先级 `命令行 > 预设 > config > 内置默认`,忽略 `undefined` 值。

- [ ] **Step 1: 写失败测试**

`src/utils/server-options.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveServerOptions, parseIntOpt, BUILTIN_SERVER_DEFAULTS } from './server-options.js';
import { DEFAULT_CONFIG } from '../types.js';

const base = { model: '/m.gguf' };

describe('resolveServerOptions', () => {
  it('仅给 model 时,其余来自 config 与内置默认', () => {
    const o = resolveServerOptions(base, null, { ...DEFAULT_CONFIG });
    expect(o.ctxSize).toBe(DEFAULT_CONFIG.defaultCtxSize);
    expect(o.port).toBe(DEFAULT_CONFIG.defaultPort);
    expect(o.jinja).toBe(true);
    expect(o.useVision).toBe(true);
    expect(o.flashAttn).toBe('auto');
  });

  it('config 覆盖内置默认', () => {
    const o = resolveServerOptions(base, null, { ...DEFAULT_CONFIG, defaultCtxSize: 32768 });
    expect(o.ctxSize).toBe(32768);
  });

  it('预设覆盖 config', () => {
    const o = resolveServerOptions(base, { ctxSize: 8192, kvCacheType: 'q8_0' }, { ...DEFAULT_CONFIG, defaultCtxSize: 32768 });
    expect(o.ctxSize).toBe(8192);
    expect(o.kvCacheType).toBe('q8_0');
  });

  it('命令行覆盖预设;undefined 不覆盖', () => {
    const o = resolveServerOptions(
      { ...base, ctxSize: 4096, port: undefined },
      { ctxSize: 8192, port: 9090 },
      { ...DEFAULT_CONFIG },
    );
    expect(o.ctxSize).toBe(4096);
    expect(o.port).toBe(9090);
  });

  it('useVision 可经预设或 CLI 关闭(false 不被忽略)', () => {
    expect(resolveServerOptions({ ...base, useVision: false }, null, { ...DEFAULT_CONFIG }).useVision).toBe(false);
    expect(resolveServerOptions(base, { useVision: false }, { ...DEFAULT_CONFIG }).useVision).toBe(false);
  });

  it('gpuLayers 支持数字 0 与 auto', () => {
    expect(resolveServerOptions({ ...base, gpuLayers: 0 }, null, { ...DEFAULT_CONFIG }).gpuLayers).toBe(0);
  });
});

describe('parseIntOpt', () => {
  it('解析合法整数', () => {
    expect(parseIntOpt('8080')).toBe(8080);
    expect(parseIntOpt('0')).toBe(0);
  });

  it('非法输入抛错', () => {
    expect(() => parseIntOpt('abc')).toThrow();
    expect(() => parseIntOpt('')).toThrow();
  });
});
```

- [ ] **Step 2: 确认失败**

```bash
npx vitest run src/utils/server-options.test.ts
```

预期:FAIL(模块不存在)

- [ ] **Step 3: 实现**

`src/utils/server-options.ts`:

```ts
import { InvalidArgumentError } from 'commander';
import { Config, Preset, ServerOptions } from '../types.js';

// 不来自 Config 的内置默认值(types.ts 中 DEFAULT_SERVER_OPTIONS 删除后以此为准)
export const BUILTIN_SERVER_DEFAULTS = {
  jinja: true,
  flashAttn: 'auto' as const,
  reasoningBudget: -1,
  useVision: true,
};

// Config 的 defaultX 键到 ServerOptions 的映射
function configDefaults(config: Config): Partial<ServerOptions> {
  return {
    ctxSize: config.defaultCtxSize,
    gpuLayers: config.defaultGpuLayers,
    host: config.defaultHost,
    port: config.defaultPort,
    batchSize: config.defaultBatchSize,
    threadsBatch: config.defaultThreadsBatch,
    cachePrompt: config.defaultCachePrompt,
    cacheReuse: config.defaultCacheReuse,
  };
}

function overlayDefined<T extends object>(target: Record<string, unknown>, src: T): void {
  for (const [k, v] of Object.entries(src)) {
    if (v !== undefined) target[k] = v;
  }
}

// 单点解析:命令行 > 预设 > config > 内置默认
export function resolveServerOptions(
  cli: Partial<ServerOptions>,
  preset: Partial<Preset> | null,
  config: Config,
): ServerOptions {
  const merged: Record<string, unknown> = { ...BUILTIN_SERVER_DEFAULTS };
  overlayDefined(merged, configDefaults(config));
  if (preset) overlayDefined(merged, preset);
  overlayDefined(merged, cli);
  return merged as unknown as ServerOptions;
}

// commander 数字选项解析:NaN 直接报错,而不是把 NaN 传给 llama-server
export function parseIntOpt(value: string): number {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) throw new InvalidArgumentError(`Not a number: ${value}`);
  return n;
}
```

- [ ] **Step 4: 确认通过 + 构建**

```bash
npx vitest run src/utils/server-options.test.ts && npm run build
```

预期:7 passed;tsc 零错误(`DEFAULT_SERVER_OPTIONS` 此时尚未删除,不冲突)

- [ ] **Step 5: Commit**

```bash
git add src/utils/server-options.ts src/utils/server-options.test.ts
git commit -m "feat: single-point server option resolution with CLI/preset/config precedence"
```

---

### Task 4: hf-api 量化匹配修复 — TDD

**Files:**
- Modify: `src/utils/hf-api.ts:70-78`
- Test: `src/utils/hf-api.test.ts`

**背景:** `QUANTIZATION_PATTERNS` 中 `Q4_K` 排在 `Q4_K_M`/`Q4_K_S` 前,`includes` 取首个短匹配。修复:匹配时按模式长度降序。先看 `hf-api.ts` 当前实现(提取量化名的导出函数,若没有导出则导出一个 `detectQuantization(fileName: string): string | null`)。

- [ ] **Step 1: 写失败测试**

`src/utils/hf-api.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { detectQuantization } from './hf-api.js';

describe('detectQuantization', () => {
  it('优先匹配长模式', () => {
    expect(detectQuantization('model-Q4_K_M.gguf')).toBe('Q4_K_M');
    expect(detectQuantization('model-Q4_K_S.gguf')).toBe('Q4_K_S');
    expect(detectQuantization('model-Q2_K.gguf')).toBe('Q2_K');
  });

  it('大小写不敏感', () => {
    expect(detectQuantization('Model-q4_k_m.gguf')).toBe('Q4_K_M');
  });

  it('无匹配返回 null', () => {
    expect(detectQuantization('README.md')).toBeNull();
  });
});
```

注:以 `hf-api.ts` 实际导出名为准;若现状是内部函数,导出为 `detectQuantization`。

- [ ] **Step 2: 确认失败**

```bash
npx vitest run src/utils/hf-api.test.ts
```

预期:FAIL(`Q4_K_M` 实际得到 `Q4_K`)

- [ ] **Step 3: 修复** — 模块加载时将模式表按长度降序排序一次,匹配逻辑不变:

```ts
const SORTED_PATTERNS = [...QUANTIZATION_PATTERNS].sort((a, b) => b.length - a.length);
// 匹配处:for (const q of SORTED_PATTERNS) { if (upper.includes(q)) return q; }
```

- [ ] **Step 4: 确认通过 + 构建**

```bash
npx vitest run src/utils/hf-api.test.ts && npm run build
```

预期:4 passed;tsc 零错误

- [ ] **Step 5: Commit**

```bash
git add src/utils/hf-api.ts src/utils/hf-api.test.ts
git commit -m "fix: match longest quantization pattern first (Q4_K_M no longer detected as Q4_K)"
```

---

## 阶段 1:高危修复

### Task 5: downloader 续传决策纯函数 + 流/超时/重定向 — TDD

**Files:**
- Modify: `src/utils/downloader.ts`(319-321, 340-399, 409, 418-433, 441-444, 481-485)
- Test: `src/utils/downloader.test.ts`

**背景:** 四个续传 bug(spec 高危 #1)加一个丢弃重试 bug。策略:把"(partial 大小, HTTP 状态码, 期望大小) → 怎么开文件"提取为纯函数 `planResume` 导出,TDD 覆盖全部分支后接入 `downloadFile`;同时修流 error 处理、abort 销毁写流、请求超时、meta 写节流。

- [ ] **Step 1: 写失败测试**

`src/utils/downloader.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { planResume } from './downloader.js';

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
});

describe('planResume 输出接入约定', () => {
  it('offset 永远来自磁盘 stat,不来自内存计数', () => {
    // 调用方契约:partialSize 必须 statSync 得到;此处固化返回值形状
    const r = planResume(400, 206, 1000);
    expect(r).toHaveProperty('offset');
    expect(r).toHaveProperty('flags');
  });
});
```

- [ ] **Step 2: 确认失败**

```bash
npx vitest run src/utils/downloader.test.ts
```

预期:FAIL(`planResume` 未导出)

- [ ] **Step 3: 实现 `planResume` 并接入**

在 `downloader.ts` 顶部(类外)新增并导出:

```ts
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
```

接入 `downloadFile`(当前约 319-399 行),要点:
1. 发请求前:`const partialSize = existsSync(partialPath) ? statSync(partialPath).size : 0;`,Range 头与 `task.downloadedBytes` 初值都用它(替换内存计数)
2. `https.request` 回调里先 `const plan = planResume(partialSize, res.statusCode ?? 0, task.expectedSize)`:
   - `complete` → 走现有完成路径(partial rename 为正式文件,发 complete 事件)
   - `restart` → `res.resume()` 消费响应、`rmSync(partialPath, { force: true })`、走重试路径
   - `download` → `createWriteStream(partialPath, { flags: plan.flags })`,`task.downloadedBytes = plan.offset`
3. `res.on('error', err => handleDownloadError(task, err))`(当前只有 data/end)
4. writeStream 错误处理:`writeStream.on('error', ...)` 同样进重试路径;`abort` 实现(约 409 行)补 `writeStream.destroy()`
5. 请求加空闲超时:`req.setTimeout(60_000, () => req.destroy(new Error('Request timed out')))`
6. 重定向处理(约 342-350)改为调用 Task 12 的 `http.ts`?——不,下载器重定向就地修:`res.resume()` 后再 follow;加 `redirectCount` 参数上限 5;仅当目标 host 满足 `isTrustedHost` 才带 `Authorization`:

```ts
function isTrustedHost(hostname: string): boolean {
  return hostname === 'huggingface.co'
    || hostname.endsWith('.huggingface.co')
    || hostname.endsWith('.hf.co');
}
```

7. `handleDownloadError` 的 `setTimeout` 重试(约 418-433):到点无条件 `task.status = 'pending'; this.processQueue()`;`processQueue` 开头加 `if (this.isPaused) return;`,且仅在无 pending/downloading 任务且无活动下载时才 emit `complete`
8. `updateMetaTimestamp`(约 481-485)节流:任务上次写入距今 < 10s 则跳过(完成/暂停时强制写)

- [ ] **Step 4: 确认通过 + 构建**

```bash
npx vitest run src/utils/downloader.test.ts && npm run build
```

预期:8 passed;tsc 零错误

- [ ] **Step 5: Commit**

```bash
git add src/utils/downloader.ts src/utils/downloader.test.ts
git commit -m "fix: download resume no longer corrupts files (disk-based offset, 200/416 handling, paused-retry, stream errors, timeout)"
```

---

### Task 6: modelId 校验 + execFileSync(堵 shell 注入/路径穿越)

**Files:**
- Modify: `src/utils/downloader.ts:572`(`checkDiskSpace`)
- Modify: `src/utils/preset-generator.ts:242-267`(`getModelDir`/`getModelStoragePath`)
- Modify: `src/utils/hf-api.ts`(模型 ID 进入 API 路径的入口函数)
- Test: `src/utils/server-options.test.ts` 不动;校验逻辑放 `hf-api.ts` 导出,测试加到 `src/utils/hf-api.test.ts`

- [ ] **Step 1: 追加失败测试**

`src/utils/hf-api.test.ts` 追加:

```ts
import { assertValidModelId } from './hf-api.js';

describe('assertValidModelId', () => {
  it('接受合法 org/repo', () => {
    expect(() => assertValidModelId('bartowski/Qwen2.5-7B-Instruct-GGUF')).not.toThrow();
  });

  it('拒绝注入与路径穿越', () => {
    expect(() => assertValidModelId('$(rm -rf ~)/x')).toThrow();
    expect(() => assertValidModelId('../../etc')).toThrow();
    expect(() => assertValidModelId('no-slash')).toThrow();
    expect(() => assertValidModelId('a/b/c')).toThrow();
    expect(() => assertValidModelId('')).toThrow();
  });
});
```

- [ ] **Step 2: 确认失败**

```bash
npx vitest run src/utils/hf-api.test.ts
```

预期:FAIL(`assertValidModelId` 未导出)

- [ ] **Step 3: 实现**

`hf-api.ts` 导出:

```ts
export function assertValidModelId(modelId: string): void {
  if (!/^[\w.-]+\/[\w.-]+$/.test(modelId)) {
    throw new Error(`Invalid model ID: ${modelId} (expected "org/repo")`);
  }
}
```

接入点:
- `hf-api.ts` 中所有以 modelId 拼 URL 的公共函数入口调用 `assertValidModelId(modelId)`
- `preset-generator.ts` 的 `getModelDir`/`getModelStoragePath` 入口调用(import 自 hf-api)
- `downloader.ts:572` `checkDiskSpace` 改无 shell 调用:

```ts
import { execFileSync } from 'child_process';
// 替换 execSync(`df -B1 "${dir}" ...`)
const out = execFileSync('df', ['-B1', dir], { encoding: 'utf8' });
// 解析逻辑保持现有(取最后一行数字列)
```

- [ ] **Step 4: 确认通过 + 构建**

```bash
npx vitest run && npm run build
```

预期:全部 passed;tsc 零错误

- [ ] **Step 5: Commit**

```bash
git add src/utils/hf-api.ts src/utils/hf-api.test.ts src/utils/preset-generator.ts src/utils/downloader.ts
git commit -m "fix: validate model IDs and drop shell interpolation (injection + path traversal)"
```

---

### Task 7: config/presets/meta/PID 接入 json-file(原子写 + 损坏备份)

**Files:**
- Modify: `src/utils/config-manager.ts:34-47`
- Modify: `src/utils/preset-manager.ts:14-24`
- Modify: `src/utils/download-meta.ts`(读写处)
- Modify: `src/utils/process-manager.ts`(PID 文件读写处,约 11-58)
- Test: `src/utils/config-manager.test.ts`

- [ ] **Step 1: 写失败测试(损坏恢复场景)**

`src/utils/config-manager.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lsc-cfg-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('loadConfig 损坏恢复', () => {
  it('config.json 损坏时备份 .bak、返回默认,且后续保存不丢数据', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', dir); // 若实现不用 XDG,则改为 mock 路径常量
    const { getConfigPath, saveConfig, loadConfig } = await import('./config-manager.js');
    writeFileSync(getConfigPath(), '{broken');
    const cfg = loadConfig();
    expect(cfg.defaultPort).toBe(8080);
    expect(existsSync(getConfigPath() + '.bak')).toBe(true);
    saveConfig({ ...cfg, defaultCtxSize: 32768 });
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf8')).defaultCtxSize).toBe(32768);
    expect(existsSync(getConfigPath() + '.tmp')).toBe(false);
  });
});
```

注:`config-manager.ts` 当前把配置路径写死为 `~/.config/lsc/config.json`(约 6-7 行)。为可测,将其改为读 `process.env.LSC_CONFIG_DIR ?? ~/.config/lsc`(同步改 presets/meta/pid 的目录解析,各自提供 `getConfigPath()`/`getPresetsPath()` 等导出)。测试用 `LSC_CONFIG_DIR=dir` 替代 `XDG_CONFIG_HOME`,并用 `vi.resetModules()` + 动态 import 保证每个用例独立。

- [ ] **Step 2: 确认失败**

```bash
LSC_CONFIG_DIR=$dir npx vitest run src/utils/config-manager.test.ts
```

预期:FAIL(当前损坏时静默返回默认、无 .bak)

- [ ] **Step 3: 实现** — 四个 manager 的 `readFileSync+JSON.parse` 换 `readJsonSafe`,`writeFileSync` 换 `writeJsonAtomic`(保持各自 merge/默认逻辑不变):

```ts
// config-manager.ts
import { readJsonSafe, writeJsonAtomic } from './json-file.js';
export function getConfigDir(): string {
  return process.env.LSC_CONFIG_DIR ?? join(homedir(), '.config', 'lsc');
}
export function getConfigPath(): string { return join(getConfigDir(), 'config.json'); }
// loadConfig: return { ...DEFAULT_CONFIG, ...readJsonSafe(getConfigPath(), {}) }
// saveConfig: writeJsonAtomic(getConfigPath(), config)
```

preset-manager / download-meta / process-manager 同理(PID 文件仍是 JSON,同样用原子写;PID 读取失败静默 fallback 即可,不需要 .bak 警告——PID 文件易失,readJsonSafe 传 fallback `{}` 即可,警告可接受)。

- [ ] **Step 4: 确认通过 + 构建**

```bash
npx vitest run && npm run build
```

预期:全部 passed;tsc 零错误

- [ ] **Step 5: Commit**

```bash
git add src/utils/config-manager.ts src/utils/preset-manager.ts src/utils/download-meta.ts src/utils/process-manager.ts src/utils/config-manager.test.ts
git commit -m "fix: atomic writes for config/presets/meta/pid; corrupt JSON backed up instead of silently wiped"
```

---

### Task 8: request-logger 流与 Buffer 修复

**Files:**
- Modify: `src/utils/request-logger.ts`(31, 75-79, 118-132, 181-190, 208)

**背景:** spec 高危 #5 + 中危 #9 的代理部分。无单测(网络集成),靠 build + 后续手动冒烟。

- [ ] **Step 1: 阅读现状**

读 `src/utils/request-logger.ts` 全文,确认:
- 请求体逐 chunk `toString()` 拼接(75-79)并以原 `content-length` 转发(118-121)
- `proxyRes` 无 `error` 处理(123+)
- `proxyReq.on('error')` 无条件 `writeHead(502)`(181-185)
- 死代码 `formatJson`(31)、无人读的 `LSC_FULL_BODY` 提示(208)

- [ ] **Step 2: 实施修复**

1. 请求/响应体收集改 Buffer 数组:

```ts
const chunks: Buffer[] = [];
req.on('data', (c: Buffer) => chunks.push(c));
req.on('end', () => {
  const body = Buffer.concat(chunks);
  const display = body.toString('utf8', 0, maxBodyLength); // 仅展示用,截断
  // 转发时写 Buffer 本体,content-length 用 body.length
});
```

2. `showResponse` 为 false 时不累积响应体
3. `proxyRes.on('error', ...)`、`proxyReq` 对应客户端 `req.on('close', () => proxyReq.destroy())`
4. `writeHead(502)` 加守卫:

```ts
proxyReq.on('error', (err) => {
  if (!res.headersSent) res.writeHead(502);
  res.end(`Proxy error: ${err.message}`);
});
```

5. 删除 `formatJson` 与 `LSC_FULL_BODY` 提示

- [ ] **Step 3: 构建 + 全量测试**

```bash
npm run build && npx vitest run
```

预期:tsc 零错误;全部 passed

- [ ] **Step 4: Commit**

```bash
git add src/utils/request-logger.ts
git commit -m "fix: proxy buffers bodies as Buffer, handles stream errors, guards headersSent, drops dead code"
```

---

## 阶段 2:性能与稳定性

### Task 9: TUI 性能(异步化 + 缓存 + 精准刷新)

**Files:**
- Create: `src/tui/system-info.ts`
- Modify: `src/tui/index.ts`(86-124, 427-460, 496-582, 653-655, 987, 1236, 2054-2067)
- Modify: `src/utils/model-recommender.ts:98-101`(getSystemInfo 改异步)

**背景:** spec 中危 #6。四块:GPU/RAM 查询异步化并抽模块;系统信息缓存(不再每个 keypress 调 nvidia-smi);下载进度回调不再全量 updateStatus;日志/删除不阻塞。

- [ ] **Step 1: 抽出 `src/tui/system-info.ts`**

把 `getGpuInfo`(tui/index.ts:86-106)与 `getRamInfo`(109-124)移入新模块并改异步:

```ts
import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileP = promisify(execFile);

export interface GpuInfo { used: number; total: number; percent: number; temp: number }
export interface RamInfo { used: number; total: number; percent: number }

export async function getGpuInfo(): Promise<GpuInfo[] | null> {
  try {
    const { stdout } = await execFileP('nvidia-smi', [
      '--query-gpu=memory.used,memory.total,utilization.gpu,temperature.gpu',
      '--format=csv,noheader,nounits',
    ], { timeout: 2000 });
    // 解析逻辑沿用 tui/index.ts 原实现
    return stdout.trim().split('\n').map((line) => {
      const [used, total, percent, temp] = line.split(',').map((s) => parseFloat(s.trim()));
      return { used, total, percent, temp };
    });
  } catch {
    return null;
  }
}

export async function getRamInfo(): Promise<RamInfo> {
  // 沿用原实现,execFileP('free', ['-m']) 解析 Mem 行
}

// 系统级一次性信息(GPU 数量/型号),启动时填充
let cachedGpuCount: number | null = null;
export async function warmSystemInfoCache(): Promise<void> {
  const gpus = await getGpuInfo();
  cachedGpuCount = gpus ? gpus.length : 0;
}
export function getCachedGpuCount(): number {
  return cachedGpuCount ?? 1;
}
```

- [ ] **Step 2: model-recommender.getSystemInfo 改异步**

`model-recommender.ts:98-101` 的 `execSync('nvidia-smi', {timeout: 5000})` 改 `execFile` promisify 版,函数签名改 `async getSystemInfo()`,调用处(TUI 下载推荐流程)加 `await`。TUI 在 `init` 里 `await warmSystemInfoCache()` 一次;`getTensorSplitOptions`(tui/index.ts:653-655)改读 `getCachedGpuCount()`,不再每次调 `getSystemInfo()`。

- [ ] **Step 3: TUI 周期任务异步化 + 精准刷新**

- `updateResources`(496-562):改 `async`,`await getGpuInfo()/getRamInfo()`;间隔保持 2s
- `updateLogs`(574-582):`execFile('tail', ['-n', '100', logFile])` 异步;**内容与上次相同则不重绘**;仅当 `logBox.getScrollPerc() >= 99` 时才 `setScrollPerc(100)`
- 下载进度回调(2054-2067):不再调完整 `updateStatus()`;新增只更新状态栏下载段的轻量函数(复用现有文案拼装);`scanIncompleteDownloads` 结果缓存,仅在下载管理器打开/删除/续传或距上次扫描 > 5s 时重算
- `setActiveDownloadManager`(2054)保存 handler 引用,替换/清空 manager 时 `manager.off('progress', handler)`
- 模型删除(987):`rmSync(modelDir, {recursive:true})` → `await fs.promises.rm(modelDir, {recursive:true, force:true})`

- [ ] **Step 4: 构建 + 测试**

```bash
npm run build && npx vitest run
```

预期:tsc 零错误;全部 passed

- [ ] **Step 5: 手动冒烟(记录结果)**

`npm start` 启动 TUI:开下载管理器观察进度刷新;按左右方向键调 Tensor Split(应无卡顿);`l` 看日志滚动不被强拉。记录观察到 CLI/TUI 行为正常。

- [ ] **Step 6: Commit**

```bash
git add src/tui/system-info.ts src/tui/index.ts src/utils/model-recommender.ts
git commit -m "perf: async GPU/RAM queries, cached system info, targeted status updates in TUI"
```

---

### Task 10: TUI 稳定性(模态、编排回滚、退出清理)

**Files:**
- Create: `src/tui/dialogs.ts`
- Modify: `src/tui/index.ts`(700-738, 741-775, 847-885, 952, 1033, 1905, 2308, 2354, 2399-2412, 2579-2656, 2684-2688, 2725-2738)

**背景:** spec 中危 #7。全局快捷键穿透输入框/对话框;对话框可叠层;代理失败留孤儿;退出不清理。

- [ ] **Step 1: `src/tui/dialogs.ts` — 模态感知确认框**

```ts
import blessed from 'blessed';

// 模态深度:>0 时全局快捷键应静默
let modalDepth = 0;
export function isModalOpen(): boolean { return modalDepth > 0; }

export function confirmDialog(
  screen: blessed.Widgets.Screen,
  message: string,
  onConfirm: () => void,
): void {
  modalDepth++;
  const box = blessed.box({
    parent: screen,
    top: 'center', left: 'center', width: '50%', height: 'shrink',
    border: { type: 'line' },
    content: `${message}\n\n[y] Yes    [n/Esc] No`,
    style: { border: { fg: 'yellow' } },
    keys: true,
  });
  const cleanup = () => {
    modalDepth--;
    box.destroy();
    screen.render();
  };
  box.on('keypress', (_ch, key) => {
    if (key.name === 'y') { cleanup(); onConfirm(); }
    else if (key.name === 'n' || key.name === 'escape') { cleanup(); }
  });
  box.focus();
  screen.render();
}
```

替换 tui/index.ts 五处 `screen.on('keypress')` y/n/esc 样板(980, 1059, 1934, 2336, 2387 附近)为 `confirmDialog(...)`。样式以现有对话框为准微调,行为契约:同屏最多一个(新调用先忽略或替换旧的,取简单做法:isModalOpen() 时直接 return)。

- [ ] **Step 2: 全局快捷键加模态/输入守卫**

`screen.key(['q','C-c'], ...)`(2585)、`r`(2589)、`l`(2596)、`s`(2607)、`tab`(2656)各 handler 开头:

```ts
if (isModalOpen()) return;
const focused = screen.focused as { editing?: boolean } | undefined;
if (focused?.editing) return; // 输入框编辑中(blessed textbox 读入时 editing=true)
```

- [ ] **Step 3: 服务编排修复**

- `handleStartServer`(700-738)与 `handleLoadPreset`(847-885)抽公共 `launchServer(options, publicPort)`:`startServer` 成功后若 `startProxy` 失败 → `await stopServer()` 回滚并提示;`currentServerOptions` 只在全部成功后赋值
- `handleRestartServer`(766-775):先 `stopProxy()` 再 `stopServer()`
- `handleStopServer`(741-764):状态清理(`currentServerOptions = {}`、停 watcher)放 `finally`;`stopServer` 的 "not running" 拒绝视为成功
- `cleanup`(2684-2688):补 `screen.destroy()`;`init()` 调用(2738)加 `.catch(err => { console.error(err); process.exit(1); })`

- [ ] **Step 4: 构建 + 测试**

```bash
npm run build && npx vitest run
```

预期:tsc 零错误;全部 passed

- [ ] **Step 5: Commit**

```bash
git add src/tui/dialogs.ts src/tui/index.ts
git commit -m "fix: modal-aware TUI keys, proxy failure rollback, clean shutdown"
```

---

### Task 11: process-manager 硬化(PID 身份、死亡确认、锁、proxy 标志)

**Files:**
- Modify: `src/utils/process-manager.ts`(11-18, 36, 54-58, 189-203, 232-270)
- Modify: `src/types.ts`(`PidFile` 增加可选字段)
- Modify: `src/tui/index.ts`(2417-2435, 2700-2729)
- Modify: `src/commands/start.ts`(写 PID 时带 proxy 标志,随 Task 12 一起改也可)

**背景:** spec 中危 #8 + TUI init 的 `port % 10` 猜测。

- [ ] **Step 1: PidFile 扩展**

`src/types.ts`:

```ts
export interface PidFile {
  pid: number;
  model: string;
  port: number;
  startTime: string;
  proxy?: boolean;      // 是否经请求日志代理启动
  publicPort?: number;  // 代理对外端口(有代理时)
}
```

- [ ] **Step 2: 进程身份校验与死亡确认**

```ts
// process-manager.ts
function isLlamaServerProcess(pid: number): boolean {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmdline.includes('llama-server');
  } catch {
    return true; // 非 Linux 或无权限:回退到仅 kill(pid,0) 判断
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return isLlamaServerProcess(pid);
  } catch (err) {
    // EPERM:进程存在但属其他用户 → 视为存活,不得删 PID 文件
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
```

`getServerStatus`(54-58):仅在 `isProcessRunning` 明确 false(非 EPERM)时删 PID 文件。
`stopServer`(232-270):SIGTERM → 等待 → SIGKILL 后**轮询确认死亡**(每 100ms 查 `isProcessRunning`,最多 3s)再删 PID 文件;仍存活则 throw 且保留 PID 文件。

- [ ] **Step 3: start 互斥锁**

```ts
// 简单锁文件:O_EXCL 创建,持锁进程死亡则视为陈旧锁接管
function acquireLock(lockPath: string): void {
  try {
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
  } catch {
    const holder = parseInt(readFileSync(lockPath, 'utf8'), 10);
    if (!isNaN(holder) && isProcessRunning(holder)) {
      throw new Error('Another lsc start is in progress');
    }
    rmSync(lockPath, { force: true });
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
  }
}
```

`startServer` 入口 acquire、完成/失败 release;`spawn` 的 `child.on('error', ...)` 拒绝 Promise 并关闭已打开的 logFd(修复 189-203 的 fd 泄漏)。写 PID 文件时写入 `proxy`/`publicPort`。

- [ ] **Step 4: TUI 配合修改**

- `cleanupOrphanProcesses`(tui/index.ts:2417-2435):端口取自 config(`defaultPort`,及其 -1 的代理端口),杀前用 `isLlamaServerProcess` 校验;`execSync('sleep 1')` 改 `await new Promise(r => setTimeout(r, 1000))`;`init` 里重复的 lsof(2700)删除
- `init` 重连逻辑(2705-2721):读 PID 文件的 `proxy`/`publicPort` 决定要不要补代理;旧格式无该字段 → 视为无代理(不再按 `port % 10` 猜)

- [ ] **Step 5: 构建 + 测试**

```bash
npm run build && npx vitest run
```

预期:tsc 零错误;全部 passed

- [ ] **Step 6: Commit**

```bash
git add src/utils/process-manager.ts src/types.ts src/tui/index.ts src/commands/start.ts
git commit -m "fix: PID identity checks, verified shutdown, start lock, proxy flag in PID file"
```

---

### Task 12: http.ts + hf-api 分页 + 推荐器修正 + CLI 接入 server-options

**Files:**
- Create: `src/utils/http.ts`
- Modify: `src/utils/hf-api.ts`(189-197, 204-205, 225)
- Modify: `src/utils/model-recommender.ts`(141-145, 194, 285, 294)
- Modify: `src/commands/start.ts`(75, 84-94, 110, 121, 152-166, 211-227)
- Modify: `src/commands/config.ts:34,51`(validKeys 单点 + hfToken)
- Modify: `src/commands/proxy.ts:31,157`、`src/commands/status.ts:53`(parseIntOpt 替换)
- Modify: `src/commands/preset.ts`(170-177, 245-252 默认值改读 config)
- Test: `src/utils/server-options.test.ts`(CLI 接入后现有测试继续兜底)

- [ ] **Step 1: `src/utils/http.ts`**

```ts
import https from 'https';

export interface HttpRequestOptions {
  headers?: Record<string, string>;
  timeout?: number;          // 默认 30s 空闲超时
  maxRedirects?: number;     // 默认 5
  token?: string;            // Bearer token,仅发往可信域名
}

export function isTrustedHost(hostname: string): boolean {
  return hostname === 'huggingface.co'
    || hostname.endsWith('.huggingface.co')
    || hostname.endsWith('.hf.co');
}

// 统一的 https.request 封装:空闲超时、重定向上限、token 域名校阅、响应体消费
export function httpRequestWithRedirects(
  url: string,
  options: HttpRequestOptions,
  onResponse: (res: import('http').IncomingMessage) => void,
  redirects = 0,
): import('http').ClientRequest {
  const u = new URL(url);
  const headers = { ...options.headers };
  if (options.token && isTrustedHost(u.hostname)) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }
  const req = https.request(url, { headers }, (res) => {
    const code = res.statusCode ?? 0;
    if (code >= 300 && code < 400 && res.headers.location) {
      res.resume(); // 消费响应体,释放 socket
      if (redirects >= (options.maxRedirects ?? 5)) {
        req.destroy(new Error('Too many redirects'));
        return;
      }
      const next = new URL(res.headers.location, url).toString();
      httpRequestWithRedirects(next, options, onResponse, redirects + 1);
      return;
    }
    onResponse(res);
  });
  req.setTimeout(options.timeout ?? 30_000, () => req.destroy(new Error('Request timed out')));
  return req;
}
```

- [ ] **Step 2: hf-api 接入 + 分页**

- 所有 `https.request`(189 附近)改 `httpRequestWithRedirects`,删除本地重定向逻辑;响应体设上限(如 50MB 防御)
- tree 接口(225):`/api/models/{id}/tree/main?recursive=true`,并按 `Link` 头 cursor 翻页循环取完
- 保留 Task 4 的量化修复与 Task 6 的 `assertValidModelId`

- [ ] **Step 3: 推荐器修正**

- `fits`/`recommended`(194):`totalVRAM` → `availableVRAM`(字段已有,改读它);`getRecommendedGpuLayers`(285)同理
- `estimateModelSize`(141-145):所选量化在 `repo.files` 有真实 `size` 时优先用真实值,找不到再退回参数估算
- GPU 层数下限(294):`Math.max(10, …)` → `Math.max(0, …)`

- [ ] **Step 4: CLI 接入 server-options(修复预设丢字段/--no-vision/config 失效)**

`commands/start.ts` 的 `runStart` 重写选项合并段:
1. 删除 `serverOptions = {...DEFAULT_SERVER_OPTIONS}` 预填充(75)
2. 收集 CLI 覆盖:仅收集用户显式传入的键(commander 的 `options` 对象里 `undefined` 跳过);数字选项全部用 `parseIntOpt` 作 commander coercion(19,22,26,27,30,33)
3. `--no-vision` → `useVision: false` 进入 CLI 覆盖对象
4. 最终 `finalOptions = resolveServerOptions(cliOverrides, preset ?? null, config)`,替换 211-227 的手工合并;`gpuLayers` 的 `parseInt(x) || 'auto'` 改为显式 `'auto' === v ? 'auto' : parseIntOpt(v)`
5. 删除 `src/types.ts` 的 `DEFAULT_SERVER_OPTIONS` 及其引用(如有其它引用一并改 `BUILTIN_SERVER_DEFAULTS`/`resolveServerOptions`)

`commands/config.ts`:validKeys 两处合并为 `const VALID_KEYS = [...Object.keys(DEFAULT_CONFIG), 'hfToken'] as const`。
`commands/proxy.ts:31,157`、`status.ts:53`、`preset.ts:171,252`:`parseInt(x) || fallback` 改 `parseIntOpt`。
`commands/preset.ts` 交互默认值(170,177,245,251):改读 `getExpandedConfig()`。

- [ ] **Step 5: 构建 + 全量测试**

```bash
npm run build && npx vitest run
```

预期:tsc 零错误;全部 passed

- [ ] **Step 6: Commit**

```bash
git add src/utils/http.ts src/utils/hf-api.ts src/utils/model-recommender.ts src/commands/ src/types.ts
git commit -m "feat: shared HTTP helper with timeouts/redirect limits; CLI honors presets, config defaults, and --no-vision"
```

---

## 阶段 3:结构重构

### Task 13: TUI 接入 server-options(消除默认值重复)

**Files:**
- Modify: `src/tui/index.ts`(847-866 预设→选项复制处,及其它手工构造 ServerOptions 处)
- Modify: `src/commands/preset.ts`(若 Task 12 未完成)

**背景:** Task 12 后 CLI 已用 `resolveServerOptions`;TUI 仍手工复制预设字段(847-866),是第二处实现。

- [ ] **Step 1: TUI 预设加载改 `resolveServerOptions`**

`handleLoadPreset`(847-885)中手工字段复制改为:

```ts
const config = getExpandedConfig();
const options = resolveServerOptions({}, preset, config);
```

TUI 其它构造 ServerOptions 的位置(如 start 流程的默认选项拼装)同样改为 `resolveServerOptions(uiOverrides, preset, config)`,UI 上的字段作为 `uiOverrides` 传入。行为要求:合并结果与现 TUI 逐字段语义一致(现 TUI 是全字段复制,resolveServerOptions 语义等价)。

- [ ] **Step 2: 构建 + 测试**

```bash
npm run build && npx vitest run
```

预期:tsc 零错误;全部 passed

- [ ] **Step 3: Commit**

```bash
git add src/tui/index.ts src/commands/preset.ts
git commit -m "refactor: TUI uses shared option resolution; single defaults source"
```

---

### Task 14: commands/proxy.ts 改为 request-logger 薄封装

**Files:**
- Modify: `src/commands/proxy.ts`(61-173 整体替换)
- Modify: `src/utils/request-logger.ts`(导出配置接口,若需要)

**背景:** 两套代理实现已漂移(maxBodyLength 2000 vs 4000、showResponse 默认值不同)。保留 `request-logger.ts` 为唯一实现;CLI 默认值统一到 request-logger 的默认(maxBodyLength 4000、showResponse 默认关),`--max-body`/`--show-response` 显式传参仍有效——这是一次有意的行为对齐,在 commit message 中注明。

- [ ] **Step 1: 重写 proxy.ts**

```ts
import { Command } from 'commander';
import { createRequestLogger } from '../utils/request-logger.js';
import { parseIntOpt } from '../utils/server-options.js';
import { getExpandedConfig } from '../utils/config-manager.js';

export function createProxyCommand(): Command {
  const cmd = new Command('proxy');
  cmd
    .description('Start request logging proxy')
    .option('-p, --port <port>', 'Public port', parseIntOpt)
    .option('--target <url>', 'Target server URL')
    .option('--max-body <bytes>', 'Max body bytes to display', parseIntOpt)
    .option('--show-response', 'Log response bodies')
    .action(async (options) => {
      const config = getExpandedConfig();
      // 默认值对齐 request-logger;显式参数优先
      // 端口/target 解析沿用现有 CLI 语义,仅替换实现
      const proxy = createRequestLogger({
        port: options.port ?? config.defaultPort - 1,
        target: options.target ?? `http://127.0.0.1:${config.defaultPort}`,
        maxBodyLength: options.maxBody,
        showResponse: options.showResponse ?? false,
      });
      await proxy.start();
      console.log(`Proxy listening on :${options.port ?? config.defaultPort - 1}`);
    });
  return cmd;
}
```

注:`createRequestLogger` 的实际签名以 `request-logger.ts` 现状为准,若参数形状不同则适配;`--target` 等现有 flag 保留。

- [ ] **Step 2: 构建 + 测试**

```bash
npm run build && npx vitest run
```

预期:tsc 零错误;全部 passed

- [ ] **Step 3: Commit**

```bash
git add src/commands/proxy.ts src/utils/request-logger.ts
git commit -m "refactor: lsc proxy wraps request-logger (single implementation; defaults aligned to maxBody 4000/showResponse off)"
```

---

### Task 15: 死代码清理 + tsconfig 严格化 + 版本号 + 扫描器容错

**Files:**
- Modify: `tsconfig.json`
- Modify: `src/tui/index.ts`(36, 62-66, 80, 168, 1982, 2011, 2618 等约 40 处)
- Modify: `src/index.ts:19`
- Modify: `src/utils/model-scanner.ts`(28, 60-69, 67, 81)
- Modify: `src/commands/preset.ts:11`(未用的 `listPresetNames`)

- [ ] **Step 1: tsconfig 加 flag**

```json
"noImplicitReturns": true,
"noFallthroughCasesInSwitch": true,
"noUnusedLocals": true,
"noUnusedParameters": true
```

- [ ] **Step 2: 跑构建,按报错清单逐一清理**

```bash
npm run build
```

预期约 40 个 `TS6133`(未用变量/导入)类错误。逐条处理:确认无副作用的删除;有副作用疑问的保留并加 `_` 前缀(仅参数)。已知项(以 tsc 实际输出为准):tui/index.ts 的 `isAbsolute`、`DownloadProgress`/`DownloadTask`、`formatSpeed`/`formatEta`、`readDownloadMeta`、`downloadStatusInterval`、`getLogFile()` 未用变量;request-logger 的 `formatJson`(Task 8 已删);preset.ts 的 `listPresetNames` 导入。顺带:tui/index.ts:2011 的 `.replace('{percent}', ...)` 改模板字符串;1982 的不可达 fallback 删除。

- [ ] **Step 3: 版本号运行时读取**

`src/index.ts`:

```ts
import { readFileSync } from 'fs';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
program.name('lsc').description('CLI tool for managing llama.cpp server').version(pkg.version);
```

(dist/index.js 的 `../package.json` 即项目根 package.json,避开 rootDir 限制)

- [ ] **Step 4: model-scanner 容错与 mmproj 精确匹配**

- `findGgufFiles`(28)的 `readdirSync` 包 try/catch(权限不足子目录跳过)
- `statSync`(67, 81)包 try/catch(扫描中文件消失跳过)
- mmproj 匹配(60-69):同目录多个 mmproj 时,优先文件名包含模型基础名者,其次取第一个,不再 last-wins

- [ ] **Step 5: 构建 + 全量测试**

```bash
npm run build && npx vitest run
```

预期:tsc 零错误(含新 flag);全部 passed

- [ ] **Step 6: Commit**

```bash
git add tsconfig.json src/
git commit -m "chore: enable stricter tsc flags, remove dead code, runtime version, scanner resilience"
```

---

### Task 16: 删除开发残留文件 + TUI 机械拆分收尾

**Files:**
- Delete: `config.json`、`presets.json`、`patch-test-live.js`、`test-patch4.js`(仓库根)
- Modify: `src/tui/index.ts`(收尾拆分)

**⚠️ Step 1 是 git 跟踪文件的删除,执行前必须向用户确认。**

- [ ] **Step 1: 删除残留文件(需用户确认)**

```bash
git rm config.json presets.json patch-test-live.js test-patch4.js
```

确认这四个文件内容确为开发残留(设计文档低危 #13 已确认:app 只读 `~/.config/lsc/`,根目录文件是个人配置/补丁实验)。`opencode.json` 不动。

- [ ] **Step 2: TUI 拆分收尾检查**

Task 9/10 已抽出 `system-info.ts` 与 `dialogs.ts`。本步仅做低风险的进一步机械抽取(若抽取点与共享状态耦合紧、无法干净移动,则跳过并在 commit message 说明):
- `formatUptime`、`createProgressBar`/`createDownloadBar`(合并为一个)、`inferModelIdFromPath`(与 download-meta 去重,保留 download-meta 版)移至 `src/tui/widgets.ts`(纯函数,无状态)

**不做**:下载管理 UI、预设编辑器的模块拆分(与 index.ts 共享状态耦合深,留待有测试网后单独做)。

- [ ] **Step 3: 构建 + 全量测试 + 手动冒烟**

```bash
npm run build && npx vitest run
```

预期:tsc 零错误;全部 passed

手动冒烟清单(逐项记录结果):
- `lsc --version` 显示 1.0.0
- `lsc config list` / `lsc config set defaultCtxSize 32768` 后 `lsc start --help` 正常
- `lsc models`、`lsc preset list`、`lsc status`
- `npm start` 进 TUI:列表渲染、`s` 启停流程(无模型时到报错即可)、`q` 退出后终端状态正常(无残留 alternate screen)

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: drop tracked dev leftovers; extract pure TUI widgets"
```

---

## 自查记录(计划落盘前完成)

- **Spec 覆盖**:高危 #1→Task 5;#2→Task 6;#3→Task 4;#4→Task 2/7;#5→Task 5/8;中危 #6→Task 9;#7→Task 10;#8→Task 11;#9→Task 8/12;#10→Task 3/12;#11→Task 9/12;低危 #12→Task 14/15;#13→Task 16;#14→Task 15。推荐器 VRAM/层数→Task 12。mmproj→Task 15。
- **占位符**:无 TBD/TODO;每步含代码或精确命令。
- **类型一致性**:`planResume`/`ResumePlan`(Task 5 定义,无后续变体);`resolveServerOptions(cli, preset, config)`(Task 3 定义,Task 12/13 调用一致);`BUILTIN_SERVER_DEFAULTS`(Task 3 定义);`parseIntOpt`(Task 3 定义,Task 12/14 使用);`readJsonSafe`/`writeJsonAtomic`(Task 2 定义,Task 7 使用);`isTrustedHost`(Task 12 http.ts 定义,Task 5 下载器内联同名实现——执行时若 Task 12 已完成,downloader 应改为从 http.ts import,消除重复);`isLlamaServerProcess`/`isProcessRunning`(Task 11);`confirmDialog`/`isModalOpen`(Task 10);`assertValidModelId`(Task 6)。
- **与 spec 的偏差**:续传 200/206/416 分支用纯函数 `planResume` 测试替代 spec 中的 mock HTTP(分支覆盖等价,更稳);`getHFToken` 缓存放弃(TUI 运行期改配置会失效,重读成本可忽略)。

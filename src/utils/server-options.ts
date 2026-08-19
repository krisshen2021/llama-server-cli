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
//
// 调用方义务(后续接线任务 12/13 注意):
// 1. `model` 只能来自 cli 或 preset(config 层不提供)。交互式流程允许在 model 未定前
//    先合并取提示默认值、由交互补全 model 后再启动(见 commands/start.ts);
//    但 model 未补全的合并结果不得直接用于启动
// 2. 传入的 `cli` 必须先规范化成 `Partial<ServerOptions>` 的形状——不能直接把 commander 的
//    `opts()` 原样传入(`--no-vision` 产出的是 `vision` 键而非 `useVision`;`--fit` 是字符串;
//    `gpuLayers` 需转数字/'auto'),否则未知键会静默穿透而正确键不生效
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

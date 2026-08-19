// 全局配置
export interface Config {
  modelsDir: string;
  llamaServerPath: string;
  defaultPort: number;
  defaultCtxSize: number;
  defaultGpuLayers: number | 'auto';
  defaultHost: string;
  defaultBatchSize: number;
  defaultThreadsBatch: number; // 0 = auto
  defaultCachePrompt: boolean;
  defaultCacheReuse: number; // 0 = disabled
  hfToken?: string;  // HuggingFace API Token (for private repos)
  // 下载后端:auto=有 aria2c 用 aria2 否则内置;aria2=强制 aria2(未安装则回退内置);
  // builtin=强制内置。配置 hfToken 时总是回退内置(aria2 会把 token 透传到重定向域名)
  downloadBackend?: 'auto' | 'aria2' | 'builtin';
}

// 服务器启动选项
export interface ServerOptions {
  model: string;
  mmproj?: string;
  useVision?: boolean;
  ctxSize: number | 'auto'; // 'auto':不传 -c,由 --fit 按空闲显存自动选择
  gpuLayers: number | 'auto';
  tensorSplit?: string; // e.g. "1,1" or "3,1"
  fit?: boolean;
  kvCacheType?: 'f16' | 'q8_0' | 'q4_0';
  chatTemplate?: string;
  host: string;
  port: number;
  jinja: boolean;
  flashAttn: 'on' | 'off' | 'auto';
  reasoningBudget: number; // -1 = unlimited, 0 = disabled
  threads?: number;
  threadsBatch?: number;
  batchSize?: number;
  cachePrompt?: boolean;
  cacheReuse?: number;
  logRequests?: boolean; // 是否启用请求日志代理
  specType?: string;  // 投机解码类型(--spec-type,如 draft-mtp)
  specModel?: string; // draft/MTP 模块路径(--model-draft)
  slotSavePath?: string; // 会话 KV 持久化目录(--slot-save-path);undefined = 禁用
}

// 预设配置
export interface Preset {
  name: string;
  model: string;
  mmproj?: string;
  useVision?: boolean;
  ctxSize: number | 'auto'; // 'auto':不传 -c,由 --fit 按空闲显存自动选择
  gpuLayers: number | 'auto';
  tensorSplit?: string;
  fit?: boolean;
  kvCacheType?: 'f16' | 'q8_0' | 'q4_0';
  chatTemplate?: string;
  host: string;
  port: number;
  jinja: boolean;
  flashAttn: 'on' | 'off' | 'auto';
  reasoningBudget: number;
  threadsBatch?: number;
  batchSize?: number;
  cachePrompt?: boolean;
  cacheReuse?: number;
  specType?: string;  // 投机解码类型(--spec-type,如 draft-mtp)
  specModel?: string; // draft/MTP 模块路径(--model-draft)
  slotSavePath?: string; // 会话 KV 持久化目录(--slot-save-path);undefined = 禁用
}

// 预设存储
export interface PresetsStore {
  [name: string]: Omit<Preset, 'name'>;
}

// 模型信息
export interface ModelInfo {
  name: string;
  path: string;
  size: number;
  sizeHuman: string;
  mmproj?: string;
  mmprojSize?: number;
  mtp?: string; // 配对的 MTP 模块路径(投机解码用,同目录 mtp-*.gguf)
}

// 服务器状态
export interface ServerStatus {
  running: boolean;
  pid?: number;
  model?: string;
  port?: number;
  startTime?: Date;
  proxy?: boolean;      // 是否经请求日志代理启动(来自 PID 文件)
  publicPort?: number;  // 代理对外端口(有代理时)
}

// PID 文件内容
export interface PidFile {
  pid: number;
  model: string;
  port: number;
  startTime: string;
  proxy?: boolean;      // 是否经请求日志代理启动
  publicPort?: number;  // 代理对外端口(有代理时)
}

// 默认配置
export const DEFAULT_CONFIG: Config = {
  modelsDir: '~/.cache/lm-studio/models/lmstudio-community/',
  llamaServerPath: '~/llama.cpp/build/bin/llama-server',
  defaultPort: 8080,
  defaultCtxSize: 4096,
  defaultGpuLayers: 'auto',
  defaultHost: '0.0.0.0',
  defaultBatchSize: 2048,
  defaultThreadsBatch: 0,
  defaultCachePrompt: true,
  defaultCacheReuse: 0,
  downloadBackend: 'auto',
};

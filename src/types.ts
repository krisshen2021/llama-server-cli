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
}

// 服务器启动选项
export interface ServerOptions {
  model: string;
  mmproj?: string;
  useVision?: boolean;
  ctxSize: number;
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
}

// 预设配置
export interface Preset {
  name: string;
  model: string;
  mmproj?: string;
  useVision?: boolean;
  ctxSize: number;
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
}

// 服务器状态
export interface ServerStatus {
  running: boolean;
  pid?: number;
  model?: string;
  port?: number;
  startTime?: Date;
}

// PID 文件内容
export interface PidFile {
  pid: number;
  model: string;
  port: number;
  startTime: string;
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
};

// 默认服务器选项
export const DEFAULT_SERVER_OPTIONS: Partial<ServerOptions> = {
  ctxSize: 4096,
  gpuLayers: 'auto',
  host: '0.0.0.0',
  port: 8080,
  jinja: true,
  flashAttn: 'auto',
  reasoningBudget: -1,
  cachePrompt: true,
  cacheReuse: 0,
  batchSize: 2048,
};

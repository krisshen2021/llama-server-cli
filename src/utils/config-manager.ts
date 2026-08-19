import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Config, DEFAULT_CONFIG } from '../types.js';
import { readJsonSafe, writeJsonAtomic } from './json-file.js';

// 配置目录:可用 LSC_CONFIG_DIR 覆盖(便于测试)
export function getConfigDir(): string {
  return process.env.LSC_CONFIG_DIR ?? join(homedir(), '.config', 'lsc');
}

export function getConfigPath(): string {
  return join(getConfigDir(), 'config.json');
}

// 展开路径中的 ~
export function expandPath(p: string): string {
  if (p.startsWith('~/')) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

// 确保配置目录存在
function ensureConfigDir(): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// 加载配置
export function loadConfig(): Config {
  ensureConfigDir();

  if (!existsSync(getConfigPath())) {
    // 首次运行，创建默认配置
    saveConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }

  // 解析失败时 readJsonSafe 会备份 .bak 并返回 {},避免静默丢数据
  const config = readJsonSafe<Partial<Config>>(getConfigPath(), {});
  // 合并默认配置，确保所有字段都存在
  return { ...DEFAULT_CONFIG, ...config };
}

// 保存配置(原子写)
export function saveConfig(config: Config): void {
  ensureConfigDir();
  writeJsonAtomic(getConfigPath(), config);
}

// 获取单个配置项
export function getConfigValue<K extends keyof Config>(key: K): Config[K] {
  const config = loadConfig();
  return config[key];
}

// 设置单个配置项
export function setConfigValue<K extends keyof Config>(key: K, value: Config[K]): void {
  const config = loadConfig();
  config[key] = value;
  saveConfig(config);
}

// 获取展开后的路径配置
export function getExpandedConfig(): Config {
  const config = loadConfig();
  return {
    ...config,
    modelsDir: expandPath(config.modelsDir),
    llamaServerPath: expandPath(config.llamaServerPath),
  };
}

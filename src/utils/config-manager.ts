import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { Config, DEFAULT_CONFIG } from '../types.js';

const CONFIG_DIR = join(homedir(), '.config', 'lsc');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

// 展开路径中的 ~
export function expandPath(p: string): string {
  if (p.startsWith('~/')) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

// 确保配置目录存在
function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

// 加载配置
export function loadConfig(): Config {
  ensureConfigDir();
  
  if (!existsSync(CONFIG_FILE)) {
    // 首次运行，创建默认配置
    saveConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
  
  try {
    const content = readFileSync(CONFIG_FILE, 'utf-8');
    const config = JSON.parse(content) as Partial<Config>;
    // 合并默认配置，确保所有字段都存在
    return { ...DEFAULT_CONFIG, ...config };
  } catch {
    return DEFAULT_CONFIG;
  }
}

// 保存配置
export function saveConfig(config: Config): void {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
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

export { CONFIG_DIR, CONFIG_FILE };

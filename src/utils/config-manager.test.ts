import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lsc-cfg-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('loadConfig 损坏恢复', () => {
  it('config.json 损坏时备份 .bak、返回默认,且后续保存不丢数据', async () => {
    vi.stubEnv('LSC_CONFIG_DIR', dir);
    vi.resetModules();
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

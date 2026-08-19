import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Preset } from '../types.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lsc-preset-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// LSC_CONFIG_DIR 隔离 + 模块级缓存复位,与 config-manager.test.ts 同一套路
async function fresh() {
  vi.stubEnv('LSC_CONFIG_DIR', dir);
  vi.resetModules();
  return import('./preset-manager.js');
}

function makePreset(name: string, model = '/models/m.gguf'): Preset {
  return {
    name,
    model,
    ctxSize: 4096,
    gpuLayers: 'auto',
    host: '0.0.0.0',
    port: 8080,
    jinja: true,
    flashAttn: 'auto',
    reasoningBudget: -1,
  };
}

describe('renamePreset', () => {
  it('正常重命名:新名生效、旧名删除、字段完整保留', async () => {
    const pm = await fresh();
    pm.savePreset({ ...makePreset('old'), kvCacheType: 'q8_0', specType: 'draft-mtp' });

    expect(pm.renamePreset('old', 'new')).toBe(true);
    expect(pm.presetExists('old')).toBe(false);
    const renamed = pm.getPreset('new');
    expect(renamed?.model).toBe('/models/m.gguf');
    expect(renamed?.kvCacheType).toBe('q8_0');
    expect(renamed?.specType).toBe('draft-mtp');
  });

  it('旧名不存在:返回 false,不产生新条目', async () => {
    const pm = await fresh();
    expect(pm.renamePreset('ghost', 'new')).toBe(false);
    expect(pm.presetExists('new')).toBe(false);
  });

  it('新名已被占用:返回 false,不覆盖现有预设', async () => {
    const pm = await fresh();
    pm.savePreset({ ...makePreset('a', '/a.gguf') });
    pm.savePreset({ ...makePreset('b', '/b.gguf') });

    expect(pm.renamePreset('a', 'b')).toBe(false);
    expect(pm.getPreset('b')?.model).toBe('/b.gguf');
    expect(pm.presetExists('a')).toBe(true);
  });

  it('新旧同名:返回 false,原预设不变', async () => {
    const pm = await fresh();
    pm.savePreset(makePreset('same'));
    expect(pm.renamePreset('same', 'same')).toBe(false);
    expect(pm.getPreset('same')?.model).toBe('/models/m.gguf');
  });
});

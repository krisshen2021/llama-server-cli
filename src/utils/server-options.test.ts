import { describe, it, expect } from 'vitest';
import { resolveServerOptions, parseIntOpt } from './server-options.js';
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

  it('必填字段全有定义(替代手写字面量的编译期完整性检查)', () => {
    // resolver 的 cast 丢掉了必填字段的编译期保证;ServerOptions 新增必填字段时,
    // 须在此登记并在内置/config 层提供默认值,否则本测试失败
    const o = resolveServerOptions(base, null, { ...DEFAULT_CONFIG });
    const requiredKeys = ['ctxSize', 'gpuLayers', 'host', 'port', 'jinja', 'flashAttn', 'reasoningBudget'] as const;
    for (const key of requiredKeys) {
      expect(o[key], key).toBeDefined();
    }
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

  it('gpuLayers 支持数字 0', () => {
    expect(resolveServerOptions({ ...base, gpuLayers: 0 }, null, { ...DEFAULT_CONFIG }).gpuLayers).toBe(0);
  });

  it("ctxSize 'auto' 从预设透传", () => {
    const o = resolveServerOptions(base, { ctxSize: 'auto' }, { ...DEFAULT_CONFIG });
    expect(o.ctxSize).toBe('auto');
  });

  it("ctxSize 'auto' 从命令行透传并覆盖预设数字", () => {
    const o = resolveServerOptions(
      { ...base, ctxSize: 'auto' },
      { ctxSize: 8192 },
      { ...DEFAULT_CONFIG },
    );
    expect(o.ctxSize).toBe('auto');
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

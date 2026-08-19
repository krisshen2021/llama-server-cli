import { describe, it, expect } from 'vitest';
import { detectQuantization, assertValidModelId, getDownloadUrl } from './hf-api.js';
import { getModelDir, getModelStoragePath } from './preset-generator.js';

describe('detectQuantization', () => {
  it('优先匹配长模式', () => {
    expect(detectQuantization('model-Q4_K_M.gguf')).toBe('Q4_K_M');
    expect(detectQuantization('model-Q4_K_S.gguf')).toBe('Q4_K_S');
    expect(detectQuantization('model-Q2_K.gguf')).toBe('Q2_K');
  });

  it('大小写不敏感', () => {
    expect(detectQuantization('Model-q4_k_m.gguf')).toBe('Q4_K_M');
  });

  it('识别全连字符变体', () => {
    expect(detectQuantization('model-Q4-K-M.gguf')).toBe('Q4_K_M');
    expect(detectQuantization('model-Q2-K-S.gguf')).toBe('Q2_K_S');
  });

  it('无匹配返回 null', () => {
    expect(detectQuantization('README.md')).toBeNull();
  });
});

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

  it('拒绝全点号段 ../x', () => {
    expect(() => assertValidModelId('../x')).toThrow();
  });

  it('拒绝全点号段 a/..', () => {
    expect(() => assertValidModelId('a/..')).toThrow();
  });

  it('接受带点号的 org.name/repo.name', () => {
    expect(() => assertValidModelId('org.name/repo.name')).not.toThrow();
  });

  it('拒绝单点段 ./x 与 a/.', () => {
    expect(() => assertValidModelId('./x')).toThrow();
    expect(() => assertValidModelId('a/.')).toThrow();
  });
});

// 入口函数确实调用校验 (防止后续改动意外移除)
describe('modelId 校验接入', () => {
  it('getModelStoragePath 拒绝非法 modelId', () => {
    expect(() => getModelStoragePath('/m', '../x', 'f.gguf')).toThrow();
  });

  it('getModelDir 拒绝非法 modelId', () => {
    expect(() => getModelDir('/m', 'a/..')).toThrow();
  });

  it('getDownloadUrl 拒绝非法 modelId', () => {
    expect(() => getDownloadUrl('a/..', 'f.gguf')).toThrow();
  });
});

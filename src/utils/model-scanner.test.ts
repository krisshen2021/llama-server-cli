import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { scanModels as scanModelsFn, resolveSpecModel as resolveSpecModelFn, findDraftModelFiles as findDraftModelFilesFn } from './model-scanner.js';

let dir: string;
let scanModels: typeof scanModelsFn;
let resolveSpecModel: typeof resolveSpecModelFn;
let findDraftModelFiles: typeof findDraftModelFilesFn;

// scanner 只按文件名/大小工作,dummy 文件即可;但 scanModels 会经 getExpandedConfig
// 触碰配置目录,须用 LSC_CONFIG_DIR 隔离
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lsc-scan-'));
  vi.stubEnv('LSC_CONFIG_DIR', dir);
  vi.resetModules();
  ({ scanModels, resolveSpecModel, findDraftModelFiles } = await import('./model-scanner.js'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function touch(name: string): void {
  writeFileSync(join(dir, name), 'x');
}

describe('scanModels mmproj 匹配', () => {
  it('同目录多个 mmproj:文件名包含模型基础名(剥掉量化标记)者优先', () => {
    touch('Qwen2.5-7B-Instruct-Q4_K_M.gguf');
    touch('OtherModel-mmproj-F16.gguf');
    touch('Qwen2.5-7B-Instruct-mmproj-BF16.gguf');

    const models = scanModels(dir);
    expect(models).toHaveLength(1);
    expect(models[0].mmproj).toBe(join(dir, 'Qwen2.5-7B-Instruct-mmproj-BF16.gguf'));
  });

  it('无匹配时回退到扫描顺序的第一个', () => {
    touch('ModelX-Q8_0.gguf');
    touch('Alpha-mmproj-F16.gguf');
    touch('Beta-vision-F16.gguf');

    // 与 scanner 同源的"第一个":readdirSync 顺序中首个 mmproj 类文件
    const firstMmproj = readdirSync(dir)
      .filter(n => n.endsWith('.gguf'))
      .find(n => /mmproj|clip|vision/.test(n.toLowerCase()));

    const models = scanModels(dir);
    expect(models).toHaveLength(1);
    expect(models[0].mmproj).toBe(join(dir, firstMmproj));
  });

  it('单个 mmproj:无论文件名是否匹配都挂载', () => {
    touch('Foo-Q4_K_M.gguf');
    touch('CompletelyUnrelated-mmproj.gguf');

    const models = scanModels(dir);
    expect(models).toHaveLength(1);
    expect(models[0].mmproj).toBe(join(dir, 'CompletelyUnrelated-mmproj.gguf'));
    expect(models[0].mmprojSize).toBe(1);
  });

  it('点分隔命名(TheBloke 风格):剥掉量化标记后基础名不带残留点号', () => {
    touch('Foo.Q4_K_M.gguf');
    touch('Other-mmproj-F16.gguf');
    touch('Foo-mmproj-F16.gguf');

    const models = scanModels(dir);
    expect(models).toHaveLength(1);
    expect(models[0].mmproj).toBe(join(dir, 'Foo-mmproj-F16.gguf'));
  });
});

describe('scanModels MTP 模块', () => {
  it('mtp-*.gguf 不作为独立模型列出', () => {
    touch('gemma-4-12B-it-Q4_K_M.gguf');
    touch('mtp-gemma-4-12B-it.gguf');

    const models = scanModels(dir);
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe('gemma-4-12B-it-Q4_K_M.gguf');
  });

  it('按剥掉量化标记的基础名配对到对应模型', () => {
    touch('gemma-4-12B-it-Q4_K_M.gguf');
    touch('gemma-4-27B-it-Q4_K_M.gguf');
    touch('mtp-gemma-4-12B-it.gguf');
    touch('mtp-gemma-4-27B-it.gguf');

    const models = scanModels(dir);
    expect(models).toHaveLength(2);
    const m12 = models.find(m => m.name.includes('12B'))!;
    const m27 = models.find(m => m.name.includes('27B'))!;
    expect(m12.mtp).toBe(join(dir, 'mtp-gemma-4-12B-it.gguf'));
    expect(m27.mtp).toBe(join(dir, 'mtp-gemma-4-27B-it.gguf'));
  });

  it('无配对 MTP 模块的模型 mtp 为 undefined', () => {
    touch('Foo-Q4_K_M.gguf');

    const models = scanModels(dir);
    expect(models).toHaveLength(1);
    expect(models[0].mtp).toBeUndefined();
  });

  it('多模型同目录:MTP 只按名配对,无匹配时不回退到别人的模块', () => {
    touch('gemma-4-12B-it-Q4_K_M.gguf');
    touch('gemma-4-27B-it-Q4_K_M.gguf');
    touch('mtp-gemma-4-12B-it.gguf');

    const models = scanModels(dir);
    expect(models).toHaveLength(2);
    const m12 = models.find(m => m.name.includes('12B'))!;
    const m27 = models.find(m => m.name.includes('27B'))!;
    expect(m12.mtp).toBe(join(dir, 'mtp-gemma-4-12B-it.gguf'));
    // 挂错 MTP 不会像 mmproj 那样加载报错,而是静默劣化投机解码,故宁可不挂
    expect(m27.mtp).toBeUndefined();
  });

  it('目录内只有一个模型:名称不匹配也回退挂载第一个 MTP', () => {
    touch('Foo-Q4_K_M.gguf');
    touch('mtp-Unrelated.gguf');

    const models = scanModels(dir);
    expect(models).toHaveLength(1);
    expect(models[0].mtp).toBe(join(dir, 'mtp-Unrelated.gguf'));
  });

  it('分片模型:剥掉分片后缀后按基础名配对,所有分片都挂上同一 MTP', () => {
    touch('Model-Q4_K_M-00001-of-00003.gguf');
    touch('Model-Q4_K_M-00002-of-00003.gguf');
    touch('Model-Q4_K_M-00003-of-00003.gguf');
    touch('mtp-Model.gguf');

    const models = scanModels(dir);
    // 分片仍作为独立条目列出(既有行为,不在此处改动)
    expect(models).toHaveLength(3);
    for (const m of models) {
      expect(m.mtp).toBe(join(dir, 'mtp-Model.gguf'));
    }
  });

  it('分片模型 + 名称不匹配的 MTP:分片去重后按单模型回退挂载', () => {
    touch('Model-Q4_K_M-00001-of-00002.gguf');
    touch('Model-Q4_K_M-00002-of-00002.gguf');
    touch('mtp-Unrelated.gguf');

    const models = scanModels(dir);
    expect(models).toHaveLength(2);
    for (const m of models) {
      expect(m.mtp).toBe(join(dir, 'mtp-Unrelated.gguf'));
    }
  });

  it('两个不同分片模型同目录:MTP 只配给按名匹配的那个,不回退', () => {
    touch('Alpha-7B-Q4_K_M-00001-of-00002.gguf');
    touch('Alpha-7B-Q4_K_M-00002-of-00002.gguf');
    touch('Beta-13B-Q4_K_M-00001-of-00002.gguf');
    touch('Beta-13B-Q4_K_M-00002-of-00002.gguf');
    touch('mtp-Alpha-7B.gguf');

    const models = scanModels(dir);
    expect(models).toHaveLength(4);
    const alpha = models.filter(m => m.name.startsWith('Alpha'));
    const beta = models.filter(m => m.name.startsWith('Beta'));
    expect(alpha).toHaveLength(2);
    expect(beta).toHaveLength(2);
    for (const m of alpha) {
      expect(m.mtp).toBe(join(dir, 'mtp-Alpha-7B.gguf'));
    }
    for (const m of beta) {
      expect(m.mtp).toBeUndefined();
    }
  });
});

describe('resolveSpecModel 投机解码模块解析', () => {
  const mtp = '/models/mtp-a.gguf';

  it('未设 specType:specModel 原样保留,不警告', () => {
    expect(resolveSpecModel(undefined, undefined, mtp)).toEqual({ specModel: undefined });
    expect(resolveSpecModel(undefined, '/x.gguf', mtp)).toEqual({ specModel: '/x.gguf' });
  });

  it('显式 specModel 优先:不覆盖、不警告', () => {
    expect(resolveSpecModel('draft-simple', '/x.gguf', mtp)).toEqual({ specModel: '/x.gguf' });
  });

  it('draft 系类型 + 配对模块:自动挂载', () => {
    expect(resolveSpecModel('draft-mtp', undefined, mtp)).toEqual({ specModel: mtp });
    expect(resolveSpecModel('draft-simple', undefined, mtp)).toEqual({ specModel: mtp });
  });

  it('ngram 系/none 不需要模块:有配对也不挂载(避免白占 VRAM)', () => {
    expect(resolveSpecModel('ngram-simple', undefined, mtp)).toEqual({});
    expect(resolveSpecModel('none', undefined, mtp)).toEqual({});
  });

  it('draft-mtp 无配对模块:不警告(可用目标模型内置 MTP)', () => {
    expect(resolveSpecModel('draft-mtp', undefined, undefined)).toEqual({});
  });

  it('必须外挂模块的类型无配对:返回警告', () => {
    const r = resolveSpecModel('draft-simple', undefined, undefined, 'en');
    expect(r.specModel).toBeUndefined();
    expect(r.warning).toContain('draft-simple');
    expect(r.warning).toContain('requires a draft/MTP module');
  });

  it('逗号列表:含 draft-mtp 不警告;含必须外挂类型则警告', () => {
    expect(resolveSpecModel('ngram-mod,draft-mtp', undefined, undefined)).toEqual({});
    const r = resolveSpecModel('ngram-mod,draft-dspark', undefined, undefined);
    expect(r.warning).toContain('ngram-mod,draft-dspark');
  });

  it('逗号列表含 draft 系 + 配对模块:自动挂载', () => {
    expect(resolveSpecModel('ngram-mod,draft-mtp', undefined, mtp)).toEqual({ specModel: mtp });
  });

  it('zh 语言:返回中文警告', () => {
    const r = resolveSpecModel('draft-eagle3', undefined, undefined, 'zh');
    expect(r.warning).toContain('需要 draft/MTP 模块');
  });
});

describe('findDraftModelFiles 草稿模型扫描', () => {
  it('匹配 mtp-*/DFlash/DSpark/EAGLE/draft 命名,普通模型与 mmproj 不入列', () => {
    touch('Qwen3.8-27B-Q6_K_L.gguf');
    touch('mmproj-Qwen3.8-27B-f16.gguf');
    touch('mtp-Qwen3.8-27B.gguf');
    touch('Qwen3.8-27B-DFlash2-Q8_0.gguf');
    touch('Foo-DSpark-Q4_K_M.gguf');
    touch('Bar-eagle3-Q4_K_M.gguf');
    touch('Baz-draft-Q4_K_M.gguf');

    const files = findDraftModelFiles(dir).map(p => p.split('/').pop());
    expect(files).toEqual([
      'Bar-eagle3-Q4_K_M.gguf',
      'Baz-draft-Q4_K_M.gguf',
      'Foo-DSpark-Q4_K_M.gguf',
      'Qwen3.8-27B-DFlash2-Q8_0.gguf',
      'mtp-Qwen3.8-27B.gguf',
    ]);
  });

  it('目录不存在:返回空数组', () => {
    expect(findDraftModelFiles(join(dir, 'nope'))).toEqual([]);
  });
});

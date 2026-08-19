import { describe, it, expect } from 'vitest';
import { analyzeQuantizations, getRecommendedGpuLayers, SystemInfo } from './model-recommender.js';
import type { HFRepo } from './hf-api.js';

// 12B 模型,两个量化:Q4_K_M 物理装得下,Q8_0 物理装不下
const repo: HFRepo = {
  modelId: 'test/model-12b',
  parameterCount: 12,
  files: [
    { filename: 'model-Q4_K_M.gguf', size: 7.5e9, quantization: 'Q4_K_M', isMainModel: true },
    { filename: 'model-Q8_0.gguf', size: 13e9, quantization: 'Q8_0', isMainModel: true },
  ],
};

// 24GB 物理显存,但当前被其他模型/进程占用,只剩 8GB 空闲
const busyGpu: SystemInfo = {
  totalRAM: 64e9,
  availableRAM: 32e9,
  cpuCores: 16,
  gpuName: 'RTX 3090',
  totalVRAM: 24 * 1024 ** 3, // 25769803776
  availableVRAM: 8e9,
};

describe('analyzeQuantizations: 以物理总显存为判断基准', () => {
  it('空闲显存被占用但物理装得下:Q4_K_M 应 fits,不应报 VRAM 不足', () => {
    const estimates = analyzeQuantizations(repo, ['Q4_K_M', 'Q8_0'], busyGpu);
    const q4 = estimates.find(e => e.quantization === 'Q4_K_M')!;
    expect(q4.fits).toBe(true);
    expect(q4.warning).toBeUndefined();
    expect(q4.recommended).toBe(true);
  });

  it('物理装不下的 Q8_0:不 fits,但按物理显存给出 Context 受限而非 VRAM 不足', () => {
    const estimates = analyzeQuantizations(repo, ['Q8_0'], busyGpu);
    const q8 = estimates[0];
    expect(q8.fits).toBe(false);
    // 物理 24GB:13GB 权重 + 开销后还能开 ~26K context
    expect(q8.warning).toMatch(/^Context 受限/);
    expect(q8.maxContext).toBeGreaterThanOrEqual(16384);
  });

  it('totalVRAM 缺失(无 GPU 信息)时回退到 availableVRAM', () => {
    const noGpu: SystemInfo = { totalRAM: 64e9, availableRAM: 32e9, cpuCores: 16, availableVRAM: 8e9 };
    const estimates = analyzeQuantizations(repo, ['Q4_K_M'], noGpu);
    expect(estimates[0].fits).toBe(false);
    expect(estimates[0].warning).toBe('VRAM 不足');
  });
});

describe('getRecommendedGpuLayers: 部分卸载按物理显存计算', () => {
  it('装不下的量化按物理容量估算可卸载层数,而非因瞬时占用退回 auto', () => {
    const estimates = analyzeQuantizations(repo, ['Q8_0'], busyGpu);
    const layers = getRecommendedGpuLayers(estimates[0], busyGpu);
    // (24GB - KV ~14.7GB - 0.5GB 开销) / 13GB ≈ 0.81 → floor(32*0.81) = 25
    expect(layers).toBe(25);
  });
});

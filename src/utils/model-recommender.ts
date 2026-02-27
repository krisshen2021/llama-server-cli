/**
 * 智能推荐模块
 * 根据系统配置推荐最佳量化版本
 */

import { execSync } from 'child_process';
import os from 'os';
import { HFRepo, formatSize } from './hf-api.js';

// 系统信息
export interface SystemInfo {
  totalRAM: number;      // bytes
  availableRAM: number;  // bytes
  gpuName?: string;
  totalVRAM?: number;    // bytes
  availableVRAM?: number; // bytes
  cpuCores: number;
}

// 量化估算信息
export interface QuantizationEstimate {
  quantization: string;
  modelSize: number;         // 估算的模型大小 (bytes)
  kvCacheSize: number;       // KV Cache 大小 (bytes)
  visionSize: number;        // 视觉模块大小 (bytes)
  totalVRAM: number;         // 总需求 VRAM
  maxContext: number;        // 最大 context 长度
  fits: boolean;             // 是否能装下
  recommended: boolean;      // 是否推荐
  warning?: string;          // 警告信息
  bitsPerWeight: number;     // 每参数比特数
}

// 量化类型到每参数比特数的映射
const BITS_PER_WEIGHT: Record<string, number> = {
  'Q2_K': 2.5,
  'Q2_K_S': 2.5,
  'Q2_K_M': 2.75,
  'Q2_K_L': 3.0,
  'Q3_K': 3.4,
  'Q3_K_S': 3.4,
  'Q3_K_M': 3.9,
  'Q3_K_L': 4.3,
  'Q4_0': 4.5,
  'Q4_1': 5.0,
  'Q4_K': 4.5,
  'Q4_K_S': 4.5,
  'Q4_K_M': 4.8,
  'Q4_K_L': 5.0,
  'Q5_0': 5.5,
  'Q5_1': 6.0,
  'Q5_K': 5.5,
  'Q5_K_S': 5.5,
  'Q5_K_M': 5.7,
  'Q5_K_L': 6.0,
  'Q6_K': 6.6,
  'Q6_K_L': 6.8,
  'Q8_0': 8.5,
  'Q8_1': 9.0,
  'Q8_K': 8.5,
  'IQ1_S': 1.5,
  'IQ1_M': 1.75,
  'IQ2_XXS': 2.0,
  'IQ2_XS': 2.3,
  'IQ2_S': 2.5,
  'IQ2_M': 2.7,
  'IQ3_XXS': 3.0,
  'IQ3_XS': 3.3,
  'IQ3_S': 3.5,
  'IQ3_M': 3.7,
  'IQ4_NL': 4.5,
  'IQ4_XS': 4.25,
  'FP16': 16,
  'BF16': 16,
  'FP32': 32,
};

// 默认上下文大小
const DEFAULT_CONTEXT = 32768;
const MIN_CONTEXT = 4096;

/**
 * 获取系统信息
 */
export function getSystemInfo(): SystemInfo {
  const totalRAM = os.totalmem();
  const freeRAM = os.freemem();
  const cpuCores = os.cpus().length;
  
  let gpuName: string | undefined;
  let totalVRAM: number | undefined;
  let availableVRAM: number | undefined;
  
  // 尝试获取 NVIDIA GPU 信息
  try {
    const output = execSync(
      'nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits',
      { encoding: 'utf-8', timeout: 5000 }
    );
    const lines = output.trim().split('\n');
    if (lines.length > 0) {
      const parts = lines[0].split(', ');
      if (parts.length >= 3) {
        gpuName = parts[0].trim();
        totalVRAM = parseInt(parts[1]) * 1024 * 1024; // MB to bytes
        availableVRAM = parseInt(parts[2]) * 1024 * 1024;
      }
    }
  } catch {
    // 没有 NVIDIA GPU 或 nvidia-smi 不可用
  }
  
  return {
    totalRAM,
    availableRAM: freeRAM,
    gpuName,
    totalVRAM,
    availableVRAM,
    cpuCores,
  };
}

/**
 * 估算模型大小
 * @param paramCount 参数量（以 B 为单位）
 * @param bitsPerWeight 每参数比特数
 */
function estimateModelSize(paramCount: number, bitsPerWeight: number): number {
  // 参数量 * 比特数 / 8 = 字节数
  // 加上约 10% 的额外开销（元数据等）
  return paramCount * 1e9 * bitsPerWeight / 8 * 1.1;
}

/**
 * 估算 KV Cache 大小
 * 基于 llama.cpp 的计算方式
 * @param paramCount 参数量（以 B 为单位）
 * @param contextSize 上下文长度
 */
function estimateKVCacheSize(paramCount: number, contextSize: number): number {
  // 简化估算：每 token 约需要 (参数量 / 7B) * 0.25MB
  // 这是一个近似值，实际取决于模型架构
  const basePerToken = 256 * 1024; // 256KB per token for 7B
  const scaleFactor = paramCount / 7;
  return contextSize * basePerToken * scaleFactor;
}

/**
 * 计算最大可用 context
 */
function calculateMaxContext(
  availableVRAM: number,
  modelSize: number,
  visionSize: number,
  paramCount: number
): number {
  const overhead = 500 * 1024 * 1024; // 500MB 系统开销
  const remainingVRAM = availableVRAM - modelSize - visionSize - overhead;
  
  if (remainingVRAM <= 0) return 0;
  
  // 反向计算可支持的 context
  const basePerToken = 256 * 1024;
  const scaleFactor = paramCount / 7;
  const maxTokens = remainingVRAM / (basePerToken * scaleFactor);
  
  // 向下取整到 1024 的倍数
  return Math.floor(maxTokens / 1024) * 1024;
}

/**
 * 分析所有量化选项并给出推荐
 */
export function analyzeQuantizations(
  repo: HFRepo,
  availableQuantizations: string[],
  systemInfo: SystemInfo,
  desiredContext: number = DEFAULT_CONTEXT
): QuantizationEstimate[] {
  const estimates: QuantizationEstimate[] = [];
  const vram = systemInfo.totalVRAM || 0;
  const paramCount = repo.parameterCount || 7; // 默认 7B
  
  // 对于 MoE 模型，使用激活参数来估算 KV Cache
  const kvParamCount = repo.isMoE && repo.activeParams ? repo.activeParams : paramCount;
  
  // 估算视觉模块大小（如果有）
  const visionSize = repo.hasVision ? 1.5 * 1024 * 1024 * 1024 : 0; // 约 1.5GB
  
  for (const quant of availableQuantizations) {
    const bitsPerWeight = BITS_PER_WEIGHT[quant] || 4.5;
    
    // 对于 MoE，总参数量用于模型大小，激活参数用于 KV Cache
    const modelSize = estimateModelSize(paramCount, bitsPerWeight);
    const kvCacheSize = estimateKVCacheSize(kvParamCount, desiredContext);
    const totalVRAM = modelSize + kvCacheSize + visionSize;
    
    const fits = totalVRAM <= vram;
    const maxContext = calculateMaxContext(vram, modelSize, visionSize, kvParamCount);
    
    let warning: string | undefined;
    if (!fits) {
      if (maxContext < MIN_CONTEXT) {
        warning = 'VRAM 不足';
      } else {
        warning = `Context 受限 (~${Math.floor(maxContext / 1024)}K)`;
      }
    }
    
    estimates.push({
      quantization: quant,
      modelSize,
      kvCacheSize,
      visionSize,
      totalVRAM,
      maxContext: fits ? desiredContext : maxContext,
      fits,
      recommended: false,
      warning,
      bitsPerWeight,
    });
  }
  
  // 选择推荐的量化
  // 策略：选择能完全装下且精度最高的
  const fittingEstimates = estimates.filter(e => e.fits);
  if (fittingEstimates.length > 0) {
    // 按精度排序（bitsPerWeight 越高精度越好）
    fittingEstimates.sort((a, b) => b.bitsPerWeight - a.bitsPerWeight);
    fittingEstimates[0].recommended = true;
  } else {
    // 没有完全装下的，选择 maxContext 最大的
    const sortedByContext = [...estimates].sort((a, b) => b.maxContext - a.maxContext);
    if (sortedByContext.length > 0 && sortedByContext[0].maxContext >= MIN_CONTEXT) {
      sortedByContext[0].recommended = true;
    }
  }
  
  return estimates;
}

/**
 * 获取推荐的 context 大小
 */
export function getRecommendedContext(
  estimate: QuantizationEstimate,
  systemInfo: SystemInfo
): number {
  // 如果能装下，使用默认值
  if (estimate.fits) {
    return DEFAULT_CONTEXT;
  }
  
  // 否则使用计算出的最大值，但至少 4K
  return Math.max(estimate.maxContext, MIN_CONTEXT);
}

/**
 * 获取推荐的 GPU layers
 */
export function getRecommendedGpuLayers(
  estimate: QuantizationEstimate,
  systemInfo: SystemInfo
): number | 'auto' {
  // 如果完全装下，使用 auto
  if (estimate.fits) {
    return 'auto';
  }
  
  // 计算能装多少层
  // 简化估算：假设模型有 32 层，按比例计算
  const vram = systemInfo.totalVRAM || 0;
  const overhead = 500 * 1024 * 1024;
  const availableForModel = vram - estimate.visionSize - estimate.kvCacheSize - overhead;
  
  if (availableForModel <= 0) return 'auto';
  
  const ratio = availableForModel / estimate.modelSize;
  const estimatedLayers = Math.floor(32 * ratio);
  
  return Math.max(10, Math.min(estimatedLayers, 99));
}

/**
 * 格式化系统信息用于显示
 */
export function formatSystemInfo(info: SystemInfo): string {
  const lines: string[] = [];
  
  lines.push(`CPU: ${info.cpuCores} cores`);
  lines.push(`RAM: ${formatSize(info.availableRAM)} / ${formatSize(info.totalRAM)}`);
  
  if (info.gpuName) {
    lines.push(`GPU: ${info.gpuName}`);
    if (info.totalVRAM) {
      lines.push(`VRAM: ${formatSize(info.availableVRAM || 0)} / ${formatSize(info.totalVRAM)}`);
    }
  } else {
    lines.push('GPU: Not detected');
  }
  
  return lines.join('\n');
}

/**
 * 格式化量化估算用于显示
 */
export function formatQuantizationEstimate(est: QuantizationEstimate): string {
  const sizeStr = formatSize(est.modelSize);
  let status = '';
  
  if (est.recommended) {
    status = '✓ Recommended';
  } else if (est.fits) {
    status = '✓ OK';
  } else if (est.warning) {
    status = `⚠ ${est.warning}`;
  }
  
  return `${est.quantization.padEnd(10)} (~${sizeStr.padEnd(8)}) ${status}`;
}

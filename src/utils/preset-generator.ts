/**
 * 预设生成器
 * 根据下载的模型和系统配置自动生成预设
 */

import os from 'os';
import { Preset } from '../types.js';
import { HFRepo, HFFile } from './hf-api.js';
import { SystemInfo, QuantizationEstimate, getRecommendedContext, getRecommendedGpuLayers } from './model-recommender.js';
import { loadPresets, savePreset } from './preset-manager.js';

export interface GeneratePresetOptions {
  repo: HFRepo;
  mainModelPath: string;
  visionModelPath?: string;
  quantization: string;
  estimate: QuantizationEstimate;
  systemInfo: SystemInfo;
  reasoningBudget?: number;
}

/**
 * 生成唯一的预设名称
 */
export function generateUniqueName(repo: HFRepo, quantization: string, reasoningBudget: number = 0): string {
  // 构建基础名称
  // 格式：{family}{size}-{quant} 如 qwen35-27b-q4km
  let baseName = '';
  
  // 模型家族
  if (repo.modelFamily) {
    baseName += repo.modelFamily.toLowerCase().replace(/[^a-z0-9]/g, '');
  } else {
    // 从 modelId 提取
    const parts = repo.modelId.split('/');
    const repoName = parts[parts.length - 1];
    baseName += repoName.split('-')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  
  // 参数量
  if (repo.parameterSize) {
    baseName += '-' + repo.parameterSize.toLowerCase().replace('.', '');
  }
  
  // MoE 激活参数
  if (repo.isMoE && repo.activeParams) {
    baseName += '-a' + repo.activeParams.toString().replace('.', '');
  }
  
  // 量化
  baseName += '-' + quantization.toLowerCase().replace(/_/g, '');

  // thinking 标记
  baseName += reasoningBudget === 0 ? '-no-think' : '-think';
  
  // 检查重名
  const existingPresets = loadPresets();
  const existingNames = Object.keys(existingPresets);
  
  if (!existingNames.includes(baseName)) {
    return baseName;
  }
  
  // 添加数字后缀
  let i = 2;
  while (existingNames.includes(`${baseName}-${i}`)) {
    i++;
  }
  
  return `${baseName}-${i}`;
}

/**
 * 自动生成预设
 */
export function generatePreset(options: GeneratePresetOptions): Preset {
  const { repo, mainModelPath, visionModelPath, quantization, estimate, systemInfo, reasoningBudget } = options;
  
  // 生成名称
  const name = generateUniqueName(repo, quantization, reasoningBudget ?? 0);
  
  // 计算最佳参数
  const ctxSize = getRecommendedContext(estimate, systemInfo);
  const gpuLayers = getRecommendedGpuLayers(estimate, systemInfo);
  
  // 构建预设
  const preset: Preset = {
    name,
    model: mainModelPath,
    ctxSize,
    gpuLayers,
    kvCacheType: 'f16',
    host: '0.0.0.0',
    port: 8080,
    jinja: true,
    flashAttn: 'auto',
    reasoningBudget: reasoningBudget ?? 0, // 思维链默认关闭
  };
  
  // 如果有视觉模型
  if (visionModelPath) {
    preset.mmproj = visionModelPath;
  }
  
  return preset;
}

/**
 * 生成并保存预设
 */
export function generateAndSavePreset(options: GeneratePresetOptions): Preset {
  const preset = generatePreset(options);
  savePreset(preset);
  return preset;
}

/**
 * 根据模型路径推断模型信息
 * 用于为现有模型生成预设
 */
export function inferModelInfo(modelPath: string): {
  family?: string;
  parameterSize?: string;
  quantization?: string;
  isMoE?: boolean;
  activeParams?: number;
} {
  const filename = modelPath.split('/').pop() || modelPath;
  const upper = filename.toUpperCase();
  
  // 推断模型家族
  const families = ['QWEN', 'LLAMA', 'MISTRAL', 'PHI', 'GEMMA', 'YI', 'DEEPSEEK', 'COMMAND', 'FALCON', 'MIXTRAL'];
  let family: string | undefined;
  for (const f of families) {
    if (upper.includes(f)) {
      family = f.charAt(0) + f.slice(1).toLowerCase();
      break;
    }
  }
  
  // 推断参数量
  const paramMatch = filename.match(/(\d+\.?\d*)[Bb]/);
  const parameterSize = paramMatch ? paramMatch[1] + 'B' : undefined;
  
  // 推断 MoE
  const moeMatch = filename.match(/A(\d+\.?\d*)[Bb]/i);
  const isMoE = !!moeMatch;
  const activeParams = moeMatch ? parseFloat(moeMatch[1]) : undefined;
  
  // 推断量化
  const quantPatterns = [
    'Q2_K', 'Q3_K_S', 'Q3_K_M', 'Q3_K_L', 
    'Q4_K_S', 'Q4_K_M', 'Q4_K_L', 'Q4_0',
    'Q5_K_S', 'Q5_K_M', 'Q5_K_L', 'Q5_0',
    'Q6_K', 'Q8_0',
    'IQ2_XXS', 'IQ2_XS', 'IQ3_XXS', 'IQ3_XS', 'IQ4_NL', 'IQ4_XS',
    'FP16', 'BF16'
  ];
  
  let quantization: string | undefined;
  for (const q of quantPatterns) {
    if (upper.includes(q.replace('_', '-')) || upper.includes(q)) {
      quantization = q;
      break;
    }
  }
  
  return {
    family,
    parameterSize,
    quantization,
    isMoE,
    activeParams,
  };
}

/**
 * 为现有模型快速生成预设名称
 */
export function generateNameFromPath(modelPath: string): string {
  const info = inferModelInfo(modelPath);
  
  let name = '';
  
  if (info.family) {
    name += info.family.toLowerCase();
  } else {
    name += 'model';
  }
  
  if (info.parameterSize) {
    name += '-' + info.parameterSize.toLowerCase().replace('.', '');
  }
  
  if (info.isMoE && info.activeParams) {
    name += '-a' + info.activeParams.toString().replace('.', '');
  }
  
  if (info.quantization) {
    name += '-' + info.quantization.toLowerCase().replace(/_/g, '');
  }
  
  // 检查重名
  const existingPresets = loadPresets();
  const existingNames = Object.keys(existingPresets);
  
  if (!existingNames.includes(name)) {
    return name;
  }
  
  let i = 2;
  while (existingNames.includes(`${name}-${i}`)) {
    i++;
  }
  
  return `${name}-${i}`;
}

/**
 * 规范化路径，移除尾部斜杠
 */
function normalizePath(p: string): string {
  return p.replace(/\/+$/, '');
}

/**
 * 计算模型文件的存储路径
 * 基于 LM Studio 的目录结构
 */
export function getModelStoragePath(
  modelsDir: string,
  modelId: string,
  filename: string
): string {
  // modelId 格式：organization/repo-name
  // 存储路径：modelsDir/organization/repo-name/filename
  const normalizedDir = normalizePath(modelsDir);
  const parts = modelId.split('/');
  const org = parts[0];
  const repoName = parts.length > 1 ? parts[1] : parts[0];
  
  return `${normalizedDir}/${org}/${repoName}/${filename}`;
}

/**
 * 获取模型目录
 */
export function getModelDir(modelsDir: string, modelId: string): string {
  const normalizedDir = normalizePath(modelsDir);
  const parts = modelId.split('/');
  const org = parts[0];
  const repoName = parts.length > 1 ? parts[1] : parts[0];
  
  return `${normalizedDir}/${org}/${repoName}`;
}

/**
 * HuggingFace API 模块
 * 用于获取模型仓库信息和文件列表
 */

import https from 'https';
import { loadConfig } from './config-manager.js';

// HuggingFace 文件信息
export interface HFFile {
  filename: string;
  size: number;
  sha256?: string;
  lfs?: {
    sha256: string;
    size: number;
    pointerSize: number;
  };
  // 解析出的信息
  quantization?: string;
  isVision?: boolean;
  isMainModel?: boolean;
  isSplit?: boolean;
  splitIndex?: number;
  splitTotal?: number;
}

// HuggingFace 仓库信息
export interface HFRepo {
  modelId: string;
  files: HFFile[];
  // 推断的模型信息
  modelFamily?: string;
  modelName?: string;
  parameterSize?: string;
  parameterCount?: number; // 以 B 为单位
  hasVision?: boolean;
  isMoE?: boolean; // 是否是 MoE 模型
  activeParams?: number; // MoE 激活参数
}

// API 响应的文件结构
interface HFTreeItem {
  type: 'file' | 'directory';
  path: string;
  size?: number;
  lfs?: {
    sha256: string;
    size: number;
    pointerSize: number;
  };
}

// 常见量化类型
const QUANTIZATION_PATTERNS = [
  'Q2_K', 'Q2_K_S', 'Q2_K_M', 'Q2_K_L',
  'Q3_K', 'Q3_K_S', 'Q3_K_M', 'Q3_K_L',
  'Q4_0', 'Q4_1', 'Q4_K', 'Q4_K_S', 'Q4_K_M', 'Q4_K_L',
  'Q5_0', 'Q5_1', 'Q5_K', 'Q5_K_S', 'Q5_K_M', 'Q5_K_L',
  'Q6_K', 'Q6_K_L',
  'Q8_0', 'Q8_1', 'Q8_K',
  'IQ1_S', 'IQ1_M',
  'IQ2_XXS', 'IQ2_XS', 'IQ2_S', 'IQ2_M',
  'IQ3_XXS', 'IQ3_XS', 'IQ3_S', 'IQ3_M',
  'IQ4_NL', 'IQ4_XS',
  'FP16', 'FP32', 'BF16',
];

// 从文件名解析量化类型
function parseQuantization(filename: string): string | undefined {
  const upper = filename.toUpperCase();
  for (const q of QUANTIZATION_PATTERNS) {
    if (upper.includes(q) || upper.includes(q.replace('_', '-'))) {
      return q;
    }
  }
  return undefined;
}

// 检测是否是视觉相关文件
function isVisionFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.includes('mmproj') ||
         lower.includes('vision') ||
         lower.includes('clip') ||
         lower.includes('visual');
}

// 检测是否是主模型文件
function isMainModelFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  // 必须是 .gguf 文件，且不是视觉文件
  if (!lower.endsWith('.gguf')) return false;
  if (isVisionFile(filename)) return false;
  return true;
}

// 解析分片文件信息 (如 model-00001-of-00003.gguf)
function parseSplitInfo(filename: string): { isSplit: boolean; index?: number; total?: number } {
  const match = filename.match(/(\d{5})-of-(\d{5})/i);
  if (match) {
    return {
      isSplit: true,
      index: parseInt(match[1], 10),
      total: parseInt(match[2], 10),
    };
  }
  return { isSplit: false };
}

// 从模型 ID 解析模型信息
function parseModelInfo(modelId: string): {
  modelFamily?: string;
  modelName?: string;
  parameterSize?: string;
  parameterCount?: number;
  isMoE?: boolean;
  activeParams?: number;
} {
  const parts = modelId.split('/');
  const repoName = parts[parts.length - 1];
  
  // 常见模型家族
  const families = ['Qwen', 'Llama', 'Mistral', 'Phi', 'Gemma', 'Yi', 'DeepSeek', 'Command', 'Falcon', 'Mixtral', 'RWKV', 'InternLM'];
  let modelFamily: string | undefined;
  for (const f of families) {
    if (repoName.toLowerCase().includes(f.toLowerCase())) {
      modelFamily = f;
      break;
    }
  }
  
  // 解析参数量 (如 7B, 14B, 27B, 70B, 72B)
  const paramMatch = repoName.match(/(\d+\.?\d*)[Bb]/);
  let parameterSize: string | undefined;
  let parameterCount: number | undefined;
  if (paramMatch) {
    parameterSize = paramMatch[1] + 'B';
    parameterCount = parseFloat(paramMatch[1]);
  }
  
  // 检测 MoE (如 Qwen3.5-35B-A3B-GGUF)
  let isMoE = false;
  let activeParams: number | undefined;
  const moeMatch = repoName.match(/A(\d+\.?\d*)[Bb]/i);
  if (moeMatch) {
    isMoE = true;
    activeParams = parseFloat(moeMatch[1]);
  }
  // Mixtral 等明确的 MoE 模型
  if (repoName.toLowerCase().includes('mixtral') || repoName.toLowerCase().includes('moe')) {
    isMoE = true;
  }
  
  return {
    modelFamily,
    modelName: repoName,
    parameterSize,
    parameterCount,
    isMoE,
    activeParams,
  };
}

// 获取 HF Token
function getHFToken(): string | undefined {
  try {
    const config = loadConfig() as any;
    return config.hfToken;
  } catch {
    return undefined;
  }
}

// 发起 HTTPS 请求
function httpsRequest(url: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'lsc/1.0',
        ...headers,
      },
    };
    
    const req = https.request(options, (res) => {
      // 处理重定向
      if (res.statusCode === 301 || res.statusCode === 302) {
        const redirectUrl = res.headers.location;
        if (redirectUrl) {
          httpsRequest(redirectUrl, headers).then(resolve).catch(reject);
          return;
        }
      }
      
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        return;
      }
      
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    
    req.on('error', reject);
    req.end();
  });
}

/**
 * 获取 HuggingFace 仓库的文件列表
 */
export async function fetchRepoFiles(modelId: string): Promise<HFRepo> {
  const token = getHFToken();
  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  
  // 获取文件树
  const treeUrl = `https://huggingface.co/api/models/${modelId}/tree/main`;
  
  try {
    const response = await httpsRequest(treeUrl, headers);
    const items: HFTreeItem[] = JSON.parse(response);
    
    // 过滤并解析文件
    const files: HFFile[] = items
      .filter(item => item.type === 'file' && item.path.endsWith('.gguf'))
      .map(item => {
        const filename = item.path;
        const splitInfo = parseSplitInfo(filename);
        
        return {
          filename,
          size: item.lfs?.size || item.size || 0,
          sha256: item.lfs?.sha256,
          lfs: item.lfs,
          quantization: parseQuantization(filename),
          isVision: isVisionFile(filename),
          isMainModel: isMainModelFile(filename),
          ...splitInfo,
        };
      });
    
    // 解析模型信息
    const modelInfo = parseModelInfo(modelId);
    
    // 检测是否有视觉支持
    const hasVision = files.some(f => f.isVision);
    
    return {
      modelId,
      files,
      ...modelInfo,
      hasVision,
    };
  } catch (error: any) {
    if (error.message?.includes('401')) {
      throw new Error('Unauthorized: This model may require authentication. Please set your HF token.');
    }
    if (error.message?.includes('404')) {
      throw new Error(`Model not found: ${modelId}`);
    }
    throw error;
  }
}

/**
 * 获取特定量化版本的所有相关文件
 * 包括分片文件和推荐的视觉文件
 */
export function getFilesForQuantization(repo: HFRepo, quantization: string): {
  mainFiles: HFFile[];
  visionFiles: HFFile[];
  totalSize: number;
} {
  // 获取该量化的主模型文件（可能是分片）
  const mainFiles = repo.files.filter(f => 
    f.isMainModel && 
    f.quantization === quantization
  );
  
  // 获取视觉文件（优先选择匹配量化的，否则选 BF16/FP16）
  let visionFiles: HFFile[] = [];
  if (repo.hasVision) {
    const allVision = repo.files.filter(f => f.isVision);
    // 尝试找匹配量化的
    const matchingVision = allVision.filter(f => f.quantization === quantization);
    if (matchingVision.length > 0) {
      visionFiles = matchingVision;
    } else {
      // 选择 BF16 或 FP16
      const bf16Vision = allVision.filter(f => f.quantization === 'BF16');
      const fp16Vision = allVision.filter(f => f.quantization === 'FP16');
      visionFiles = bf16Vision.length > 0 ? bf16Vision : 
                    fp16Vision.length > 0 ? fp16Vision : 
                    allVision.slice(0, 1); // 兜底选第一个
    }
  }
  
  const totalSize = [...mainFiles, ...visionFiles].reduce((sum, f) => sum + f.size, 0);
  
  return { mainFiles, visionFiles, totalSize };
}

/**
 * 获取可用的量化版本列表（去重）
 */
export function getAvailableQuantizations(repo: HFRepo): string[] {
  const quants = new Set<string>();
  for (const file of repo.files) {
    if (file.isMainModel && file.quantization) {
      quants.add(file.quantization);
    }
  }
  
  // 按量化精度排序（从高到低）
  const order = QUANTIZATION_PATTERNS;
  return Array.from(quants).sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  }).reverse(); // 反转，让高精度在前
}

/**
 * 构建下载 URL
 */
export function getDownloadUrl(modelId: string, filename: string): string {
  return `https://huggingface.co/${modelId}/resolve/main/${filename}`;
}

/**
 * 格式化文件大小
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

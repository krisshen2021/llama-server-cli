/**
 * HuggingFace API 模块
 * 用于获取模型仓库信息和文件列表
 */

import { loadConfig } from './config-manager.js';
import { httpRequestWithRedirects } from './http.js';

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

// 按长度降序排序，确保长模式(如 Q4_K_M)优先于短模式(如 Q4_K)匹配
const SORTED_PATTERNS = [...QUANTIZATION_PATTERNS].sort((a, b) => b.length - a.length);

// 从文件名解析量化类型
function parseQuantization(filename: string): string | undefined {
  const upper = filename.toUpperCase();
  for (const q of SORTED_PATTERNS) {
    if (upper.includes(q) || upper.includes(q.replaceAll('_', '-'))) {
      return q;
    }
  }
  return undefined;
}

// 校验模型 ID 格式 (org/repo)，防止注入与路径穿越
export function assertValidModelId(modelId: string): void {
  // 每段不得为全点号 (. .. ...)，否则形如 ../x 仍可路径穿越
  if (!/^(?!\.+\/)[\w.-]+\/(?!\.+$)[\w.-]+$/.test(modelId)) {
    throw new Error(`Invalid model ID: ${modelId} (expected "org/repo")`);
  }
}

// 从文件名检测量化类型(无匹配返回 null)
export function detectQuantization(fileName: string): string | null {
  return parseQuantization(fileName) ?? null;
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

// 响应体大小上限(防御异常/恶意的超大响应)
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024; // 50MB

// 翻页上限(防御 Link 头 cursor 自指/异常导致的无限翻页)
const MAX_TREE_PAGES = 100;

// 发起 HTTPS 请求(统一走 http.ts:空闲超时、重定向上限、token 域名校阅)
// 返回响应体与响应头(翻页需要读 Link 头)
function httpsRequest(url: string): Promise<{ body: string; headers: import('http').IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const handle = httpRequestWithRedirects(
      url,
      {
        headers: { 'User-Agent': 'lsc/1.0' },
        token: getHFToken(),
      },
      {
        onResponse: (res) => {
          if (res.statusCode !== 200) {
            res.resume(); // 消费响应体,释放 socket
            reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
            return;
          }

          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_RESPONSE_BYTES) {
              // 超上限:经句柄中止当前在途 hop,由 onError 收到 'Response too large'
              handle.destroy(new Error('Response too large'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf-8'), headers: res.headers }));
          res.on('error', reject);
        },
        onError: reject,
      },
    );
  });
}

// 解析 Link 头中 rel="next" 的 URL(HF tree 接口的 cursor 分页)
function parseNextLink(linkHeader: string | undefined): string | undefined {
  if (!linkHeader) return undefined;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * 获取 HuggingFace 仓库的文件列表
 */
export async function fetchRepoFiles(modelId: string): Promise<HFRepo> {
  assertValidModelId(modelId);

  // 获取文件树:recursive=true 让子目录中的 GGUF 可见;按 Link 头 cursor 翻页取完
  let nextUrl: string | undefined =
    `https://huggingface.co/api/models/${modelId}/tree/main?recursive=true`;
  const items: HFTreeItem[] = [];
  // 翻页防御:cursor 重复(自指 Link)或页数超上限即终止
  const seenUrls = new Set<string>();

  try {
    while (nextUrl) {
      if (seenUrls.has(nextUrl) || seenUrls.size >= MAX_TREE_PAGES) {
        console.warn(
          `Warning: tree pagination truncated for ${modelId} ` +
          `(repeated cursor or over ${MAX_TREE_PAGES} pages); file list may be incomplete`,
        );
        break;
      }
      seenUrls.add(nextUrl);
      const { body, headers } = await httpsRequest(nextUrl);
      const page: HFTreeItem[] = JSON.parse(body);
      items.push(...page);
      const link = headers['link'];
      nextUrl = parseNextLink(Array.isArray(link) ? link[0] : link);
    }
    
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
  assertValidModelId(modelId);
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

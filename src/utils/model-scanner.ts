import { existsSync, readdirSync, statSync } from 'fs';
import { basename, dirname, join } from 'path';
import { ModelInfo } from '../types.js';
import { getExpandedConfig } from './config-manager.js';
import { detectQuantization } from './hf-api.js';

// 格式化文件大小
function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

// 递归查找所有 .gguf 文件
function findGgufFiles(dir: string): string[] {
  const files: string[] = [];
  
  if (!existsSync(dir)) {
    return files;
  }
  
  // 权限不足等情况跳过该子目录,不中断整体扫描
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    
    if (entry.isDirectory()) {
      files.push(...findGgufFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.gguf')) {
      files.push(fullPath);
    }
  }
  
  return files;
}

// 判断是否是 mmproj 文件（视觉投影文件）
function isMmprojFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.includes('mmproj') || lower.includes('clip') || lower.includes('vision');
}

// 判断是否是 MTP 模块文件(投机解码 draft 模块,文件名以 mtp- 开头)
function isMtpFile(filename: string): boolean {
  return /^mtp-/i.test(filename);
}

// 从模型基础名中剥掉量化标记(如 q4_k_m)与分片后缀(如 -00001-of-00003),并清理残留分隔符(. - _)
// 全连字符写法(如 Q4-K-M)上游 hf-api 已能检测(其 replaceAll 会替换全部下划线),
// detectQuantization 统一返回下划线形式,这里按 [-_] 同时匹配两种分隔符;
// 分片后缀须先于量化标记剥掉,否则残留的 -0000X-of-0000Y 会干扰基础名匹配
function stripQuantFromStem(stem: string): string {
  const unsharded = stem.replace(/-\d{5}-of-\d{5}$/i, '');
  const quant = detectQuantization(unsharded);
  if (!quant) return unsharded.toLowerCase();
  const pattern = new RegExp(quant.replace(/_/g, '[-_]'), 'i');
  return unsharded.replace(pattern, '')
    .replace(/[-_.]{2,}/g, '-')
    .replace(/[-_.]+$/, '')
    .toLowerCase();
}

// 扫描模型目录
export function scanModels(customDir?: string): ModelInfo[] {
  const config = getExpandedConfig();
  const modelsDir = customDir || config.modelsDir;
  
  if (!existsSync(modelsDir)) {
    return [];
  }
  
  const ggufFiles = findGgufFiles(modelsDir);
  const models: ModelInfo[] = [];
  const mmprojMap: Map<string, { path: string; size: number }[]> = new Map();
  const mtpMap: Map<string, string[]> = new Map();
  const modelBaseNames: Map<string, Set<string>> = new Map();
  
  // 第一遍：识别所有 mmproj / MTP 模块文件（同目录可能有多个）,并统计各目录的模型基础名
  for (const filePath of ggufFiles) {
    const filename = basename(filePath);
    if (isMmprojFile(filename)) {
      const dirPath = dirname(filePath);
      // 扫描过程中文件可能消失,statSync 失败则跳过
      let stats;
      try {
        stats = statSync(filePath);
      } catch {
        continue;
      }
      const list = mmprojMap.get(dirPath) || [];
      list.push({ path: filePath, size: stats.size });
      mmprojMap.set(dirPath, list);
    } else if (isMtpFile(filename)) {
      const dirPath = dirname(filePath);
      const list = mtpMap.get(dirPath) || [];
      list.push(filePath);
      mtpMap.set(dirPath, list);
    } else {
      // 模型按剥掉量化/分片后缀的基础名去重计数:同一模型的多个分片(或量化变体)算 1 个;
      // 该计数只用于 MTP 回退配对(见第二遍),文件消失导致的计数偏高只会让回退更保守
      const dirPath = dirname(filePath);
      const names = modelBaseNames.get(dirPath) || new Set<string>();
      names.add(stripQuantFromStem(basename(filePath, '.gguf')));
      modelBaseNames.set(dirPath, names);
    }
  }
  
  // 第二遍：构建模型列表
  for (const filePath of ggufFiles) {
    const filename = basename(filePath);
    
    // 跳过 mmproj / MTP 模块文件(它们是附件,不作为独立模型列出)
    if (isMmprojFile(filename) || isMtpFile(filename)) {
      continue;
    }
    
    // 扫描过程中文件可能消失,statSync 失败则跳过
    let stats;
    try {
      stats = statSync(filePath);
    } catch {
      continue;
    }
    const dirPath = dirname(filePath);
    const relativePath = filePath.replace(modelsDir, '').replace(/^\//, '');
    
    const modelInfo: ModelInfo = {
      name: relativePath,
      path: filePath,
      size: stats.size,
      sizeHuman: formatSize(stats.size),
    };
    
    // 检查同目录下是否有 mmproj 文件:优先文件名包含模型基础名(剥掉量化标记)者,其次取第一个
    const mmprojs = mmprojMap.get(dirPath);
    if (mmprojs && mmprojs.length > 0) {
      const baseName = stripQuantFromStem(basename(filePath, '.gguf'));
      const mmproj = mmprojs.find(m => basename(m.path).toLowerCase().includes(baseName)) || mmprojs[0];
      modelInfo.mmproj = mmproj.path;
      modelInfo.mmprojSize = mmproj.size;
    }
    
    // 检查同目录下是否有 MTP 模块:优先文件名包含模型基础名(剥掉量化/分片标记)者;
    // 仅当目录内只有一个模型(按基础名去重)时才回退取第一个——多模型目录挂错 MTP
    // 不像 mmproj 那样加载即报错,draft-mtp 无 vocab 校验,会静默劣化投机解码
    const mtps = mtpMap.get(dirPath);
    if (mtps && mtps.length > 0) {
      const baseName = stripQuantFromStem(basename(filePath, '.gguf'));
      const mtp = mtps.find(p => basename(p).toLowerCase().includes(baseName))
        || (modelBaseNames.get(dirPath)?.size === 1 ? mtps[0] : undefined);
      if (mtp) {
        modelInfo.mtp = mtp;
      }
    }
    
    models.push(modelInfo);
  }
  
  // 按名称排序
  models.sort((a, b) => a.name.localeCompare(b.name));
  
  return models;
}

// 根据名称或路径查找模型
export function findModel(nameOrPath: string): ModelInfo | null {
  const models = scanModels();
  
  // 精确匹配路径
  let model = models.find(m => m.path === nameOrPath);
  if (model) return model;
  
  // 匹配相对名称
  model = models.find(m => m.name === nameOrPath);
  if (model) return model;
  
  // 模糊匹配（包含关键词）
  const lower = nameOrPath.toLowerCase();
  model = models.find(m => m.name.toLowerCase().includes(lower));
  
  return model || null;
}

// --spec-type 列表中必须外挂 draft/MTP 模块的类型;
// draft-mtp 可用目标模型内置 MTP(GLM-4.5/DeepSeek-V3/Qwen3-Next 等),不在此列
const EXTERNAL_DRAFT_TYPES = ['draft-simple', 'draft-eagle3', 'draft-dflash', 'draft-dspark'];

// 逗号分隔的 spec-type 列表 → 类型数组(容忍元素间空格)
function parseSpecTypes(specType: string): string[] {
  return specType.split(',').map(t => t.trim()).filter(Boolean);
}

// 投机解码模块解析:仅 draft 系类型需要外部模块;返回最终 specModel 与可选警告
// - 未设 specType 或显式给了 specModel:原样保留,不警告
// - 含 draft 系类型且扫描器配到了 MTP 模块:自动挂载
// - 必须外挂模块的类型却配不到:返回警告(draft-mtp 无模块时走内置 MTP,不警告)
// - ngram 系/none 等不需要模块的类型:不挂载——llama.cpp 会无条件把 --model-draft
//   加载进 VRAM,挂上用不到的 draft 纯属浪费(--fit 还会为它预留显存)
export function resolveSpecModel(
  specType: string | undefined,
  specModel: string | undefined,
  pairedMtp: string | undefined,
  lang: 'en' | 'zh' = 'en',
): { specModel?: string; warning?: string } {
  if (!specType || specModel) {
    return { specModel };
  }
  const types = parseSpecTypes(specType);
  const hasDraftType = types.some(t => t.startsWith('draft-'));
  if (hasDraftType && pairedMtp) {
    return { specModel: pairedMtp };
  }
  const needsExternal = types.some(t => EXTERNAL_DRAFT_TYPES.includes(t));
  if (needsExternal) {
    const warning = lang === 'zh'
      ? `spec-type "${specType}" 需要 draft/MTP 模块,但该模型目录下未找到 mtp-*.gguf`
      : `Warning: speculative type "${specType}" requires a draft/MTP module, but none was found for this model.`;
    return { warning };
  }
  return {};
}

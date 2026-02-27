import { existsSync, readdirSync, statSync } from 'fs';
import { basename, dirname, join } from 'path';
import { ModelInfo } from '../types.js';
import { getExpandedConfig } from './config-manager.js';

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
  
  const entries = readdirSync(dir, { withFileTypes: true });
  
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

// 扫描模型目录
export function scanModels(customDir?: string): ModelInfo[] {
  const config = getExpandedConfig();
  const modelsDir = customDir || config.modelsDir;
  
  if (!existsSync(modelsDir)) {
    return [];
  }
  
  const ggufFiles = findGgufFiles(modelsDir);
  const models: ModelInfo[] = [];
  const mmprojMap: Map<string, { path: string; size: number }> = new Map();
  
  // 第一遍：识别所有 mmproj 文件
  for (const filePath of ggufFiles) {
    const filename = basename(filePath);
    if (isMmprojFile(filename)) {
      const dirPath = dirname(filePath);
      const stats = statSync(filePath);
      mmprojMap.set(dirPath, { path: filePath, size: stats.size });
    }
  }
  
  // 第二遍：构建模型列表
  for (const filePath of ggufFiles) {
    const filename = basename(filePath);
    
    // 跳过 mmproj 文件
    if (isMmprojFile(filename)) {
      continue;
    }
    
    const stats = statSync(filePath);
    const dirPath = dirname(filePath);
    const relativePath = filePath.replace(modelsDir, '').replace(/^\//, '');
    
    const modelInfo: ModelInfo = {
      name: relativePath,
      path: filePath,
      size: stats.size,
      sizeHuman: formatSize(stats.size),
    };
    
    // 检查同目录下是否有 mmproj 文件
    const mmproj = mmprojMap.get(dirPath);
    if (mmproj) {
      modelInfo.mmproj = mmproj.path;
      modelInfo.mmprojSize = mmproj.size;
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

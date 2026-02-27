import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, rmdirSync } from 'fs';
import { basename, dirname, join } from 'path';

export interface DownloadMeta {
  url: string;
  modelId: string;
  filename: string;
  expectedSize: number;
  expectedSha256?: string;
  quantization?: string;
  isVision?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IncompleteDownload {
  metaPath: string;
  partialPath: string;
  meta: DownloadMeta;
  downloadedBytes: number;
}

export function getMetaPathForFile(destPath: string): string {
  return destPath + '.meta.json';
}

export function writeDownloadMeta(metaPath: string, meta: DownloadMeta): void {
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

export function readDownloadMeta(metaPath: string): DownloadMeta | null {
  if (!existsSync(metaPath)) return null;
  try {
    const content = readFileSync(metaPath, 'utf-8');
    return JSON.parse(content) as DownloadMeta;
  } catch {
    return null;
  }
}

export function deleteDownloadMeta(metaPath: string): void {
  if (existsSync(metaPath)) {
    unlinkSync(metaPath);
  }
}

export function deletePartialFile(partialPath: string): void {
  if (existsSync(partialPath)) {
    unlinkSync(partialPath);
  }
}

export function cleanupEmptyDirs(rootDir: string, filePath: string): void {
  const normalizedRoot = rootDir.replace(/\/+$/, '');
  let currentDir = dirname(filePath);

  while (currentDir.startsWith(normalizedRoot)) {
    try {
      const entries = readdirSync(currentDir);
      if (entries.length > 0) {
        break;
      }
      rmdirSync(currentDir);
    } catch {
      break;
    }

    if (currentDir === normalizedRoot) break;
    currentDir = dirname(currentDir);
  }
}

export function updateMetaTimestamp(metaPath: string): void {
  const meta = readDownloadMeta(metaPath);
  if (!meta) return;
  meta.updatedAt = new Date().toISOString();
  writeDownloadMeta(metaPath, meta);
}

function collectMetaFiles(dirPath: string, results: string[]): void {
  if (!existsSync(dirPath)) return;
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectMetaFiles(fullPath, results);
    } else if (entry.isFile() && entry.name.endsWith('.meta.json')) {
      results.push(fullPath);
    }
  }
}

export function scanIncompleteDownloads(modelsDir: string): IncompleteDownload[] {
  const normalizedDir = modelsDir.replace(/\/+$/, '');
  const metaFiles: string[] = [];
  collectMetaFiles(normalizedDir, metaFiles);

  const results: IncompleteDownload[] = [];
  for (const metaPath of metaFiles) {
    const meta = readDownloadMeta(metaPath);
    if (!meta) continue;

    const partialPath = metaPath.replace(/\.meta\.json$/, '.partial');
    if (!existsSync(partialPath)) continue;

    let downloadedBytes = 0;
    try {
      const stats = statSync(partialPath);
      downloadedBytes = stats.size;
    } catch {
      downloadedBytes = 0;
    }

    results.push({
      metaPath,
      partialPath,
      meta,
      downloadedBytes,
    });
  }

  return results;
}

export function inferModelIdFromPath(modelPath: string, modelsDir: string): string {
  if (!modelPath) return 'Unknown';
  const normalizedDir = modelsDir.replace(/\/+$/, '');
  const normalizedPath = modelPath.replace(/\/+$/, '');

  if (normalizedPath.startsWith(normalizedDir)) {
    const relative = normalizedPath.slice(normalizedDir.length).replace(/^\//, '');
    const parts = relative.split('/');
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
  }

  return basename(modelPath);
}

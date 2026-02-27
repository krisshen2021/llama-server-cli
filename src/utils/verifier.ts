/**
 * 文件校验模块
 * SHA256 校验，支持进度回调
 */

import { createReadStream, statSync } from 'fs';
import { createHash } from 'crypto';

export interface VerifyProgress {
  filename: string;
  bytesRead: number;
  totalBytes: number;
  percent: number;
}

export interface VerifyResult {
  filename: string;
  expected: string;
  actual: string;
  valid: boolean;
}

/**
 * 计算文件的 SHA256 哈希
 */
export async function calculateSha256(
  filePath: string,
  onProgress?: (progress: VerifyProgress) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const totalBytes = statSync(filePath).size;
    let bytesRead = 0;
    
    const stream = createReadStream(filePath, {
      highWaterMark: 16 * 1024 * 1024, // 16MB chunks for better performance
    });
    
    stream.on('data', (chunk) => {
      hash.update(chunk);
      bytesRead += chunk.length;
      
      if (onProgress) {
        onProgress({
          filename: filePath.split('/').pop() || filePath,
          bytesRead,
          totalBytes,
          percent: Math.round((bytesRead / totalBytes) * 100),
        });
      }
    });
    
    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });
    
    stream.on('error', reject);
  });
}

/**
 * 验证文件 SHA256
 */
export async function verifySha256(
  filePath: string,
  expectedHash: string,
  onProgress?: (progress: VerifyProgress) => void
): Promise<VerifyResult> {
  const filename = filePath.split('/').pop() || filePath;
  const actual = await calculateSha256(filePath, onProgress);
  const expected = expectedHash.toLowerCase();
  
  return {
    filename,
    expected,
    actual,
    valid: actual === expected,
  };
}

/**
 * 批量验证文件
 */
export async function verifyFiles(
  files: Array<{ path: string; sha256: string }>,
  onProgress?: (progress: VerifyProgress, index: number, total: number) => void,
  onComplete?: (result: VerifyResult, index: number, total: number) => void
): Promise<VerifyResult[]> {
  const results: VerifyResult[] = [];
  
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    
    const result = await verifySha256(
      file.path,
      file.sha256,
      onProgress ? (p) => onProgress(p, i, files.length) : undefined
    );
    
    results.push(result);
    
    if (onComplete) {
      onComplete(result, i, files.length);
    }
  }
  
  return results;
}

/**
 * 格式化验证进度用于显示
 */
export function formatVerifyProgress(progress: VerifyProgress): string {
  const bar = createProgressBar(progress.percent, 20);
  return `Verifying ${progress.filename}... [${bar}] ${progress.percent}%`;
}

/**
 * 创建进度条字符串
 */
function createProgressBar(percent: number, width: number): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

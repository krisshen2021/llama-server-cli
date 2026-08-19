import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';

// 读取 JSON 文件;解析失败时将损坏文件改名为 .bak 并返回 fallback,避免静默覆盖用户数据
// (用 rename 而非 copy:损坏文件只警告一次,后续读取按"文件不存在"处理)
export function readJsonSafe<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    try {
      renameSync(filePath, filePath + '.bak');
      console.error(`Warning: ${filePath} is corrupted, backed up to ${filePath}.bak`);
    } catch { /* 备份失败不阻塞 */ }
    return fallback;
  }
}

// 原子写入:先写 tmp 再 rename,防止中途崩溃留下半个文件
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, filePath);
}

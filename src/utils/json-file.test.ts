import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readJsonSafe, writeJsonAtomic } from './json-file.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lsc-json-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('readJsonSafe', () => {
  it('文件不存在时返回 fallback', () => {
    expect(readJsonSafe(join(dir, 'nope.json'), { a: 1 })).toEqual({ a: 1 });
  });

  it('正常解析 JSON', () => {
    const p = join(dir, 'ok.json');
    writeFileSync(p, '{"a":2}');
    expect(readJsonSafe(p, { a: 1 })).toEqual({ a: 2 });
  });

  it('JSON 损坏时备份 .bak 并返回 fallback', () => {
    const p = join(dir, 'bad.json');
    writeFileSync(p, '{corrupted');
    expect(readJsonSafe(p, { a: 1 })).toEqual({ a: 1 });
    expect(existsSync(p + '.bak')).toBe(true);
    expect(readFileSync(p + '.bak', 'utf8')).toBe('{corrupted');
  });
});

describe('writeJsonAtomic', () => {
  it('写入后可读回,且不残留 tmp 文件', () => {
    const p = join(dir, 'w.json');
    writeJsonAtomic(p, { b: 3 });
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ b: 3 });
    expect(existsSync(p + '.tmp')).toBe(false);
  });

  it('覆盖已存在文件', () => {
    const p = join(dir, 'w.json');
    writeFileSync(p, '{"old":true}');
    writeJsonAtomic(p, { b: 4 });
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ b: 4 });
  });
});

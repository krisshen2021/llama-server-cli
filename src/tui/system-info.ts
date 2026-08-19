/**
 * TUI 系统信息模块
 * 异步采集 GPU/内存信息,避免 execSync 阻塞事件循环
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';

const execFileP = promisify(execFile);

export interface GpuInfo {
  used: number;
  total: number;
  percent: number;
  temp: number;
}

export interface RamInfo {
  used: number;
  total: number;
  percent: number;
}

// 获取 NVIDIA GPU 信息(异步,失败返回 null)
export async function getGpuInfo(): Promise<GpuInfo[] | null> {
  try {
    const { stdout } = await execFileP(
      'nvidia-smi',
      ['--query-gpu=memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'],
      { encoding: 'utf-8', timeout: 2000 }
    );
    const lines = stdout.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return null;
    return lines.map((line) => {
      const [used, total, temp] = line.split(', ').map(Number);
      return {
        used,
        total,
        percent: Math.round((used / total) * 100),
        temp,
      };
    });
  } catch {
    return null;
  }
}

// 获取系统内存信息(异步,失败返回全 0)
export async function getRamInfo(): Promise<RamInfo> {
  try {
    const { stdout } = await execFileP('free', ['-m'], { encoding: 'utf-8', timeout: 2000 });
    const lines = stdout.trim().split('\n');
    const memLine = lines[1].split(/\s+/);
    const total = parseInt(memLine[1]);
    const used = parseInt(memLine[2]);
    return {
      used,
      total,
      percent: Math.round((used / total) * 100),
    };
  } catch {
    return { used: 0, total: 0, percent: 0 };
  }
}

// GPU 数量缓存:GPU 数量运行期不会变化,启动时探测一次即可
// (预设编辑器左右方向键每次都会读它,不能每次都跑 nvidia-smi)
let cachedGpuCount: number | null = null;

export async function warmSystemInfoCache(): Promise<void> {
  const gpus = await getGpuInfo();
  cachedGpuCount = gpus ? gpus.length : 0;
}

export function getCachedGpuCount(): number {
  return cachedGpuCount ?? 1;
}

interface NicInfo {
  address: string;
  family: string | number;
  internal: boolean;
}

// 从网卡列表挑局域网 IPv4:跳过 loopback/链路本地(169.254),
// 物理网卡(en*/eth*/wl*)优先于 docker/tailscale 等虚拟网卡
export function pickLanIPv4(nics: Record<string, NicInfo[] | undefined>): string | undefined {
  const physical: string[] = [];
  const virtual: string[] = [];
  for (const [name, infos] of Object.entries(nics)) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' && info.family !== 4) continue;
      if (info.internal) continue;
      if (info.address.startsWith('169.254.')) continue;
      if (/^(en|eth|wl)/.test(name)) physical.push(info.address);
      else virtual.push(info.address);
    }
  }
  return physical[0] ?? virtual[0];
}

// 本机局域网 IPv4(无合适网卡时 undefined)
export function getLanIPv4(): string | undefined {
  return pickLanIPv4(os.networkInterfaces());
}

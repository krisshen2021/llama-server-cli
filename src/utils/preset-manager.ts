import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { Preset, PresetsStore } from '../types.js';
import { getConfigDir } from './config-manager.js';
import { readJsonSafe, writeJsonAtomic } from './json-file.js';

export function getPresetsPath(): string {
  return join(getConfigDir(), 'presets.json');
}

// 加载所有预设(损坏时 readJsonSafe 备份 .bak 并返回 {})
export function loadPresets(): PresetsStore {
  return readJsonSafe<PresetsStore>(getPresetsPath(), {});
}

// 保存所有预设(原子写)
export function savePresets(presets: PresetsStore): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeJsonAtomic(getPresetsPath(), presets);
}

// 获取单个预设
export function getPreset(name: string): Preset | null {
  const presets = loadPresets();
  const preset = presets[name];
  
  if (!preset) {
    return null;
  }
  
  return { name, ...preset };
}

// 保存单个预设
export function savePreset(preset: Preset): void {
  const presets = loadPresets();
  const { name, ...rest } = preset;
  presets[name] = rest;
  savePresets(presets);
}

// 删除预设
export function deletePreset(name: string): boolean {
  const presets = loadPresets();
  
  if (!presets[name]) {
    return false;
  }
  
  delete presets[name];
  savePresets(presets);
  return true;
}

// 检查预设是否存在
export function presetExists(name: string): boolean {
  const presets = loadPresets();
  return name in presets;
}

// 重命名预设:新旧任一校验失败都返回 false 且不落盘(调用方负责提示)
export function renamePreset(oldName: string, newName: string): boolean {
  const presets = loadPresets();
  if (!presets[oldName]) return false;
  if (oldName === newName || presets[newName]) return false; // 同名/新名被占,不覆盖
  presets[newName] = presets[oldName];
  delete presets[oldName];
  savePresets(presets);
  return true;
}

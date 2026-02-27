import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Preset, PresetsStore } from '../types.js';
import { CONFIG_DIR } from './config-manager.js';

const PRESETS_FILE = join(CONFIG_DIR, 'presets.json');

// 加载所有预设
export function loadPresets(): PresetsStore {
  if (!existsSync(PRESETS_FILE)) {
    return {};
  }
  
  try {
    const content = readFileSync(PRESETS_FILE, 'utf-8');
    return JSON.parse(content) as PresetsStore;
  } catch {
    return {};
  }
}

// 保存所有预设
export function savePresets(presets: PresetsStore): void {
  writeFileSync(PRESETS_FILE, JSON.stringify(presets, null, 2));
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

// 列出所有预设名称
export function listPresetNames(): string[] {
  const presets = loadPresets();
  return Object.keys(presets);
}

// 检查预设是否存在
export function presetExists(name: string): boolean {
  const presets = loadPresets();
  return name in presets;
}

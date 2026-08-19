/**
 * TUI 通用小部件
 * 纯函数,无 blessed/屏幕状态依赖
 */

// 进度条所需的主题色(由调用方传入,结构性匹配 index.ts 的 theme)
export interface BarColors {
  success: string;
  warning: string;
  error: string;
  surface2: string;
}

// 创建进度条;useThresholds 为 true 时按百分比变色(>80 error、>60 warning),否则固定 success 色(下载进度)
export function createProgressBar(percent: number, width: number, colors: BarColors, useThresholds = true): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  let color = colors.success;
  if (useThresholds) {
    if (percent > 80) color = colors.error;
    else if (percent > 60) color = colors.warning;
  }
  return `{${color}-fg}${'█'.repeat(filled)}{/}{${colors.surface2}-fg}${'░'.repeat(empty)}{/}`;
}

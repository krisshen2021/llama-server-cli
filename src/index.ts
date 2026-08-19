#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { createStartCommand } from './commands/start.js';
import { createStopCommand } from './commands/stop.js';
import { createStatusCommand } from './commands/status.js';
import { createModelsCommand } from './commands/models.js';
import { createConfigCommand } from './commands/config.js';
import { createPresetCommand } from './commands/preset.js';
import { createProxyCommand } from './commands/proxy.js';
import { createTUI } from './tui/index.js';

const program = new Command();

// 版本号运行时从 package.json 读取(dist/index.js 的 ../package.json 即项目根)
// 读取失败(文件缺失/JSON 损坏)时回退硬编码版本,避免 CLI 在 commander 启动前崩溃
// 注意:回退值需与 package.json 的 version 保持同步
let pkgVersion = '1.0.0';
try {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // 忽略,使用回退版本
}

program
  .name('lsc')
  .description('CLI tool for managing llama.cpp server')
  .version(pkgVersion);

// 注册子命令
program.addCommand(createStartCommand());
program.addCommand(createStopCommand());
program.addCommand(createStatusCommand());
program.addCommand(createModelsCommand());
program.addCommand(createConfigCommand());
program.addCommand(createPresetCommand());
program.addCommand(createProxyCommand());

// ui 命令 - 启动 TUI 界面
program
  .command('ui')
  .description('Launch interactive TUI interface')
  .action(() => {
    createTUI();
  });

// 默认命令（无参数时启动 TUI）
program.action(() => {
  createTUI();
});

// 解析命令行参数
program.parse();

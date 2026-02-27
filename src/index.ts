#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { createStartCommand } from './commands/start.js';
import { createStopCommand } from './commands/stop.js';
import { createStatusCommand } from './commands/status.js';
import { createModelsCommand } from './commands/models.js';
import { createConfigCommand } from './commands/config.js';
import { createPresetCommand } from './commands/preset.js';
import { createProxyCommand } from './commands/proxy.js';
import { createTUI } from './tui/index.js';

const program = new Command();

program
  .name('lsc')
  .description('CLI tool for managing llama.cpp server')
  .version('1.0.0');

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

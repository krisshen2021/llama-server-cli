import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { Preset } from '../types.js';
import { scanModels } from '../utils/model-scanner.js';
import { getExpandedConfig } from '../utils/config-manager.js';
import { parseIntOpt } from '../utils/server-options.js';
import { 
  loadPresets, 
  savePreset, 
  deletePreset, 
  getPreset 
} from '../utils/preset-manager.js';

export function createPresetCommand(): Command {
  const cmd = new Command('preset');
  
  cmd.description('Manage presets');
  
  // lsc preset list
  cmd
    .command('list')
    .description('List all presets')
    .action(() => {
      const presets = loadPresets();
      const names = Object.keys(presets);
      
      console.log();
      console.log(chalk.cyan('=== Presets ==='));
      console.log();
      
      if (names.length === 0) {
        console.log(chalk.yellow('  No presets configured'));
        console.log();
        console.log(chalk.gray(`  Create one with: ${chalk.white('lsc preset save <name>')}`));
        return;
      }
      
      for (const name of names) {
        const p = presets[name];
        const thinking = p.reasoningBudget === 0 ? 'no-think' : 'think';
        console.log(`  ${chalk.green(name.padEnd(20))} ${chalk.gray(p.model)} ${chalk.blue(`[${thinking}]`)}`);
      }
      
      console.log();
      console.log(chalk.gray(`Use ${chalk.white('lsc start <preset>')} to start with a preset`));
    });
  
  // lsc preset show <name>
  cmd
    .command('show <name>')
    .description('Show preset details')
    .action((name: string) => {
      const preset = getPreset(name);
      
      if (!preset) {
        console.error(chalk.red(`Preset "${name}" not found`));
        process.exit(1);
      }
      
      console.log();
      console.log(chalk.cyan(`=== Preset: ${name} ===`));
      console.log();
      console.log(`  ${chalk.yellow('model:'.padEnd(18))} ${chalk.white(preset.model)}`);
      console.log(`  ${chalk.yellow('ctxSize:'.padEnd(18))} ${chalk.white(preset.ctxSize)}`);
      console.log(`  ${chalk.yellow('gpuLayers:'.padEnd(18))} ${chalk.white(preset.gpuLayers)}`);
      if (preset.tensorSplit) {
        console.log(`  ${chalk.yellow('tensorSplit:'.padEnd(18))} ${chalk.white(preset.tensorSplit)}`);
      }
      if (preset.useVision !== undefined) {
        console.log(`  ${chalk.yellow('vision:'.padEnd(18))} ${chalk.white(preset.useVision ? 'on' : 'off')}`);
      }
      if (preset.fit !== undefined) {
        console.log(`  ${chalk.yellow('fit:'.padEnd(18))} ${chalk.white(preset.fit ? 'on' : 'off')}`);
      }
      if (preset.batchSize !== undefined) {
        console.log(`  ${chalk.yellow('batchSize:'.padEnd(18))} ${chalk.white(preset.batchSize)}`);
      }
      if (preset.threadsBatch !== undefined) {
        console.log(`  ${chalk.yellow('threadsBatch:'.padEnd(18))} ${chalk.white(preset.threadsBatch)}`);
      }
      if (preset.cachePrompt !== undefined) {
        console.log(`  ${chalk.yellow('cachePrompt:'.padEnd(18))} ${chalk.white(String(preset.cachePrompt))}`);
      }
      if (preset.cacheReuse !== undefined) {
        console.log(`  ${chalk.yellow('cacheReuse:'.padEnd(18))} ${chalk.white(preset.cacheReuse)}`);
      }
      console.log(`  ${chalk.yellow('host:'.padEnd(18))} ${chalk.white(preset.host)}`);
      console.log(`  ${chalk.yellow('port:'.padEnd(18))} ${chalk.white(preset.port)}`);
      console.log(`  ${chalk.yellow('jinja:'.padEnd(18))} ${chalk.white(preset.jinja)}`);
      console.log(`  ${chalk.yellow('flashAttn:'.padEnd(18))} ${chalk.white(preset.flashAttn)}`);
      console.log(`  ${chalk.yellow('reasoningBudget:'.padEnd(18))} ${chalk.white(preset.reasoningBudget)} ${preset.reasoningBudget === 0 ? chalk.blue('(thinking disabled)') : chalk.blue('(thinking enabled)')}`);
      console.log();
    });
  
  // lsc preset save <name>
  cmd
    .command('save <name>')
    .description('Create or update a preset interactively')
    .action(async (name: string) => {
      try {
        await runPresetSave(name);
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exit(1);
      }
    });
  
  // lsc preset delete <name>
  cmd
    .command('delete <name>')
    .description('Delete a preset')
    .action(async (name: string) => {
      const existing = getPreset(name);
      
      if (!existing) {
        console.error(chalk.red(`Preset "${name}" not found`));
        process.exit(1);
      }
      
      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: `Delete preset "${name}"?`,
        default: false,
      }]);
      
      if (!confirm) {
        console.log(chalk.yellow('Cancelled'));
        return;
      }
      
      deletePreset(name);
      console.log(chalk.green(`Deleted preset "${name}"`));
    });
  
  return cmd;
}

async function runPresetSave(name: string): Promise<void> {
  const existing = getPreset(name);
  const models = scanModels();
  const config = getExpandedConfig();
  
  if (models.length === 0) {
    throw new Error('No models found. Configure models directory first.');
  }
  
  console.log();
  if (existing) {
    console.log(chalk.yellow(`Updating preset: ${name}`));
  } else {
    console.log(chalk.cyan(`Creating preset: ${name}`));
  }
  console.log();
  
  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'model',
      message: 'Select model:',
      choices: models.map(m => ({
        name: `${m.name} (${m.sizeHuman})${m.mmproj ? ' [Vision]' : ''}`,
        value: m.name,
      })),
      default: existing?.model,
    },
    {
      type: 'input',
      name: 'ctxSize',
      message: 'Context size (number or "auto"):',
      default: existing?.ctxSize ?? config.defaultCtxSize,
      filter: (val) => val === 'auto' ? 'auto' : parseIntOpt(String(val)),
    },
    {
      type: 'input',
      name: 'gpuLayers',
      message: 'GPU layers (number or "auto"):',
      default: existing?.gpuLayers ?? config.defaultGpuLayers,
      filter: (val) => val === 'auto' ? 'auto' : parseIntOpt(String(val)),
    },
    {
      type: 'input',
      name: 'tensorSplit',
      message: 'Tensor split (e.g. 50,50). Leave empty for auto:',
      default: existing?.tensorSplit ?? '',
      filter: (val) => String(val || '').trim(),
    },
    {
      type: 'confirm',
      name: 'useVision',
      message: 'Enable vision (mmproj)?',
      default: existing?.useVision ?? true,
    },
    {
      type: 'confirm',
      name: 'fit',
      message: 'Fit model to free VRAM?',
      default: existing?.fit ?? true,
    },
    {
      type: 'input',
      name: 'batchSize',
      message: 'Batch size (0=default, empty=default):',
      default: existing?.batchSize ?? '',
      filter: (val) => {
        const trimmed = String(val || '').trim();
        if (!trimmed) return '';
        const parsed = parseInt(trimmed);
        return isNaN(parsed) ? '' : parsed;
      },
    },
    {
      type: 'input',
      name: 'threadsBatch',
      message: 'Threads batch (0=auto, empty=default):',
      default: existing?.threadsBatch ?? '',
      filter: (val) => {
        const trimmed = String(val || '').trim();
        if (!trimmed) return '';
        const parsed = parseInt(trimmed);
        return isNaN(parsed) ? '' : parsed;
      },
    },
    {
      type: 'confirm',
      name: 'cachePrompt',
      message: 'Enable prompt cache?',
      default: existing?.cachePrompt ?? true,
    },
    {
      type: 'input',
      name: 'cacheReuse',
      message: 'Cache reuse size (0=disabled, empty=default):',
      default: existing?.cacheReuse ?? '',
      filter: (val) => {
        const trimmed = String(val || '').trim();
        if (!trimmed) return '';
        const parsed = parseInt(trimmed);
        return isNaN(parsed) ? '' : parsed;
      },
    },
    {
      type: 'input',
      name: 'host',
      message: 'Host:',
      default: existing?.host ?? config.defaultHost,
    },
    {
      type: 'input',
      name: 'port',
      message: 'Port:',
      default: existing?.port ?? config.defaultPort,
      filter: (val) => parseIntOpt(String(val)),
    },
    {
      type: 'confirm',
      name: 'jinja',
      message: 'Enable Jinja template?',
      default: existing?.jinja ?? true,
    },
    {
      type: 'list',
      name: 'flashAttn',
      message: 'Flash Attention:',
      choices: [
        { name: 'Auto', value: 'auto' },
        { name: 'On', value: 'on' },
        { name: 'Off', value: 'off' },
      ],
      default: existing?.flashAttn ?? 'auto',
    },
    {
      type: 'input',
      name: 'reasoningBudget',
      message: 'Reasoning/Thinking budget (-1=unlimited, 0=off):',
      default: existing?.reasoningBudget ?? -1,
      filter: (val) => {
        const parsed = parseInt(String(val).trim());
        if (parsed === 0 || parsed === -1) return parsed;
        return -1;
      },
    },
    {
      type: 'list',
      name: 'specType',
      message: 'Speculative decoding type:',
      choices: [
        { name: 'Off', value: '' },
        { name: 'draft-simple', value: 'draft-simple' },
        { name: 'draft-eagle3', value: 'draft-eagle3' },
        { name: 'draft-mtp', value: 'draft-mtp' },
        { name: 'draft-dflash', value: 'draft-dflash' },
        { name: 'draft-dspark', value: 'draft-dspark' },
        { name: 'ngram-simple', value: 'ngram-simple' },
        { name: 'ngram-map-k', value: 'ngram-map-k' },
        { name: 'ngram-map-k4v', value: 'ngram-map-k4v' },
        { name: 'ngram-mod', value: 'ngram-mod' },
        { name: 'ngram-cache', value: 'ngram-cache' },
      ],
      default: existing?.specType ?? '',
    },
    {
      type: 'input',
      name: 'specModel',
      message: 'Speculative draft model path (blank = auto-pair):',
      default: existing?.specModel ?? '',
      // 仅 draft-* 系需要草稿模块(draft-mtp 时作为内置 MTP 的覆盖通道)
      when: (a) => typeof a.specType === 'string' && a.specType.startsWith('draft-'),
    },
    {
      type: 'input',
      name: 'specDraftMax',
      message: 'Draft tokens per step, --spec-draft-n-max (0=default; DFlash2 建议 7):',
      default: existing?.specDraftMax ?? 0,
      when: (a) => typeof a.specType === 'string' && a.specType.startsWith('draft-'),
      filter: (val) => {
        const parsed = parseInt(String(val).trim());
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
      },
    },
  ]);
  
  const preset: Preset = {
    name,
    model: answers.model,
    ctxSize: answers.ctxSize,
    gpuLayers: answers.gpuLayers,
    tensorSplit: answers.tensorSplit || undefined,
    useVision: answers.useVision,
    fit: answers.fit,
    batchSize: answers.batchSize === '' ? undefined : answers.batchSize,
    threadsBatch: answers.threadsBatch === '' ? undefined : answers.threadsBatch,
    cachePrompt: answers.cachePrompt,
    cacheReuse: answers.cacheReuse === '' ? undefined : answers.cacheReuse,
    host: answers.host,
    port: answers.port,
    jinja: answers.jinja,
    flashAttn: answers.flashAttn,
    reasoningBudget: answers.reasoningBudget,
    specType: answers.specType || undefined, // '' (Off) 不写入预设,与 TUI 编辑器一致
    // specModel 仅在 draft-* 系下保留(此时字段已显示,answers.specModel 必有值);
    // 其他类型保留会让 llama.cpp 把用不到的 draft 白加载进 VRAM
    specModel: answers.specType.startsWith('draft-') ? (answers.specModel || undefined) : undefined,
    // 草稿 token 数;0 = 不写(用 llama.cpp 默认值)
    specDraftMax: answers.specDraftMax > 0 ? answers.specDraftMax : undefined,
    // parallelSlots 不在 CLI 交互流程中提供(TUI 编辑器管理),已有值原样保留
    parallelSlots: existing?.parallelSlots,
    // slotSavePath 同理:交互流程不提供该字段,已配置的值(TUI 开关或手工设置)原样保留
    slotSavePath: existing?.slotSavePath,
  };
  
  savePreset(preset);
  
  console.log();
  console.log(chalk.green(`Preset "${name}" saved!`));
  console.log();
  console.log(chalk.gray(`Use ${chalk.white(`lsc start ${name}`)} to start with this preset`));
}

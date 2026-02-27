import { Command } from 'commander';
import chalk from 'chalk';
import { scanModels } from '../utils/model-scanner.js';
import { getExpandedConfig } from '../utils/config-manager.js';

export function createModelsCommand(): Command {
  const cmd = new Command('models');
  
  cmd
    .description('List available models')
    .option('-d, --dir <path>', 'Custom models directory')
    .action(async (options) => {
      try {
        await runModels(options.dir);
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exit(1);
      }
    });
  
  return cmd;
}

async function runModels(customDir?: string): Promise<void> {
  const config = getExpandedConfig();
  const modelsDir = customDir || config.modelsDir;
  
  console.log();
  console.log(chalk.cyan(`Models in: ${modelsDir}`));
  console.log();
  
  const models = scanModels(customDir);
  
  if (models.length === 0) {
    console.log(chalk.yellow('  No models found'));
    console.log();
    console.log(chalk.gray(`  Configure models directory with: ${chalk.white('lsc config set modelsDir <path>')}`));
    return;
  }
  
  // 找出最长的名称用于对齐
  const maxNameLen = Math.min(60, Math.max(...models.map(m => m.name.length)));
  
  for (const model of models) {
    const name = model.name.length > 60 ? '...' + model.name.slice(-57) : model.name.padEnd(maxNameLen);
    const size = model.sizeHuman.padStart(10);
    const vision = model.mmproj ? chalk.blue(' [Vision]') : '';
    
    console.log(`  ${chalk.white(name)}  ${chalk.gray(size)}${vision}`);
  }
  
  console.log();
  console.log(chalk.gray(`  Total: ${models.length} model(s)`));
  console.log();
  console.log(chalk.gray(`Use ${chalk.white('lsc start')} to start a model`));
}

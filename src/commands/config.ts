import { Command } from 'commander';
import chalk from 'chalk';
import { Config } from '../types.js';
import { loadConfig, setConfigValue, getConfigValue } from '../utils/config-manager.js';

export function createConfigCommand(): Command {
  const cmd = new Command('config');
  
  cmd.description('Manage configuration');
  
  // lsc config list
  cmd
    .command('list')
    .description('List all configuration')
    .action(() => {
      const config = loadConfig();
      
      console.log();
      console.log(chalk.cyan('=== Configuration ==='));
      console.log();
      
      for (const [key, value] of Object.entries(config)) {
        console.log(`  ${chalk.yellow(key.padEnd(20))} ${chalk.white(String(value))}`);
      }
      
      console.log();
    });
  
  // lsc config get <key>
  cmd
    .command('get <key>')
    .description('Get a configuration value')
    .action((key: string) => {
      const validKeys = ['modelsDir', 'llamaServerPath', 'defaultPort', 'defaultCtxSize', 'defaultGpuLayers', 'defaultHost'];
      
      if (!validKeys.includes(key)) {
        console.error(chalk.red(`Invalid key: ${key}`));
        console.log(chalk.gray(`Valid keys: ${validKeys.join(', ')}`));
        process.exit(1);
      }
      
      const value = getConfigValue(key as keyof Config);
      console.log(value);
    });
  
  // lsc config set <key> <value>
  cmd
    .command('set <key> <value>')
    .description('Set a configuration value')
    .action((key: string, value: string) => {
      const validKeys = ['modelsDir', 'llamaServerPath', 'defaultPort', 'defaultCtxSize', 'defaultGpuLayers', 'defaultHost'];
      
      if (!validKeys.includes(key)) {
        console.error(chalk.red(`Invalid key: ${key}`));
        console.log(chalk.gray(`Valid keys: ${validKeys.join(', ')}`));
        process.exit(1);
      }
      
      let parsedValue: string | number = value;
      
      // 数值类型转换
      if (key === 'defaultPort' || key === 'defaultCtxSize') {
        parsedValue = parseInt(value);
        if (isNaN(parsedValue)) {
          console.error(chalk.red(`Invalid value for ${key}: must be a number`));
          process.exit(1);
        }
      } else if (key === 'defaultGpuLayers') {
        if (value !== 'auto') {
          parsedValue = parseInt(value);
          if (isNaN(parsedValue)) {
            console.error(chalk.red(`Invalid value for ${key}: must be a number or "auto"`));
            process.exit(1);
          }
        }
      }
      
      setConfigValue(key as keyof Config, parsedValue as never);
      console.log(chalk.green(`Set ${key} = ${parsedValue}`));
    });
  
  return cmd;
}

import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import { ServerOptions, DEFAULT_SERVER_OPTIONS } from '../types.js';
import { getExpandedConfig } from '../utils/config-manager.js';
import { scanModels, findModel } from '../utils/model-scanner.js';
import { getPreset } from '../utils/preset-manager.js';
import { startServer, getServerStatus, stopServer } from '../utils/process-manager.js';
import { startRequestLogger } from '../utils/request-logger.js';

export function createStartCommand(): Command {
  const cmd = new Command('start');
  
  cmd
    .description('Start llama-server with a model')
    .argument('[preset]', 'Preset name to use')
    .option('-m, --model <path>', 'Model file path or name')
    .option('-c, --ctx-size <size>', 'Context size', parseInt)
    .option('-ngl, --gpu-layers <layers>', 'GPU layers (number or "auto")')
    .option('--host <host>', 'Host to bind')
    .option('-p, --port <port>', 'Port to listen on', parseInt)
    .option('--no-jinja', 'Disable Jinja template')
    .option('-fa, --flash-attn <mode>', 'Flash attention mode (on/off/auto)')
    .option('-ts, --tensor-split <split>', 'Tensor split (e.g. 50,50)')
    .option('--reasoning-budget <budget>', 'Reasoning budget (-1=unlimited, 0=disabled)', parseInt)
    .option('-i, --interactive', 'Interactive mode')
    .option('-L, --log-requests', 'Enable request logging proxy (runs in foreground)')
    .action(async (presetName, options) => {
      try {
        await runStart(presetName, options);
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exit(1);
      }
    });
  
  return cmd;
}

async function runStart(presetName?: string, cmdOptions?: Record<string, unknown>): Promise<void> {
  const config = getExpandedConfig();
  
  // 检查是否已有运行中的服务
  const status = getServerStatus();
  if (status.running) {
    console.log(chalk.yellow(`Server is already running (PID: ${status.pid}, Port: ${status.port})`));
    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: 'What would you like to do?',
      choices: [
        { name: 'Stop current server and start new one', value: 'restart' },
        { name: 'Cancel', value: 'cancel' },
      ],
    }]);
    
    if (action === 'cancel') {
      return;
    }
    
    // 停止当前服务
    const stopSpinner = ora('Stopping current server...').start();
    await stopServer();
    stopSpinner.succeed('Server stopped');
  }
  
  let serverOptions: Partial<ServerOptions> = { ...DEFAULT_SERVER_OPTIONS };
  
  // 如果指定了预设，加载预设配置
  if (presetName) {
    const preset = getPreset(presetName);
    if (!preset) {
      throw new Error(`Preset "${presetName}" not found`);
    }
    console.log(chalk.blue(`Using preset: ${presetName}`));
    serverOptions = {
      model: preset.model,
      ctxSize: preset.ctxSize,
      gpuLayers: preset.gpuLayers,
      host: preset.host,
      port: preset.port,
      jinja: preset.jinja,
      flashAttn: preset.flashAttn,
      reasoningBudget: preset.reasoningBudget,
      tensorSplit: preset.tensorSplit,
    };
    
    // 查找模型完整路径
    const modelInfo = findModel(preset.model);
    if (modelInfo) {
      serverOptions.model = modelInfo.path;
      if (modelInfo.mmproj) {
        serverOptions.mmproj = modelInfo.mmproj;
      }
    }
  }
  
  // 命令行选项覆盖预设
  if (cmdOptions?.model) serverOptions.model = cmdOptions.model as string;
  if (cmdOptions?.ctxSize) serverOptions.ctxSize = cmdOptions.ctxSize as number;
  if (cmdOptions?.gpuLayers) {
    serverOptions.gpuLayers = cmdOptions.gpuLayers === 'auto' ? 'auto' : parseInt(cmdOptions.gpuLayers as string);
  }
  if (cmdOptions?.host) serverOptions.host = cmdOptions.host as string;
  if (cmdOptions?.port) serverOptions.port = cmdOptions.port as number;
  if (cmdOptions?.jinja === false) serverOptions.jinja = false;
  if (cmdOptions?.flashAttn) serverOptions.flashAttn = cmdOptions.flashAttn as 'on' | 'off' | 'auto';
  if (cmdOptions?.tensorSplit) serverOptions.tensorSplit = cmdOptions.tensorSplit as string;
  if (cmdOptions?.reasoningBudget !== undefined) serverOptions.reasoningBudget = cmdOptions.reasoningBudget as number;
  
  // 交互模式或缺少必要参数时，进入交互式选择
  if (cmdOptions?.interactive || !serverOptions.model) {
    const models = scanModels();
    
    if (models.length === 0) {
      throw new Error(`No models found in ${config.modelsDir}`);
    }
    
    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'model',
        message: 'Select a model:',
        choices: models.map(m => ({
          name: `${m.name} (${m.sizeHuman})${m.mmproj ? ' [Vision]' : ''}`,
          value: m,
        })),
        when: !serverOptions.model,
      },
      {
        type: 'input',
        name: 'ctxSize',
        message: 'Context size:',
        default: serverOptions.ctxSize,
        filter: (val) => parseInt(val) || serverOptions.ctxSize,
      },
      {
        type: 'input',
        name: 'gpuLayers',
        message: 'GPU layers (number or "auto"):',
        default: serverOptions.gpuLayers,
        filter: (val) => val === 'auto' ? 'auto' : (parseInt(val) || 'auto'),
      },
      {
        type: 'input',
        name: 'port',
        message: 'Port:',
        default: serverOptions.port,
        filter: (val) => parseInt(val) || serverOptions.port,
      },
      {
        type: 'confirm',
        name: 'jinja',
        message: 'Enable Jinja template?',
        default: serverOptions.jinja,
      },
      {
        type: 'list',
        name: 'reasoningBudget',
        message: 'Reasoning/Thinking mode:',
        choices: [
          { name: 'Enabled (unlimited thinking)', value: -1 },
          { name: 'Disabled (no thinking)', value: 0 },
        ],
        default: serverOptions.reasoningBudget === 0 ? 1 : 0,
      },
    ]);
    
    if (answers.model) {
      serverOptions.model = answers.model.path;
      if (answers.model.mmproj) {
        serverOptions.mmproj = answers.model.mmproj;
      }
    }
    serverOptions.ctxSize = answers.ctxSize;
    serverOptions.gpuLayers = answers.gpuLayers;
    serverOptions.port = answers.port;
    serverOptions.jinja = answers.jinja;
    serverOptions.reasoningBudget = answers.reasoningBudget;
  } else if (serverOptions.model && !serverOptions.model.startsWith('/')) {
    // 如果提供的是模型名称而非完整路径，查找模型
    const modelInfo = findModel(serverOptions.model);
    if (modelInfo) {
      serverOptions.model = modelInfo.path;
      if (modelInfo.mmproj && !serverOptions.mmproj) {
        serverOptions.mmproj = modelInfo.mmproj;
      }
    } else {
      throw new Error(`Model not found: ${serverOptions.model}`);
    }
  }
  
  // 确保所有必要参数都有值
  const finalOptions: ServerOptions = {
    model: serverOptions.model!,
    mmproj: serverOptions.mmproj,
    ctxSize: serverOptions.ctxSize ?? config.defaultCtxSize,
    gpuLayers: serverOptions.gpuLayers ?? config.defaultGpuLayers,
    host: serverOptions.host ?? config.defaultHost,
    port: serverOptions.port ?? config.defaultPort,
    jinja: serverOptions.jinja ?? true,
    flashAttn: serverOptions.flashAttn ?? 'auto',
    reasoningBudget: serverOptions.reasoningBudget ?? -1,
    tensorSplit: serverOptions.tensorSplit,
  };
  
  // 显示配置
  console.log();
  console.log(chalk.cyan('Starting llama-server with:'));
  console.log(chalk.gray(`  Model:    ${finalOptions.model}`));
  if (finalOptions.mmproj) {
    console.log(chalk.gray(`  Vision:   ${finalOptions.mmproj}`));
  }
  console.log(chalk.gray(`  Context:  ${finalOptions.ctxSize}`));
  console.log(chalk.gray(`  GPU:      ${finalOptions.gpuLayers}`));
  console.log(chalk.gray(`  Host:     ${finalOptions.host}`));
  console.log(chalk.gray(`  Port:     ${finalOptions.port}`));
  console.log(chalk.gray(`  Jinja:    ${finalOptions.jinja}`));
  console.log(chalk.gray(`  Thinking: ${finalOptions.reasoningBudget === 0 ? 'disabled' : 'enabled'}`));
  if (finalOptions.tensorSplit) {
    console.log(chalk.gray(`  Tensor:   ${finalOptions.tensorSplit}`));
  }
  console.log();
  
  // 如果启用请求日志，调整端口
  const logRequests = cmdOptions?.logRequests === true;
  const publicPort = finalOptions.port;
  
  if (logRequests) {
    // llama-server 监听内部端口，代理监听公开端口
    finalOptions.port = publicPort + 1; // e.g., 8081
  }
  
  // 启动服务器
  const spinner = ora('Starting llama-server...').start();
  
  try {
    const result = await startServer(finalOptions);
    spinner.succeed(chalk.green(`Server started successfully!`));
    console.log();
    console.log(chalk.green(`  PID:      ${result.pid}`));
    
    if (logRequests) {
      console.log(chalk.green(`  Backend:  http://127.0.0.1:${finalOptions.port} (internal)`));
      console.log(chalk.green(`  Proxy:    http://${finalOptions.host}:${publicPort} (public)`));
    } else {
      console.log(chalk.green(`  URL:      http://${finalOptions.host}:${finalOptions.port}`));
    }
    console.log(chalk.gray(`  Logs:     ${result.logFile}`));
    
    // 如果启用请求日志，启动代理
    if (logRequests) {
      console.log();
      console.log(chalk.yellow('Starting request logging proxy...'));
      console.log(chalk.gray('Press Ctrl+C to stop both proxy and server'));
      
      const proxyServer = await startRequestLogger({
        listenPort: publicPort,
        targetPort: finalOptions.port,
        targetHost: '127.0.0.1',
      });
      
      // 处理退出信号
      const cleanup = async () => {
        console.log();
        console.log(chalk.yellow('Shutting down...'));
        proxyServer.close();
        try {
          await stopServer();
          console.log(chalk.green('Server and proxy stopped.'));
        } catch {
          // 忽略停止错误
        }
        process.exit(0);
      };
      
      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);
      
      // 保持运行
      await new Promise(() => {});
    } else {
      console.log();
      console.log(chalk.gray(`Use ${chalk.white('lsc status')} to check server status`));
      console.log(chalk.gray(`Use ${chalk.white('lsc stop')} to stop the server`));
    }
  } catch (err) {
    spinner.fail(chalk.red('Failed to start server'));
    throw err;
  }
}

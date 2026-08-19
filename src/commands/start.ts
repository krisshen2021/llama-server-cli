import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import { basename } from 'path';
import { ServerOptions, Preset } from '../types.js';
import { getExpandedConfig } from '../utils/config-manager.js';
import { scanModels, findModel, resolveSpecModel } from '../utils/model-scanner.js';
import { getPreset } from '../utils/preset-manager.js';
import { startServer, getServerStatus, stopServer, checkLlamaServerVersion, ctxAutoFitConflict, readLastLogs, MIN_LLAMA_SERVER_BUILD } from '../utils/process-manager.js';
import { startRequestLogger } from '../utils/request-logger.js';
import { resolveServerOptions, parseIntOpt } from '../utils/server-options.js';

// --gpu-layers 的 coercion:数字或 'auto',非法输入直接报错
function parseGpuLayers(value: string): number | 'auto' {
  return value === 'auto' ? 'auto' : parseIntOpt(value);
}

// --ctx-size 的 coercion:数字或 'auto'(交给 --fit 自动调整),非法输入直接报错
function parseCtxOpt(value: string): number | 'auto' {
  return value === 'auto' ? 'auto' : parseIntOpt(value);
}

export function createStartCommand(): Command {
  const cmd = new Command('start');
  
  cmd
    .description('Start llama-server with a model')
    .argument('[preset]', 'Preset name to use')
    .option('-m, --model <path>', 'Model file path or name')
    .option('-c, --ctx-size <size>', 'Context size (number or "auto")', parseCtxOpt)
    .option('-ngl, --gpu-layers <layers>', 'GPU layers (number or "auto")', parseGpuLayers)
    .option('--host <host>', 'Host to bind')
    .option('-p, --port <port>', 'Port to listen on', parseIntOpt)
    .option('--no-jinja', 'Disable Jinja template')
    .option('-fa, --flash-attn <mode>', 'Flash attention mode (on/off/auto)')
    .option('-ts, --tensor-split <split>', 'Tensor split (e.g. 50,50)')
    .option('-b, --batch-size <size>', 'Batch size', parseIntOpt)
    .option('-tb, --threads-batch <threads>', 'Batch threads (0=auto)', parseIntOpt)
    .option('--cache-prompt', 'Enable prompt cache')
    .option('--no-cache-prompt', 'Disable prompt cache')
    .option('--cache-reuse <size>', 'Cache reuse chunk size', parseIntOpt)
    .option('--no-vision', 'Disable vision (ignore mmproj)')
    .option('--fit <mode>', 'Fit model to free VRAM (on/off)')
    .option('--reasoning-budget <budget>', 'Reasoning budget (-1=unlimited, 0=disabled)', parseIntOpt)
    .option('--spec-type <type>', 'Speculative decoding type (e.g. draft-mtp, ngram-simple)')
    .option('--spec-model <path>', 'Draft/MTP module path for speculative decoding')
    .option('--slot-save-path <dir>', 'Directory to persist slot KV caches (session resume)')
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

// 收集用户显式传入的 CLI 选项,规范化为 Partial<ServerOptions>
// 注意:--no-jinja/--no-vision 只有否定式,未传入时 commander 给 true,
// 只有 === false 才代表用户显式传入,不能按 undefined 跳过逻辑处理
function collectCliOverrides(cmdOptions?: Record<string, unknown>): Partial<ServerOptions> {
  const cli: Partial<ServerOptions> = {};
  if (!cmdOptions) return cli;

  if (cmdOptions.model !== undefined) cli.model = cmdOptions.model as string;
  if (cmdOptions.ctxSize !== undefined) cli.ctxSize = cmdOptions.ctxSize as number | 'auto';
  if (cmdOptions.gpuLayers !== undefined) cli.gpuLayers = cmdOptions.gpuLayers as number | 'auto';
  if (cmdOptions.host !== undefined) cli.host = cmdOptions.host as string;
  if (cmdOptions.port !== undefined) cli.port = cmdOptions.port as number;
  if (cmdOptions.jinja === false) cli.jinja = false;
  if (cmdOptions.flashAttn !== undefined) cli.flashAttn = cmdOptions.flashAttn as 'on' | 'off' | 'auto';
  if (cmdOptions.tensorSplit !== undefined) cli.tensorSplit = cmdOptions.tensorSplit as string;
  if (cmdOptions.batchSize !== undefined) cli.batchSize = cmdOptions.batchSize as number;
  if (cmdOptions.threadsBatch !== undefined) cli.threadsBatch = cmdOptions.threadsBatch as number;
  if (cmdOptions.cachePrompt !== undefined) cli.cachePrompt = cmdOptions.cachePrompt as boolean;
  if (cmdOptions.cacheReuse !== undefined) cli.cacheReuse = cmdOptions.cacheReuse as number;
  if (cmdOptions.vision === false) cli.useVision = false;
  if (cmdOptions.fit !== undefined) {
    cli.fit = (cmdOptions.fit as string).toLowerCase() === 'on';
  }
  if (cmdOptions.reasoningBudget !== undefined) cli.reasoningBudget = cmdOptions.reasoningBudget as number;
  if (cmdOptions.specType !== undefined) cli.specType = cmdOptions.specType as string;
  if (cmdOptions.specModel !== undefined) cli.specModel = cmdOptions.specModel as string;
  if (cmdOptions.slotSavePath !== undefined) cli.slotSavePath = cmdOptions.slotSavePath as string;

  return cli;
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
  
  // 收集用户显式传入的 CLI 选项(commander 未传入的键为 undefined,跳过)
  const cliOverrides = collectCliOverrides(cmdOptions);

  // 如果指定了预设，加载预设配置(全字段参与合并,不再手工挑选字段)
  let preset: Preset | null = null;
  if (presetName) {
    preset = getPreset(presetName);
    if (!preset) {
      throw new Error(`Preset "${presetName}" not found`);
    }
    console.log(chalk.blue(`Using preset: ${presetName}`));
  }

  // model 只能来自 CLI 或预设;相对名称解析为完整路径(顺带发现 mmproj / MTP 模块)
  let model = cliOverrides.model ?? preset?.model;
  let mmproj: string | undefined;
  let mtp: string | undefined;
  if (model && !model.startsWith('/')) {
    const modelInfo = findModel(model);
    if (modelInfo) {
      model = modelInfo.path;
      if (modelInfo.mmproj) {
        mmproj = modelInfo.mmproj;
      }
      if (modelInfo.mtp) {
        mtp = modelInfo.mtp;
      }
    } else if (!cmdOptions?.interactive) {
      throw new Error(`Model not found: ${model}`);
    }
  }

  // mmproj 必须排除在 preset 层之外(与 TUI 同理):扫描器配不到 mmproj 时(如文件已删/移动),
  // overlayDefined 会跳过覆盖层的 undefined 而让 preset 里的过期路径渗漏,
  // 导致 --mmproj 指向不存在文件;mmproj 只来自上方 findModel 的实时配对结果
  // 注意与 specModel 的刻意不对称:specModel 留在 preset 层不剥离——它是手工指定
  // 非 mtp- 命名 draft 模块的覆盖通道(扫描器只配 mtp-* 前缀文件);mmproj 则始终以扫描器为准
  let presetLayer: Partial<Preset> | null = null;
  if (preset) {
    const { mmproj: _presetMmproj, ...presetRest } = preset;
    presetLayer = presetRest;
  }

  // 单点合并:命令行 > 预设 > config > 内置默认
  // 注:交互模式下 model 可能尚未确定,由下方交互提示补全后才启动
  const finalOptions = resolveServerOptions(
    { ...cliOverrides, ...(model !== undefined ? { model } : {}) },
    presetLayer,
    config,
  );
  if (mmproj) {
    finalOptions.mmproj = mmproj;
  }
  
  // 交互模式或缺少必要参数时，进入交互式选择
  if (cmdOptions?.interactive || !finalOptions.model) {
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
        when: !finalOptions.model,
      },
      {
        type: 'input',
        name: 'ctxSize',
        message: 'Context size (number or "auto"):',
        default: finalOptions.ctxSize,
        filter: (val) => val === 'auto' ? 'auto' : parseIntOpt(String(val)),
      },
      {
        type: 'input',
        name: 'gpuLayers',
        message: 'GPU layers (number or "auto"):',
        default: finalOptions.gpuLayers,
        filter: (val) => val === 'auto' ? 'auto' : parseIntOpt(String(val)),
      },
      {
        type: 'input',
        name: 'port',
        message: 'Port:',
        default: finalOptions.port,
        filter: (val) => parseIntOpt(String(val)),
      },
      {
        type: 'confirm',
        name: 'jinja',
        message: 'Enable Jinja template?',
        default: finalOptions.jinja,
      },
      {
        type: 'list',
        name: 'reasoningBudget',
        message: 'Reasoning/Thinking mode:',
        choices: [
          { name: 'Enabled (unlimited thinking)', value: -1 },
          { name: 'Disabled (no thinking)', value: 0 },
        ],
        default: finalOptions.reasoningBudget === 0 ? 1 : 0,
      },
    ]);
    
    if (answers.model) {
      finalOptions.model = answers.model.path;
      if (answers.model.mmproj) {
        finalOptions.mmproj = answers.model.mmproj;
      }
      if (answers.model.mtp) {
        mtp = answers.model.mtp;
      }
    }
    finalOptions.ctxSize = answers.ctxSize;
    finalOptions.gpuLayers = answers.gpuLayers;
    finalOptions.port = answers.port;
    finalOptions.jinja = answers.jinja;
    finalOptions.reasoningBudget = answers.reasoningBudget;
  }
  
  // 投机解码模块解析:仅 draft 系类型自动挂载配对模块;必须外挂模块却配不到时警告
  const spec = resolveSpecModel(finalOptions.specType, finalOptions.specModel, mtp, 'en');
  finalOptions.specModel = spec.specModel;
  if (spec.warning) {
    console.log(chalk.yellow(spec.warning));
  }
  
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
  if (finalOptions.batchSize !== undefined) {
    console.log(chalk.gray(`  Batch:    ${finalOptions.batchSize}`));
  }
  if (finalOptions.threadsBatch !== undefined) {
    console.log(chalk.gray(`  T.Batch:  ${finalOptions.threadsBatch}`));
  }
  if (finalOptions.cachePrompt !== undefined) {
    console.log(chalk.gray(`  Cache:    ${finalOptions.cachePrompt ? 'on' : 'off'}`));
  }
  if (finalOptions.cacheReuse !== undefined) {
    console.log(chalk.gray(`  Reuse:    ${finalOptions.cacheReuse}`));
  }
  if (finalOptions.fit !== undefined) {
    console.log(chalk.gray(`  Fit:      ${finalOptions.fit ? 'on' : 'off'}`));
  } else if (finalOptions.ctxSize === 'auto') {
    // ctxSize 'auto' 会强制 -fit on(见 buildServerArgs);fit 未显式设置时也要显示,否则用户看不到被强制的 fit
    console.log(chalk.gray(`  Fit:      on (auto)`));
  }
  if (finalOptions.specType) {
    const specSuffix = finalOptions.specModel ? ` (${basename(finalOptions.specModel)})` : '';
    console.log(chalk.gray(`  Spec:     ${finalOptions.specType}${specSuffix}`));
  }
  console.log();
  
  // 如果启用请求日志，调整端口
  const logRequests = cmdOptions?.logRequests === true;
  const publicPort = finalOptions.port;
  
  if (logRequests) {
    // llama-server 监听内部端口，代理监听公开端口
    finalOptions.port = publicPort + 1; // e.g., 8081
  }
  
  // ctxSize 'auto' 与锁定 GPU 层数/多卡切分冲突时提前警告(fit 降级但 llama.cpp 仍会启动,故只警告不阻断)
  const fitConflict = ctxAutoFitConflict(finalOptions);
  if (fitConflict) {
    console.log(chalk.yellow('Warning: ' + fitConflict));
  }

  // 启动服务器
  const spinner = ora('Starting llama-server...').start();

  // 版本探测:过旧的 llama-server 提前给出明确警告(--fit/-ngl auto/--reasoning-budget 等参数需要较新版本)
  const versionCheck = checkLlamaServerVersion(config.llamaServerPath);
  if (versionCheck && !versionCheck.supported) {
    spinner.warn(chalk.yellow(`llama-server build ${versionCheck.build} is too old (need >= b${MIN_LLAMA_SERVER_BUILD}); flags like --fit, -ngl auto, --reasoning-budget may not be supported. Please upgrade llama.cpp.`));
    spinner.start();
  }
  
  try {
    const result = await startServer(finalOptions, logRequests ? { publicPort } : undefined);
    spinner.succeed(chalk.green(`Server started successfully!`));
    console.log();
    console.log(chalk.green(`  PID:      ${result.pid}`));

    // CPU 回退自检(日志每次启动截断,只含本次输出):
    // 混合架构(GDN/Mamba 类)有层落 CPU 时生成速度会跌到全 GPU 的 1/5 以下
    const startupLogs = readLastLogs(80);
    if (/assigned to device CPU|not supported, set to disabled/.test(startupLogs)) {
      console.log(chalk.yellow(`  WARNING:  部分模型层因显存不足回退到 CPU,生成速度会严重下降。`));
      console.log(chalk.yellow(`            建议:-ngl 99 搭配固定较小 -c,或关闭视觉/其他占显存的进程后重启`));
    }
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

import blessed from 'blessed';
import http from 'http';
import { rmSync, readdirSync } from 'fs';
import { basename, dirname, isAbsolute, join } from 'path';
import { execSync } from 'child_process';
import { ModelInfo, ServerOptions } from '../types.js';
import { scanModels, findModel } from '../utils/model-scanner.js';
import { getServerStatus, startServer, stopServer, readLastLogs, getLogFile } from '../utils/process-manager.js';
import { loadPresets, getPreset, savePreset, deletePreset } from '../utils/preset-manager.js';
import { getExpandedConfig } from '../utils/config-manager.js';
import { createRequestLogger } from '../utils/request-logger.js';
import { CONFIG_DIR } from '../utils/config-manager.js';
import { 
  fetchRepoFiles, 
  getAvailableQuantizations, 
  getFilesForQuantization, 
  getDownloadUrl, 
  formatSize,
  HFRepo,
  HFFile 
} from '../utils/hf-api.js';
import { 
  getSystemInfo, 
  analyzeQuantizations, 
  SystemInfo,
  QuantizationEstimate 
} from '../utils/model-recommender.js';
import { 
  DownloadManager, 
  DownloadProgress, 
  DownloadTask,
  DownloadStatus,
  formatSpeed, 
  formatEta, 
  checkDiskSpace 
} from '../utils/downloader.js';
import { verifySha256, VerifyProgress } from '../utils/verifier.js';
import { 
  generateAndSavePreset, 
  getModelStoragePath, 
  getModelDir 
} from '../utils/preset-generator.js';
import {
  DownloadMeta,
  scanIncompleteDownloads,
  deleteDownloadMeta,
  deletePartialFile,
  readDownloadMeta,
  cleanupEmptyDirs,
  IncompleteDownload,
} from '../utils/download-meta.js';

// 获取 NVIDIA GPU 信息
function getGpuInfo(): Array<{ used: number; total: number; percent: number; temp: number }> | null {
  try {
    const output = execSync(
      'nvidia-smi --query-gpu=memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits',
      { encoding: 'utf-8', timeout: 2000 }
    );
    const lines = output.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return null;
    return lines.map((line) => {
      const [used, total, temp] = line.split(', ').map(Number);
      return {
        used,
        total,
        percent: Math.round((used / total) * 100),
        temp,
      };
    });
  } catch {
    return null;
  }
}

// 获取系统内存信息
function getRamInfo(): { used: number; total: number; percent: number } {
  try {
    const output = execSync('free -m', { encoding: 'utf-8', timeout: 2000 });
    const lines = output.trim().split('\n');
    const memLine = lines[1].split(/\s+/);
    const total = parseInt(memLine[1]);
    const used = parseInt(memLine[2]);
    return {
      used,
      total,
      percent: Math.round((used / total) * 100),
    };
  } catch {
    return { used: 0, total: 0, percent: 0 };
  }
}

export function createTUI(): void {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'lsc - llama.cpp Server CLI',
    fullUnicode: true,
    warnings: false,  // 禁用终端兼容性警告
    terminal: 'xterm-256color',  // 强制使用兼容的终端类型
  });

  // 状态变量
  let currentModel: ModelInfo | null = null;
  let models: ModelInfo[] = [];
  let presetNames: string[] = [];
  let logInterval: ReturnType<typeof setInterval> | null = null;
  let resourceInterval: ReturnType<typeof setInterval> | null = null;
  let proxyServer: http.Server | null = null;
  let currentPublicPort: number = 8080; // 代理对外端口
  let currentInternalPort: number = 8081; // llama-server 内部端口
  let currentServerOptions: Partial<ServerOptions> = {}; // 当前服务器参数
  let presetEditMode: boolean = false; // 是否处于编辑预设模式
  let modelDeleteHandler: (() => void) | null = null;

  // 下载管理器状态
  interface DownloadEntry {
    key: string;
    meta: DownloadMeta;
    downloadedBytes: number;
    status: DownloadStatus;
  }

  let downloadManagerOverlay: blessed.Widgets.BoxElement | null = null;
  let downloadManagerList: blessed.Widgets.ListElement | null = null;
  let downloadManagerInfo: blessed.Widgets.BoxElement | null = null;
  let downloadManagerHelp: blessed.Widgets.BoxElement | null = null;
  let downloadManagerVisible = false;
  let downloadManagerListKeys: string[] = [];
  let downloadManagerSelectedKeys = new Set<string>();
  let activeDownloadManager: DownloadManager | null = null;
  let activeDownloadPaused = false;
  let activeDownloadSnapshot = new Map<string, DownloadEntry>();
  let activeDownloadTaskIds = new Map<string, string>();
  let downloadStatusInterval: ReturnType<typeof setInterval> | null = null;

  // 颜色主题 - 暗色风格，类似 OpenCode
  const theme = {
    primary: '#5f87ff',    // 蓝紫色
    secondary: '#5fafff',  // 亮蓝色
    success: '#87d787',    // 柔和绿
    warning: '#d7af5f',    // 柔和黄
    error: '#d75f5f',      // 柔和红
    muted: '#585858',      // 暗灰
    text: '#c0c0c0',       // 浅灰文字
    border: '#444444',     // 边框灰
  };

  // === 布局组件 ===

  // ASCII Logo - 小羊驼
  const logo = `{${theme.warning}-fg}  ◝(' ω ')◜  {/}{bold}{${theme.primary}-fg}lsc{/} {${theme.text}-fg}· llama.cpp server controller{/}
{${theme.warning}-fg}    /|  |\\    {/}{${theme.muted}-fg}manage models, presets & requests{/}`;

  // 标题栏
  const header = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: 4,
    content: logo,
    tags: true,
    style: {
      fg: theme.text,
      bg: '#0c0c0c',
    },
    padding: { left: 2, top: 1 },
  });

  // 状态栏
  const statusBar = blessed.box({
    parent: screen,
    top: 4,
    left: 0,
    width: '100%',
    height: 3,
    content: '',
    tags: true,
    border: { type: 'line' },
    style: {
      fg: theme.text,
      border: { fg: theme.border },
    },
    padding: { left: 1, right: 1 },
  });

  // 主菜单
  const menuBox = blessed.list({
    parent: screen,
    top: 7,
    left: 0,
    width: '30%',
    height: '50%-7',
    label: ' Menu ',
    tags: true,
    border: { type: 'line' },
    style: {
      fg: theme.text,
      border: { fg: theme.border },
      selected: { bg: theme.primary, fg: '#000000', bold: true },
      item: { fg: theme.text },
    },
    keys: true,
    vi: true,
    mouse: true,
    padding: { left: 1, right: 1 },
    items: [
      '▶ Start Server',
      '■ Stop Server',
      '⟳ Restart Server',
      '⏏ Eject Model',
      '☰ Select Model',
      '⬇ Download Model',
      '📥 Download Manager',
      '★ Load Preset',
      '✎ Edit Preset',
      '⚙ Settings',
      '✕ Exit',
    ],
  });

  // 模型列表
  const modelList = blessed.list({
    parent: screen,
    top: 7,
    left: '30%',
    width: '70%',
    height: '50%-7',
    label: ' Models ',
    tags: true,
    border: { type: 'line' },
    style: {
      fg: theme.text,
      border: { fg: theme.border },
      selected: { bg: theme.primary, fg: '#000000', bold: true },
      item: { fg: theme.text },
    },
    keys: true,
    vi: true,
    mouse: true,
    hidden: true,
    padding: { left: 1, right: 1 },
    items: [],
  });

  // 预设列表
  const presetList = blessed.list({
    parent: screen,
    top: 7,
    left: '30%',
    width: '70%',
    height: '50%-7',
    label: ' Presets ',
    tags: true,
    border: { type: 'line' },
    style: {
      fg: theme.text,
      border: { fg: theme.border },
      selected: { bg: theme.primary, fg: '#000000', bold: true },
      item: { fg: theme.text },
    },
    keys: true,
    vi: true,
    mouse: true,
    hidden: true,
    padding: { left: 1, right: 1 },
    items: [],
  });

  // 信息面板 - 左侧：服务器状态
  const infoBox = blessed.box({
    parent: screen,
    top: 7,
    left: '30%',
    width: '35%',
    height: '50%-7',
    label: ' Server Info ',
    tags: true,
    border: { type: 'line' },
    content: '',
    style: {
      fg: theme.text,
      border: { fg: theme.border },
    },
    padding: { left: 1, right: 1, top: 1 },
  });

  // 信息面板 - 右侧：资源监控
  const resourceBox = blessed.box({
    parent: screen,
    top: 7,
    left: '65%',
    width: '35%',
    height: '50%-7',
    label: ' Resources ',
    tags: true,
    border: { type: 'line' },
    content: '',
    style: {
      fg: theme.text,
      border: { fg: theme.border },
    },
    padding: { left: 1, right: 1, top: 1 },
  });

  // 左侧日志窗口 - llama.cpp 服务器日志
  const serverLogBox = blessed.log({
    parent: screen,
    top: '50%',
    left: 0,
    width: '50%',
    height: '50%-3',
    label: ' Server Logs ',
    tags: true,
    border: { type: 'line' },
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      ch: '│',
      style: { fg: theme.muted },
    },
    style: {
      fg: theme.text,
      border: { fg: theme.border },
    },
    mouse: true,
    padding: { left: 1, right: 1 },
  });

  // 右侧日志窗口 - 请求/响应日志
  const requestLogBox = blessed.log({
    parent: screen,
    top: '50%',
    left: '50%',
    width: '50%',
    height: '50%-3',
    label: ' Requests ',
    tags: true,
    border: { type: 'line' },
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      ch: '│',
      style: { fg: theme.muted },
    },
    style: {
      fg: theme.text,
      border: { fg: theme.secondary },
    },
    mouse: true,
    padding: { left: 1, right: 1 },
  });

  // 快捷键提示
  const helpBar = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 3,
    content: `{center}{${theme.secondary}-fg}↑↓{/} Navigate {${theme.muted}-fg}│{/} {${theme.secondary}-fg}Enter{/} Select {${theme.muted}-fg}│{/} {${theme.secondary}-fg}Tab{/} Switch {${theme.muted}-fg}│{/} {${theme.secondary}-fg}r{/} Refresh {${theme.muted}-fg}│{/} {${theme.secondary}-fg}q{/} Quit{/center}`,
    tags: true,
    style: {
      fg: theme.text,
      bg: '#121212',
    },
    valign: 'middle',
  });

  // === 功能函数 ===

  function updateStatus(): void {
    const status = getServerStatus();
    let content = '';
    const config = getExpandedConfig();
    const incompleteCount = scanIncompleteDownloads(config.modelsDir).length;
    const activeProgress = getActiveDownloadProgress();

    if (status.running || proxyServer) {
      const modelName = basename(status.model || 'Unknown');
      const proxyStatus = proxyServer ? '{green-fg}●{/green-fg}' : '{red-fg}●{/red-fg}';
      content = `{green-fg}●{/green-fg} Running  |  ` +
        `{cyan-fg}PID:{/cyan-fg} ${status.pid}  |  ` +
        `{cyan-fg}Port:{/cyan-fg} ${currentPublicPort}  |  ` +
        `{cyan-fg}Proxy:{/cyan-fg} ${proxyStatus}  |  ` +
        `{cyan-fg}Model:{/cyan-fg} ${modelName}`;
      if (activeProgress.active) {
        content += `  |  {#5fafff-fg}⬇ ${activeProgress.label}{/} {#87d787-fg}${activeProgress.percent}%{/} {#585858-fg}[S] Show{/}`;
      }
      if (incompleteCount > 0) {
        content += `  |  {yellow-fg}⚠ ${incompleteCount} incomplete download(s){/yellow-fg}`;
      }
    } else {
      content = `{red-fg}●{/red-fg} Not Running`;
      if (activeProgress.active) {
        content += `  |  {#5fafff-fg}⬇ ${activeProgress.label}{/} {#87d787-fg}${activeProgress.percent}%{/} {#585858-fg}[S] Show{/}`;
      }
      if (incompleteCount > 0) {
        content += `  |  {yellow-fg}⚠ ${incompleteCount} incomplete download(s){/yellow-fg}`;
      }
    }

    statusBar.setContent(` ${content}`);
    screen.render();
  }

  function updateInfo(): void {
    const status = getServerStatus();
    const config = getExpandedConfig();
    
    let content = '';
    
    if (status.running) {
      const proxyStatus = proxyServer ? '{green-fg}Running{/green-fg}' : '{red-fg}Not Running{/red-fg}';
      content = `{bold}Server Status{/bold}\n\n` +
        `  {cyan-fg}Status:{/cyan-fg}     {green-fg}Running{/green-fg}\n` +
        `  {cyan-fg}PID:{/cyan-fg}        ${status.pid}\n` +
        `  {cyan-fg}Model:{/cyan-fg}      ${basename(status.model || '')}\n\n` +
        `{bold}Network{/bold}\n\n` +
        `  {cyan-fg}Public URL:{/cyan-fg}  http://localhost:${currentPublicPort}\n` +
        `  {cyan-fg}Internal:{/cyan-fg}    http://127.0.0.1:${currentInternalPort}\n` +
        `  {cyan-fg}Proxy:{/cyan-fg}       ${proxyStatus}\n`;
      
      if (status.startTime) {
        const uptime = formatUptime(Date.now() - status.startTime.getTime());
        content += `\n  {cyan-fg}Uptime:{/cyan-fg}     ${uptime}\n`;
      }
    } else {
      content = `{bold}Server Status{/bold}\n\n` +
        `  {cyan-fg}Status:{/cyan-fg}     {red-fg}Not Running{/red-fg}\n\n` +
        `{bold}Configuration{/bold}\n\n` +
        `  {cyan-fg}Models Dir:{/cyan-fg}  ${config.modelsDir}\n` +
        `  {cyan-fg}Server:{/cyan-fg}      ${config.llamaServerPath}\n` +
        `  {cyan-fg}Default Port:{/cyan-fg} ${config.defaultPort}\n`;
    }

    infoBox.setContent(content);
    screen.render();
  }

  function updateResources(): void {
    const status = getServerStatus();
    const gpus = getGpuInfo();
    const ram = getRamInfo();
    
    let content = '';
    
    // RAM 信息
    content += `{bold}System RAM{/bold}\n\n`;
    const ramBar = createProgressBar(ram.percent, 20);
    content += `  ${ramBar} ${ram.percent}%\n`;
    content += `  {${theme.secondary}-fg}${ram.used} / ${ram.total} MB{/}\n\n`;
    
    // GPU 信息
    if (gpus && gpus.length > 0) {
      content += `{bold}GPU VRAM{/bold}\n\n`;
      for (let i = 0; i < gpus.length; i++) {
        const gpu = gpus[i];
        const vramBar = createProgressBar(gpu.percent, 16);
        content += `  GPU${i} ${vramBar} ${gpu.percent}%\n`;
        content += `    {${theme.secondary}-fg}${gpu.used} / ${gpu.total} MB{/}  {${theme.secondary}-fg}Temp:{/} ${gpu.temp}°C\n`;
      }
      content += '\n';
    }
    
    // 服务器参数
    if (status.running && Object.keys(currentServerOptions).length > 0) {
      content += `{bold}Server Config{/bold}\n\n`;
      if (currentServerOptions.ctxSize) {
        content += `  {${theme.secondary}-fg}Context:{/} ${currentServerOptions.ctxSize}\n`;
      }
      if (currentServerOptions.gpuLayers) {
        content += `  {${theme.secondary}-fg}GPU Layers:{/} ${currentServerOptions.gpuLayers}\n`;
      }
      if (currentServerOptions.tensorSplit) {
        content += `  {${theme.secondary}-fg}Tensor Split:{/} ${currentServerOptions.tensorSplit}\n`;
      }
      if (currentServerOptions.reasoningBudget !== undefined) {
        const thinking = currentServerOptions.reasoningBudget === 0 ? '{yellow-fg}Off{/}' : '{green-fg}On{/}';
        content += `  {${theme.secondary}-fg}Thinking:{/} ${thinking}\n`;
      }
      if (currentServerOptions.mmproj) {
        content += `  {${theme.secondary}-fg}Vision:{/} {green-fg}Yes{/}\n`;
      }
    }
    
    resourceBox.setContent(content);
    screen.render();
  }

  // 创建进度条
  function createProgressBar(percent: number, width: number): string {
    const filled = Math.round((percent / 100) * width);
    const empty = width - filled;
    let color = theme.success;
    if (percent > 80) color = theme.error;
    else if (percent > 60) color = theme.warning;
    return `{${color}-fg}${'█'.repeat(filled)}{/}{${theme.muted}-fg}${'░'.repeat(empty)}{/}`;
  }

  function updateLogs(): void {
    const logs = readLastLogs(100);
    if (logs) {
      serverLogBox.setContent(logs);
      serverLogBox.setScrollPerc(100);
    }
    screen.render();
  }

  function getActiveDownloadProgress(): { active: boolean; percent: number; label: string } {
    if (!activeDownloadManager) {
      return { active: false, percent: 0, label: '' };
    }
    const tasks = activeDownloadManager.getTasks();
    if (tasks.length === 0) {
      return { active: false, percent: 0, label: '' };
    }
    const total = tasks.reduce((sum, t) => sum + (t.expectedSize || 0), 0);
    const downloaded = tasks.reduce((sum, t) => sum + (t.downloadedBytes || 0), 0);
    const percent = total > 0 ? Math.round((downloaded / total) * 100) : 0;
    return {
      active: true,
      percent,
      label: `${tasks.length} file${tasks.length > 1 ? 's' : ''}`,
    };
  }

  function loadModels(): void {
    models = scanModels();
    const items = models.map(m => {
      const vision = m.mmproj ? ' {blue-fg}[Vision]{/blue-fg}' : '';
      return ` ${basename(m.path)}${vision}`;
    });
    modelList.setItems(items);
  }

  function loadPresetsList(): void {
    const presets = loadPresets();
    presetNames = Object.keys(presets);
    const config = getExpandedConfig();
    const items = presetNames.map(name => {
      const p = presets[name];
      const thinking = p.reasoningBudget === 0 ? '{yellow-fg}[no-think]{/yellow-fg}' : '{green-fg}[think]{/green-fg}';
      return ` ${name} ${thinking}`;
    });
    
    if (items.length === 0) {
      presetList.setItems([' (No presets configured)']);
    } else {
      presetList.setItems(items);
    }
  }

  function inferModelIdFromPath(modelPath: string, modelsDir: string): string {
    if (!modelPath) return 'Unknown';
    const normalizedDir = modelsDir.replace(/\/+$/, '');
    const normalizedPath = modelPath.replace(/\/+$/, '');

    if (normalizedPath.startsWith(normalizedDir)) {
      const relative = normalizedPath.slice(normalizedDir.length).replace(/^\//, '');
      const parts = relative.split('/');
      if (parts.length >= 2) {
        return `${parts[0]}/${parts[1]}`;
      }
    }

    return basename(modelPath);
  }

  function showMessage(msg: string, type: 'info' | 'success' | 'error' = 'info'): void {
    const color = type === 'success' ? theme.success : type === 'error' ? theme.error : theme.primary;
    serverLogBox.log(`{${color}-fg}${msg}{/${color}-fg}`);
    screen.render();
  }

  function getTensorSplitOptions(): string[] {
    const systemInfo = getSystemInfo();
    const gpuCount = systemInfo.gpus?.length || 0;
    if (gpuCount <= 1) return [''];
    if (gpuCount === 2) return ['', '50,50', '60,40', '70,30', '80,20', '90,10'];
    const base = Math.floor(100 / gpuCount);
    const splits = new Array(gpuCount).fill(base);
    const remainder = 100 - base * gpuCount;
    if (remainder > 0) {
      splits[splits.length - 1] += remainder;
    }
    return ['', splits.join(',')];
  }

  async function handleStartServer(): Promise<void> {
    const status = getServerStatus();
    
    if (status.running) {
      showMessage('Server is already running. Stop it first.', 'error');
      return;
    }

    if (!currentModel) {
      showMessage('Please select a model first.', 'error');
      return;
    }

    const config = getExpandedConfig();
    currentPublicPort = config.defaultPort;
    currentInternalPort = config.defaultPort + 1;

    // llama-server 监听内部端口
    const options: ServerOptions = {
      model: currentModel.path,
      mmproj: currentModel.mmproj,
      ctxSize: config.defaultCtxSize,
      gpuLayers: config.defaultGpuLayers,
      tensorSplit: undefined,
      kvCacheType: 'f16',
      chatTemplate: undefined,
      host: '127.0.0.1', // 内部只监听 localhost
      port: currentInternalPort,
      jinja: true,
      flashAttn: 'auto',
      reasoningBudget: -1,
    };

    showMessage('Starting server...');
    
    try {
      const result = await startServer(options);
      currentServerOptions = options; // 保存服务器参数
      showMessage(`llama-server started on internal port ${currentInternalPort}`, 'success');
      
      // 启动代理
      await startProxy(currentPublicPort, currentInternalPort);
      showMessage(`Proxy listening on port ${currentPublicPort}`, 'success');
      
      updateStatus();
      updateInfo();
      startLogWatcher();
      startResourceWatcher();
    } catch (err) {
      showMessage(`Failed to start: ${(err as Error).message}`, 'error');
    }
  }

  async function handleStopServer(): Promise<void> {
    const status = getServerStatus();
    
    if (!status.running && !proxyServer) {
      showMessage('Server is not running.', 'error');
      return;
    }

    showMessage('Stopping server...');
    
    try {
      stopProxy();
      await stopServer();
      currentServerOptions = {}; // 清空服务器参数
      showMessage('Server and proxy stopped.', 'success');
      updateStatus();
      updateInfo();
      updateResources();
      stopLogWatcher();
      stopResourceWatcher();
    } catch (err) {
      showMessage(`Failed to stop: ${(err as Error).message}`, 'error');
    }
  }

  async function handleRestartServer(): Promise<void> {
    const status = getServerStatus();
    
    if (status.running) {
      showMessage('Stopping server...');
      await stopServer();
    }
    
    await handleStartServer();
  }

  async function handleEjectModel(): Promise<void> {
    const status = getServerStatus();
    
    if (!status.running && !proxyServer) {
      showMessage('No model loaded.', 'error');
      return;
    }

    showMessage('Ejecting model and freeing VRAM...', 'info');
    
    try {
      // 停止代理
      stopProxy();
      
      // 停止服务器
      await stopServer();
      
      // 清空状态
      currentServerOptions = {};
      currentModel = null;
      
      // 强制触发 CUDA 内存回收
      try {
        execSync('nvidia-smi --gpu-reset 2>/dev/null || true', { timeout: 5000 });
      } catch {}
      
      showMessage('Model ejected, VRAM freed.', 'success');
      updateStatus();
      updateInfo();
      updateResources();
      stopLogWatcher();
      stopResourceWatcher();
    } catch (err) {
      showMessage(`Failed to eject: ${(err as Error).message}`, 'error');
    }
  }

  async function handleLoadPreset(index: number): Promise<void> {
    if (index < 0 || index >= presetNames.length) {
      return;
    }

    const name = presetNames[index];
    const preset = getPreset(name);
    
    if (!preset) {
      showMessage(`Preset "${name}" not found.`, 'error');
      return;
    }

    const model = findModel(preset.model);
    if (!model) {
      showMessage(`Model "${preset.model}" not found.`, 'error');
      return;
    }

    currentModel = model;

    const status = getServerStatus();
    if (status.running) {
      showMessage('Stopping current server...');
      stopProxy();
      await stopServer();
    }

    currentPublicPort = preset.port;
    currentInternalPort = preset.port + 1;

    // llama-server 监听内部端口
    const options: ServerOptions = {
      model: model.path,
      mmproj: model.mmproj,
      ctxSize: preset.ctxSize,
      gpuLayers: preset.gpuLayers,
      tensorSplit: preset.tensorSplit,
      kvCacheType: preset.kvCacheType || 'f16',
      chatTemplate: preset.chatTemplate,
      host: '127.0.0.1', // 内部只监听 localhost
      port: currentInternalPort,
      jinja: preset.jinja,
      flashAttn: preset.flashAttn,
      reasoningBudget: preset.reasoningBudget,
    };

    showMessage(`Loading preset "${name}"...`);
    
    try {
      const result = await startServer(options);
      currentServerOptions = options; // 保存服务器参数
      showMessage(`llama-server started on internal port ${currentInternalPort}`, 'success');
      
      // 启动代理
      await startProxy(currentPublicPort, currentInternalPort);
      showMessage(`Proxy listening on port ${currentPublicPort}`, 'success');
      
      updateStatus();
      updateInfo();
      startLogWatcher();
      startResourceWatcher();
    } catch (err) {
      showMessage(`Failed: ${(err as Error).message}`, 'error');
    }

    presetList.hide();
    infoBox.show();
    resourceBox.show();
    menuBox.focus();
    screen.render();
  }

  function showModelList(): void {
    loadModels();
    modelList.setLabel(' Models (Enter select, d delete) ');
    infoBox.hide();
    presetList.hide();
    modelList.show();
    modelList.focus();
    if (modelDeleteHandler) {
      modelList.unkey('d', modelDeleteHandler);
    }
    modelDeleteHandler = async () => {
      const selectedIndex = (modelList as any).selected;
      if (selectedIndex >= 0 && selectedIndex < models.length) {
        const model = models[selectedIndex];
        await confirmDeleteModel(model);
      }
    };
    modelList.key('d', modelDeleteHandler);
    screen.render();
  }

  function showPresetList(): void {
    loadPresetsList();
    presetEditMode = false;  // 确保是加载模式
    presetList.setLabel(' Presets ');
    infoBox.hide();
    modelList.hide();
    presetList.show();
    presetList.focus();
    screen.render();
  }

  // 编辑模式退出函数（需要在 hideSubLists 之前定义）
  let deleteHandler: (() => void) | null = null;
  
  function exitEditMode(): void {
    presetEditMode = false;
    if (deleteHandler) {
      presetList.unkey('d', deleteHandler);
      deleteHandler = null;
    }
    presetList.setLabel(' Presets ');
  }

  function hideSubLists(): void {
    modelList.hide();
    presetList.hide();
    infoBox.show();
    exitEditMode();
    if (modelDeleteHandler) {
      modelList.unkey('d', modelDeleteHandler);
      modelDeleteHandler = null;
    }
    modelList.setLabel(' Models ');
    menuBox.focus();
    screen.render();
  }

  async function confirmDeleteModel(model: ModelInfo): Promise<void> {
    const modelDir = dirname(model.path);
    const dialog = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: 60,
      height: 9,
      label: ' Delete Model ',
      tags: true,
      border: { type: 'line' },
      style: {
        fg: theme.text,
        bg: '#1c1c1c',
        border: { fg: theme.error },
      },
      padding: { left: 2, right: 2, top: 1 },
    });

    dialog.setContent(
      `Delete model directory?\n\n` +
      `{bold}${modelDir}{/bold}\n\n` +
      `{${theme.secondary}-fg}[Y]{/} Yes  {${theme.secondary}-fg}[N]{/} No`
    );

    screen.render();

    const onKeyPress = (ch: string, key: any) => {
      if (key.name === 'y' || key.name === 'n' || key.name === 'escape') {
        screen.removeListener('keypress', onKeyPress);
        dialog.destroy();

        if (key.name === 'y') {
          try {
            rmSync(modelDir, { recursive: true, force: true });
            showMessage(`Model deleted: ${basename(modelDir)}`, 'success');
            loadModels();
            showModelList();
          } catch (err) {
            showMessage(`Delete failed: ${(err as Error).message}`, 'error');
          }
        }

        screen.render();
      }
    };

    screen.on('keypress', onKeyPress);
  }

  // 编辑预设界面
  function showEditPresetList(): void {
    loadPresetsList();
    presetEditMode = true;
    
    // 修改预设列表标签
    presetList.setLabel(' Edit Preset (Enter to edit, d to delete) ');
    
    infoBox.hide();
    modelList.hide();
    presetList.show();
    presetList.focus();
    
    // 添加删除键绑定
    if (deleteHandler) {
      presetList.unkey('d', deleteHandler);
    }
    deleteHandler = async () => {
      const selectedIndex = (presetList as any).selected;
      if (selectedIndex >= 0 && selectedIndex < presetNames.length) {
        const name = presetNames[selectedIndex];
        await confirmDeletePreset(name);
      }
    };
    presetList.key('d', deleteHandler);
    
    screen.render();
  }

  // 确认删除预设
  async function confirmDeletePreset(name: string): Promise<void> {
    const dialog = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: 50,
      height: 7,
      label: ' Delete Preset ',
      tags: true,
      border: { type: 'line' },
      style: {
        fg: theme.text,
        bg: '#1c1c1c',
        border: { fg: theme.error },
      },
      padding: { left: 2, right: 2, top: 1 },
    });

    dialog.setContent(
      `Delete preset "{bold}${name}{/bold}"?\n\n` +
      `{${theme.secondary}-fg}[Y]{/} Yes  {${theme.secondary}-fg}[N]{/} No`
    );

    screen.render();

    const onKeyPress = (ch: string, key: any) => {
      if (key.name === 'y' || key.name === 'n' || key.name === 'escape') {
        screen.removeListener('keypress', onKeyPress);
        dialog.destroy();
        
        if (key.name === 'y') {
          deletePreset(name);
          showMessage(`Preset "${name}" deleted.`, 'success');
          loadPresetsList();
          showEditPresetList();
        }
        screen.render();
      }
    };

    screen.on('keypress', onKeyPress);
  }

  // 预设编辑器
  async function showPresetEditor(presetName: string): Promise<void> {
    const preset = getPreset(presetName);
    if (!preset) {
      showMessage(`Preset "${presetName}" not found.`, 'error');
      hideSubLists();
      return;
    }

    // 隐藏 presetList 防止键盘事件冲突
    presetList.hide();

    // 编辑状态
    let editState = {
      model: preset.model,
      mmproj: (preset as any).mmproj,
      ctxSize: preset.ctxSize,
      gpuLayers: preset.gpuLayers,
      tensorSplit: preset.tensorSplit || '',
      kvCacheType: preset.kvCacheType || 'f16',
      chatTemplate: preset.chatTemplate || '',
      host: (preset as any).host || '0.0.0.0',
      port: preset.port,
      reasoningBudget: preset.reasoningBudget,
      jinja: preset.jinja,
      flashAttn: preset.flashAttn,
    };

    const config = getExpandedConfig();
    const normalizedModelsDir = config.modelsDir.replace(/\/+$/, '');
    const presetPath = preset.model;
    let modelDir = getModelDir(config.modelsDir, inferModelIdFromPath(preset.model, config.modelsDir));
    if (presetPath && presetPath.startsWith('/') && !presetPath.startsWith(normalizedModelsDir + '/')) {
      modelDir = dirname(presetPath);
    }
    const templateOptions = getChatTemplateOptions(modelDir, join(CONFIG_DIR, 'templates'));

    // 创建编辑对话框
    const editor = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: 60,
      height: 20,
      label: ` Edit: ${presetName} `,
      tags: true,
      border: { type: 'line' },
      style: {
        fg: theme.text,
        bg: '#1c1c1c',
        border: { fg: theme.primary },
      },
      padding: { left: 2, right: 2, top: 1 },
    });

    // 当前选中的字段
    let selectedField = 0;
    const fields = ['ctxSize', 'gpuLayers', 'tensorSplit', 'kvCacheType', 'chatTemplate', 'port', 'host', 'reasoningBudget', 'jinja', 'flashAttn'];
    const fieldLabels = ['Context Size', 'GPU Layers', 'Tensor Split', 'KV Cache', 'Chat Template', 'Port', 'Host', 'Thinking', 'Jinja', 'Flash Attention'];

    function renderEditor() {
      let content = `{${theme.muted}-fg}Model:{/} ${editState.model}\n\n`;
      
      fields.forEach((field, i) => {
        const isSelected = i === selectedField;
        const prefix = isSelected ? `{${theme.primary}-fg}▶{/} ` : '  ';
        const label = fieldLabels[i];
        let value: string;
        
        switch (field) {
          case 'ctxSize':
            value = String(editState.ctxSize);
            break;
          case 'gpuLayers':
            value = String(editState.gpuLayers);
            break;
          case 'tensorSplit':
            value = editState.tensorSplit ? editState.tensorSplit : '{yellow-fg}Auto{/}';
            break;
          case 'kvCacheType':
            value = editState.kvCacheType;
            break;
          case 'chatTemplate':
            value = editState.chatTemplate ? editState.chatTemplate : '{yellow-fg}Default{/}';
            break;
          case 'port':
            value = String(editState.port);
            break;
          case 'host':
            value = editState.host;
            break;
          case 'reasoningBudget':
            value = editState.reasoningBudget === 0 ? '{yellow-fg}Off{/}' : '{green-fg}On{/}';
            break;
          case 'jinja':
            value = editState.jinja ? '{green-fg}Yes{/}' : '{yellow-fg}No{/}';
            break;
          case 'flashAttn':
            value = editState.flashAttn;
            break;
          default:
            value = '';
        }
        
        const highlight = isSelected ? `{bold}` : '';
        const highlightEnd = isSelected ? `{/bold}` : '';
        content += `${prefix}${highlight}{${theme.secondary}-fg}${label}:{/} ${value}${highlightEnd}\n`;
      });

      content += `\n{${theme.muted}-fg}↑↓ Select | ←→ Change | Enter Save | Esc Cancel{/}`;
      
      editor.setContent(content);
      screen.render();
    }

    function changeValue(delta: number) {
      const field = fields[selectedField];
        switch (field) {
          case 'ctxSize':
            const ctxSteps = [1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072];
            const ctxIdx = ctxSteps.indexOf(editState.ctxSize);
            const newCtxIdx = Math.max(0, Math.min(ctxSteps.length - 1, ctxIdx + delta));
            editState.ctxSize = ctxSteps[newCtxIdx];
            break;
          case 'gpuLayers':
            if (editState.gpuLayers === 'auto') {
              editState.gpuLayers = delta > 0 ? 99 : 0;
            } else {
              const newLayers = (editState.gpuLayers as number) + delta * 10;
              if (newLayers < 0) editState.gpuLayers = 'auto';
              else editState.gpuLayers = Math.max(0, newLayers);
            }
            break;
          case 'tensorSplit':
            const splitOptions = getTensorSplitOptions();
            const splitIdx = splitOptions.indexOf(editState.tensorSplit || '');
            editState.tensorSplit = splitOptions[(splitIdx + 1) % splitOptions.length];
            break;
          case 'kvCacheType':
            const kvTypes: Array<'f16' | 'q8_0' | 'q4_0'> = ['f16', 'q8_0', 'q4_0'];
            const kvIdx = kvTypes.indexOf(editState.kvCacheType);
            editState.kvCacheType = kvTypes[(kvIdx + 1) % kvTypes.length];
            break;
          case 'chatTemplate':
            const tplIdx = templateOptions.indexOf(editState.chatTemplate || '');
            const nextIdx = (tplIdx + 1) % templateOptions.length;
            editState.chatTemplate = templateOptions[nextIdx] || '';
            break;
          case 'port':
            editState.port = Math.max(1024, Math.min(65535, editState.port + delta * 100));
            break;
          case 'host':
            editState.host = editState.host === '0.0.0.0' ? '127.0.0.1' : '0.0.0.0';
            break;
          case 'reasoningBudget':
            editState.reasoningBudget = editState.reasoningBudget === 0 ? -1 : 0;
            break;
        case 'jinja':
          editState.jinja = !editState.jinja;
          break;
        case 'flashAttn':
          const modes: ('on' | 'off' | 'auto')[] = ['auto', 'on', 'off'];
          const modeIdx = modes.indexOf(editState.flashAttn);
          editState.flashAttn = modes[(modeIdx + 1) % modes.length];
          break;
      }
      renderEditor();
    }

    const keyHandler = (ch: string, key: any) => {
      if (key.name === 'up') {
        selectedField = (selectedField - 1 + fields.length) % fields.length;
        renderEditor();
      } else if (key.name === 'down') {
        selectedField = (selectedField + 1) % fields.length;
        renderEditor();
      } else if (key.name === 'left') {
        changeValue(-1);
      } else if (key.name === 'right') {
        changeValue(1);
      } else if (key.name === 'enter') {
        // 保存
        screen.removeListener('keypress', keyHandler);
        editor.destroy();
        
        const updatedPreset: any = {
          name: presetName,
          model: editState.model,
          mmproj: editState.mmproj,
          ctxSize: editState.ctxSize,
          gpuLayers: editState.gpuLayers,
          tensorSplit: editState.tensorSplit || undefined,
          kvCacheType: editState.kvCacheType,
          chatTemplate: editState.chatTemplate || undefined,
          host: editState.host,
          port: editState.port,
          jinja: editState.jinja,
          flashAttn: editState.flashAttn,
          reasoningBudget: editState.reasoningBudget,
        };
        
        savePreset(updatedPreset);
        showMessage(`Preset "${presetName}" saved.`, 'success');
        loadPresetsList();
        hideSubLists();
      } else if (key.name === 'escape') {
        screen.removeListener('keypress', keyHandler);
        editor.destroy();
        hideSubLists();
      }
    };

    screen.on('keypress', keyHandler);
    editor.focus();
    renderEditor();
  }

  // ========== 模型下载功能 ==========
  
  // 下载界面通用样式 - 中灰半透明背景，亮色文字
  const downloadStyle = {
    fg: '#e0e0e0',      // 亮色文字
    bg: '#2a2a2a',      // 中灰背景
    border: { fg: theme.primary },
    selected: { bg: theme.primary, fg: '#ffffff', bold: true },
  };

  // 浮层统一样式
  const overlayStyle = {
    fg: '#e8e8e8',
    bg: '#2d2d2d',
    border: { fg: theme.primary },
    selected: { bg: '#3a3a3a', fg: '#ffffff', bold: true },
  };

  async function showDownloadModel(): Promise<void> {
    // Step 1: 输入 HuggingFace Model ID
    const inputBox = blessed.textbox({
      parent: screen,
      top: 'center',
      left: 'center',
      width: 70,
      height: 3,
      label: ' Enter HuggingFace Model ID ',
      tags: true,
      border: { type: 'line' },
      style: {
        fg: overlayStyle.fg,
        bg: overlayStyle.bg,
        border: overlayStyle.border,
      },
      inputOnFocus: true,
    });

    inputBox.focus();
    screen.render();

    inputBox.on('submit', async (value: string) => {
      inputBox.destroy();
      screen.render();
      
      const modelId = value.trim();
      if (!modelId) {
        showMessage('No model ID entered.', 'error');
        return;
      }

      if (!modelId.includes('/')) {
        showMessage('Invalid format. Use: organization/model-name', 'error');
        return;
      }

      await fetchAndShowQuantizations(modelId);
    });

    inputBox.on('cancel', () => {
      inputBox.destroy();
      screen.render();
    });

    inputBox.readInput();
  }

  async function fetchAndShowQuantizations(modelId: string): Promise<void> {
    // 显示加载状态
    const loadingBox = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: 50,
      height: 5,
      tags: true,
      border: { type: 'line' },
      content: `{center}{#ffffff-fg}Fetching model info...{/}\n\n{#87d787-fg}${modelId}{/}{/center}`,
      style: {
        fg: overlayStyle.fg,
        bg: overlayStyle.bg,
        border: overlayStyle.border,
      },
    });
    screen.render();

    try {
      const repo = await fetchRepoFiles(modelId);
      loadingBox.destroy();
      
      if (repo.files.length === 0) {
        showMessage('No GGUF files found in this repository.', 'error');
        return;
      }

      await showQuantizationSelector(repo);
    } catch (err) {
      loadingBox.destroy();
      showMessage(`Error: ${(err as Error).message}`, 'error');
    }
  }

  async function showQuantizationSelector(repo: HFRepo): Promise<void> {
    const systemInfo = getSystemInfo();
    const quantizations = getAvailableQuantizations(repo);
    
    if (quantizations.length === 0) {
      showMessage('No quantizations found.', 'error');
      return;
    }

    const estimates = analyzeQuantizations(repo, quantizations, systemInfo);
    
    // 多选状态：记录选中的量化
    const selectedQuants = new Set<number>();
    // 默认选中推荐的量化
    const recommendedIdx = estimates.findIndex(e => e.recommended);
    if (recommendedIdx >= 0) {
      selectedQuants.add(recommendedIdx);
    }

    function renderQuantItems(): string[] {
      return estimates.map((est, i) => {
        const checked = selectedQuants.has(i) ? `{#87d787-fg}[✓]{/}` : `{#585858-fg}[ ]{/}`;
        const sizeStr = formatSize(est.modelSize).padEnd(10);
        let status = '';
        let prefix = '  ';
        
        if (est.recommended) {
          status = `{#87d787-fg}✓ Recommended{/}`;
          prefix = '{bold}► {/bold}';
        } else if (est.fits) {
          status = `{#87d787-fg}✓ OK{/}`;
        } else if (est.warning) {
          status = `{#d7af5f-fg}⚠ ${est.warning}{/}`;
        }
        
        return `${checked} ${prefix}{#ffffff-fg}${est.quantization.padEnd(10)}{/} {#5fafff-fg}~${sizeStr}{/} ${status}`;
      });
    }

    const overlayHeight = Math.min(estimates.length + 7, 22);
    const overlay = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: 75,
      height: overlayHeight,
      label: ` Select Quantization(s) - ${repo.modelId} `,
      tags: true,
      border: { type: 'line' },
      style: {
        fg: overlayStyle.fg,
        bg: overlayStyle.bg,
        border: overlayStyle.border,
      },
    });

    const infoBox = blessed.box({
      parent: overlay,
      top: 0,
      left: 1,
      right: 1,
      height: 3,
      tags: true,
      content: `{#87d787-fg}System:{/} ${systemInfo.gpus && systemInfo.gpus.length > 0 ? `${systemInfo.gpus.length} GPU(s)` : (systemInfo.gpuName || 'No GPU')} | VRAM: ${systemInfo.totalVRAM ? formatSize(systemInfo.totalVRAM) : 'N/A'}\n` +
        `{#87d787-fg}Model:{/} ${repo.parameterSize || 'Unknown'} params${repo.isMoE ? ` (MoE, ${repo.activeParams}B active)` : ''}`,
      style: { fg: overlayStyle.fg, bg: overlayStyle.bg },
    });

    const listHeight = overlayHeight - 6;
    const selectBox = blessed.list({
      parent: overlay,
      top: 3,
      left: 1,
      right: 1,
      height: Math.max(3, listHeight),
      tags: true,
      style: {
        fg: overlayStyle.fg,
        bg: overlayStyle.bg,
        selected: overlayStyle.selected,
      },
      keys: true,
      vi: true,
      mouse: true,
      items: renderQuantItems(),
    });

    const helpBox = blessed.box({
      parent: overlay,
      bottom: 0,
      left: 1,
      right: 1,
      height: 2,
      tags: true,
      content: `{#585858-fg}[Space] Toggle | [Enter] Continue | [Esc] Cancel{/}`,
      style: { fg: overlayStyle.fg, bg: overlayStyle.bg },
    });

    // 默认选中推荐项
    selectBox.select(recommendedIdx >= 0 ? recommendedIdx : 0);
    selectBox.focus();
    screen.render();

    selectBox.key(['space'], () => {
      const idx = (selectBox as any).selected;
      if (idx >= 0 && idx < estimates.length) {
        if (selectedQuants.has(idx)) {
          selectedQuants.delete(idx);
        } else {
          selectedQuants.add(idx);
        }
        const currentSelection = (selectBox as any).selected;
        selectBox.setItems(renderQuantItems());
        selectBox.select(currentSelection);
        screen.render();
      }
    });

    selectBox.key(['enter'], async () => {
      if (selectedQuants.size === 0) {
        showMessage('Please select at least one quantization.', 'error');
        return;
      }

      overlay.destroy();
      const selectedEstimates = Array.from(selectedQuants).map(i => estimates[i]);
      await showFileSelector(repo, selectedEstimates, systemInfo);
    });

    selectBox.key(['escape'], () => {
      overlay.destroy();
      screen.render();
    });
  }

  async function showFileSelector(
    repo: HFRepo, 
    estimates: QuantizationEstimate[],
    systemInfo: SystemInfo
  ): Promise<void> {
    // 收集所有选中量化的文件
    const allFiles: { file: HFFile; quant: string }[] = [];
    
    for (const est of estimates) {
      const { mainFiles, visionFiles } = getFilesForQuantization(repo, est.quantization);
      mainFiles.forEach(f => allFiles.push({ file: f, quant: est.quantization }));
      visionFiles.forEach(f => {
        // 避免重复添加相同的视觉文件
        if (!allFiles.some(af => af.file.filename === f.filename)) {
          allFiles.push({ file: f, quant: est.quantization });
        }
      });
    }
    
    const selectedFiles = new Set<number>();
    
    // 自动选中所有文件
    allFiles.forEach((_, i) => selectedFiles.add(i));

    function renderFileItems(): string[] {
      return allFiles.map(({ file, quant }, i) => {
        const checked = selectedFiles.has(i) ? `{#87d787-fg}[✓]{/}` : `{#585858-fg}[ ]{/}`;
        const type = file.isVision ? `{#5fafff-fg}[Vision]{/}` : `{#585858-fg}[${quant}]{/}`;
        const size = formatSize(file.size);
        return `${checked} {#ffffff-fg}${file.filename}{/} {#5fafff-fg}(${size}){/} ${type}`;
      });
    }

    const overlayHeight = Math.min(allFiles.length + 7, 26);
    const overlay = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: 85,
      height: overlayHeight,
      label: ` Select Files to Download `,
      tags: true,
      border: { type: 'line' },
      style: {
        fg: overlayStyle.fg,
        bg: overlayStyle.bg,
        border: overlayStyle.border,
      },
    });

    const infoBox = blessed.box({
      parent: overlay,
      top: 0,
      left: 1,
      right: 1,
      height: 2,
      tags: true,
      content: `{#87d787-fg}Quantizations:{/} ${estimates.map(e => e.quantization).join(', ')}`,
      style: { fg: overlayStyle.fg, bg: overlayStyle.bg },
    });

    const listHeight = overlayHeight - 5;
    const fileList = blessed.list({
      parent: overlay,
      top: 2,
      left: 1,
      right: 1,
      height: Math.max(3, listHeight),
      tags: true,
      style: {
        fg: overlayStyle.fg,
        bg: overlayStyle.bg,
        selected: overlayStyle.selected,
      },
      keys: true,
      vi: true,
      mouse: true,
      items: renderFileItems(),
    });

    const helpBox = blessed.box({
      parent: overlay,
      bottom: 0,
      left: 1,
      right: 1,
      height: 2,
      tags: true,
      content: `{#585858-fg}[Space] Toggle | [Enter] Download | [Esc] Back{/}`,
      style: { fg: overlayStyle.fg, bg: overlayStyle.bg },
    });

    fileList.select(0);
    fileList.focus();
    screen.render();

    fileList.key(['space'], () => {
      const idx = (fileList as any).selected;
      if (idx >= 0 && idx < allFiles.length) {
        if (selectedFiles.has(idx)) {
          selectedFiles.delete(idx);
        } else {
          selectedFiles.add(idx);
        }
        const currentSelection = (fileList as any).selected;
        fileList.setItems(renderFileItems());
        fileList.select(currentSelection);
        screen.render();
      }
    });

    fileList.key(['enter'], async () => {
      if (selectedFiles.size === 0) {
        showMessage('Please select at least one file.', 'error');
        return;
      }

      const filesToDownload = Array.from(selectedFiles).map(i => allFiles[i].file);
      overlay.destroy();
      await startDownloadProcess(repo, filesToDownload, estimates, systemInfo);
    });

    fileList.key(['escape'], () => {
      overlay.destroy();
      showQuantizationSelector(repo);
    });
  }

  async function startDownloadProcess(
    repo: HFRepo,
    files: HFFile[],
    estimates: QuantizationEstimate[],
    systemInfo: SystemInfo,
    managerOverride?: DownloadManager
  ): Promise<void> {
    const config = getExpandedConfig();
    const modelDir = getModelDir(config.modelsDir, repo.modelId);
    
    // 计算总大小
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    
    // 检查磁盘空间
    const spaceCheck = await checkDiskSpace(modelDir, totalSize);
    if (!spaceCheck.ok) {
      showMessage(`Not enough disk space. Need ${formatSize(totalSize)}, available ${formatSize(spaceCheck.available)}`, 'error');
      return;
    }

    // 使用 Download Manager 显示进度
    const manager = managerOverride || new DownloadManager({ maxConcurrent: 3 });

    if (!managerOverride) {
      // 添加下载任务
      for (const file of files) {
        const destPath = getModelStoragePath(config.modelsDir, repo.modelId, file.filename);
        manager.addTask({
          url: getDownloadUrl(repo.modelId, file.filename),
          destPath,
          filename: file.filename,
          expectedSize: file.size,
          expectedSha256: file.sha256,
          meta: {
            url: getDownloadUrl(repo.modelId, file.filename),
            modelId: repo.modelId,
            filename: file.filename,
            expectedSize: file.size,
            expectedSha256: file.sha256,
            quantization: file.quantization,
            isVision: file.isVision,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        });
      }
    }

    // 初始化活动下载快照
    const tasks = manager.getTasks();
    activeDownloadSnapshot.clear();
    downloadManagerListKeys = [];
    for (const task of tasks) {
      if (!task.meta) continue;
      const key = buildDownloadKey(task.meta.modelId, task.filename);
      activeDownloadSnapshot.set(key, {
        key,
        meta: task.meta,
        downloadedBytes: task.downloadedBytes,
        status: task.status,
      });
      downloadManagerListKeys.push(key);
    }

    // 设置为全局活动下载
    setActiveDownloadManager(manager);
    openDownloadManager(true);

    // 开始下载
    try {
      await manager.start();

      // 下载完成，开始校验
      const completedTasks = manager.getTasks().filter(t => t.status === 'completed');
      
      let verifyContent = '';
      let allValid = true;
      
      for (const task of completedTasks) {
        if (task.expectedSha256) {
          verifyContent += `{#ffffff-fg}Verifying ${task.filename}...{/}\n`;
          showMessage(verifyContent.trim(), 'info');
          
          const result = await verifySha256(task.destPath, task.expectedSha256, (p) => {
            const bar = createDownloadBar(p.percent, 30);
            showMessage(`${task.filename} ${p.percent}% [${bar}]`, 'info');
          });
          
          if (result.valid) {
            verifyContent += `  {#87d787-fg}✓ OK{/}\n`;
          } else {
            verifyContent += `  {#d75f5f-fg}✗ Hash mismatch!{/}\n`;
            allValid = false;
          }
        } else {
          verifyContent += `{#ffffff-fg}${task.filename}:{/} {#d7af5f-fg}No hash available, skipping verification{/}\n`;
        }
      }

      if (!allValid) {
        await delay(2000);
        showMessage('Some files failed verification. Please re-download.', 'error');
        setActiveDownloadManager(null);
        return;
      }

      // 为每个量化版本生成预设
      const presetNames: string[] = [];
      const selectedQuants = new Set<string>(files.map(f => f.quantization).filter(Boolean) as string[]);

      if (estimates.length === 0) {
        // 续传场景：根据文件名推断量化
        for (const quant of selectedQuants) {
          const mainFile = files.find(f => f.isMainModel && f.quantization === quant);
          const visionFile = files.find(f => f.isVision);
          if (!mainFile) continue;
          const mainPath = getModelStoragePath(config.modelsDir, repo.modelId, mainFile.filename);
          const visionPath = visionFile ? getModelStoragePath(config.modelsDir, repo.modelId, visionFile.filename) : undefined;

          const fakeEstimate: QuantizationEstimate = {
            quantization: quant,
            modelSize: 0,
            kvCacheSize: 0,
            visionSize: 0,
            totalVRAM: 0,
            maxContext: 32768,
            fits: true,
            recommended: false,
            bitsPerWeight: 0,
          };

          const preset = generateAndSavePreset({
            repo,
            mainModelPath: mainPath,
            visionModelPath: visionPath,
            quantization: quant,
            estimate: fakeEstimate,
            systemInfo,
          });
          presetNames.push(preset.name);
        }
      } else {
        for (const estimate of estimates) {
          if (!selectedQuants.has(estimate.quantization)) continue;
          const mainFile = files.find(f => f.isMainModel && f.quantization === estimate.quantization);
          const visionFile = files.find(f => f.isVision);
          
          if (mainFile) {
            const mainPath = getModelStoragePath(config.modelsDir, repo.modelId, mainFile.filename);
            const visionPath = visionFile 
              ? getModelStoragePath(config.modelsDir, repo.modelId, visionFile.filename) 
              : undefined;
            
            const preset = generateAndSavePreset({
              repo,
              mainModelPath: mainPath,
              visionModelPath: visionPath,
              quantization: estimate.quantization,
              estimate,
              systemInfo,
            });
            
            presetNames.push(preset.name);
          }
        }
      }
      
      // 下载完成，清除活动状态
      setActiveDownloadManager(null);

      // 显示完成消息，不询问启动
      showDownloadComplete(presetNames);
      
    } catch (err) {
      setActiveDownloadManager(null);
      showMessage(`Download failed: ${(err as Error).message}`, 'error');
    }
  }

  function showDownloadComplete(presetNameList: string[]): void {
    const dialog = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: 60,
      height: Math.min(presetNameList.length + 8, 15),
      label: ' Download Complete ',
      tags: true,
      border: { type: 'line' },
      style: {
        fg: overlayStyle.fg,
        bg: overlayStyle.bg,
        border: { fg: theme.success },
      },
      padding: { left: 2, right: 2, top: 1 },
    });

    let content = `{bold}{#87d787-fg}Download completed successfully!{/}{/bold}\n\n`;
    content += `{#ffffff-fg}Created preset(s):{/}\n`;
    presetNameList.forEach(name => {
      content += `  {#5fafff-fg}• ${name}{/}\n`;
    });
    content += `\n{#585858-fg}[Enter] Close{/}`;

    dialog.setContent(content);
    screen.render();

    const onKeyPress = (ch: string, key: any) => {
      if (key && (key.name === 'enter' || key.name === 'escape')) {
        screen.removeListener('keypress', onKeyPress);
        dialog.destroy();
        
        loadPresetsList();
        loadModels();
        showMessage(`Preset(s) ready: ${presetNameList.join(', ')}`, 'success');
        screen.render();
      }
    };

    screen.on('keypress', onKeyPress);
  }

  function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function createDownloadBar(percent: number, width: number): string {
    const filled = Math.round((percent / 100) * width);
    const empty = width - filled;
    return `{#87d787-fg}${'█'.repeat(filled)}{/}{#585858-fg}${'░'.repeat(empty)}{/}`;
  }

  function getChatTemplateOptions(modelDir: string, globalTemplatesDir: string): string[] {
    const options = [''];
    try {
      const entries = readdirSync(modelDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.jinja')) continue;
        if (!entry.name.includes('chat-template')) continue;
        options.push(entry.name);
      }
    } catch {
      // ignore
    }
    try {
      const entries = readdirSync(globalTemplatesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.jinja')) continue;
        options.push(`templates/${entry.name}`);
      }
    } catch {
      // ignore
    }
    return options.length > 0 ? options : [''];
  }

  function buildDownloadKey(modelId: string, filename: string): string {
    return `${modelId}|${filename}`;
  }

  function updateDownloadManagerList(): void {
    if (!downloadManagerList || !downloadManagerInfo) return;
    const items: string[] = [];
    const keys = downloadManagerListKeys;
    for (const key of keys) {
      const entry = activeDownloadSnapshot.get(key);
      if (!entry) continue;
      const checked = downloadManagerSelectedKeys.has(key) ? `{#87d787-fg}[✓]{/}` : `{#585858-fg}[ ]{/}`;
      const meta = entry.meta;
      const total = meta.expectedSize || 0;
      const downloaded = entry.downloadedBytes || 0;
      const percent = total > 0 ? Math.round((downloaded / total) * 100) : 0;
      const bar = createDownloadBar(percent, 20);
      const statusLabel = entry.status === 'paused'
        ? `{#d7af5f-fg}Paused{/}`
        : entry.status === 'failed'
        ? `{#d75f5f-fg}Failed{/}`
        : entry.status === 'completed'
        ? `{#87d787-fg}Done{/}`
        : `{#5fafff-fg}Running{/}`;

      items.push(`${checked} {#ffffff-fg}${meta.modelId}{/} {#585858-fg}${meta.filename}{/} ${statusLabel}`);
      items.push(`  [${bar}] {#5fafff-fg}${formatSize(downloaded)} / ${formatSize(total)} ({percent}%) {/}`.replace('{percent}', String(percent)));
    }

    if (items.length === 0) {
      items.push('{#87d787-fg}No active downloads.{/}');
    }

    downloadManagerList.setItems(items);
    if (downloadManagerInfo) {
      const status = activeDownloadPaused ? 'Paused' : activeDownloadManager ? 'Running' : 'Idle';
      const count = activeDownloadSnapshot.size;
      downloadManagerInfo.setContent(`{#87d787-fg}Downloads:{/} ${count}  {#5fafff-fg}${status}{/}`);
    }
    screen.render();
  }

  function setActiveDownloadManager(manager: DownloadManager | null): void {
    activeDownloadManager = manager;
    activeDownloadPaused = false;
    activeDownloadSnapshot.clear();
    downloadManagerSelectedKeys.clear();
    downloadManagerListKeys = [];
    activeDownloadTaskIds.clear();

    if (!manager) {
      updateDownloadManagerList();
      return;
    }

    const tasks = manager.getTasks();
    for (const task of tasks) {
      if (!task.meta) continue;
      const key = buildDownloadKey(task.meta.modelId, task.filename);
      activeDownloadSnapshot.set(key, {
        key,
        meta: task.meta,
        downloadedBytes: task.downloadedBytes,
        status: task.status,
      });
      downloadManagerListKeys.push(key);
      activeDownloadTaskIds.set(key, task.id);
    }

    manager.on('progress', (progress) => {
      for (const task of progress.tasks) {
        if (!task.meta) continue;
        const key = buildDownloadKey(task.meta.modelId, task.filename);
        const entry = activeDownloadSnapshot.get(key);
        if (entry) {
          entry.downloadedBytes = task.downloadedBytes;
          entry.status = task.status;
        }
        activeDownloadTaskIds.set(key, task.id);
      }
      updateDownloadManagerList();
      updateStatus();
    });

    updateDownloadManagerList();
  }

  function openDownloadManager(forceFocus: boolean = false): void {
    if (downloadManagerVisible && downloadManagerOverlay) {
      if (forceFocus && downloadManagerList) downloadManagerList.focus();
      return;
    }

    if (!activeDownloadManager) {
      const config = getExpandedConfig();
      const incomplete = scanIncompleteDownloads(config.modelsDir);
      activeDownloadSnapshot.clear();
      downloadManagerListKeys = [];
      activeDownloadTaskIds.clear();
      for (const item of incomplete) {
        const key = buildDownloadKey(item.meta.modelId, item.meta.filename);
        activeDownloadSnapshot.set(key, {
          key,
          meta: item.meta,
          downloadedBytes: item.downloadedBytes,
          status: 'pending',
        });
        downloadManagerListKeys.push(key);
      }
    }

    downloadManagerVisible = true;
    const overlayHeight = 18;
    downloadManagerOverlay = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: 90,
      height: overlayHeight,
      label: ' Download Manager ',
      tags: true,
      border: { type: 'line' },
      style: {
        fg: overlayStyle.fg,
        bg: overlayStyle.bg,
        border: overlayStyle.border,
      },
    });

    downloadManagerInfo = blessed.box({
      parent: downloadManagerOverlay,
      top: 0,
      left: 1,
      right: 1,
      height: 1,
      tags: true,
      content: '{#87d787-fg}Downloads:{/} 0  {#5fafff-fg}Idle{/}',
      style: { fg: overlayStyle.fg, bg: overlayStyle.bg },
    });

    downloadManagerList = blessed.list({
      parent: downloadManagerOverlay,
      top: 1,
      left: 1,
      right: 1,
      height: overlayHeight - 4,
      tags: true,
      style: {
        fg: overlayStyle.fg,
        bg: overlayStyle.bg,
        selected: overlayStyle.selected,
      },
      keys: true,
      vi: true,
      mouse: true,
      items: [],
    });

    downloadManagerHelp = blessed.box({
      parent: downloadManagerOverlay,
      bottom: 0,
      left: 1,
      right: 1,
      height: 2,
      tags: true,
      content: '{#585858-fg}[Space] Select | [A] All | [P] Pause | [H] Hide | [D] Delete | [Esc] Back{/}',
      style: { fg: overlayStyle.fg, bg: overlayStyle.bg },
    });

    updateDownloadManagerList();
    downloadManagerList.select(0);
    downloadManagerList.focus();

    downloadManagerList.key(['space'], () => {
      const idx = (downloadManagerList as any).selected;
      const keyIndex = Math.floor(idx / 2);
      const key = downloadManagerListKeys[keyIndex];
      if (!key) return;
      if (downloadManagerSelectedKeys.has(key)) {
        downloadManagerSelectedKeys.delete(key);
      } else {
        downloadManagerSelectedKeys.add(key);
      }
      updateDownloadManagerList();
    });

    downloadManagerList.key(['a'], () => {
      if (downloadManagerSelectedKeys.size === downloadManagerListKeys.length) {
        downloadManagerSelectedKeys.clear();
      } else {
        downloadManagerSelectedKeys = new Set(downloadManagerListKeys);
      }
      updateDownloadManagerList();
    });

    downloadManagerList.key(['p'], () => {
      if (!activeDownloadManager) return;
      if (activeDownloadPaused) {
        activeDownloadPaused = false;
        activeDownloadManager.resume();
      } else {
        activeDownloadPaused = true;
        activeDownloadManager.pause();
      }
      updateDownloadManagerList();
    });

    downloadManagerList.key(['d'], async () => {
      if (downloadManagerSelectedKeys.size === 0) {
        showMessage('Select at least one download to delete.', 'error');
        return;
      }
      const confirm = await confirmDeleteDownloads(downloadManagerSelectedKeys.size);
      if (!confirm) return;

      const config = getExpandedConfig();
      if (activeDownloadManager) {
        const taskIds: string[] = [];
        for (const key of Array.from(downloadManagerSelectedKeys)) {
          const id = activeDownloadTaskIds.get(key);
          if (id) taskIds.push(id);
        }
        if (taskIds.length > 0) {
          activeDownloadManager.cancelTasks(taskIds);
        }
      }
      for (const key of Array.from(downloadManagerSelectedKeys)) {
        const entry = activeDownloadSnapshot.get(key);
        if (!entry) continue;
        const metaPath = getModelStoragePath(config.modelsDir, entry.meta.modelId, entry.meta.filename) + '.meta.json';
        const partialPath = getModelStoragePath(config.modelsDir, entry.meta.modelId, entry.meta.filename) + '.partial';
        deletePartialFile(partialPath);
        deleteDownloadMeta(metaPath);
        cleanupEmptyDirs(config.modelsDir, partialPath);
        activeDownloadSnapshot.delete(key);
        activeDownloadTaskIds.delete(key);
      }
      downloadManagerSelectedKeys.clear();
      downloadManagerListKeys = Array.from(activeDownloadSnapshot.keys());
      updateDownloadManagerList();
    });

    downloadManagerList.key(['r', 'enter'], async () => {
      if (activeDownloadManager) {
        showMessage('Download already running.', 'info');
        return;
      }

      const config = getExpandedConfig();
      const incomplete = scanIncompleteDownloads(config.modelsDir);
      const selectedMeta = Array.from(downloadManagerSelectedKeys);
      if (selectedMeta.length === 0) {
        showMessage('Select at least one download to resume.', 'error');
        return;
      }

      const items = incomplete.filter(item => selectedMeta.includes(buildDownloadKey(item.meta.modelId, item.meta.filename)));
      if (items.length === 0) {
        showMessage('Selected downloads are not available.', 'error');
        return;
      }

      const manager = new DownloadManager({ maxConcurrent: 3 });
      for (const item of items) {
        manager.addTask({
          url: item.meta.url,
          destPath: item.partialPath.replace(/\.partial$/, ''),
          filename: item.meta.filename,
          expectedSize: item.meta.expectedSize,
          expectedSha256: item.meta.expectedSha256,
          meta: item.meta,
        });
      }

      setActiveDownloadManager(manager);
      openDownloadManager(true);

      const fakeRepo: HFRepo = {
        modelId: items[0].meta.modelId,
        files: [],
      };
      const files: HFFile[] = items.map(i => ({
        filename: i.meta.filename,
        size: i.meta.expectedSize,
        sha256: i.meta.expectedSha256,
        isVision: i.meta.isVision,
        isMainModel: !i.meta.isVision,
        quantization: i.meta.quantization,
      }));
      const systemInfo = getSystemInfo();
      const fakeEstimates: QuantizationEstimate[] = [];

      await startDownloadProcess(fakeRepo, files, fakeEstimates, systemInfo, manager);
    });

    downloadManagerList.key(['h'], () => {
      hideDownloadManager();
    });

    downloadManagerList.key(['escape'], () => {
      hideDownloadManager();
    });

    screen.render();
  }

  function hideDownloadManager(): void {
    if (!downloadManagerOverlay) return;
    downloadManagerOverlay.destroy();
    downloadManagerOverlay = null;
    downloadManagerList = null;
    downloadManagerInfo = null;
    downloadManagerHelp = null;
    downloadManagerVisible = false;
    screen.render();
  }

  async function showDownloadManager(): Promise<void> {
    openDownloadManager(true);
  }

  async function confirmDeleteDownloads(count: number): Promise<boolean> {
    return new Promise((resolve) => {
      const dialog = blessed.box({
        parent: screen,
        top: 'center',
        left: 'center',
        width: 60,
        height: 8,
        label: ' Confirm Delete ',
        tags: true,
        border: { type: 'line' },
        style: {
          fg: overlayStyle.fg,
          bg: overlayStyle.bg,
          border: { fg: theme.warning },
        },
        padding: { left: 2, right: 2, top: 1 },
      });

      dialog.setContent(
        `{#d7af5f-fg}Delete ${count} incomplete download(s)?{/}\n\n` +
        `{#585858-fg}This will remove .partial and metadata files.{/}\n\n` +
        `{#87d787-fg}[Y]{/} Yes  {#d75f5f-fg}[N]{/} No`
      );

      screen.render();

      const onKeyPress = (ch: string, key: any) => {
        if (key && (key.name === 'y' || key.name === 'n' || key.name === 'escape')) {
          screen.removeListener('keypress', onKeyPress);
          dialog.destroy();
          resolve(key.name === 'y');
          screen.render();
        }
      };

      screen.on('keypress', onKeyPress);
    });
  }

  // resumeDownloads removed - resume is handled inline in Download Manager

  // ========== 结束模型下载功能 ==========

  // 退出确认对话框
  async function handleExit(): Promise<void> {
    const status = getServerStatus();
    
    if (status.running || proxyServer) {
      // 创建确认对话框
      const dialog = blessed.box({
        parent: screen,
        top: 'center',
        left: 'center',
        width: 50,
        height: 9,
        label: ' Exit ',
        tags: true,
        border: { type: 'line' },
        style: {
          fg: theme.text,
          bg: '#1c1c1c',
          border: { fg: theme.warning },
        },
        padding: { left: 2, right: 2, top: 1 },
      });

      dialog.setContent(
        `{bold}Server is still running!{/bold}\n\n` +
        `{${theme.secondary}-fg}[Y]{/} Stop server and exit\n` +
        `{${theme.secondary}-fg}[N]{/} Exit without stopping\n` +
        `{${theme.secondary}-fg}[Esc]{/} Cancel`
      );

      screen.render();

      // 使用 once 方式监听按键
      const onKeyPress = async (ch: string, key: any) => {
        if (key.name === 'y' || key.name === 'n' || key.name === 'escape') {
          screen.removeListener('keypress', onKeyPress);
          dialog.destroy();
          
          if (key.name === 'y') {
            showMessage('Stopping server before exit...', 'info');
            stopProxy();
            try {
              await stopServer();
            } catch {}
            cleanup();
            process.exit(0);
          } else if (key.name === 'n') {
            cleanup();
            process.exit(0);
          }
          // Escape - just close dialog and return to menu
          screen.render();
        }
      };

      screen.on('keypress', onKeyPress);
    } else {
      cleanup();
      process.exit(0);
    }
  }

  // 清理残留进程（启动时调用）
  function cleanupOrphanProcesses(): void {
    try {
      // 检查 8080 和 8081 端口是否被占用
      const output = execSync('lsof -i :8080 -i :8081 -t 2>/dev/null || true', { encoding: 'utf-8' });
      const pids = output.trim().split('\n').filter(p => p);
      
      if (pids.length > 0) {
        showMessage(`Found ${pids.length} orphan process(es) on ports 8080/8081, cleaning up...`, 'info');
        for (const pid of pids) {
          try {
            process.kill(parseInt(pid), 'SIGTERM');
          } catch {}
        }
        // 等待进程终止
        execSync('sleep 1');
        showMessage('Orphan processes cleaned up.', 'success');
      }
    } catch {}
  }

  function startLogWatcher(): void {
    if (logInterval) return;
    logInterval = setInterval(updateLogs, 2000);
    updateLogs();
  }

  function stopLogWatcher(): void {
    if (logInterval) {
      clearInterval(logInterval);
      logInterval = null;
    }
  }

  function startResourceWatcher(): void {
    if (resourceInterval) return;
    resourceInterval = setInterval(updateResources, 2000);
    updateResources();
  }

  function stopResourceWatcher(): void {
    if (resourceInterval) {
      clearInterval(resourceInterval);
      resourceInterval = null;
    }
  }

  // 代理相关函数
  function startProxy(publicPort: number, internalPort: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (proxyServer) {
        proxyServer.close();
        proxyServer = null;
      }

      proxyServer = createRequestLogger({
        listenPort: publicPort,
        targetPort: internalPort,
        targetHost: '127.0.0.1',
        showBody: true,
        showResponse: false,
        onLog: (message, type) => {
          // 分行输出，每行单独 log 到请求日志窗口
          const lines = message.split('\n');
          for (const line of lines) {
            if (line.trim()) {
              // 根据类型添加颜色 - 使用更柔和的配色
              let coloredLine = line;
              if (type === 'request') {
                coloredLine = `{#5fafff-fg}${line}{/}`;  // 亮蓝色
              } else if (type === 'response') {
                coloredLine = `{#87d787-fg}${line}{/}`;  // 柔和绿
              } else if (type === 'error') {
                coloredLine = `{#d75f5f-fg}${line}{/}`;  // 柔和红
              }
              requestLogBox.log(coloredLine);
            }
          }
          screen.render();
        },
      });

      proxyServer.on('error', (err) => {
        showMessage(`Proxy error: ${err.message}`, 'error');
        reject(err);
      });

      proxyServer.listen(publicPort, '0.0.0.0', () => {
        resolve();
      });
    });
  }

  function stopProxy(): void {
    if (proxyServer) {
      proxyServer.close();
      proxyServer = null;
    }
  }

  // === 事件处理 ===

  menuBox.on('select', async (item, index) => {
    switch (index) {
      case 0: // Start
        await handleStartServer();
        break;
      case 1: // Stop
        await handleStopServer();
        break;
      case 2: // Restart
        await handleRestartServer();
        break;
      case 3: // Eject Model
        await handleEjectModel();
        break;
      case 4: // Select Model
        showModelList();
        break;
      case 5: // Download Model
        await showDownloadModel();
        break;
      case 6: // Download Manager
        await showDownloadManager();
        break;
      case 7: // Load Preset
        showPresetList();
        break;
      case 8: // Edit Preset
        showEditPresetList();
        break;
      case 9: // Settings
        showMessage('Settings: Use "lsc config" command to configure.', 'info');
        break;
      case 10: // Exit
        await handleExit();
        break;
    }
  });

  modelList.on('select', (item, index) => {
    if (index >= 0 && index < models.length) {
      currentModel = models[index];
      showMessage(`Selected: ${currentModel.name}`, 'success');
      hideSubLists();
    }
  });

  presetList.on('select', async (item, index) => {
    if (presetEditMode) {
      // 编辑模式：打开编辑器
      if (index >= 0 && index < presetNames.length) {
        exitEditMode();
        await showPresetEditor(presetNames[index]);
      }
    } else {
      // 加载模式：加载预设
      await handleLoadPreset(index);
    }
  });

  // 键盘快捷键
  screen.key(['escape'], () => {
    if (!modelList.hidden || !presetList.hidden) {
      hideSubLists();
    }
  });

  screen.key(['q', 'C-c'], async () => {
    await handleExit();
  });

  screen.key(['r'], () => {
    updateStatus();
    updateInfo();
    updateLogs();
    showMessage('Refreshed.', 'info');
  });

  screen.key(['s'], () => {
    if (downloadManagerVisible) {
      if (downloadManagerList) downloadManagerList.focus();
    } else if (activeDownloadManager) {
      openDownloadManager(true);
    }
  });

  let focusedElement: 'menu' | 'model' | 'preset' | 'serverLog' | 'requestLog' = 'menu';
  
  // 更新焦点边框高亮
  function updateFocusBorder(): void {
    // 重置所有边框
    menuBox.style.border = { fg: theme.border };
    serverLogBox.style.border = { fg: theme.border };
    requestLogBox.style.border = { fg: theme.secondary };
    
    // 高亮当前焦点
    switch (focusedElement) {
      case 'menu':
        menuBox.style.border = { fg: theme.primary };
        break;
      case 'serverLog':
        serverLogBox.style.border = { fg: theme.primary };
        break;
      case 'requestLog':
        requestLogBox.style.border = { fg: theme.primary };
        break;
    }
    screen.render();
  }
  
  screen.key(['tab'], () => {
    if (focusedElement === 'model' && !modelList.hidden) {
      focusedElement = 'menu';
      menuBox.focus();
    } else if (focusedElement === 'preset' && !presetList.hidden) {
      focusedElement = 'menu';
      menuBox.focus();
    } else if (focusedElement === 'menu') {
      focusedElement = 'serverLog';
      serverLogBox.focus();
    } else if (focusedElement === 'serverLog') {
      focusedElement = 'requestLog';
      requestLogBox.focus();
    } else {
      focusedElement = 'menu';
      menuBox.focus();
    }
    updateFocusBorder();
  });
  
  modelList.on('focus', () => { focusedElement = 'model'; updateFocusBorder(); });
  presetList.on('focus', () => { focusedElement = 'preset'; updateFocusBorder(); });
  menuBox.on('focus', () => { focusedElement = 'menu'; updateFocusBorder(); });
  serverLogBox.on('focus', () => { focusedElement = 'serverLog'; updateFocusBorder(); });
  requestLogBox.on('focus', () => { focusedElement = 'requestLog'; updateFocusBorder(); });

  // === 初始化 ===

  function cleanup(): void {
    stopLogWatcher();
    stopResourceWatcher();
    stopProxy();
  }

  async function init(): Promise<void> {
    loadModels();
    loadPresetsList();
    
    // 检查是否有残留进程
    const status = getServerStatus();
    
    // 检查端口占用情况
    let portsInUse = false;
    try {
      const output = execSync('lsof -i :8080 -i :8081 -t 2>/dev/null || true', { encoding: 'utf-8' });
      portsInUse = output.trim().length > 0;
    } catch {}
    
    // 如果有 PID 文件记录的服务器在运行
    if (status.running && status.port) {
      currentInternalPort = status.port;
      currentPublicPort = status.port - 1;
      
      if (status.port % 10 === 0) {
        currentPublicPort = status.port;
        currentInternalPort = status.port + 1;
        showMessage(`Note: Server running on port ${status.port} without proxy.`, 'info');
        showMessage(`Restart via TUI to enable request logging.`, 'info');
      } else {
        try {
          await startProxy(currentPublicPort, currentInternalPort);
          showMessage(`Proxy reconnected on port ${currentPublicPort}`, 'success');
        } catch {
          showMessage(`Could not start proxy on port ${currentPublicPort}`, 'error');
        }
      }
      
      startLogWatcher();
      startResourceWatcher();
    } else if (portsInUse && !status.running) {
      // 端口被占用但没有 PID 文件 - 可能是残留进程
      showMessage('Detected orphan processes on ports 8080/8081', 'info');
      cleanupOrphanProcesses();
    }

    updateStatus();
    updateInfo();
    updateResources();
    menuBox.focus();
    screen.render();
  }

  init();
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

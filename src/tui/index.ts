import blessed from 'blessed';
import http from 'http';

// --- Monkey patch for rounded borders ---
const blessedElement = (blessed as any).widget.Element;
const originalRender = blessedElement.prototype.render;
blessedElement.prototype.render = function(this: any) {
  const ret = originalRender.apply(this, arguments);
  if (this.border && this.border.type === 'line' && this.lpos) {
    const coords = this.lpos;
    const lines = this.screen.lines;
    if (coords.yi >= 0 && coords.yi < lines.length && 
        coords.yl > 0 && coords.yl <= lines.length) {
      const yi = coords.yi, yl = coords.yl - 1;
      const xi = coords.xi, xl = coords.xl - 1;
      if (lines[yi] && lines[yi][xi] && lines[yi][xi][1] === '\u250c') {
        lines[yi][xi][1] = '\u256d'; lines[yi].dirty = true; // ╭
      }
      if (lines[yi] && lines[yi][xl] && lines[yi][xl][1] === '\u2510') {
        lines[yi][xl][1] = '\u256e'; lines[yi].dirty = true; // ╮
      }
      if (lines[yl] && lines[yl][xi] && lines[yl][xi][1] === '\u2514') {
        lines[yl][xi][1] = '\u2570'; lines[yl].dirty = true; // ╰
      }
      if (lines[yl] && lines[yl][xl] && lines[yl][xl][1] === '\u2518') {
        lines[yl][xl][1] = '\u256f'; lines[yl].dirty = true; // ╯
      }
    }
  }
  return ret;
};
blessedElement.prototype._render = blessedElement.prototype.render;
// --- End monkey patch ---

import { existsSync, readdirSync, writeFileSync } from 'fs';
import { rm } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { execSync, execFile } from 'child_process';
import { promisify } from 'util';
import { ModelInfo, Preset, ServerOptions } from '../types.js';
import { getGpuInfo, getRamInfo, warmSystemInfoCache, getCachedGpuCount, getLanIPv4 } from './system-info.js';
import { scanModels, findModel, resolveSpecModel, findDraftModelFiles } from '../utils/model-scanner.js';
import { getServerStatus, startServer, stopServer, readLastLogs, getLogFile, isLlamaServerProcess, checkLlamaServerVersion, ctxAutoFitConflict, getDefaultSlotSavePath, MIN_LLAMA_SERVER_BUILD } from '../utils/process-manager.js';
import { loadPresets, getPreset, savePreset, deletePreset, presetExists, renamePreset } from '../utils/preset-manager.js';
import { getExpandedConfig, getConfigDir } from '../utils/config-manager.js';
import { resolveServerOptions } from '../utils/server-options.js';
import { createRequestLogger } from '../utils/request-logger.js';
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
  DownloadManagerLike, 
  DownloadProgress, 
  DownloadStatus,
  checkDiskSpace 
} from '../utils/downloader.js';
import { createDownloadManager } from '../utils/download-backend.js';
import { verifySha256 } from '../utils/verifier.js';
import { confirmDialog, isModalOpen, isEditingInput } from './dialogs.js';
import { createProgressBar } from './widgets.js';
import { formatUptime } from '../utils/format.js';
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
  cleanupEmptyDirs,
  inferModelIdFromPath,
} from '../utils/download-meta.js';

const execFileP = promisify(execFile);

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
  let logPaused = false;

  // 下载管理器状态
  interface DownloadEntry {
    key: string;
    meta: DownloadMeta;
    downloadedBytes: number;
    status: DownloadStatus;
    speed: number; // bytes/sec,来自 DownloadManager 的 EMA 平滑速度
  }

  let downloadManagerOverlay: blessed.Widgets.BoxElement | null = null;
  let downloadManagerList: blessed.Widgets.ListElement | null = null;
  let downloadManagerInfo: blessed.Widgets.BoxElement | null = null;
  let downloadManagerVisible = false;
  let downloadManagerListKeys: string[] = [];
  let downloadManagerSelectedKeys = new Set<string>();
  let activeDownloadManager: DownloadManagerLike | null = null;
  let activeDownloadProgressHandler: ((progress: DownloadProgress) => void) | null = null;
  let activeDownloadPaused = false;
  let activeDownloadSnapshot = new Map<string, DownloadEntry>();
  let activeDownloadTaskIds = new Map<string, string>();

  // 颜色主题 - 现代护眼风格 (Catppuccin Macchiato)
  const theme = {
    // 品牌色 & 强调色
    primary: '#cba6f7',    // Mauve (紫罗兰，原蓝紫)
    secondary: '#8caaee',  // Sapphire (蓝宝石，原亮蓝)
    
    // 状态色
    success: '#a6e3a1',    // Green (柔和绿)
    warning: '#f9e2af',    // Yellow (琥珀黄)
    error: '#f38ba8',      // Red (珊瑚红)
    info: '#89b4fa',       // Blue (信息蓝)
    
    // 背景与表面层级
    bg: '#24273a',         // Base (深暗灰蓝，主背景)
    surface0: '#363a4f',   // Surface0 (面板/状态栏背景)
    surface1: '#494d64',   // Surface1 (高亮悬浮背景/选中态背景)
    surface2: '#5b6078',   // Surface2 (深色边框)
    
    // 文本与图标
    text: '#cad3f5',       // Text (主要浅灰文字)
    subtext: '#a5adcb',    // Subtext1 (次要文字)
    muted: '#8087a2',      // Overlay1 (暗灰/禁用状态)
    border: '#494d64',     // Surface1 (普通边框灰)
  };

  // === 布局组件 ===

  // ASCII Logo - 小羊驼
  const logo = `{${theme.warning}-fg}  ◝(' ω ')◜  {/}{bold}{${theme.primary}-fg}lsc{/} {${theme.text}-fg}· llama.cpp server controller{/}
{${theme.warning}-fg}    /|  |\\    {/}{${theme.muted}-fg}manage models, presets & requests{/}`;

  // 标题栏
  blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: 4,
    content: logo,
    tags: true,
    style: {
      fg: theme.text,
      
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
      bg: theme.surface0,
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
      selected: { bg: theme.surface1, fg: theme.primary, bold: true },
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
      selected: { bg: theme.surface1, fg: theme.primary, bold: true },
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
      selected: { bg: theme.surface1, fg: theme.primary, bold: true },
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
    focusable: true,
    keys: true,
    mouse: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      ch: '█',
      style: { fg: theme.surface2 },
    },
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
    focusable: true,
    keys: true,
    mouse: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      ch: '█',
      style: { fg: theme.surface2 },
    },
    style: {
      fg: theme.text,
      
      border: { fg: theme.border },
    },
    padding: { left: 1, right: 1, top: 1 },
  });

  // blessed 的 Box 不自带键盘滚动(只有鼠标滚轮),手动绑定。
  // 注意必须用元素级 on('keypress')(仅焦点时触发);Element.key() 是程序级
  // 全局注册,焦点不在也会滚动,且元素销毁后泄漏
  function bindPanelScrollKeys(box: blessed.Widgets.BoxElement): void {
    const page = () => Math.max(1, (box.height as number) - 3);
    box.on('keypress', (_ch: string, key: any) => {
      const name = key && key.name;
      switch (name) {
        case 'up':
        case 'k':
          box.scroll(-1);
          break;
        case 'down':
        case 'j':
          box.scroll(1);
          break;
        case 'pageup':
          box.scroll(-page());
          break;
        case 'pagedown':
          box.scroll(page());
          break;
        case 'home':
          box.scrollTo(0);
          break;
        case 'end':
          box.scrollTo(box.getScrollHeight());
          break;
        default:
          return;
      }
      screen.render();
    });
  }
  bindPanelScrollKeys(infoBox);
  bindPanelScrollKeys(resourceBox);

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
      ch: '█',
      style: { fg: theme.surface2 },
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
      ch: '█',
      style: { fg: theme.surface2 },
    },
    style: {
      fg: theme.text,
      
      border: { fg: theme.secondary },
    },
    mouse: true,
    padding: { left: 1, right: 1 },
  });

  // 快捷键提示
  blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 3,
    content: `{center}{${theme.secondary}-fg}↑↓{/} Navigate {${theme.muted}-fg}│{/} {${theme.secondary}-fg}Enter{/} Select {${theme.muted}-fg}│{/} {${theme.secondary}-fg}Tab{/} Switch {${theme.muted}-fg}│{/} {${theme.secondary}-fg}r{/} Refresh {${theme.muted}-fg}│{/} {${theme.secondary}-fg}l{/} Pause Logs {${theme.muted}-fg}│{/} {${theme.secondary}-fg}q{/} Quit{/center}`,
    tags: true,
    style: {
      fg: theme.subtext,
      bg: theme.surface0,
    },
    valign: 'middle',
  });

  // === 功能函数 ===

  // 未完成下载扫描缓存:全量 updateStatus 不再每次递归遍历模型目录,
  // 仅在下载管理器打开/删除/续传(由调用方置失效)或距上次扫描超过 TTL 时重算
  const INCOMPLETE_SCAN_TTL = 5000;
  let incompleteScanCache: { time: number; count: number } | null = null;

  function getIncompleteDownloadCount(modelsDir: string): number {
    const now = Date.now();
    if (incompleteScanCache && now - incompleteScanCache.time < INCOMPLETE_SCAN_TTL) {
      return incompleteScanCache.count;
    }
    const count = scanIncompleteDownloads(modelsDir).length;
    incompleteScanCache = { time: now, count };
    return count;
  }

  function invalidateIncompleteScanCache(): void {
    incompleteScanCache = null;
  }

  // 状态栏静态段缓存 + 上次渲染内容,供轻量刷新复用
  let statusStaticSegments: { base: string; incomplete: string } | null = null;
  let lastStatusContent: string | null = null;

  // 状态栏下载进度段文案(全量/轻量刷新共用)
  function buildDownloadSegment(): string {
    const activeProgress = getActiveDownloadProgress();
    if (!activeProgress.active) return '';
    return `  |  {${theme.info}-fg}⬇ ${activeProgress.label}{/} {${theme.success}-fg}${activeProgress.percent}%{/} {${theme.muted}-fg}[S] Show{/}`;
  }

  function updateStatus(): void {
    const status = getServerStatus();
    const config = getExpandedConfig();
    const incompleteCount = getIncompleteDownloadCount(config.modelsDir);
    let base = '';

    if (status.running || proxyServer) {
      const modelName = basename(status.model || 'Unknown');
      const proxyStatus = proxyServer ? `{${theme.success}-fg}●{/}` : `{${theme.error}-fg}●{/}`;
      base = `{${theme.success}-fg}●{/} Running  |  ` +
        `{${theme.secondary}-fg}PID:{/} ${status.pid}  |  ` +
        `{${theme.secondary}-fg}Port:{/} ${currentPublicPort}  |  ` +
        `{${theme.secondary}-fg}Proxy:{/} ${proxyStatus}  |  ` +
        `{${theme.secondary}-fg}Model:{/} ${modelName}`;
    } else {
      base = `{${theme.error}-fg}●{/} Not Running`;
    }

    const incomplete = incompleteCount > 0
      ? `  |  {${theme.warning}-fg}⚠ ${incompleteCount} incomplete download(s){/}`
      : '';
    statusStaticSegments = { base, incomplete };

    const content = ` ${base}${buildDownloadSegment()}${incomplete}`;
    lastStatusContent = content;
    statusBar.setContent(content);
    screen.render();
  }

  // 轻量状态栏刷新:只更新下载进度段,不重复读 PID/配置/扫描磁盘
  // (下载进度回调每 500ms 触发一次,全量 updateStatus 会阻塞事件循环)
  function updateDownloadStatusSegment(): void {
    if (!statusStaticSegments) {
      updateStatus();
      return;
    }
    const content = ` ${statusStaticSegments.base}${buildDownloadSegment()}${statusStaticSegments.incomplete}`;
    if (content === lastStatusContent) return;
    lastStatusContent = content;
    statusBar.setContent(content);
    screen.render();
  }

  function updateInfo(): void {
    const status = getServerStatus();
    const config = getExpandedConfig();
    
    let content = '';
    
    if (status.running) {
      const proxyStatus = proxyServer ? `{${theme.success}-fg}Running{/}` : `{${theme.error}-fg}Not Running{/}`;
      // proxy 绑 0.0.0.0,局域网可直接访问;显示 LAN base URL 方便其他机器对接
      const lanIp = getLanIPv4();
      const lanLine = lanIp
        ? `  {${theme.secondary}-fg}LAN API:{/}    http://${lanIp}:${currentPublicPort}/v1\n`
        : '';
      content = `{bold}Server Status{/bold}\n\n` +
        `  {${theme.secondary}-fg}Status:{/}     {${theme.success}-fg}Running{/}\n` +
        `  {${theme.secondary}-fg}PID:{/}        ${status.pid}\n` +
        `  {${theme.secondary}-fg}Model:{/}      ${basename(status.model || '')}\n\n` +
        `{bold}Network{/bold}\n\n` +
        `  {${theme.secondary}-fg}Public URL:{/}  http://localhost:${currentPublicPort}\n` +
        lanLine +
        `  {${theme.secondary}-fg}Internal:{/}    http://127.0.0.1:${currentInternalPort}\n` +
        `  {${theme.secondary}-fg}Proxy:{/}       ${proxyStatus}\n`;
      
      if (status.startTime) {
        const uptime = formatUptime(Date.now() - status.startTime.getTime());
        content += `\n  {${theme.secondary}-fg}Uptime:{/}     ${uptime}\n`;
      }
    } else {
      content = `{bold}Server Status{/bold}\n\n` +
        `  {${theme.secondary}-fg}Status:{/}     {${theme.error}-fg}Not Running{/}\n\n` +
        `{bold}Configuration{/bold}\n\n` +
        `  {${theme.secondary}-fg}Models Dir:{/}  ${config.modelsDir}\n` +
        `  {${theme.secondary}-fg}Server:{/}      ${config.llamaServerPath}\n` +
        `  {${theme.secondary}-fg}Default Port:{/} ${config.defaultPort}\n`;
    }

    infoBox.setContent(content);
    screen.render();
  }

  // 周期任务防重入:上一轮采集未结束(如 nvidia-smi 超时≈刷新间隔)则跳过本轮
  let resourcesTickRunning = false;

  async function updateResources(): Promise<void> {
    if (resourcesTickRunning) return;
    resourcesTickRunning = true;
    try {
      const status = getServerStatus();
      // 异步采集,避免 nvidia-smi/free 阻塞事件循环
      const [gpus, ram] = await Promise.all([getGpuInfo(), getRamInfo()]);

      let content = '';

      // RAM 信息
      content += `{bold}System RAM{/bold}\n\n`;
      const ramBar = createProgressBar(ram.percent, 20, theme);
      content += `  ${ramBar} ${ram.percent}%\n`;
      content += `  {${theme.secondary}-fg}${ram.used} / ${ram.total} MB{/}\n\n`;

      // GPU 信息
      if (gpus && gpus.length > 0) {
        content += `{bold}GPU VRAM{/bold}\n\n`;
        for (let i = 0; i < gpus.length; i++) {
          const gpu = gpus[i];
          const vramBar = createProgressBar(gpu.percent, 16, theme);
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
        if (currentServerOptions.batchSize !== undefined) {
          content += `  {${theme.secondary}-fg}Batch Size:{/} ${currentServerOptions.batchSize}\n`;
        }
        if (currentServerOptions.threadsBatch !== undefined) {
          content += `  {${theme.secondary}-fg}Threads Batch:{/} ${currentServerOptions.threadsBatch}\n`;
        }
        if (currentServerOptions.cachePrompt !== undefined) {
          content += `  {${theme.secondary}-fg}Cache Prompt:{/} ${currentServerOptions.cachePrompt ? 'on' : 'off'}\n`;
        }
        if (currentServerOptions.cacheReuse !== undefined) {
          content += `  {${theme.secondary}-fg}Cache Reuse:{/} ${currentServerOptions.cacheReuse}\n`;
        }
        if (currentServerOptions.fit !== undefined) {
          content += `  {${theme.secondary}-fg}Fit:{/} ${currentServerOptions.fit ? 'on' : 'off'}\n`;
        }
        if (currentServerOptions.reasoningBudget !== undefined) {
          let thinking = '{green-fg}On{/}';
          if (currentServerOptions.reasoningBudget === 0) {
            thinking = '{yellow-fg}Off{/}';
          }
          content += `  {${theme.secondary}-fg}Thinking:{/} ${thinking}\n`;
        }
        if (currentServerOptions.mmproj) {
          content += `  {${theme.secondary}-fg}Vision:{/} {green-fg}Yes{/}\n`;
        }
        if (currentServerOptions.specType) {
          content += `  {${theme.secondary}-fg}Spec Type:{/} ${currentServerOptions.specType}\n`;
        }
      }

      resourceBox.setContent(content);
      screen.render();
    } finally {
      resourcesTickRunning = false;
    }
  }

  // 上次渲染的日志内容,相同则不重绘
  let lastLogContent: string | null = null;
  let logsTickRunning = false;

  async function updateLogs(): Promise<void> {
    if (logPaused || logsTickRunning) return;
    logsTickRunning = true;
    try {
      // 异步 tail,避免 execSync 阻塞事件循环
      let logs = '';
      const logFile = getLogFile();
      if (existsSync(logFile)) {
        try {
          const { stdout } = await execFileP('tail', ['-n', '100', logFile], { encoding: 'utf-8' });
          logs = stdout;
        } catch {
          logs = '';
        }
      }
      // 内容没有变化则跳过重绘
      if (logs === lastLogContent) return;
      // 首次填充或用户本就在底部时才跟随滚动;用户上翻查看历史时不强拉到底部
      const followTail = lastLogContent === null || serverLogBox.getScrollPerc() >= 99;
      lastLogContent = logs;
      if (logs) {
        serverLogBox.setContent(logs);
        if (followTail) {
          serverLogBox.setScrollPerc(100);
        }
      }
      screen.render();
    } finally {
      logsTickRunning = false;
    }
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
      const vision = m.mmproj ? ` {${theme.info}-fg}[Vision]{/}` : '';
      return ` ${basename(m.path)}${vision}`;
    });
    modelList.setItems(items);
  }

  function loadPresetsList(): void {
    const presets = loadPresets();
    presetNames = Object.keys(presets);
    const items = presetNames.map(name => {
      const p = presets[name];
      let thinking = `{${theme.success}-fg}[think]{/}`;
      if (p.reasoningBudget === 0) {
        thinking = `{${theme.warning}-fg}[no-think]{/}`;
      }
      return ` ${name} ${thinking}`;
    });
    
    if (items.length === 0) {
      presetList.setItems([' (No presets configured)']);
    } else {
      presetList.setItems(items);
    }
  }

  function showMessage(msg: string, type: 'info' | 'success' | 'error' | 'warning' = 'info'): void {
    const color = type === 'success' ? theme.success : type === 'error' ? theme.error : type === 'warning' ? theme.warning : theme.primary;
    serverLogBox.log(`{${color}-fg}${msg}{/${color}-fg}`);
    screen.render();
  }

  function getTensorSplitOptions(): string[] {
    // GPU 数量运行期不变,读启动时预热好的缓存,避免每次按键都跑 nvidia-smi
    const gpuCount = getCachedGpuCount();
    if (gpuCount <= 1) return [''];
    if (gpuCount === 2) {
      return [
        '',
        '50,50',
        '40,60',
        '30,70',
        '20,80',
        '10,90',
        '0,100',
        '60,40',
        '70,30',
        '80,20',
        '90,10',
        '100,0',
      ];
    }
    const base = Math.floor(100 / gpuCount);
    const splits = new Array(gpuCount).fill(base);
    const remainder = 100 - base * gpuCount;
    if (remainder > 0) {
      splits[splits.length - 1] += remainder;
    }
    return ['', splits.join(',')];
  }

  // 启动 llama-server + 请求代理;任一步失败都回滚到全停状态,避免半启动
  async function launchServer(options: ServerOptions, publicPort: number): Promise<void> {
    // 版本探测:过旧的 llama-server 提前警告(--fit/-ngl auto/--reasoning-budget 需要较新版本)
    const versionCheck = checkLlamaServerVersion(getExpandedConfig().llamaServerPath);
    if (versionCheck && !versionCheck.supported) {
      showMessage(`llama-server build ${versionCheck.build} 过旧(需要 ≥ b${MIN_LLAMA_SERVER_BUILD}),--fit/-ngl auto 等参数可能不受支持,建议升级 llama.cpp`, 'warning');
    }
    // ctxSize 'auto' 与锁定 GPU 层数/多卡切分冲突时警告(fit 降级但仍可启动,不阻断)
    const fitConflict = ctxAutoFitConflict(options);
    if (fitConflict) {
      showMessage(fitConflict, 'warning');
    }
    // 只回滚本进程真正启动的服务器:startServer 拒绝(如锁被 CLI 持有)时,
    // 服务器可能是别的进程刚启动的,不能误停
    let serverStarted = false;
    try {
      await startServer(options, { publicPort });
      serverStarted = true;
      showMessage(`llama-server started on internal port ${options.port}`, 'success');

      // CPU 回退自检:日志每次启动都会截断,只含本次输出。
      // 混合架构(GDN/Mamba 类)只要有层落到 CPU,逐 token 计算都要过 CPU,
      // 实测生成速度会掉到全 GPU 的 1/5 以下
      const startupLogs = readLastLogs(80);
      if (/assigned to device CPU|not supported, set to disabled/.test(startupLogs)) {
        showMessage('WARNING: 部分模型层因显存不足回退到 CPU,生成速度会严重下降。建议:预设中 GPU Layers 设 99 + Context 固定较小值,或关闭视觉/其他占显存的进程后重启', 'warning');
      }

      // 启动代理
      await startProxy(publicPort, options.port);
      showMessage(`Proxy listening on port ${publicPort}`, 'success');
    } catch (err) {
      // startServer 已成功但 startProxy 失败(如 EADDRINUSE):回滚已启动的服务器,
      // 避免留下无 PID 管理的孤儿进程
      // 同时清掉 proxyServer 引用(EADDRINUSE 时变量非空但未监听),避免状态栏误显示代理在跑
      try { stopProxy(); } catch {}
      if (serverStarted) {
        try { await stopServer(); } catch {}
      }
      throw err;
    }

    // 全部成功后才保存服务器参数
    currentServerOptions = options;
    updateStatus();
    updateInfo();
    startLogWatcher();
    startResourceWatcher();
  }

  // 返回是否成功启动(供 Restart 判断是否需要清理残留状态)
  async function handleStartServer(): Promise<boolean> {
    const status = getServerStatus();

    if (status.running) {
      showMessage('Server is already running. Stop it first.', 'error');
      return false;
    }

    if (!currentModel) {
      showMessage('Please select a model first.', 'error');
      return false;
    }

    const config = getExpandedConfig();
    currentPublicPort = config.defaultPort;
    currentInternalPort = config.defaultPort + 1;

    // llama-server 监听内部端口;默认值由 resolveServerOptions 合并(内置默认 + config),
    // TUI 专属字段(model 实际路径、内部 host/port、fit/kvCacheType 硬编码)作为覆盖层
    const options = resolveServerOptions(
      {
        model: currentModel.path,
        mmproj: currentModel.mmproj,
        fit: true,
        kvCacheType: 'f16',
        host: '127.0.0.1', // 内部只监听 localhost
        port: currentInternalPort,
      },
      null,
      config,
    );

    // 投机解码模块解析:仅 draft 系类型自动挂载配对模块;必须外挂模块却配不到时警告
    const spec = resolveSpecModel(options.specType, options.specModel, currentModel.mtp, 'zh');
    options.specModel = spec.specModel;
    if (spec.warning) {
      showMessage(spec.warning, 'warning');
    }

    showMessage('Starting server...');

    try {
      await launchServer(options, currentPublicPort);
      return true;
    } catch (err) {
      showMessage(`Failed to start: ${(err as Error).message}`, 'error');
      return false;
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
      try {
        await stopServer();
      } catch (err) {
        // 仅代理在跑(服务器已不在)时 stopServer 拒绝 "not running":视为已停止
        if (!(err as Error).message.includes('not running')) throw err;
      }
      showMessage('Server and proxy stopped.', 'success');
    } catch (err) {
      showMessage(`Failed to stop: ${(err as Error).message}`, 'error');
    } finally {
      // 状态清理无论成败都要做:代理已停,参数与 watcher 不应残留
      currentServerOptions = {}; // 清空服务器参数
      updateStatus();
      updateInfo();
      updateResources();
      stopLogWatcher();
      stopResourceWatcher();
    }
  }

  async function handleRestartServer(): Promise<void> {
    const status = getServerStatus();

    if (status.running) {
      showMessage('Stopping server...');
      // 先停代理再停服务器,避免代理继续转发到已死的后端
      stopProxy();
      try {
        await stopServer();
      } catch (err) {
        // PID 已失效(仅代理在跑)时 "not running" 视为已停止;
        // 其他错误提示后仍走启动流程(handleStartServer 会拦截"已在运行")
        if (!(err as Error).message.includes('not running')) {
          showMessage(`Failed to stop: ${(err as Error).message}`, 'error');
        }
      }
    }

    const started = await handleStartServer();
    if (!started && !getServerStatus().running) {
      // 重启失败且服务器已停:清理旧参数与 watcher,避免半启动残留
      currentServerOptions = {};
      updateStatus();
      updateInfo();
      updateResources();
      stopLogWatcher();
      stopResourceWatcher();
    }
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

      // 停止服务器(仅代理在跑时拒绝 "not running":视为已停止)
      try {
        await stopServer();
      } catch (err) {
        if (!(err as Error).message.includes('not running')) throw err;
      }

      // 服务器已停,模型引用可以清(失败路径保留 currentModel)
      currentModel = null;

      // 强制触发 CUDA 内存回收
      try {
        execSync('nvidia-smi --gpu-reset 2>/dev/null || true', { timeout: 5000 });
      } catch {}

      showMessage('Model ejected, VRAM freed.', 'success');
    } catch (err) {
      showMessage(`Failed to eject: ${(err as Error).message}`, 'error');
    } finally {
      // 状态清理无论成败都要做:代理已停,参数与 watcher 不应残留
      currentServerOptions = {};
      updateStatus();
      updateInfo();
      updateResources();
      stopLogWatcher();
      stopResourceWatcher();
    }
  }

  async function handleLoadPreset(index: number): Promise<void> {
    const config = getExpandedConfig();
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
      try {
        await stopServer();
      } catch (err) {
        // PID 已失效(仅代理在跑)时 "not running" 视为已停止;
        // 其他错误提示后仍尝试加载(startServer 会拦截"已在运行")
        if (!(err as Error).message.includes('not running')) {
          showMessage(`Failed to stop: ${(err as Error).message}`, 'error');
        }
      }
    }

    currentPublicPort = preset.port;
    currentInternalPort = preset.port + 1;

    // llama-server 监听内部端口;preset 之上的 TUI 覆盖:model 用扫描到的实际路径,
    // host/port 指内部监听地址,fit/kvCacheType 保留 TUI 的回退默认(不在内置默认层)
    // mmproj 必须排除在 preset 层之外:扫描不到配对 mmproj 时(如文件已删)overlayDefined
    // 会跳过覆盖层 undefined 而让 preset 里的过期路径渗漏,导致 --mmproj 指向不存在文件
    const { mmproj: _presetMmproj, ...presetRest } = preset;
    const options = resolveServerOptions(
      {
        model: model.path,
        mmproj: model.mmproj, // 只来自扫描器配对结果;没有则不带视觉启动
        fit: preset.fit ?? true,
        kvCacheType: preset.kvCacheType || 'f16',
        host: '127.0.0.1', // 内部只监听 localhost
        port: currentInternalPort,
      },
      presetRest,
      config,
    );

    // 投机解码模块解析:仅 draft 系类型自动挂载配对模块;必须外挂模块却配不到时警告
    const spec = resolveSpecModel(options.specType, options.specModel, model.mtp, 'zh');
    options.specModel = spec.specModel;
    if (spec.warning) {
      showMessage(spec.warning, 'warning');
    }

    showMessage(`Loading preset "${name}"...`);

    let started = false;
    try {
      await launchServer(options, currentPublicPort);
      started = true;
    } catch (err) {
      showMessage(`Failed: ${(err as Error).message}`, 'error');
    }

    if (!started && !getServerStatus().running) {
      // 加载失败且服务器已停:清理旧参数与 watcher,避免半启动残留
      currentServerOptions = {};
      updateStatus();
      updateInfo();
      updateResources();
      stopLogWatcher();
      stopResourceWatcher();
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
    presetList.setLabel(' Presets (Enter load, n new) ');
    infoBox.hide();
    modelList.hide();
    presetList.show();
    presetList.focus();
    bindNewPresetKey();
    screen.render();
  }

  // 编辑模式退出函数（需要在 hideSubLists 之前定义）
  let deleteHandler: (() => void) | null = null;
  let newPresetHandler: (() => void) | null = null;
  let renameHandler: (() => void) | null = null;
  
  function exitEditMode(): void {
    presetEditMode = false;
    if (deleteHandler) {
      presetList.unkey('d', deleteHandler);
      deleteHandler = null;
    }
    if (renameHandler) {
      presetList.unkey('r', renameHandler);
      renameHandler = null;
    }
    presetList.setLabel(' Presets (Enter load, n new) ');
  }

  function hideSubLists(): void {
    modelList.hide();
    presetList.hide();
    infoBox.show();
    exitEditMode();
    if (newPresetHandler) {
      presetList.unkey('n', newPresetHandler);
      newPresetHandler = null;
    }
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
    confirmDialog(
      screen,
      `Delete model directory?\n\n` +
      `{bold}${modelDir}{/bold}\n\n` +
      `{${theme.secondary}-fg}[Y]{/} Yes  {${theme.secondary}-fg}[N]{/} No`,
      async () => {
        try {
          // 异步删除,多 GB 模型目录不再阻塞 UI
          await rm(modelDir, { recursive: true, force: true });
          showMessage(`Model deleted: ${basename(modelDir)}`, 'success');
          loadModels();
          showModelList();
        } catch (err) {
          showMessage(`Delete failed: ${(err as Error).message}`, 'error');
        }
      },
      {
        label: ' Delete Model ',
        width: 60,
        height: 9,
        borderColor: theme.error,
        fg: theme.text,
        bg: theme.surface0,
      },
    );
  }

  // 编辑预设界面
  function showEditPresetList(): void {
    loadPresetsList();
    presetEditMode = true;
    
    // 修改预设列表标签
    presetList.setLabel(' Edit Preset (Enter edit, d delete, r rename, n new) ');
    
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

    // r 重命名(与 deleteHandler 同样的 unkey-then-key 防重复);
    // 全局 r 刷新在此模式下对 presetList 焦点让路(见 screen.key(['r']))
    if (renameHandler) {
      presetList.unkey('r', renameHandler);
    }
    renameHandler = () => {
      const selectedIndex = (presetList as any).selected;
      if (selectedIndex >= 0 && selectedIndex < presetNames.length) {
        promptRenamePreset(presetNames[selectedIndex]);
      }
    };
    presetList.key('r', renameHandler);
    bindNewPresetKey();
    
    screen.render();
  }

  // 确认删除预设
  async function confirmDeletePreset(name: string): Promise<void> {
    confirmDialog(
      screen,
      `Delete preset "{bold}${name}{/bold}"?\n\n` +
      `{${theme.secondary}-fg}[Y]{/} Yes  {${theme.secondary}-fg}[N]{/} No`,
      () => {
        // 磁盘满/权限不足时 writeJsonAtomic 会抛错,不能让其穿透 blessed 按键派发杀死进程
        try {
          deletePreset(name);
        } catch (err) {
          showMessage(`Failed to delete preset: ${(err as Error).message}`, 'error');
          return;
        }
        showMessage(`Preset "${name}" deleted.`, 'success');
        loadPresetsList();
        showEditPresetList();
      },
      {
        label: ' Delete Preset ',
        width: 50,
        height: 7,
        borderColor: theme.error,
        fg: theme.text,
        bg: theme.surface0,
      },
    );
  }

  // ========== 新建预设 ==========

  // n 键绑定(加载/编辑两种列表模式共用,与 deleteHandler 同样的 unkey-then-key 防重复)
  function bindNewPresetKey(): void {
    if (newPresetHandler) {
      presetList.unkey('n', newPresetHandler);
    }
    newPresetHandler = () => {
      promptNewPresetName();
    };
    presetList.key('n', newPresetHandler);
  }

  // 取消新建时回到进入前的预设列表视图(加载或编辑模式)
  function restorePresetListView(): void {
    if (presetEditMode) {
      showEditPresetList();
    } else {
      showPresetList();
    }
  }

  // Step 1: 输入预设名称(校验失败保留已输入内容重新打开,可修改重试或 Esc 取消)
  function promptNewPresetName(retryValue?: string): void {
    // 隐藏 presetList:screen 级 Esc 处理器见列表可见会 hideSubLists 抢走焦点,
    // 导致 textbox 的 cancel 收不到 Esc(同 showPresetEditor 的处理)
    presetList.hide();

    const inputBox = blessed.textbox({
      parent: screen,
      top: 'center',
      left: 'center',
      width: 50,
      height: 3,
      label: ' New Preset Name ',
      tags: true,
      shadow: true,
      border: { type: 'line' },
      style: {
        fg: overlayStyle.fg,
        bg: overlayStyle.bg,
        border: overlayStyle.border,
      },
      padding: { left: 1, right: 1 },
      inputOnFocus: true,
      censor: false,
    });

    // 重试时回填上次输入,便于直接修改
    if (retryValue) {
      inputBox.setValue(retryValue);
    }

    inputBox.focus();
    screen.render();

    inputBox.on('submit', (value: string) => {
      const name = value.trim();
      // blessed readInput 是一次性的:submit 触发后文本框已停止读入并回绕焦点,
      // 必须销毁重建(下载对话框同样在 submit 时即销毁)
      inputBox.destroy();
      if (!name) {
        showMessage('Preset name cannot be empty.', 'error');
        promptNewPresetName();
        return;
      }
      // {} 会被 blessed tags 解析,破坏选择器/编辑器标签渲染;换行同样是垃圾字符
      if (/[{}\n\r]/.test(name)) {
        showMessage('Preset name cannot contain {, } or newlines.', 'error');
        promptNewPresetName(name);
        return;
      }
      if (presetExists(name)) {
        showMessage(`Preset "${name}" already exists.`, 'error');
        promptNewPresetName(name);
        return;
      }
      screen.render();
      showNewPresetModelPicker(name);
    });

    inputBox.on('cancel', () => {
      inputBox.destroy();
      restorePresetListView();
      screen.render();
    });

    inputBox.readInput();
  }

  // 重命名预设:预填旧名,校验规则与新建一致(空/花括号/换行/重名)
  function promptRenamePreset(oldName: string, retryValue?: string): void {
    // 同 promptNewPresetName:隐藏列表,避免 screen 级 Esc 处理抢焦点
    presetList.hide();

    const inputBox = blessed.textbox({
      parent: screen,
      top: 'center',
      left: 'center',
      width: 50,
      height: 3,
      label: ` Rename Preset - ${oldName} `,
      tags: true,
      shadow: true,
      border: { type: 'line' },
      style: {
        fg: overlayStyle.fg,
        bg: overlayStyle.bg,
        border: overlayStyle.border,
      },
      padding: { left: 1, right: 1 },
      inputOnFocus: true,
      censor: false,
    });

    // 预填旧名便于直接编辑;校验失败重试时回填上次输入
    inputBox.setValue(retryValue ?? oldName);

    inputBox.focus();
    screen.render();

    inputBox.on('submit', (value: string) => {
      const name = value.trim();
      // blessed readInput 是一次性的:submit 后必须销毁重建(见 promptNewPresetName)
      inputBox.destroy();
      if (!name) {
        showMessage('Preset name cannot be empty.', 'error');
        promptRenamePreset(oldName);
        return;
      }
      if (/[{}\n\r]/.test(name)) {
        showMessage('Preset name cannot contain {, } or newlines.', 'error');
        promptRenamePreset(oldName, name);
        return;
      }
      if (name !== oldName && presetExists(name)) {
        showMessage(`Preset "${name}" already exists.`, 'error');
        promptRenamePreset(oldName, name);
        return;
      }
      if (name !== oldName) {
        try {
          if (!renamePreset(oldName, name)) {
            showMessage(`Failed to rename preset "${oldName}".`, 'error');
            showEditPresetList();
            return;
          }
        } catch (err) {
          showMessage(`Failed to rename preset: ${(err as Error).message}`, 'error');
          showEditPresetList();
          return;
        }
        showMessage(`Preset renamed: ${oldName} → ${name}`, 'success');
      }
      showEditPresetList();
    });

    inputBox.on('cancel', () => {
      inputBox.destroy();
      showEditPresetList();
      screen.render();
    });

    inputBox.readInput();
  }

  // Step 2: 选择模型(编辑器内模型只读,创建时先选定,与下载生成预设一样存绝对路径)
  function showNewPresetModelPicker(name: string): void {
    loadModels();
    if (models.length === 0) {
      showMessage('No models found. Configure models directory first.', 'error');
      restorePresetListView();
      return;
    }

    const overlayHeight = Math.min(models.length + 4, 20);
    const overlay = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: 70,
      height: overlayHeight,
      label: ` Select Model - ${name} `,
      tags: true,
      shadow: true,
      border: { type: 'line' },
      style: {
        fg: overlayStyle.fg,
        bg: overlayStyle.bg,
        border: overlayStyle.border,
      },
    });

    const picker = blessed.list({
      parent: overlay,
      top: 0,
      left: 1,
      right: 1,
      bottom: 1,
      keys: true,
      vi: true,
      mouse: true,
      tags: true,
      style: {
        fg: overlayStyle.fg,
        bg: overlayStyle.bg,
        selected: overlayStyle.selected,
      },
      items: models.map(m => ` ${basename(m.path)}${m.mmproj ? ` {${theme.info}-fg}[Vision]{/}` : ''}`),
    });

    picker.on('select', async (_item, index) => {
      if (index < 0 || index >= models.length) return;
      const model = models[index];
      overlay.destroy();
      screen.render();
      await showPresetEditor(name, model.path);
    });

    picker.on('keypress', (_ch: string, key: any) => {
      // 元素级(原因见 openDownloadManager 注释):Element.key() 全局泄漏
      if (key && key.name !== 'escape') return;
      overlay.destroy();
      restorePresetListView();
      screen.render();
    });

    picker.focus();
    screen.render();
  }

  // 预设编辑器(newPresetModel 传入时为创建模式:以全局默认值为底稿)
  async function showPresetEditor(presetName: string, newPresetModel?: string): Promise<void> {
    const config = getExpandedConfig();
    const existingPreset = getPreset(presetName);
    if (!existingPreset && newPresetModel === undefined) {
      showMessage(`Preset "${presetName}" not found.`, 'error');
      hideSubLists();
      return;
    }

    // 隐藏 presetList 防止键盘事件冲突
    presetList.hide();

    // 创建模式:合成带配置默认值的底稿,与既有预设共用同一套 editState 初始化/保存路径
    const preset: Preset = existingPreset ?? {
      name: presetName,
      model: newPresetModel!,
      ctxSize: config.defaultCtxSize,
      gpuLayers: config.defaultGpuLayers,
      host: config.defaultHost,
      port: config.defaultPort,
      jinja: true,
      flashAttn: 'auto',
      reasoningBudget: -1,
    };

    // 编辑状态
    let editState = {
      model: preset.model,
      mmproj: (preset as any).mmproj,
      useVision: preset.useVision ?? true,
      fit: preset.fit ?? true,
      ctxSize: preset.ctxSize,
      gpuLayers: preset.gpuLayers,
      tensorSplit: preset.tensorSplit || '',
      batchSize: preset.batchSize ?? 0,
      threadsBatch: preset.threadsBatch ?? 0,
      cachePrompt: preset.cachePrompt ?? true,
      cacheReuse: preset.cacheReuse ?? 0,
      kvCacheType: preset.kvCacheType || 'f16',
      chatTemplate: preset.chatTemplate || '',
      host: (preset as any).host || '0.0.0.0',
      port: preset.port,
      reasoningBudget: preset.reasoningBudget,
      jinja: preset.jinja,
      flashAttn: preset.flashAttn,
      specType: preset.specType || '',
      specModel: preset.specModel || '',
      specDraftMax: preset.specDraftMax ?? 0,
      slotSave: !!preset.slotSavePath,
    };

    const normalizedModelsDir = config.modelsDir.replace(/\/+$/, '');
    const presetPath = preset.model;
    let modelDir: string;
    if (presetPath && presetPath.startsWith('/') && !presetPath.startsWith(normalizedModelsDir + '/')) {
      // 绝对路径在 modelsDir 之外：直接使用其所在目录
      modelDir = dirname(presetPath);
    } else {
      try {
        modelDir = getModelDir(config.modelsDir, inferModelIdFromPath(preset.model, config.modelsDir));
      } catch {
        // 非 org/repo 结构 (如模型直接放在 modelsDir 根下)：回退到模型所在目录
        modelDir = dirname(presetPath);
      }
    }
    const templateOptions = getChatTemplateOptions(modelDir, join(getConfigDir(), 'templates'));
    // 草稿模型选项:扫描 modelsDir 里的 mtp-*/DFlash/DSpark 等文件,'' 表示 Auto(启动时自动配对)
    const specModelOptions = ['', ...findDraftModelFiles(config.modelsDir)];

    // 创建编辑对话框(高度自适应终端,超出可滚动:20 个字段 + Model 行 + 帮助行在 height:21 下会截断尾部字段)
    const editor = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: 60,
      height: Math.min(24, (screen.height as number) - 2),
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      mouse: true,
      label: ` ${existingPreset ? 'Edit' : 'New'}: ${presetName} `,
      tags: true,
      shadow: true,
      border: { type: 'line' },
      style: {
        fg: theme.text,
        bg: theme.surface0,
        border: { fg: theme.primary },
      },
      padding: { left: 2, right: 2, top: 1 },
    });

    // 当前选中的字段
    let selectedField = 0;
    const fields = ['ctxSize', 'gpuLayers', 'tensorSplit', 'useVision', 'fit', 'batchSize', 'threadsBatch', 'cachePrompt', 'cacheReuse', 'kvCacheType', 'chatTemplate', 'port', 'host', 'reasoningBudget', 'jinja', 'flashAttn', 'specType', 'specModel', 'specDraftMax', 'slotSave'];
    const fieldLabels = ['Context Size', 'GPU Layers', 'Tensor Split', 'Vision', 'Fit', 'Batch Size', 'Threads Batch', 'Cache Prompt', 'Cache Reuse', 'KV Cache', 'Chat Template', 'Port', 'Host', 'Thinking', 'Jinja', 'Flash Attention', 'Spec Type', 'Spec Model', 'Spec Draft N', 'Slot Save'];

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
          case 'useVision':
            value = editState.useVision ? '{green-fg}On{/}' : '{yellow-fg}Off{/}';
            break;
          case 'fit':
            value = editState.fit ? '{green-fg}On{/}' : '{yellow-fg}Off{/}';
            break;
          case 'batchSize':
            value = editState.batchSize ? String(editState.batchSize) : '{yellow-fg}Default{/}';
            break;
          case 'threadsBatch':
            value = editState.threadsBatch ? String(editState.threadsBatch) : '{yellow-fg}Auto{/}';
            break;
          case 'cachePrompt':
            value = editState.cachePrompt ? '{green-fg}On{/}' : '{yellow-fg}Off{/}';
            break;
          case 'cacheReuse':
            value = editState.cacheReuse ? String(editState.cacheReuse) : '{yellow-fg}Default{/}';
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
          case 'specType':
            value = editState.specType ? editState.specType : '{yellow-fg}Off{/}';
            break;
          case 'specModel':
            // 路径太长塞不进 60 宽对话框,只显示文件名(选项均来自 modelsDir 扫描)
            value = editState.specModel ? basename(editState.specModel) : '{yellow-fg}Auto{/}';
            break;
          case 'specDraftMax':
            value = editState.specDraftMax ? String(editState.specDraftMax) : '{yellow-fg}Default{/}';
            break;
          case 'slotSave':
            value = editState.slotSave ? '{green-fg}On{/}' : '{yellow-fg}Off{/}';
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
      // 选中行滚入可视区(内容布局:Model 行 + 空行 + 字段行 + 空行 + 帮助行)
      const selectedRow = selectedField + 2;
      const visibleRows = (editor.height as number) - 3; // 边框 2 + padding top 1
      const scroll = editor.getScroll();
      if (selectedRow < scroll) {
        editor.setScroll(selectedRow);
      } else if (selectedRow >= scroll + visibleRows) {
        editor.setScroll(selectedRow - visibleRows + 1);
      }
      screen.render();
    }

    function changeValue(delta: number) {
      const field = fields[selectedField];
        switch (field) {
          case 'ctxSize':
            // 'auto' 排在档位末尾:保存为字符串,启动时配合 --fit 自动调整上下文
            const ctxSteps: (number | 'auto')[] = [1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 'auto'];
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
          case 'useVision':
            editState.useVision = !editState.useVision;
            break;
          case 'fit':
            editState.fit = !editState.fit;
            break;
          case 'batchSize':
            if (delta < 0) {
              editState.batchSize = Math.max(0, editState.batchSize - 256);
            } else {
              editState.batchSize = editState.batchSize === 0 ? 2048 : Math.min(8192, editState.batchSize + 256);
            }
            break;
          case 'threadsBatch':
            if (delta < 0) {
              editState.threadsBatch = Math.max(0, editState.threadsBatch - 2);
            } else {
              editState.threadsBatch = editState.threadsBatch === 0 ? 4 : Math.min(64, editState.threadsBatch + 2);
            }
            break;
          case 'cachePrompt':
            editState.cachePrompt = !editState.cachePrompt;
            break;
          case 'cacheReuse':
            if (delta < 0) {
              editState.cacheReuse = Math.max(0, editState.cacheReuse - 256);
            } else {
              editState.cacheReuse = editState.cacheReuse === 0 ? 256 : Math.min(4096, editState.cacheReuse + 256);
            }
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
        case 'specType':
          // '' = 关闭;'none' 与缺省等价,不列入循环
          const specTypes = ['', 'draft-simple', 'draft-eagle3', 'draft-mtp', 'draft-dflash', 'draft-dspark', 'ngram-simple', 'ngram-map-k', 'ngram-map-k4v', 'ngram-mod', 'ngram-cache'];
          const specIdx = specTypes.indexOf(editState.specType);
          editState.specType = specTypes[(specIdx + 1) % specTypes.length];
          break;
        case 'specModel':
          // 循环切换扫描到的草稿模型;'' = Auto(启动时按目录自动配对 mtp-* 模块)
          const specModelIdx = specModelOptions.indexOf(editState.specModel);
          editState.specModel = specModelOptions[(specModelIdx + 1) % specModelOptions.length];
          break;
        case 'specDraftMax':
          // 0 = Default(交给 llama.cpp 默认 3);DFlash2 官方建议 7
          const draftMaxSteps = [0, 3, 5, 7, 8, 16];
          const draftMaxIdx = draftMaxSteps.indexOf(editState.specDraftMax);
          editState.specDraftMax = draftMaxSteps[(draftMaxIdx + 1) % draftMaxSteps.length];
          break;
        case 'slotSave':
          editState.slotSave = !editState.slotSave;
          break;
      }
      renderEditor();
    }

    const keyHandler = (_ch: string, key: any) => {
      // 模态确认框打开时,按键不穿透到编辑器
      if (isModalOpen()) return;
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
          useVision: editState.useVision,
          fit: editState.fit,
          ctxSize: editState.ctxSize,
          gpuLayers: editState.gpuLayers,
          tensorSplit: editState.tensorSplit || undefined,
          batchSize: editState.batchSize || undefined,
          threadsBatch: editState.threadsBatch || undefined,
          cachePrompt: editState.cachePrompt,
          cacheReuse: editState.cacheReuse || undefined,
          kvCacheType: editState.kvCacheType,
          chatTemplate: editState.chatTemplate || undefined,
          host: editState.host,
          port: editState.port,
          jinja: editState.jinja,
          flashAttn: editState.flashAttn,
          reasoningBudget: editState.reasoningBudget,
          specType: editState.specType || undefined, // '' 表示关闭,不写入预设
          // specModel 仅在 draft-* 系下有意义(draft-mtp 时为内置 MTP 的覆盖通道);
          // 其他类型保留会让 llama.cpp 把用不到的 draft 白加载进 VRAM
          specModel: editState.specType.startsWith('draft-') ? (editState.specModel || undefined) : undefined,
          // 草稿 token 数;0 = 不写(用 llama.cpp 默认值),与 specType 解耦,任何 draft 系都可调
          specDraftMax: editState.specDraftMax > 0 ? editState.specDraftMax : undefined,
          // On 时优先保留已有的自定义路径(编辑器不管理具体目录,与 specModel 同理);
          // 没有时才写默认目录;Off 时为 undefined,JSON.stringify 会丢弃该键(即禁用)
          slotSavePath: editState.slotSave ? (preset.slotSavePath || getDefaultSlotSavePath()) : undefined,
        };
        
        // 磁盘满/权限不足时 writeJsonAtomic 会抛错,不能让其穿透 blessed 按键派发杀死进程;
        // 编辑器已销毁,失败时回到主界面即可
        try {
          savePreset(updatedPreset);
        } catch (err) {
          showMessage(`Failed to save preset: ${(err as Error).message}`, 'error');
          hideSubLists();
          return;
        }
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
  
  // 浮层统一样式
  const overlayStyle = {
    fg: theme.text,
    bg: theme.surface0,
    border: { fg: theme.primary },
    selected: { bg: theme.surface1, fg: theme.primary, bold: true },
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
      shadow: true,
      border: { type: 'line' },
      style: {
        fg: overlayStyle.fg,
        bg: overlayStyle.bg,
        border: overlayStyle.border,
      },
      padding: { left: 1, right: 1 },
      inputOnFocus: true,
      censor: false,
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
      menuBox.focus();
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
      shadow: true,
      border: { type: 'line' },
      content: `{center}{${theme.text}-fg}Fetching model info...{/}\n\n{${theme.success}-fg}${modelId}{/}{/center}`,
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
    const systemInfo = await getSystemInfo();
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
      shadow: true,
      border: { type: 'line' },
      style: {
        fg: overlayStyle.fg,
        bg: overlayStyle.bg,
        border: overlayStyle.border,
      },
    });

    blessed.box({
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

    blessed.box({
      parent: overlay,
      bottom: 0,
      left: 1,
      right: 1,
      height: 2,
      tags: true,
      content: `{center}{${theme.secondary}-fg}Space{/} Toggle {${theme.muted}-fg}│{/} {${theme.secondary}-fg}Enter{/} Continue {${theme.muted}-fg}│{/} {${theme.secondary}-fg}Esc{/} Cancel{/center}`,
      style: { fg: overlayStyle.fg, bg: overlayStyle.bg },
    });

    // 默认选中推荐项
    selectBox.select(recommendedIdx >= 0 ? recommendedIdx : 0);
    selectBox.focus();
    screen.render();

    // 元素级 on('keypress'):仅焦点在该列表时触发,且随 overlay 销毁自动失效;
    // Element.key() 是程序级全局注册,浮层销毁后仍累积触发(已造成按键串扰)
    selectBox.on('keypress', async (_ch: string, key: any) => {
      if (isModalOpen()) return;
      const name = key && key.name;

      if (name === 'space') {
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
        return;
      }

      if (name === 'enter') {
        if (selectedQuants.size === 0) {
          showMessage('Please select at least one quantization.', 'error');
          return;
        }
        overlay.destroy();
        const selectedEstimates = Array.from(selectedQuants).map(i => estimates[i]);
        await showFileSelector(repo, selectedEstimates, systemInfo);
        return;
      }

      if (name === 'escape') {
        overlay.destroy();
        menuBox.focus();
        screen.render();
      }
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
      shadow: true,
      border: { type: 'line' },
      style: {
        fg: overlayStyle.fg,
        bg: overlayStyle.bg,
        border: overlayStyle.border,
      },
    });

    blessed.box({
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

    blessed.box({
      parent: overlay,
      bottom: 0,
      left: 1,
      right: 1,
      height: 2,
      tags: true,
      content: `{center}{${theme.secondary}-fg}Space{/} Toggle {${theme.muted}-fg}│{/} {${theme.secondary}-fg}Enter{/} Download {${theme.muted}-fg}│{/} {${theme.secondary}-fg}Esc{/} Back{/center}`,
      style: { fg: overlayStyle.fg, bg: overlayStyle.bg },
    });

    fileList.select(0);
    fileList.focus();
    screen.render();

    // 元素级按键(原因见 showQuantizationSelector 注释)
    fileList.on('keypress', async (_ch: string, key: any) => {
      if (isModalOpen()) return;
      const name = key && key.name;

      if (name === 'space') {
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
        return;
      }

      if (name === 'enter') {
        if (selectedFiles.size === 0) {
          showMessage('Please select at least one file.', 'error');
          return;
        }
        const filesToDownload = Array.from(selectedFiles).map(i => allFiles[i].file);
        overlay.destroy();
        await startDownloadProcess(repo, filesToDownload, estimates, systemInfo);
        return;
      }

      if (name === 'escape') {
        overlay.destroy();
        showQuantizationSelector(repo);
      }
    });
  }

  async function startDownloadProcess(
    repo: HFRepo,
    files: HFFile[],
    estimates: QuantizationEstimate[],
    systemInfo: SystemInfo,
    managerOverride?: DownloadManagerLike
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

    // 使用 Download Manager 显示进度(内置/aria2 后端由工厂按配置选择)
    const manager = managerOverride || createDownloadManager({ maxConcurrent: 3 });

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
        speed: task.speed,
      });
      downloadManagerListKeys.push(key);
    }

    // 设置为全局活动下载
    setActiveDownloadManager(manager);
    openDownloadManager(true);

    // 开始下载
    try {
      await manager.start();

      // 有任务失败时不能走完成路径:否则会给缺文件的模型生成预设并提示成功
      // (2026-08-19 实机案例:主模型 94% 失败,仍生成预设 + "Download completed")
      const failedTasks = manager.getTasks().filter(t => t.status === 'failed');
      if (failedTasks.length > 0) {
        setActiveDownloadManager(null);
        const detail = failedTasks
          .map(t => `${t.filename}: ${t.error || 'unknown error'}`)
          .join('; ');
        showMessage(`Download incomplete (${detail}). Resume in Download Manager.`, 'error');
        return;
      }

      // 下载完成，开始校验
      const completedTasks = manager.getTasks().filter(t => t.status === 'completed');
      
      let verifyContent = '';
      let allValid = true;
      
      for (const task of completedTasks) {
        if (task.expectedSha256) {
          verifyContent += `{#ffffff-fg}Verifying ${task.filename}...{/}\n`;
          showMessage(verifyContent.trim(), 'info');
          
          const result = await verifySha256(task.destPath, task.expectedSha256, (p) => {
            const bar = createProgressBar(p.percent, 30, theme, false);
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
    let content = `{bold}{#87d787-fg}Download completed successfully!{/}{/bold}\n\n`;
    content += `{#ffffff-fg}Created preset(s):{/}\n`;
    presetNameList.forEach(name => {
      content += `  {#5fafff-fg}• ${name}{/}\n`;
    });
    content += `\n{#585858-fg}[Enter] Close{/}`;

    // Enter 与 Esc 都执行同一关闭动作
    const close = () => {
      loadPresetsList();
      loadModels();
      showMessage(`Preset(s) ready: ${presetNameList.join(', ')}`, 'success');
    };

    const opened = confirmDialog(screen, content, close, {
      label: ' Download Complete ',
      width: 60,
      height: Math.min(presetNameList.length + 8, 15),
      borderColor: theme.success,
      fg: overlayStyle.fg,
      bg: overlayStyle.bg,
      confirmKeys: ['enter'],
      cancelKeys: ['escape'],
      onCancel: close,
    });
    // 已有模态框打开时弹窗被跳过,但刷新副作用(preset/模型列表、提示)仍要执行
    if (!opened) close();
  }

  function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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
      const bar = createProgressBar(percent, 20, theme, false);
      const statusLabel = entry.status === 'paused'
        ? `{#d7af5f-fg}Paused{/}`
        : entry.status === 'failed'
        ? `{#d75f5f-fg}Failed{/}`
        : entry.status === 'completed'
        ? `{#87d787-fg}Done{/}`
        : `{#5fafff-fg}Running{/}`;

      items.push(`${checked} {#ffffff-fg}${meta.modelId}{/} {#585858-fg}${meta.filename}{/} ${statusLabel}`);
      // 仅下载中显示实时速度;暂停/失败/完成时 speed 为陈旧值或 0,不展示
      const speedLabel = entry.status === 'downloading'
        ? ` {#87d787-fg}${formatSize(entry.speed)}/s{/}`
        : '';
      items.push(`  [${bar}] {#5fafff-fg}${formatSize(downloaded)} / ${formatSize(total)} (${percent}%){/}${speedLabel}`);
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

  function setActiveDownloadManager(manager: DownloadManagerLike | null): void {
    // 替换/清空 manager 前先摘掉旧 progress 监听,避免陈旧闭包累积并触发渲染
    if (activeDownloadManager && activeDownloadProgressHandler) {
      activeDownloadManager.off('progress', activeDownloadProgressHandler);
      activeDownloadProgressHandler = null;
    }
    activeDownloadManager = manager;
    activeDownloadPaused = false;
    activeDownloadSnapshot.clear();
    downloadManagerSelectedKeys.clear();
    downloadManagerListKeys = [];
    activeDownloadTaskIds.clear();

    if (!manager) {
      updateDownloadManagerList();
      // 下载到达终态(完成/失败/取消),.meta.json 可能已增删,
      // 置失效并做一次全量状态刷新,保证 "⚠ N incomplete" 角标及时更新
      invalidateIncompleteScanCache();
      updateStatus();
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
        speed: task.speed,
      });
      downloadManagerListKeys.push(key);
      activeDownloadTaskIds.set(key, task.id);
    }

    activeDownloadProgressHandler = (progress: DownloadProgress) => {
      for (const task of progress.tasks) {
        if (!task.meta) continue;
        const key = buildDownloadKey(task.meta.modelId, task.filename);
        const entry = activeDownloadSnapshot.get(key);
        if (entry) {
          entry.downloadedBytes = task.downloadedBytes;
          entry.status = task.status;
          entry.speed = task.speed;
        }
        activeDownloadTaskIds.set(key, task.id);
      }
      updateDownloadManagerList();
      // 轻量刷新状态栏下载段,不做全量 PID/配置/磁盘扫描
      updateDownloadStatusSegment();
    };
    manager.on('progress', activeDownloadProgressHandler);

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
      // 打开下载管理器时已做过全量扫描,顺手刷新状态栏计数缓存
      incompleteScanCache = { time: Date.now(), count: incomplete.length };
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
          speed: 0, // 磁盘扫描出的未完成任务不在跑,无速度
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
      shadow: true,
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

    blessed.box({
      parent: downloadManagerOverlay,
      bottom: 0,
      left: 1,
      right: 1,
      height: 2,
      tags: true,
      content: `{center}{${theme.secondary}-fg}Space{/} Select {${theme.muted}-fg}│{/} {${theme.secondary}-fg}R/Enter{/} Resume {${theme.muted}-fg}│{/} {${theme.secondary}-fg}P{/} Pause {${theme.muted}-fg}│{/} {${theme.secondary}-fg}D{/} Delete {${theme.muted}-fg}│{/} {${theme.secondary}-fg}Esc{/} Back{/center}`,
      style: { fg: overlayStyle.fg, bg: overlayStyle.bg },
    });

    updateDownloadManagerList();
    downloadManagerList.select(0);
    downloadManagerList.focus();

    // 元素级按键分发:Element.key() 是程序级全局注册,overlay 销毁后处理器
    // 仍累积在 program 上反复触发(按键串扰的根源);on('keypress') 仅当
    // 焦点在该列表时触发,且随列表销毁自动失效
    const dmKeyHandlers: Record<string, (() => void | Promise<void>)[]> = {};
    const dmKey = (names: string, handler: () => void | Promise<void>) => {
      for (const n of names.split(',')) {
        (dmKeyHandlers[n.trim()] ||= []).push(handler);
      }
    };
    downloadManagerList.on('keypress', (_ch: string, key: any) => {
      const handlers = key && dmKeyHandlers[key.name];
      if (!handlers) return;
      for (const h of handlers) h();
    });

    dmKey('space', () => {
      if (isModalOpen()) return;
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

    dmKey('a', () => {
      if (isModalOpen()) return;
      if (downloadManagerSelectedKeys.size === downloadManagerListKeys.length) {
        downloadManagerSelectedKeys.clear();
      } else {
        downloadManagerSelectedKeys = new Set(downloadManagerListKeys);
      }
      updateDownloadManagerList();
    });

    dmKey('p', () => {
      if (isModalOpen()) return;
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

    dmKey('d', async () => {
      if (isModalOpen()) return;
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
        try {
          const metaPath = getModelStoragePath(config.modelsDir, entry.meta.modelId, entry.meta.filename) + '.meta.json';
          const partialPath = getModelStoragePath(config.modelsDir, entry.meta.modelId, entry.meta.filename) + '.partial';
          deletePartialFile(partialPath);
          deleteDownloadMeta(metaPath);
          // aria2 后端的控制文件(若存在)一并清掉,避免残留孤儿
          deletePartialFile(partialPath + '.aria2');
          cleanupEmptyDirs(config.modelsDir, partialPath);
        } catch (err: any) {
          // meta 损坏 (如手改 modelId) 不应使 TUI 崩溃
          showMessage(`Failed to delete partial download: ${err?.message || err}`, 'error');
          continue;
        }
        activeDownloadSnapshot.delete(key);
        activeDownloadTaskIds.delete(key);
      }
      downloadManagerSelectedKeys.clear();
      downloadManagerListKeys = Array.from(activeDownloadSnapshot.keys());
      // 删除后未完成下载数量已变,下次状态栏刷新需重扫
      invalidateIncompleteScanCache();
      updateDownloadManagerList();
    });

    dmKey('r,enter', async () => {
      if (isModalOpen()) return;
      if (activeDownloadManager) {
        // 暂停中按 R/Enter:直接恢复,而不是只提示"已在下载"
        if (activeDownloadPaused) {
          activeDownloadPaused = false;
          activeDownloadManager.resume();
          updateDownloadManagerList();
          return;
        }
        showMessage('Download already running.', 'info');
        return;
      }

      const config = getExpandedConfig();
      const incomplete = scanIncompleteDownloads(config.modelsDir);
      // 续传前已做过全量扫描,顺手刷新状态栏计数缓存
      incompleteScanCache = { time: Date.now(), count: incomplete.length };
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

      // meta 损坏 (如手改 modelId) 不应使 TUI 崩溃:续传前先校验 modelId 可解析,
      // 否则 startDownloadProcess 里的 getModelDir 会在 async 回调中抛未处理异常
      for (const item of items) {
        try {
          getModelDir(config.modelsDir, item.meta.modelId);
        } catch (err: any) {
          showMessage(`Failed to resume download: ${err?.message || err}`, 'error');
          return;
        }
      }

      const manager = createDownloadManager({ maxConcurrent: 3 });
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
      const systemInfo = await getSystemInfo();
      const fakeEstimates: QuantizationEstimate[] = [];

      await startDownloadProcess(fakeRepo, files, fakeEstimates, systemInfo, manager);
    });

    dmKey('h', () => {
      if (isModalOpen()) return;
      hideDownloadManager();
    });

    dmKey('escape', () => {
      if (isModalOpen()) return;
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
    downloadManagerVisible = false;
    menuBox.focus();
    screen.render();
  }

  async function showDownloadManager(): Promise<void> {
    openDownloadManager(true);
  }

  async function confirmDeleteDownloads(count: number): Promise<boolean> {
    return new Promise((resolve) => {
      const opened = confirmDialog(
        screen,
        `{#d7af5f-fg}Delete ${count} incomplete download(s)?{/}\n\n` +
        `{#585858-fg}This will remove .partial and metadata files.{/}\n\n` +
        `{#87d787-fg}[Y]{/} Yes  {#d75f5f-fg}[N]{/} No`,
        () => resolve(true),
        {
          label: ' Confirm Delete ',
          width: 60,
          height: 8,
          borderColor: theme.warning,
          fg: overlayStyle.fg,
          bg: overlayStyle.bg,
          onCancel: () => resolve(false),
        },
      );
      // 已有模态框打开:不叠加,视为取消
      if (!opened) resolve(false);
    });
  }

  // resumeDownloads removed - resume is handled inline in Download Manager

  // ========== 结束模型下载功能 ==========

  // 退出确认对话框
  async function handleExit(): Promise<void> {
    const status = getServerStatus();

    if (status.running || proxyServer) {
      confirmDialog(
        screen,
        `{bold}Server is still running!{/bold}\n\n` +
        `{${theme.secondary}-fg}[Y]{/} Stop server and exit\n` +
        `{${theme.secondary}-fg}[N]{/} Exit without stopping\n` +
        `{${theme.secondary}-fg}[Esc]{/} Cancel`,
        async () => {
          showMessage('Stopping server before exit...', 'info');
          stopProxy();
          try {
            await stopServer();
          } catch {}
          cleanup();
          process.exit(0);
        },
        {
          label: ' Exit ',
          width: 50,
          height: 9,
          borderColor: theme.warning,
          fg: theme.text,
          bg: theme.surface0,
          // 三选一:n = 直接退出(停代理/ watcher,不停服务器),Esc = 取消
          onNo: () => {
            cleanup();
            process.exit(0);
          },
        },
      );
    } else {
      cleanup();
      process.exit(0);
    }
  }

  // 清理残留进程（启动时调用）:端口取自配置,杀前校验确为 llama-server,
  // 避免误杀占用同端口的其他程序(开发服务器、docker 代理等)
  async function cleanupOrphanProcesses(): Promise<void> {
    try {
      const config = getExpandedConfig();
      // llama-server 内部端口与代理对外端口(TUI/CLI 均按 defaultPort 与 defaultPort+1 配对);
      // 只查 LISTEN 状态的 TCP 连接,避免误伤仅作为客户端连接这些端口的进程
      const output = execSync(`lsof -iTCP:${config.defaultPort} -iTCP:${config.defaultPort + 1} -sTCP:LISTEN -t 2>/dev/null || true`, { encoding: 'utf-8' });
      const pids = output.trim().split('\n').filter(p => p)
        .map(p => parseInt(p, 10))
        .filter(pid => !isNaN(pid) && isLlamaServerProcess(pid));

      if (pids.length > 0) {
        showMessage(`Found ${pids.length} orphan llama-server process(es) on ports ${config.defaultPort}/${config.defaultPort + 1}, cleaning up...`, 'info');
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {}
        }
        // 等待进程终止(异步,不阻塞 UI)
        await new Promise(r => setTimeout(r, 1000));
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
          if (logPaused) return;
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

  menuBox.on('select', async (_item, index) => {
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

  modelList.on('select', (_item, index) => {
    if (index >= 0 && index < models.length) {
      currentModel = models[index];
      showMessage(`Selected: ${currentModel.name}`, 'success');
      hideSubLists();
    }
  });

  presetList.on('select', async (_item, index) => {
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
    // 模态框打开时静默(Esc 由对话框自身处理)
    if (isModalOpen()) return;
    if (!modelList.hidden || !presetList.hidden) {
      hideSubLists();
    }
  });

  screen.key(['q', 'C-c'], async () => {
    // 模态框打开或文本输入中(blessed textbox 读入时 _reading=true)时静默
    if (isModalOpen() || isEditingInput(screen)) return;
    await handleExit();
  });

  screen.key(['r'], () => {
    if (isModalOpen() || isEditingInput(screen)) return;
    // 编辑模式下焦点在预设列表时,r 是"重命名"(元素级绑定),全局刷新让路
    if (presetEditMode && screen.focused === presetList) return;
    updateStatus();
    updateInfo();
    updateLogs();
    showMessage('Refreshed.', 'info');
  });

  screen.key(['l'], () => {
    if (isModalOpen() || isEditingInput(screen)) return;
    logPaused = !logPaused;
    if (logPaused) {
      stopLogWatcher();
      showMessage('Logs paused. Use l to resume.', 'info');
    } else {
      startLogWatcher();
      showMessage('Logs resumed.', 'success');
    }
  });

  screen.key(['s'], () => {
    if (isModalOpen() || isEditingInput(screen)) return;
    if (downloadManagerVisible) {
      if (downloadManagerList) downloadManagerList.focus();
      return;
    }
    if (activeDownloadManager) {
      openDownloadManager(true);
      return;
    }

    try {
      const dest = join(getConfigDir(), 'sys.log');
      const content = readLastLogs(100000);
      if (!content) {
        showMessage('No logs to save.', 'error');
        return;
      }
      writeFileSync(dest, content, 'utf-8');
      showMessage(`Saved logs to ${dest}`, 'success');
    } catch (err) {
      showMessage(`Failed to save logs: ${(err as Error).message}`, 'error');
    }
  });

  let focusedElement: 'menu' | 'model' | 'preset' | 'info' | 'resource' | 'serverLog' | 'requestLog' = 'menu';
  
  // 更新焦点边框高亮
  function updateFocusBorder(): void {
    // 重置所有边框
    menuBox.style.border = { fg: theme.border };
    infoBox.style.border = { fg: theme.border };
    resourceBox.style.border = { fg: theme.border };
    serverLogBox.style.border = { fg: theme.border };
    requestLogBox.style.border = { fg: theme.secondary };
    
    // 高亮当前焦点
    switch (focusedElement) {
      case 'menu':
        menuBox.style.border = { fg: theme.primary };
        break;
      case 'info':
        infoBox.style.border = { fg: theme.primary };
        break;
      case 'resource':
        resourceBox.style.border = { fg: theme.primary };
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
    if (isModalOpen() || isEditingInput(screen)) return;
    if (focusedElement === 'model' && !modelList.hidden) {
      focusedElement = 'menu';
      menuBox.focus();
    } else if (focusedElement === 'preset' && !presetList.hidden) {
      focusedElement = 'menu';
      menuBox.focus();
    } else if (focusedElement === 'menu') {
      // 模型/预设列表打开时 info/resource 是隐藏的,跳过隐藏面板
      if (!infoBox.hidden) {
        focusedElement = 'info';
        infoBox.focus();
      } else {
        focusedElement = 'serverLog';
        serverLogBox.focus();
      }
    } else if (focusedElement === 'info') {
      if (!resourceBox.hidden) {
        focusedElement = 'resource';
        resourceBox.focus();
      } else {
        focusedElement = 'serverLog';
        serverLogBox.focus();
      }
    } else if (focusedElement === 'resource') {
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
  infoBox.on('focus', () => { focusedElement = 'info'; updateFocusBorder(); });
  resourceBox.on('focus', () => { focusedElement = 'resource'; updateFocusBorder(); });
  serverLogBox.on('focus', () => { focusedElement = 'serverLog'; updateFocusBorder(); });
  requestLogBox.on('focus', () => { focusedElement = 'requestLog'; updateFocusBorder(); });

  // === 初始化 ===

  function cleanup(): void {
    stopLogWatcher();
    stopResourceWatcher();
    stopProxy();
    // 恢复终端:退出 alternate screen / mouse 模式,避免 shell 残留乱码状态
    screen.destroy();
  }

  async function init(): Promise<void> {
    // 启动时预热 GPU 数量缓存(Tensor Split 选项等热路径只读缓存)
    await warmSystemInfoCache();

    loadModels();
    loadPresetsList();
    
    // 检查是否有残留进程
    const status = getServerStatus();
    
    // 如果有 PID 文件记录的服务器在运行
    if (status.running && status.port) {
      currentInternalPort = status.port;
      
      if (status.proxy && status.publicPort) {
        // PID 文件记录经代理启动:按记录的对外端口补代理
        currentPublicPort = status.publicPort;
        try {
          await startProxy(currentPublicPort, currentInternalPort);
          showMessage(`Proxy reconnected on port ${currentPublicPort}`, 'success');
        } catch {
          // 清空 proxyServer 引用(失败时变量非空但未监听),避免状态栏误显示代理在跑
          stopProxy();
          showMessage(`Could not start proxy on port ${currentPublicPort}`, 'error');
        }
      } else {
        // 无代理启动(旧格式 PID 文件无 proxy 字段同此处理):不再按端口号猜测
        currentPublicPort = status.port;
        showMessage(`Note: Server running on port ${status.port} without proxy.`, 'info');
        showMessage(`Restart via TUI to enable request logging.`, 'info');
      }
      
      startLogWatcher();
      startResourceWatcher();
    } else if (!status.running) {
      // 无 PID 记录但配置端口可能被残留 llama-server 占用:检查并清理
      await cleanupOrphanProcesses();
    }

    updateStatus();
    updateInfo();
    updateResources();
    menuBox.focus();
    screen.render();
  }

  // 初始化失败(如模型目录权限不足):先恢复终端再报错退出,避免未处理拒绝崩溃
  init().catch(err => {
    try { screen.destroy(); } catch {}
    console.error(err);
    process.exit(1);
  });
}

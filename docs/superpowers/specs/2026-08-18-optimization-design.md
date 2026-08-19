# lsc 全面优化设计文档

日期:2026-08-18
范围:方案 C(高危修复 + 性能稳定性 + 结构重构)
状态:已获用户批准

## 背景

`lsc`(llama-server-cli)是管理 llama.cpp 服务器的 CLI+TUI 工具,约 6600 行 TypeScript,无测试、无 lint/CI。全库审查发现约 30 项问题,分三档。本设计覆盖全部三档,分四个阶段实施。

## 审查发现(按严重程度)

### 高危(数据损坏 / 安全)

1. **下载续传损坏**(`src/utils/downloader.ts:319-321, 353, 359-365, 418-433`)
   - Range 请求收到 HTTP 200 时仍以 append 模式打开 `.partial`,全量数据追加到已有字节后 → 文件损坏
   - 续传偏移用内存计数 `task.downloadedBytes` 而非磁盘实际大小 → 可能产生空洞
   - 无 416 / 超大 partial 处理 → 重试 3 次后失败
   - 暂停时触发的重试被静默丢弃,任务卡在 `downloading` 但无请求,`processQueue` 误报 complete
2. **Shell 注入**(`src/utils/downloader.ts:572`):`execSync` 拼接 `dir`(含用户输入的 `modelId`),双引号不防 `$()`/反引号。同类:`getModelDir`/`getModelStoragePath` 未校验 `modelId` → 路径穿越(`src/utils/preset-generator.ts:242-267`)
3. **量化名前缀误匹配**(`src/utils/hf-api.ts:70-78`):`Q4_K` 先于 `Q4_K_M` 命中,`upper.includes(q)` 取首个短匹配 → `Q4_K_M` 被标为 `Q4_K`,同名仓库两种量化坍缩为一个选项并可能被同时下载
4. **配置/预设静默丢失**(`src/utils/config-manager.ts:34-41,47`;`src/utils/preset-manager.ts:14-19,24`;`src/utils/download-meta.ts:28`;`src/utils/process-manager.ts:36`):JSON 解析失败静默返回默认/空,下次写入覆盖原文件;写入非原子(无 tmp+rename)
5. **流缺 error 处理**(`src/utils/downloader.ts:340-399`;`src/utils/request-logger.ts:123-185`):`res`/`proxyRes` 无 `error` 监听 → 进程崩溃;abort 不销毁写流 → fd 泄漏;`writeHead(502)` 未防 `headersSent`;客户端断开不终止上游

### 中危(性能 / 稳定性)

6. **TUI 卡顿**:
   - `updateStatus` 在每次下载进度事件(500ms 一次)中递归扫描整个模型目录(`src/tui/index.ts:427-460` → `src/utils/download-meta.ts:80-123`)
   - `updateResources`/`updateLogs` 每 2s `execSync` nvidia-smi/free/tail(`src/tui/index.ts:496-582`),单次 nvidia-smi 30-200ms
   - `getTensorSplitOptions` 在方向键 keypress 上调用带 5s 超时的 `execSync` nvidia-smi(`src/tui/index.ts:653-655` → `src/utils/model-recommender.ts:98-101`)
   - 删除模型用 `rmSync` 同步删多 GB 目录(`src/tui/index.ts:987`)
7. **TUI 稳定性**:全局快捷键在输入框聚焦/对话框打开时仍触发(`src/tui/index.ts:2579-2656`);对话框非模态可叠层;代理启动失败后 llama-server 成孤儿(`724-738, 871-885`);`handleRestartServer` 不先停代理(`766-775`);`handleStopServer` 部分失败跳过清理(`741-764`);`init` 用 `port % 10` 猜代理状态(`2705-2721`);退出不 `screen.destroy()`;`updateLogs` 每 2s 强制滚到底
8. **进程管理**(`src/utils/process-manager.ts`):PID 复用可能误杀;EPERM 误判为不运行并删 PID 文件;SIGKILL 后不验证死亡;start 无锁存在 TOCTOU;`cleanupOrphanProcesses` 硬编码 8080/8081 杀任意进程且 `execSync('sleep 1')` 阻塞(`src/tui/index.ts:2417-2435`)
9. **网络**:所有 HTTP 请求无超时(`downloader.ts:340`, `hf-api.ts:189`);HF tree 不递归不分页(`hf-api.ts:225`);重定向不消费响应体、无次数上限、token 泄漏给非 HF 主机(`downloader.ts:342-350`, `hf-api.ts:191-197`);请求日志代理按字符串拼接 body(UTF-8 截断损坏)+ 无上限累积(`request-logger.ts:75-79,127-132`)
10. **CLI 功能缺陷**:`lsc start <preset>` 只复制 9 个预设字段,丢弃 `useVision/fit/batchSize/threadsBatch/cachePrompt/cacheReuse/kvCacheType/chatTemplate/mmproj`(`src/commands/start.ts:84-94`);`--no-vision` 被接受但从不生效(`start.ts:121` vs `211-227`);`DEFAULT_SERVER_OPTIONS` 预填充使 `config.defaultX` 回退全部失效(`start.ts:75, 214-225`);数字选项无 NaN 校验(`-c abc` → `-c NaN` 传给 llama-server)
11. **推荐器**:按总 VRAM 而非可用 VRAM 判断 fits(`src/utils/model-recommender.ts:194,285`);`estimateModelSize` 不用仓库文件的真实 LFS 大小(`141-145`);GPU 层数下限钳到 10(`294`)

### 低危(代码质量)

12. 约 40 处死代码/未用导入;`commands/proxy.ts` 与 `utils/request-logger.ts` 两套重复实现;默认值三处拷贝(`types.ts` DEFAULT_CONFIG / DEFAULT_SERVER_OPTIONS / `preset.ts` 硬编码);`config.ts` validKeys 缺 `hfToken`;`index.ts` 版本号硬编码
13. 仓库卫生:`config.json`、`presets.json`、`patch-test-live.js`、`test-patch4.js` 四个开发残留文件被 git 跟踪;`opencode.json` 保留不动
14. tsconfig 已有 `strict`,缺 `noImplicitReturns`、`noFallthroughCasesInSwitch`、`noUnusedLocals`、`noUnusedParameters`(前两个零成本,后两个约 40 处小改)

## 实施阶段

### 阶段 0 — 测试安全网

- 引入 vitest(仅 devDependency)
- 新建 `src/utils/server-options.ts`(`命令行 ?? 预设 ?? config ?? 内置默认` 单点解析)并先写测试;该模块在阶段 2 接入 CLI、阶段 3 接入 TUI
- 覆盖高价值纯逻辑:量化名匹配(hf-api)、预设→启动选项合并、配置/预设原子写入与损坏恢复、数字参数解析
- 下载续传用 mock HTTP 覆盖 200/206/416 分支
- 验收:`npm test` 全绿

### 阶段 1 — 高危修复

对应发现 1-5:
- 续传:每次(重)试前 `statSync` `.partial` 取实际大小;Range 请求收到 200 → 截断为 0 重下;416 → partial 已达预期大小视为完成,否则删除重下;暂停中重试 → 置 `pending` 走统一 `processQueue`
- 注入:`execFileSync` 数组参数;入口处校验 `modelId` 匹配 `/^[\w.-]+\/[\w.-]+$/`
- 量化:模式按长度降序排列再匹配
- 流:所有流补 `error` 处理;abort 销毁写流;`writeHead` 前查 `headersSent`;客户端 `close` 时销毁上游请求
- 原子写:config/presets/meta/PID 统一 tmp+rename;解析失败备份 `.bak` 并告警

### 阶段 2 — 性能与稳定性

对应发现 6-11:
- TUI:`getSystemInfo`/GPU 数量启动时缓存一次;`nvidia-smi`/`free`/`tail` 改异步;下载进度回调只更新状态栏下载段,不完整 `updateStatus`;`updateLogs` 内容未变不重绘、不在底部不强拉;删模型改 `fs.promises.rm`
- 模态:引入模态深度/输入聚焦标志,全局快捷键(hotkey)统一检查;确认对话框抽公共 `confirmDialog` helper
- 代理/服务编排:代理失败回滚停 server;`handleRestartServer` 先 `stopProxy`;`handleStopServer` 用 `finally` 清理状态
- 进程:PID 文件记录并校验进程身份(`/proc/<pid>/cmdline` 或启动时间);EPERM 视为存活;确认死亡后才删 PID 文件;孤儿清理只杀校验过的 llama-server 且用配置端口,去掉 `execSync('sleep 1')`;PID 文件记录 `proxy` 标志取代 `port % 10` 猜测;start 加锁
- 网络:全部 HTTP 请求加 `setTimeout`;HF tree `?recursive=true` + 分页;重定向 `res.resume()` + 上限 5 次 + token 仅发 HF 域名;请求日志代理 Buffer.concat + 上限截断 + 客户端断开终止上游
- 推荐器:用 `availableVRAM`;优先用文件真实大小;GPU 层数下限钳到 ≥0
- CLI:`start.ts` 接入 `server-options.ts`(顺带修复:预设字段丢失、`--no-vision` 失效、config 默认值不生效);数字参数统一 `parseIntOpt` helper(radix 10 + NaN 报错)

### 阶段 3 — 结构重构

对应发现 12-14,且必须在 0-2 完成后动:
- TUI 切换到共享的 `server-options.ts`;删除 `DEFAULT_SERVER_OPTIONS` 与 `preset.ts` 硬编码默认值(单点来源)
- `commands/proxy.ts` 改为 `utils/request-logger.ts` 的薄封装
- 死代码清理;tsconfig 加 `noImplicitReturns`、`noFallthroughCasesInSwitch`、`noUnusedLocals`、`noUnusedParameters`
- 删除 4 个 git 跟踪的开发残留文件(`git rm` 前需用户确认)
- TUI 机械式拆分:抽出 GPU/系统信息、`confirmDialog`、下载管理 UI、预设编辑器为独立模块;交互设计不变,纠缠部分不强拆

## 边界(明确不做)

- CLI 接口与 TUI 交互不变;不升级现有依赖;不重写 blessed 层;不动 `opencode.json`
- TUI 与 process-manager 不可测部分不强求单测
- `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` 不启用(性价比低)

## 验证

- 每阶段结束:`npm run build`(strict 零错误)+ `npm test`
- 完成后手动冒烟:`lsc models` / `lsc config list` / `lsc preset list` / `lsc status` / 启动 TUI 检查主流程

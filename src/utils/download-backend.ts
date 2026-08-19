/**
 * 下载后端工厂:按 config.downloadBackend 与 aria2c 可用性二选一
 */

import { DownloadManager, DownloadManagerLike, DownloadManagerOptions } from './downloader.js';
import { Aria2DownloadManager, isAria2Available } from './aria2-downloader.js';
import { loadConfig } from './config-manager.js';

export function createDownloadManager(options: DownloadManagerOptions = {}): DownloadManagerLike {
  const config = loadConfig();
  const backend = config.downloadBackend ?? 'auto';
  const wantAria2 = backend === 'aria2' || backend === 'auto';

  if (wantAria2 && isAria2Available()) {
    // aria2 会把 --header 的 Authorization 透传到重定向目标域名(1.36 实测),
    // 配置了 HF token 时回退内置下载器,避免 token 泄漏到 CDN。
    // 公开仓库不带 token 时不受此限,照常享受 aria2 多连接
    if (config.hfToken) {
      return new DownloadManager(options);
    }
    return new Aria2DownloadManager(options);
  }

  return new DownloadManager(options);
}

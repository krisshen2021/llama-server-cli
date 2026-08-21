import http from 'http';

// 解析 Prometheus 文本 exposition:跳过注释/空行,`name value` 与 `name{labels} value`
// 两种形态都按裸指标名收纳(标签维度目前用不到,llama-server 的计数器基本无标签)
export function parsePrometheusMetrics(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const sp = line.indexOf(' ');
    if (sp <= 0) continue;
    const rawName = line.slice(0, sp);
    const brace = rawName.indexOf('{');
    const name = brace >= 0 ? rawName.slice(0, brace) : rawName;
    const value = Number(line.slice(sp + 1).trim());
    if (!name || Number.isNaN(value)) continue;
    out.set(name, value);
  }
  return out;
}

// 解码速度所需的两个累计计数器
export interface DecodeMetrics {
  tokensTotal: number;   // llamacpp:tokens_predicted_total
  secondsTotal: number;  // llamacpp:tokens_predicted_seconds_total
}

// 拉取 llama-server 的 /metrics;未开 --metrics(501)、连接失败或超时都返回 null,
// 调用方(TUI 周期刷新)据此静默跳过本轮显示
export function fetchDecodeMetrics(port: number, timeoutMs = 1000): Promise<DecodeMetrics | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/metrics', timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        const m = parsePrometheusMetrics(body);
        const tokensTotal = m.get('llamacpp:tokens_predicted_total');
        const secondsTotal = m.get('llamacpp:tokens_predicted_seconds_total');
        if (tokensTotal === undefined || secondsTotal === undefined) {
          resolve(null);
          return;
        }
        resolve({ tokensTotal, secondsTotal });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

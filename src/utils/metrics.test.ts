import { describe, test, expect } from 'vitest';
import { parsePrometheusMetrics } from './metrics.js';

const SAMPLE = `# HELP llamacpp:requests_processing Number of requests being processed
# TYPE llamacpp:requests_processing gauge
llamacpp:requests_processing 1
llamacpp:prompt_seconds_total 4.80499
llamacpp:tokens_predicted_total 6950
llamacpp:tokens_predicted_seconds_total 124.539
llamacpp:n_decode_total 7
llamacpp:n_tokens_max 262144
llamacpp:spec_decode_num_accepted_tokens_total{slot="0"} 5049
`;

describe('parsePrometheusMetrics', () => {
  test('解析标量计数器与浮点值', () => {
    const m = parsePrometheusMetrics(SAMPLE);
    expect(m.get('llamacpp:tokens_predicted_total')).toBe(6950);
    expect(m.get('llamacpp:tokens_predicted_seconds_total')).toBeCloseTo(124.539);
    expect(m.get('llamacpp:n_tokens_max')).toBe(262144);
  });

  test('带标签的行按裸指标名收纳', () => {
    const m = parsePrometheusMetrics(SAMPLE);
    expect(m.get('llamacpp:spec_decode_num_accepted_tokens_total')).toBe(5049);
  });

  test('注释/空行/垃圾输入不产生条目', () => {
    expect(parsePrometheusMetrics('').size).toBe(0);
    expect(parsePrometheusMetrics('# only a comment\n\n').size).toBe(0);
    expect(parsePrometheusMetrics('not a number line').size).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { pickLanIPv4 } from './system-info.js';

const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal });

describe('pickLanIPv4', () => {
  it('物理网卡(en*/eth*/wl*)优先于虚拟网卡', () => {
    const nics = {
      'docker0': [v4('172.17.0.1')],
      'enp5s0': [v4('192.168.31.5')],
      'tailscale0': [v4('100.64.1.1')],
    };
    expect(pickLanIPv4(nics)).toBe('192.168.31.5');
  });

  it('只有虚拟网卡时退而取虚拟网卡', () => {
    const nics = {
      'docker0': [v4('172.17.0.1')],
      'tailscale0': [v4('100.64.1.1')],
    };
    expect(pickLanIPv4(nics)).toBe('172.17.0.1');
  });

  it('跳过 loopback 与链路本地(169.254)', () => {
    const nics = {
      'lo': [v4('127.0.0.1', true)],
      'enp5s0': [v4('169.254.1.1'), v4('10.0.0.8')],
    };
    expect(pickLanIPv4(nics)).toBe('10.0.0.8');
  });

  it('无可用地址返回 undefined', () => {
    expect(pickLanIPv4({ 'lo': [v4('127.0.0.1', true)] })).toBeUndefined();
    expect(pickLanIPv4({})).toBeUndefined();
  });

  it('兼容旧版 Node 的数值 family', () => {
    const nics = {
      'enp5s0': [{ address: '192.168.1.10', family: 4, internal: false }],
    };
    expect(pickLanIPv4(nics as any)).toBe('192.168.1.10');
  });
});

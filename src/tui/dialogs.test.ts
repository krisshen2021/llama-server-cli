import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'stream';
import blessed from 'blessed';
import { confirmDialog, isModalOpen } from './dialogs.js';

// 无真实终端的 blessed screen:输入输出用内存流,只为测试对话框按键行为
function makeScreen(): blessed.Widgets.Screen {
  return blessed.screen({
    smartCSR: false,
    input: new PassThrough(),
    output: new PassThrough(),
    terminal: 'xterm-256color',
    autoPadding: true,
  } as any);
}

const screens: blessed.Widgets.Screen[] = [];

afterEach(() => {
  for (const s of screens.splice(0)) {
    try { s.destroy(); } catch {}
  }
});

describe('confirmDialog 模态对话框', () => {
  it('焦点被其他元素抢走后,确认键依然生效(不陷死)', async () => {
    const screen = makeScreen();
    screens.push(screen);
    // 一个会抢焦点的干扰元素(模拟鼠标点击落到下层组件)
    const thief = blessed.box({ parent: screen, focusable: true, keys: true });

    let confirmed = 0;
    const opened = confirmDialog(screen, 'test', () => { confirmed++; }, {
      confirmKeys: ['enter'],
      cancelKeys: ['escape'],
    });
    expect(opened).toBe(true);
    expect(isModalOpen()).toBe(true);

    // 焦点被抢走:对话框不再是焦点元素
    thief.focus();
    expect(screen.focused).toBe(thief);

    // 按键经由 screen 派发(焦点不在对话框上),确认键必须仍然生效
    screen.emit('keypress', undefined, { name: 'enter' });
    expect(confirmed).toBe(1);
    await Promise.resolve(); // modalDepth 在微任务里递减
    expect(isModalOpen()).toBe(false);
  });

  it('焦点被抢走后,取消键触发 onCancel', async () => {
    const screen = makeScreen();
    screens.push(screen);
    const thief = blessed.box({ parent: screen, focusable: true, keys: true });

    let cancelled = 0;
    confirmDialog(screen, 'test', () => {}, {
      confirmKeys: ['enter'],
      cancelKeys: ['escape'],
      onCancel: () => { cancelled++; },
    });
    thief.focus();

    screen.emit('keypress', undefined, { name: 'escape' });
    expect(cancelled).toBe(1);
    await Promise.resolve();
    expect(isModalOpen()).toBe(false);
  });

  it('无关按键不会关闭对话框', async () => {
    const screen = makeScreen();
    screens.push(screen);

    let confirmed = 0;
    let cancelled = 0;
    confirmDialog(screen, 'test', () => { confirmed++; }, {
      confirmKeys: ['enter'],
      cancelKeys: ['escape'],
      onCancel: () => { cancelled++; },
    });

    screen.emit('keypress', undefined, { name: 'a' });
    expect(confirmed).toBe(0);
    expect(cancelled).toBe(0);
    expect(isModalOpen()).toBe(true);

    // 收尾:按取消键关掉,避免模态深度泄漏到其他用例
    screen.emit('keypress', undefined, { name: 'escape' });
    await Promise.resolve();
    expect(isModalOpen()).toBe(false);
  });
});

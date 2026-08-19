import blessed from 'blessed';

// 模态深度:>0 时全局快捷键应静默
let modalDepth = 0;

export function isModalOpen(): boolean {
  return modalDepth > 0;
}

// 焦点元素是否正在接收文本输入
// (blessed textbox 读入时 _reading=true;editing 防御性兼容其他实现)
export function isEditingInput(screen: blessed.Widgets.Screen): boolean {
  const focused = screen.focused as unknown as
    | { editing?: boolean; _reading?: boolean }
    | undefined;
  return !!(focused && (focused.editing || focused._reading));
}

export interface ConfirmDialogOptions {
  // 外观(默认与既有 Catppuccin 对话框一致,颜色由调用方按场景传入)
  label?: string;
  width?: number | string;
  height?: number | string;
  borderColor?: string;
  fg?: string;
  bg?: string;
  // 行为
  confirmKeys?: string[]; // 默认 ['y']
  cancelKeys?: string[];  // 默认 ['n', 'escape']
  onNo?: () => void;      // 设置后 'n' 单独走此回调(三选一场景,如退出确认)
  onCancel?: () => void;  // 取消键(n/Esc,或 onNo 设置后的 Esc)回调
}

// 模态确认框:同屏最多一个,独占焦点,按键不再穿透到下层列表/菜单。
// 返回 false 表示已有模态框打开,本次未创建(调用方按"取消"处理)。
// 注意:在另一个对话框的回调中同步调用也会返回 false(深度在微任务中才递减)。
export function confirmDialog(
  screen: blessed.Widgets.Screen,
  content: string,
  onConfirm: () => void,
  options: ConfirmDialogOptions = {},
): boolean {
  if (isModalOpen()) return false;
  modalDepth++;

  // 记录打开前的焦点,关闭时恢复(原对话框不抢焦点,关闭后焦点不动)
  const prevFocus = screen.focused as blessed.Widgets.BlessedElement | undefined;

  const box = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: options.width ?? '50%',
    height: options.height ?? 'shrink',
    label: options.label,
    tags: true,
    shadow: true,
    border: { type: 'line' },
    style: {
      fg: options.fg,
      bg: options.bg,
      border: { fg: options.borderColor ?? 'yellow' },
    },
    padding: { left: 2, right: 2, top: 1 },
    keys: true,
  });
  box.setContent(content);

  const confirmKeys = options.confirmKeys ?? ['y'];
  const cancelKeys = options.cancelKeys ?? ['n', 'escape'];

  const cleanup = () => {
    screen.removeListener('keypress', keyHandler);
    // 延迟到本次按键事件全部派发完再降深度:
    // blessed 的 _listenKeys 在 program 'keypress' 中先派发 screen 级
    // 'keypress'/'key x'(screen.key 绑定的是 screen 级 'key x',在此触发),
    // 最后才轮到焦点元素的 keypress;微任务确保同一派发周期内的所有
    // 处理器(包括焦点元素自身之后可能触发的路径)仍视模态框为打开
    queueMicrotask(() => {
      modalDepth--;
    });
    box.destroy();
    // 恢复之前焦点(元素可能已被销毁,需防御)
    if (prevFocus && !(prevFocus as any).destroyed) {
      try {
        prevFocus.focus();
      } catch {
        // 元素已销毁,忽略
      }
    }
    screen.render();
  };

  // 挂在 screen 级而非 box 元素级:鼠标点击下层组件(mouse:true 的列表/日志框)
  // 会抢走焦点,若按键只认 box 的焦点态,模态将永远无法关闭——全局键又被
  // isModalOpen 吞掉,界面死锁(2026-08-19 实机复现)。screen 级监听与焦点无关
  const keyHandler = (_ch: string, key: any) => {
    const name = key && key.name;
    if (!name) return;
    if (confirmKeys.includes(name)) {
      cleanup();
      onConfirm();
    } else if (name === 'n' && options.onNo) {
      cleanup();
      options.onNo();
    } else if (cancelKeys.includes(name)) {
      cleanup();
      options.onCancel?.();
    }
  };
  screen.on('keypress', keyHandler);

  box.focus();
  screen.render();
  return true;
}

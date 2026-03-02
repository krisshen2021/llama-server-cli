import blessed from 'blessed';

// patch using blessed.widget.Element
const blessedElement = (blessed as any).widget.Element;
const originalRender = blessedElement.prototype.render;
blessedElement.prototype.render = function(this: any) {
  const ret = originalRender.apply(this, arguments);
  if (this.border && this.border.type === 'line' && this.lpos) {
    const coords = this.lpos;
    const lines = this.screen.lines;
    const yi = coords.yi, yl = coords.yl - 1;
    const xi = coords.xi, xl = coords.xl - 1;
    if (yi >= 0 && yi < lines.length && yl > 0 && yl < lines.length) {
      if (lines[yi] && lines[yi][xi] && lines[yi][xi][1] === '\u250c') {
        lines[yi][xi][1] = '\u256d'; lines[yi].dirty = true;
      }
      if (lines[yi] && lines[yi][xl] && lines[yi][xl][1] === '\u2510') {
        lines[yi][xl][1] = '\u256e'; lines[yi].dirty = true;
      }
      if (lines[yl] && lines[yl][xi] && lines[yl][xi][1] === '\u2514') {
        lines[yl][xi][1] = '\u2570'; lines[yl].dirty = true;
      }
      if (lines[yl] && lines[yl][xl] && lines[yl][xl][1] === '\u2518') {
        lines[yl][xl][1] = '\u256f'; lines[yl].dirty = true;
      }
    }
  }
  return ret;
};

const screen = blessed.screen({ smartCSR: true });
const box = blessed.box({
  parent: screen,
  top: 0, left: 0, width: 40, height: 10,
  border: { type: 'line' },
  shadow: true,
  content: 'Hello'
});

screen.key(['q', 'C-c'], () => process.exit(0));

screen.render();

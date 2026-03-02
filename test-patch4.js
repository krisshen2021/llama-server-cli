import blessed from 'blessed';
import fs from 'fs';

const blessedElement = (blessed as any).widget.Element;
const originalRender = blessedElement.prototype.render;
blessedElement.prototype.render = function() {
  const ret = originalRender.apply(this, arguments);
  if (this.border && this.border.type === 'line' && this.lpos) {
    const coords = this.lpos;
    const lines = this.screen.lines;
    const yi = coords.yi, yl = coords.yl - 1;
    const xi = coords.xi, xl = coords.xl - 1;
    
    if (yi >= 0 && yi < lines.length && yl > 0 && yl < lines.length) {
      if (lines[yi] && lines[yi][xi]) {
        let ch = lines[yi][xi][1];
        fs.appendFileSync('out.txt', `[${this.type}] TL: charCode=${ch.charCodeAt(0)}\n`);
      }
    }
  }
  return ret;
};

const screen = blessed.screen({ smartCSR: true, forceUnicode: true });
const box = blessed.box({
  parent: screen,
  top: 0, left: 0, width: 20, height: 10,
  shadow: true,
  border: { type: 'line' }
});

screen.render();
setTimeout(() => process.exit(0), 100);

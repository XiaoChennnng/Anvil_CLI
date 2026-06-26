'use strict';

const { getTheme } = require('../theme');

class Layout {
  constructor() {
    this._width = process.stdout.columns || 80;
    this._height = process.stdout.rows || 24;
    this._isAltScreen = false;
    this._onResize = null;
    this._resizeCallbacks = [];
    this.theme = getTheme();

    this.messageWidthRatio = 0.7;
    this.sidebarWidthRatio = 0.3;
    this.editorMinHeight = 3;

    // 批量渲染:beginBatch/endBatch 包裹期间 requestRender 只保留最后一次回调
    this._batchLevel = 0;
    this._pendingRender = false;
    this._renderCallback = null;

    // 写缓冲:startBuf/endBuf 包裹期间 write 只累积,endBuf 返回累积结果
    this._writeBuf = '';
    this._buffering = false;

    this._updateDimensions();
  }

  _updateDimensions() {
    this._width = process.stdout.columns || 80;
    this._height = process.stdout.rows || 24;

    this.messageWidth = Math.floor(this._width * this.messageWidthRatio);
    this.sidebarWidth = this._width - this.messageWidth;

    this.statusBarHeight = 1;
    this.editorHeight = Math.max(this.editorMinHeight, Math.floor(this._height * 0.1));
    this.contentHeight = this._height - this.editorHeight - this.statusBarHeight;

    // header 占 3 行(空行+标题行+空行),保底至少 1 行
    this.messageViewportHeight = Math.max(1, this.contentHeight - 3);
  }

  enterAltScreen() {
    if (this._isAltScreen) {return;}
    this._isAltScreen = true;

    this.write('\x1b[?1049h');
    this.write('\x1b[?25l');

    // 鼠标追踪:滚轮翻页,Shift+拖动选择文本
    this.write('\x1b[?1000h\x1b[?1006h');

    this._onResize = () => {
      this._updateDimensions();
      for (const cb of this._resizeCallbacks) {cb();}
    };
    process.stdout.on('resize', this._onResize);
  }

  leaveAltScreen() {
    if (!this._isAltScreen) {return;}
    this._isAltScreen = false;

    this.write('\x1b[?25h');
    this.write('\x1b[?1000l\x1b[?1006l');
    this.write('\x1b[?1049l');

    if (this._onResize) {
      process.stdout.removeListener('resize', this._onResize);
    }
  }

  onResize(callback) {
    this._resizeCallbacks.push(callback);
  }

  moveTo(row, col) {
    this.write(`\x1b[${row};${col || 1}H`);
  }

  clearLine() {
    this.write('\x1b[2K');
  }

  clearToEndOfLine() {
    this.write('\x1b[K');
  }

  hideCursor() {
    this.write('\x1b[?25l');
  }

  showCursor() {
    this.write('\x1b[?25h');
  }

  // 用 Home + Erase Below 替代 2J,避免闪烁
  clearScreen() {
    this.write('\x1b[H\x1b[J');
    this.hideCursor();
  }

  beginBatch() {
    this._batchLevel++;
  }

  endBatch() {
    this._batchLevel--;
    if (this._batchLevel <= 0) {
      this._batchLevel = 0;
      if (this._pendingRender && this._renderCallback) {
        this._pendingRender = false;
        const cb = this._renderCallback;
        this._renderCallback = null;
        cb();
      }
    }
  }

  write(str) {
    if (this._buffering) {
      this._writeBuf += str;
    } else {
      process.stdout.write(str);
    }
  }

  startBuf() {
    this._writeBuf = '';
    this._buffering = true;
  }

  endBuf() {
    this._buffering = false;
    const buf = this._writeBuf;
    this._writeBuf = '';
    return buf;
  }

  requestRender(renderFn) {
    if (this._batchLevel > 0) {
      this._pendingRender = true;
      this._renderCallback = renderFn;
    } else {
      renderFn();
    }
  }

  insertLines(n) {
    this.write(`\x1b[${n}L`);
  }

  deleteLines(n) {
    this.write(`\x1b[${n}M`);
  }

  writeAt(row, col, text) {
    this.moveTo(row, col);
    this.write(text);
  }

  get messageStartRow() {
    return 1;
  }

  get messageEndRow() {
    return this.contentHeight;
  }

  get editorStartRow() {
    return this.contentHeight + 1;
  }

  get statusBarRow() {
    return this._height;
  }
}

module.exports = Layout;

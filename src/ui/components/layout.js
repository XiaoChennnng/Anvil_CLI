'use strict';

const { getTheme } = require('../theme');

class Layout {
  constructor() {
    this._width = process.stdout.columns || 80;
    this._height = process.stdout.rows || 24;
    this._isAltScreen = false;
    this._onResize = null;
    this.theme = getTheme();

    // 布局比例
    this.messageWidthRatio = 0.7;
    this.sidebarWidthRatio = 0.3;
    this.editorMinHeight = 3;

    // 批量渲染支持（用于减少闪烁）
    this._batchLevel = 0;
    this._pendingRender = false;
    this._renderCallback = null;

    // 写缓冲（合并多次 this.write 为一次）
    this._writeBuf = '';
    this._buffering = false;

    this._updateDimensions();
  }

  _updateDimensions() {
    this._width = process.stdout.columns || 80;
    this._height = process.stdout.rows || 24;

    // 消息区和侧边栏宽度
    this.messageWidth = Math.floor(this._width * this.messageWidthRatio);
    this.sidebarWidth = this._width - this.messageWidth;

    // 各区域高度
    this.statusBarHeight = 1;
    this.editorHeight = Math.max(this.editorMinHeight, Math.floor(this._height * 0.1));
    this.contentHeight = this._height - this.editorHeight - this.statusBarHeight;

    // 消息区滚动区域 (减去 header 3 行: 空行+标题行+空行)，保底至少 1 行
    this.messageViewportHeight = Math.max(1, this.contentHeight - 3);
  }

  // 进入 Alt Screen 全屏模式
  enterAltScreen() {
    if (this._isAltScreen) {return;}
    this._isAltScreen = true;

    this.write('\x1b[?1049h');  // 进入 alt screen
    this.write('\x1b[?25l');     // 隐藏光标

    // 启用鼠标追踪：滚轮翻页，Shift+拖动选择文本
    this.write('\x1b[?1000h\x1b[?1006h');

    // 监听 resize
    this._onResize = () => {
      this._updateDimensions();
      this.emit('resize');
    };
    process.stdout.on('resize', this._onResize);
  }

  // 退出 Alt Screen
  leaveAltScreen() {
    if (!this._isAltScreen) {return;}
    this._isAltScreen = false;

    this.write('\x1b[?25h');    // 显示光标
    this.write('\x1b[?1000l\x1b[?1006l');  // 关闭鼠标追踪
    this.write('\x1b[?1049l');  // 退出 alt screen

    if (this._onResize) {
      process.stdout.removeListener('resize', this._onResize);
    }
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

  // 清屏，使用 Home + Erase Below 替代 2J
  clearScreen() {
    this.write('\x1b[H\x1b[J');
    this.hideCursor();
  }

  // 批量渲染开始，所有渲染请求合并直到 endBatch()
  beginBatch() {
    this._batchLevel++;
  }

  // 批量渲染结束，batch level 降为 0 时执行待处理渲染
  endBatch() {
    this._batchLevel--;
    if (this._batchLevel <= 0) {
      this._batchLevel = 0;
      if (this._pendingRender && this._renderCallback) {
        this._pendingRender = false;
        this._renderCallback();
        this._renderCallback = null;
      }
    }
  }

  // 写入终端（支持缓冲合并）
  write(str) {
    if (this._buffering) {
      this._writeBuf += str;
    } else {
      process.stdout.write(str);
    }
  }

  // 开始写缓冲
  startBuf() {
    this._writeBuf = '';
    this._buffering = true;
  }

  // 结束写缓冲
  endBuf() {
    this._buffering = false;
    const buf = this._writeBuf;
    this._writeBuf = '';
    return buf;
  }

  // 请求渲染（可被批量合并）
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

  emit(event) {
    // 由 TUI 注册回调
  }

  /**
   * 注册事件
   */
  on(event, callback) {
    if (event === 'resize') {
      const oldEmit = this.emit.bind(this);
      this.emit = (e) => {
        oldEmit(e);
        if (e === 'resize') {callback();}
      };
    }
  }
}

module.exports = Layout;

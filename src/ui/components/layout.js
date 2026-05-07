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

    // 消息区滚动区域 (减去 header 3 行: 空行+标题行+空行)
    this.messageViewportHeight = this.contentHeight - 3;
  }

  /**
   * 进入 Alt Screen 全屏模式
   */
  enterAltScreen() {
    if (this._isAltScreen) {return;}
    this._isAltScreen = true;

    process.stdout.write('\x1b[?1049h');  // 进入 alt screen
    process.stdout.write('\x1b[?25l');     // 隐藏光标

    // 启用鼠标追踪：滚轮翻页，Shift+拖动选择文本
    process.stdout.write('\x1b[?1000h\x1b[?1006h');

    // 监听 resize
    this._onResize = () => {
      this._updateDimensions();
      this.emit('resize');
    };
    process.stdout.on('resize', this._onResize);
  }

  /**
   * 退出 Alt Screen
   */
  leaveAltScreen() {
    if (!this._isAltScreen) {return;}
    this._isAltScreen = false;

    process.stdout.write('\x1b[?25h');    // 显示光标
    process.stdout.write('\x1b[?1000l\x1b[?1006l');  // 关闭鼠标追踪
    process.stdout.write('\x1b[?1049l');  // 退出 alt screen

    if (this._onResize) {
      process.stdout.removeListener('resize', this._onResize);
    }
  }

  /**
   * 光标定位
   */
  moveTo(row, col) {
    process.stdout.write(`\x1b[${row};${col || 1}H`);
  }

  /**
   * 清除当前行
   */
  clearLine() {
    process.stdout.write('\x1b[2K');
  }

  /**
   * 清除从光标到行尾
   */
  clearToEndOfLine() {
    process.stdout.write('\x1b[K');
  }

  /**
   * 隐藏光标
   */
  hideCursor() {
    process.stdout.write('\x1b[?25l');
  }

  /**
   * 显示光标
   */
  showCursor() {
    process.stdout.write('\x1b[?25h');
  }

  /**
   * 清屏（一次性清屏，避免逐行清除造成的闪烁）
   */
  clearScreen() {
    process.stdout.write('\x1b[2J');
    this.hideCursor();
  }

  /**
   * 批量渲染开始
   * 调用 beginBatch() 后，所有渲染请求会合并直到 endBatch()
   */
  beginBatch() {
    this._batchLevel++;
  }

  /**
   * 批量渲染结束
   * 当 batch level 降为 0 时，执行待处理的渲染
   */
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

  /**
   * 请求渲染（可被批量合并）
   * @param {Function} renderFn - 渲染函数
   */
  requestRender(renderFn) {
    if (this._batchLevel > 0) {
      this._pendingRender = true;
      this._renderCallback = renderFn;
    } else {
      renderFn();
    }
  }

  /**
   * 插入行（向上滚动）
   */
  insertLines(n) {
    process.stdout.write(`\x1b[${n}L`);
  }

  /**
   * 删除行（向下滚动）
   */
  deleteLines(n) {
    process.stdout.write(`\x1b[${n}M`);
  }

  /**
   * 写入文本到指定位置
   */
  writeAt(row, col, text) {
    this.moveTo(row, col);
    process.stdout.write(text);
  }

  /**
   * 获取消息区起始行
   */
  get messageStartRow() {
    return 1;
  }

  /**
   * 获取消息区结束行
   */
  get messageEndRow() {
    return this.contentHeight;
  }

  /**
   * 获取编辑器起始行
   */
  get editorStartRow() {
    return this.contentHeight + 1;
  }

  /**
   * 获取状态栏行
   */
  get statusBarRow() {
    return this._height;
  }

  /**
   * 触发 resize 事件
   */
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

'use strict';

const chalk = require('chalk');
const { getTheme } = require('../theme');

class Editor {
  constructor(layout) {
    this.layout = layout;
    this.theme = getTheme();
    this.currentInput = '';
    this.inputLines = [];
    this.history = [];
    this.historyIndex = -1;
    this.cursorPos = 0;  // 光标在 currentInput 中的位置（0-based）
    this._needsRefresh = false;  // 增量渲染标志
  }

  /**
   * 判断是否为 CJK 双倍宽字符
   */
  _isCJK(char) {
    const code = char.charCodeAt(0);
    return (code >= 0x1100 && code <= 0x115F) ||
      (code >= 0x2E80 && code <= 0xA4CF) ||
      (code >= 0xAC00 && code <= 0xD7AF) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0xFE10 && code <= 0xFE6F) ||
      (code >= 0xFF01 && code <= 0xFF60) ||
      (code >= 0xFFE0 && code <= 0xFFE6) ||
      (code >= 0x3000 && code <= 0x303F);
  }

  /**
   * 计算字符串的可见宽度（支持 CJK 双倍宽字符）
   */
  _visibleWidth(str) {
    let width = 0;
    let inEscape = false;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === '\x1b') { inEscape = true; continue; }
      if (inEscape) { if (ch === 'm') {inEscape = false;} continue; }
      width += this._isCJK(ch) ? 2 : 1;
    }
    return width;
  }

  /**
   * 渲染输入区（增量渲染模式，固定位置写入，类似侧边栏）
   * 使用 ANSI 定位确保输入框始终在正确位置，不被消息区覆盖
   */
  render() {
    const { editorStartRow, _width } = this.layout;
    const t = this.theme;

    let output = '';

    // 顶部边框（用 dim 细线）
    const borderLine = t.textMuted('─'.repeat(_width));
    output += `\x1b[${editorStartRow};1H\x1b[2K${borderLine}`;

    // 输入提示符 ">"（使用清除到行尾确保旧内容被清除）
    const promptContent = chalk.hex(t.colors.primary).bold(' >') + (this.currentInput ? ' ' + this.currentInput : '');
    output += `\x1b[${editorStartRow + 1};1H\x1b[2K${promptContent}`;

    return output;
  }

  /**
   * 获取输入提示位置
   */
  get promptRow() {
    return this.layout.editorStartRow + 1;
  }

  get promptCol() {
    // 前缀 = " >"(2字符) + 空格分隔符(1字符) = 3 字符，下一字符从第 4 列开始
    return 4;
  }

  /**
   * 处理键盘输入
   * @returns {{ action: string, text?: string } | null}
   */
  handleKey(buf) {
    // Enter - 发送 (1:1 复刻 opencode: \+Enter 换行)
    if (buf[0] === 0x0d) {
      if (this.currentInput.endsWith('\\')) {
        this.currentInput = this.currentInput.slice(0, -1);
        this.inputLines.push(this.currentInput);
        this.currentInput = '';
        this.cursorPos = 0;
        this._redrawInput();
        return { action: 'newline' };
      }

      this.inputLines.push(this.currentInput);
      const fullInput = this.inputLines.join('\n').trim();
      this.inputLines = [];
      this.currentInput = '';
      this.cursorPos = 0;

      if (fullInput) {
        this.history.push(fullInput);
        this.historyIndex = this.history.length;
        this._redrawInput();
        return { action: 'send', text: fullInput };
      }
      this._redrawInput();
      return { action: 'empty' };
    }

    // Ctrl+J - 换行
    if (buf[0] === 0x0a) {
      this.inputLines.push(this.currentInput);
      this.currentInput = '';
      this.cursorPos = 0;
      this._redrawInput();
      return { action: 'newline' };
    }

    // Backspace - 删除光标前字符
    if (buf[0] === 0x7f) {
      if (this.cursorPos > 0) {
        this.currentInput =
          this.currentInput.slice(0, this.cursorPos - 1) +
          this.currentInput.slice(this.cursorPos);
        this.cursorPos--;
        this._redrawInput();
      }
      return { action: 'backspace' };
    }

    // Delete - 删除光标后字符 (ESC [ 3 ~)
    if (buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x33 && buf[3] === 0x7e) {
      if (this.cursorPos < this.currentInput.length) {
        this.currentInput =
          this.currentInput.slice(0, this.cursorPos) +
          this.currentInput.slice(this.cursorPos + 1);
        this._redrawInput();
      }
      return { action: 'delete' };
    }

    // Ctrl+U - 清空输入
    if (buf[0] === 0x15) {
      this.currentInput = '';
      this.cursorPos = 0;
      this.inputLines = [];
      this._redrawInput();
      return { action: 'clear' };
    }

    // ─── 方向键 & 导航 ───

    // 上箭头 - 历史
    if (buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x41 && buf.length === 3) {
      if (this.history.length > 0 && this.historyIndex > 0) {
        this.historyIndex--;
        this.currentInput = this.history[this.historyIndex] || '';
        this.cursorPos = this.currentInput.length;
        this._redrawInput();
      }
      return { action: 'history_up' };
    }

    // 下箭头 - 历史
    if (buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x42 && buf.length === 3) {
      if (this.historyIndex < this.history.length - 1) {
        this.historyIndex++;
        this.currentInput = this.history[this.historyIndex] || '';
      } else {
        this.historyIndex = this.history.length;
        this.currentInput = '';
      }
      this.cursorPos = this.currentInput.length;
      this._redrawInput();
      return { action: 'history_down' };
    }

    // 左箭头 ESC [ D - 光标左移
    if (buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x44 && buf.length === 3) {
      if (this.cursorPos > 0) {
        this.cursorPos--;
        this._restoreCursor();
      }
      return { action: 'cursor_left' };
    }

    // 右箭头 ESC [ C - 光标右移
    if (buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x43 && buf.length === 3) {
      if (this.cursorPos < this.currentInput.length) {
        this.cursorPos++;
        this._restoreCursor();
      }
      return { action: 'cursor_right' };
    }

    // Home ESC [ H - 光标到行首（也匹配 PageUp 的 buf，通过长度区分）
    if (buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x48 && buf.length === 3) {
      this.cursorPos = 0;
      this._restoreCursor();
      return { action: 'cursor_home' };
    }

    // End ESC [ F - 光标到行尾
    if (buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x46 && buf.length === 3) {
      this.cursorPos = this.currentInput.length;
      this._restoreCursor();
      return { action: 'cursor_end' };
    }

    // 正常字符（包括 Tab）
    if (buf[0] >= 0x20 || buf[0] === 0x09) {
      const key = buf.toString('utf8');
      // 在光标位置插入，不是追加
      this.currentInput =
        this.currentInput.slice(0, this.cursorPos) +
        key +
        this.currentInput.slice(this.cursorPos);
      this.cursorPos += key.length;
      this._redrawInput();
      return { action: 'char' };
    }

    return null;
  }

  /**
   * 重绘输入区域 + 光标归位
   */
  _redrawInput() {
    const row = this.promptRow;
    const t = this.theme;

    // 清除从输入区起始行到终端最后一行的所有行（避免多行残留）
    const editorEndRow = this.layout._height;
    for (let r = row; r <= editorEndRow; r++) {
      this.layout.moveTo(r, 1);
      this.layout.clearLine();
    }

    // 使用 ANSI 定位重绘（与 render() 一致）
    this.layout.moveTo(row, 1);
    this.layout.clearToEndOfLine();
    process.stdout.write(chalk.hex(t.colors.primary).bold(' >'));
    if (this.currentInput) {
      process.stdout.write(' ' + this.currentInput);
    }
    this._needsRefresh = false;
    this._restoreCursor();
  }

  /**
   * 恢复光标到当前位置（无闪烁，不重绘内容）
   * 使用可见宽度计算光标位置，支持 CJK 双倍宽字符
   */
  _restoreCursor() {
    this.layout.showCursor();
    this.layout.moveTo(this.promptRow, this.getCursorColumn());
  }

  /**
   * 计算光标当前应处的列号（公共 API，供 TUI 重绘时复用）
   * 用可见宽度计算偏移，自动支持 CJK 双倍宽字符
   * @returns {number} 1-based 列号
   */
  getCursorColumn() {
    const pos = this.cursorPos ?? this.currentInput?.length ?? 0;
    const inputBeforeCursor = (this.currentInput || '').slice(0, pos);
    return this.promptCol + this._visibleWidth(inputBeforeCursor);
  }

  /**
   * 重置
   */
  reset() {
    this.currentInput = '';
    this.cursorPos = 0;
    this.inputLines = [];
  }

  /**
   * 设置编辑器文本
   * @param {string} text - 要设置的文本
   */
  setText(text) {
    this.currentInput = text;
    this.cursorPos = text.length;
    this.inputLines = text.split('\n');
  }
}

module.exports = Editor;

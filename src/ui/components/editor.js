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
  }

  /**
   * 渲染输入区
   */
  render() {
    const { editorStartRow, _width } = this.layout;
    const t = this.theme;

    // 顶部边框（用 dim 细线替代粗横线，不抢眼）
    this.layout.moveTo(editorStartRow, 1);
    this.layout.clearLine();
    const borderLine = t.textMuted('─'.repeat(_width));
    process.stdout.write(borderLine);

    // 输入提示符 ">"
    this.layout.moveTo(editorStartRow + 1, 1);
    this.layout.clearLine();
    process.stdout.write(chalk.hex(t.colors.primary).bold(' >'));
    if (this.currentInput) {
      process.stdout.write(' ' + this.currentInput);
    }
  }

  /**
   * 获取输入提示位置
   */
  get promptRow() {
    return this.layout.editorStartRow + 1;
  }

  get promptCol() {
    return 3; // " >" + 空格分隔符
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

    this.layout.moveTo(row, 1);
    this.layout.clearLine();
    process.stdout.write(chalk.hex(t.colors.primary).bold(' >'));
    if (this.currentInput) {
      process.stdout.write(' ' + this.currentInput);
    }
    // 光标移到正确位置
    this._restoreCursor();
  }

  /**
   * 恢复光标到当前位置（无闪烁，不重绘内容）
   */
  _restoreCursor() {
    this.layout.showCursor();
    this.layout.moveTo(this.promptRow, this.promptCol + this.cursorPos);
  }

  /**
   * 重置
   */
  reset() {
    this.currentInput = '';
    this.cursorPos = 0;
    this.inputLines = [];
  }
}

module.exports = Editor;

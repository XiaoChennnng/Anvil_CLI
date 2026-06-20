'use strict';

const chalk = require('chalk');
const { getTheme } = require('../theme');

class QuestionPanel {
  constructor(layout) {
    this.layout = layout;
    this.theme = getTheme();
    this.messageBox = null;  // 由 TUI 注入引用
    this._refreshDisplay = null;  // 由 TUI 注入刷新回调

    this.active = false;
    this.resolve = null;
    this.questions = [];
    this.currentQ = 0;
    this.cursorPos = 0;         // 当前选中的选项索引
    this.selected = [];         // 每个问题的选中状态
    this.answered = new Set();  // 已回答的问题索引
    this.result = [];           // 每个问题的结果
    this._customInput = [];     // 每个问题是否允许自定义输入
    this._customInputMode = false; // 是否处于文本输入模式
    this._customInputBuffer = '';  // 自定义输入缓冲
  }

  // 显示问答面板
  show(params) {
    this._startLine = undefined;  // 重置以便 _renderToMessageBox 正确定位起始行
    this.questions = params.questions;
    this.currentQ = 0;
    this.cursorPos = 0;
    this.answered = new Set();
    this.result = [];
    this.selected = params.questions.map((q) =>
      q.multiSelect ? [] : 0  // 多选→空数组，单选→默认选中第一个
    );
    this._customInput = params.questions.map((q) => !!q.customInput);
    this._customInputMode = false;
    this._customInputBuffer = '';
    this.active = true;

    // 渲染到消息区
    this._renderToMessageBox();

    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  handleKey(buf) {
    if (!this.active) {return null;}

    const current = this.questions[this.currentQ];

    // ─── 自定义输入模式 ───
    if (this._customInputMode) {
      return this._handleCustomInput(buf);
    }

    // 当前问题可用选项数量（含自定义输入虚拟选项）
    const optCount = current.options.length + (this._customInput[this.currentQ] ? 1 : 0);

    // 上箭头 — 选项上移
    if (buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x41) {
      if (this.cursorPos > 0) {
        this.cursorPos--;
        this._renderToMessageBox();
      }
      return { action: 'question_up' };
    }

    // 下箭头 — 选项下移
    if (buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x42) {
      if (this.cursorPos < optCount - 1) {
        this.cursorPos++;
        this._renderToMessageBox();
      }
      return { action: 'question_down' };
    }

    // Enter — 确认选择
    if (buf[0] === 0x0d) {
      // 如果选中了自定义输入选项，进入文本输入模式
      if (this._customInput[this.currentQ] && this.cursorPos === current.options.length) {
        this._customInputMode = true;
        this._customInputBuffer = '';
        this._renderCustomInput();
        return { action: 'question_input_mode' };
      }

      const answer = this._getCurrentAnswer();
      this.result[this.currentQ] = answer;
      this.answered.add(this.currentQ);

      // 还有未回答的问题 → 跳到下一个
      const next = this._nextUnanswered();
      if (next !== -1) {
        this.currentQ = next;
        this.cursorPos = Array.isArray(this.selected[next])
          ? 0
          : this.selected[next];
        this._renderToMessageBox();
        return { action: 'question_next' };
      }

      // 所有问题已回答 → 先刷新 tab 显示（最后一项变绿[完成]），再完成
      this._renderToMessageBox();
      return this._finish();
    }

    // Space — 选中当前选项（单选用 Space 标记选中项，多选切换勾选）
    if (buf[0] === 0x20) {
      const idx = this.cursorPos;
      if (this._customInput[this.currentQ] && idx === current.options.length) {return null;}
      if (current.multiSelect) {
        const sel = this.selected[this.currentQ];
        const pos = sel.indexOf(idx);
        if (pos === -1) {sel.push(idx);}
        else {sel.splice(pos, 1);}
      } else {
        this.selected[this.currentQ] = idx;
      }
      this._renderToMessageBox();
      return { action: 'question_toggle' };
    }

    // Tab / 右箭头 — 下一个问题
    if ((buf[0] === 0x09) ||
        (buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x43)) {
      if (this.currentQ < this.questions.length - 1) {
        this.currentQ++;
        this.cursorPos = Array.isArray(this.selected[this.currentQ])
          ? 0
          : this.selected[this.currentQ];
        this._renderToMessageBox();
      }
      return { action: 'question_tab' };
    }

    // 左箭头 — 上一个问题
    if (buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x44) {
      if (this.currentQ > 0) {
        this.currentQ--;
        this.cursorPos = Array.isArray(this.selected[this.currentQ])
          ? 0
          : this.selected[this.currentQ];
        this._renderToMessageBox();
      }
      return { action: 'question_tab' };
    }

    // Esc — 退出提问（不提交任何答案）
    if (buf[0] === 0x1b && buf.length === 1) {
      this.active = false;
      if (this.resolve) {
        this.resolve(null);
        this.resolve = null;
      }
      return { action: 'question_cancelled' };
    }

    return null;
  }

  // 获取当前问题的选中答案
  _getCurrentAnswer() {
    const current = this.questions[this.currentQ];
    if (current.multiSelect) {
      const sel = this.selected[this.currentQ];
      return sel.map((i) => current.options[i].label);
    }
    return current.options[this.selected[this.currentQ]].label;
  }

  // 下一个未回答问题
  _nextUnanswered() {
    for (let i = 0; i < this.questions.length; i++) {
      if (!this.answered.has(i)) {return i;}
    }
    return -1;
  }

  // 完成问答
  _finish() {
    const t = this.theme;
    // 填充未回答的问题为 null
    const answers = this.questions.map((q, i) =>
      i in this.result ? this.result[i] : null
    );

    this.active = false;
    if (this.resolve) {
      this.resolve(answers);
      this.resolve = null;
    }

    // 在消息区渲染完成标记
    if (this.messageBox) {
      const marker = chalk.hex(t.colors.primary)('●');
      const answered = answers.filter((a) => a !== null).length;
      this.messageBox.renderedLines.push(
        `${marker} ${t.textMuted(`问答完成 (${answered}/${answers.length})`)}`
      );
      this.messageBox.renderedLines.push('');
    }

    return { action: 'question_done', value: answers };
  }

  // 渲染当前问题到消息区
  _renderToMessageBox() {
    if (!this.messageBox) {return;}

    const t = this.theme;
    const mb = this.messageBox;
    const current = this.questions[this.currentQ];
    const width = this.layout.messageWidth - 4;
    const allAnswered = this.answered.size === this.questions.length;

    // 临时移除已有问答行（从后往前找问答块并删除）
    // 简单做法：记录起始行，每次重绘
    if (this._startLine !== undefined) {
      mb.renderedLines.splice(this._startLine);
    } else {
      this._startLine = mb.renderedLines.length;
    }

    // 渲染所有问题的标签页头
    if (this.questions.length > 1) {
      let header = ' ';
      for (let i = 0; i < this.questions.length; i++) {
        const isCurrent = !allAnswered && i === this.currentQ;
        const isAnswered = this.answered.has(i);
        let tag;
        if (isCurrent) {
          tag = chalk.bgHex(t.colors.primary).hex(t.colors.background).bold(` ${this.questions[i].header} `);
        } else if (isAnswered) {
          tag = chalk.bgHex(t.colors.success).hex(t.colors.background).bold(` [完成] ${this.questions[i].header} `);
        } else {
          tag = chalk.bgHex(t.colors.backgroundSecondary).hex(t.colors.textMuted)(` ${this.questions[i].header} `);
        }
        header += tag + ' ';
      }
      mb.renderedLines.push(header);
      mb.renderedLines.push('');
    }

    // 全部答完时跳过问题描述和选项（只留全 [完成] tab + 完成标记）
    if (!allAnswered) {
      // 问题描述
      const questionLines = current.question.split('\n');
      for (const line of questionLines) {
        if (line.trim()) {
          mb.renderedLines.push(` ${chalk.bold(t.text(line))}`);
        }
      }
      mb.renderedLines.push('');

      // 选项列表
      for (let i = 0; i < current.options.length; i++) {
      const opt = current.options[i];
      const isSelected = i === this.cursorPos;
      const isChecked = current.multiSelect
        ? this.selected[this.currentQ].includes(i)
        : this.selected[this.currentQ] === i;

      // 选择指示器
      let indicator;
      if (current.multiSelect) {
        indicator = isChecked ? chalk.hex(t.colors.primary)('◉') : chalk.hex(t.colors.textMuted)('◯');
      } else {
        indicator = isChecked ? chalk.hex(t.colors.primary)('●') : chalk.hex(t.colors.textMuted)('○');
      }

      // 高亮当前行
      const prefix = isSelected ? chalk.hex(t.colors.primary)('▸') : ' ';
      const label = isSelected
        ? chalk.hex(t.colors.text).bold(opt.label)
        : t.text(opt.label);
      const desc = opt.description
        ? chalk.hex(t.colors.textMuted)(` — ${opt.description}`)
        : '';

      // 截断过长的行
      let line = ` ${prefix} ${indicator} ${label}${desc}`;
      const visibleLen = this._visibleLength(line);
      if (width > 0 && visibleLen > width) {
        // 截断描述部分
        const maxDescLen = width - (this._visibleLength(` ${prefix} ${indicator} ${label} — `));
        if (maxDescLen > 10) {
          const truncated = this._truncateAnsi(desc, maxDescLen);
          line = ` ${prefix} ${indicator} ${label}${truncated}`;
        } else {
          line = ` ${prefix} ${indicator} ${label}`;
        }
      }
      mb.renderedLines.push(line);
    }

    // 自定义输入选项（虚拟选项，不在 options 数组中）
    if (this._customInput[this.currentQ]) {
      const ciIdx = current.options.length;
      const isSelected = this.cursorPos === ciIdx;
      const prefix = isSelected ? chalk.hex(t.colors.primary)('▸') : ' ';
      const indicator = chalk.hex(t.colors.textMuted)('[ ]');
      const label = isSelected
        ? chalk.hex(t.colors.text).bold('自定义输入')
        : t.text('自定义输入');
      mb.renderedLines.push(` ${prefix} ${indicator} ${label}`);
    }

    mb.renderedLines.push('');

    // 操作提示（固定在底部）
    let hint = chalk.dim(' ↑↓ 选择');
    hint += chalk.dim(current.multiSelect ? ' · Space 多选' : ' · Space 选中');
    hint += chalk.dim(' · Enter 确认');
    if (this._customInput[this.currentQ]) {hint += chalk.dim(' · 自定义输入');}
    if (this.questions.length > 1) {hint += chalk.dim(' · Tab 切换');}
    hint += chalk.dim(' · Esc 跳过');
    mb.renderedLines.push(` ${hint}`);
    mb.renderedLines.push('');
    }  // end if (!allAnswered)

    // 触发屏幕刷新
    if (this._refreshDisplay) {this._refreshDisplay();}
  }

  // 渲染自定义输入界面
  _renderCustomInput() {
    if (!this.messageBox) {return;}

    const t = this.theme;
    const mb = this.messageBox;
    const current = this.questions[this.currentQ];

    // 移除已有问答行
    if (this._startLine !== undefined) {
      mb.renderedLines.splice(this._startLine);
    }

    // 问题描述
    const questionLines = current.question.split('\n');
    for (const line of questionLines) {
      if (line.trim()) {
        mb.renderedLines.push(` ${chalk.bold(t.text(line))}`);
      }
    }
    mb.renderedLines.push('');

    // 输入提示
    const cursor = chalk.hex(t.colors.primary)('▎');
    const prompt = ` ${chalk.hex(t.colors.primary)('>')} `;
    const displayText = this._customInputBuffer
      ? this._customInputBuffer
      : chalk.hex(t.colors.textMuted)('在此输入你的答案...');
    mb.renderedLines.push(`${prompt}${displayText}${cursor}`);
    mb.renderedLines.push('');

    // 操作提示
    mb.renderedLines.push(` ${chalk.dim('Enter 确认 · Backspace 删除 · Esc 返回选项')}`);
    mb.renderedLines.push('');

    // 触发屏幕刷新
    if (this._refreshDisplay) {this._refreshDisplay();}
  }

  // 处理自定义输入模式的键盘输入
  _handleCustomInput(buf) {
    // Enter — 提交
    if (buf[0] === 0x0d) {
      const text = this._customInputBuffer.trim();
      if (!text) {return { action: 'question_input_empty' };} // 空输入不提交
      this._customInputMode = false;
      this.result[this.currentQ] = `[自定义] ${text}`;
      this.answered.add(this.currentQ);

      // 跳到下一个未回答问题
      const next = this._nextUnanswered();
      if (next !== -1) {
        this.currentQ = next;
        this.cursorPos = Array.isArray(this.selected[next])
          ? 0
          : this.selected[next];
        this._renderToMessageBox();
        return { action: 'question_next' };
      }

      return this._finish();
    }

    // Backspace — 删除
    if (buf[0] === 0x7f || buf[0] === 0x08) {
      const chars = [...this._customInputBuffer];
      if (chars.length > 0) {
        chars.pop();
        this._customInputBuffer = chars.join('');
        this._renderCustomInput();
      }
      return { action: 'question_backspace' };
    }

    // Esc — 返回选项列表
    if (buf[0] === 0x1b && buf.length === 1) {
      this._customInputMode = false;
      this._renderToMessageBox();
      return { action: 'question_cancel_input' };
    }

    // 过滤控制字符：忽略箭头键、Ctrl+C 等
    if (buf[0] < 0x20 || buf[0] === 0x1b) {return null;}

    // 追加字符（支持 UTF-8）
    this._customInputBuffer += buf.toString('utf8');
    this._renderCustomInput();
    return { action: 'question_input_char' };
  }

  // 计算字符串可见长度（忽略 ANSI）
  _visibleLength(str) {
    let len = 0;
    let inEscape = false;
    for (let i = 0; i < str.length; i++) {
      if (str[i] === '\x1b') { inEscape = true; continue; }
      if (inEscape) { if (str[i] === 'm') {inEscape = false;} continue; }
      len++;
    }
    return len;
  }

  // 按可见长度截断 ANSI 字符串
  _truncateAnsi(str, maxLen) {
    let visible = 0;
    let result = '';
    let inEscape = false;
    for (let i = 0; i < str.length; i++) {
      if (str[i] === '\x1b') { inEscape = true; result += str[i]; continue; }
      if (inEscape) { result += str[i]; if (str[i] === 'm') {inEscape = false;} continue; }
      if (visible >= maxLen) { result += chalk.dim('...'); break; }
      result += str[i];
      visible++;
    }
    return result;
  }

  // 重置
  reset() {
    this.active = false;
    this.resolve = null;
    this.questions = [];
    this.currentQ = 0;
    this.cursorPos = 0;
    this.selected = [];
    this.answered = new Set();
    this.result = [];
    this._customInput = [];
    this._customInputMode = false;
    this._customInputBuffer = '';
    this._startLine = undefined;
  }
}

module.exports = QuestionPanel;

'use strict';

const chalk = require('chalk');
const { getTheme } = require('../theme');
const MessageRenderer = require('./message');

class MessageBox {
  constructor(layout) {
    this.layout = layout;
    this.theme = getTheme();
    this.renderer = new MessageRenderer();
    this.messages = [];        // 所有消息
    this.renderedLines = [];   // 渲染后的所有行
    this.scrollOffset = 0;     // 滚动偏移
    this._scrollPaused = false; // 用户手动翻页后暂停自动滚动
    this._showScrollHint = false; // 显示"向上滚动"指示器
    this.isProcessing = false;
    this._lastRenderedLine = null;  // 最后渲染的行，用于去重
    this._thinkingBuffer = '';
    this._inThinking = false;
    this._hasThinkingContent = false;
    this._contentStarted = false;
    this._startTime = null;
    // 增量渲染缓存
    this._lastRenderedVisibleLines = [];
    this._responseStarted = false;  // 标志：响应是否已开始输出
    this._firstContentBlock = true;  // 标志：是否第一个内容块（需要加 ● 前缀）
  }

  addUserMessage(content) {
    const width = this.layout.messageWidth - 2; // 减去边框和 padding
    const lines = this.renderer.renderMessage(content, true, width);
    this.messages.push({ type: 'user', lines });
    this.renderedLines.push(...lines, ''); // 空行分隔
    this._forceScrollToBottom();
  }

  startThinking() {
    this._inThinking = true;
    this._hasThinkingContent = false;
    this._thinkingBuffer = '';
    this._startTime = Date.now();
  }

  addThinkingChunk(chunk) {
    if (!this._inThinking) {return;}
    this._hasThinkingContent = true;
    this._thinkingBuffer += chunk;

    // 按行输出
    const lines = this._thinkingBuffer.split('\n');
    this._thinkingBuffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim() === '') {continue;} // 跳过空行
      // 思考内容：灰色（无斜体，跨终端兼容更好），不加 ● 前缀
      this.renderedLines.push(this.theme.thinkingFallback(line));
    }
    this._scrollToBottom();
  }

  startContent() {
    this._inThinking = false;
    this._contentStarted = true;
    this._firstContentBlock = true;  // 重置第一个内容块标志

    // 输出剩余思考缓冲（跳过空行）
    if (this._thinkingBuffer && this._thinkingBuffer.trim() !== '') {
      this.renderedLines.push(this._thinkingBuffer);
      this._thinkingBuffer = '';
    }
    if (this._hasThinkingContent) {
      this.renderedLines.push('');
    }
  }

  /**
   * 添加响应内容
   */
  addContentChunk(chunk) {
    const t = this.theme;

    // 使用 marked-terminal 渲染器处理
    const rendered = this.renderer.markdown.write(chunk);
    if (rendered) {
      // 分割每一行（marked 可能输出多行，如 code block）
      const lines = rendered.split('\n');
      for (const line of lines) {
        // 跳过空行
        if (line.trim() === '') {continue;}

        // 去重：如果这行与最后渲染的行完全相同，跳过
        if (line === this._lastRenderedLine) {
          continue;
        }
        this._lastRenderedLine = line;

        // 只有第一个内容块加 ● 前缀
        if (this._firstContentBlock) {
          const marker = chalk.hex(t.colors.primary)('●');
          this.renderedLines.push(` ${marker} ${line}`);
          this._firstContentBlock = false;
        } else {
          this.renderedLines.push(` ${line}`);
        }
      }
    }
    this._scrollToBottom();
  }

  /**
   * 强制刷新内容缓冲区
   */
  flushContentBuffer() {
    const t = this.theme;

    const remaining = this.renderer.markdown.flush();
    if (remaining) {
      const lines = remaining.split('\n');
      for (const line of lines) {
        if (line.trim() === '') {continue;}
        // 去重
        if (line === this._lastRenderedLine) {
          continue;
        }
        this._lastRenderedLine = line;
        // 只有第一个内容块加 ● 前缀
        if (this._firstContentBlock) {
          const marker = chalk.hex(t.colors.primary)('●');
          this.renderedLines.push(` ${marker} ${line}`);
          this._firstContentBlock = false;
        } else {
          this.renderedLines.push(` ${line}`);
        }
      }
    }
  }

  /**
   * 添加工具调用
   */
  addToolCall(toolCalls) {
    // 先 flush markdown 渲染器的缓冲区（避免内容被截断）
    this.flushContentBuffer();

    const calls = Array.isArray(toolCalls) ? toolCalls : [toolCalls];
    for (const call of calls) {
      const lines = this.renderer.renderToolCall(call, this.layout.messageWidth - 2);
      this.renderedLines.push(...lines);
    }
    this._scrollToBottom();
  }

  /**
   * 添加工具结果
   */
  addToolResult(name, result, toolCall) {
    // 先 flush markdown 渲染器的缓冲区（避免内容被截断）
    this.flushContentBuffer();

    const maxResultHeight = 10; // 1:1复刻opencode，工具响应最多显示10行
    const lines = this.renderer.renderToolResponse(name, result, toolCall, this.layout.messageWidth - 2, maxResultHeight);
    this.renderedLines.push(...lines);
    this._scrollToBottom();
  }

  /**
   * 完成响应（显示模型名和耗时）
   */
  finishResponse(model) {
    const t = this.theme;

    // flush 剩余 markdown 缓冲
    const remaining = this.renderer.markdown.flush();
    if (remaining) {
      const lines = remaining.split('\n');
      for (const line of lines) {
        if (line.trim() === '') {continue;} // 跳过空行

        // 只有第一个内容块加 ● 前缀
        if (this._firstContentBlock) {
          const marker = chalk.hex(t.colors.primary)('●');
          this.renderedLines.push(` ${marker} ${line}`);
          this._firstContentBlock = false;
        } else {
          this.renderedLines.push(` ${line}`);
        }
      }
    }

    // 过滤掉末尾的空行（避免多余空行）
    while (this.renderedLines.length > 0 && this.renderedLines[this.renderedLines.length - 1].trim() === '') {
      this.renderedLines.pop();
    }

    // 空行分隔
    this.renderedLines.push('');
    this._scrollToBottom();
  }

  /**
   * 渲染消息区到屏幕（双缓冲模式，减少闪烁）
   * 将所有输出合并为一次 write 调用，避免多次终端操作造成的闪烁
   */
  render() {
    const { messageStartRow, messageWidth, messageViewportHeight } = this.layout;
    const t = this.theme;

    // 构建完整输出字符串
    let output = '';

    // 滚动提示（翻页时显示在 header 区域顶部）
    if (this._showScrollHint && this.scrollOffset > 0) {
      const hint = chalk.bgHex(t.colors.backgroundSecondary).hex(t.colors.textMuted)(
        ` ↑ ${this.scrollOffset} 行之前的内容 · 按 PageDown 继续向下查看 `
      );
      output += `\x1b[${messageStartRow};1H\x1b[K${hint}${' '.repeat(Math.max(0, messageWidth - this._visibleLength(hint)))}`;
    } else {
      output += `\x1b[${messageStartRow};1H\x1b[K${' '.repeat(messageWidth)}`;
    }

    // Header: Logo + 版本（opencode 风格: ⌬ Anvil）
    const icon = t.primary('⌬');
    const ver = t.textMuted('Anvil v0.1.0-alpha');
    const help = t.textMuted('Ctrl+D 退出 · /help 帮助');
    const headerLine = `  ${icon}  ${ver}  ${chalk.dim('│')}  ${help}`;
    const headerPad = ' '.repeat(Math.max(0, messageWidth - this._visibleLength(headerLine)));

    output += `\x1b[${messageStartRow + 1};1H\x1b[K${headerLine}${headerPad}`;
    output += `\x1b[${messageStartRow + 2};1H\x1b[K${' '.repeat(messageWidth)}`;

    // 计算可见行
    const viewportStart = messageStartRow + 3;
    const visibleLines = this.renderedLines.slice(
      Math.max(0, this.renderedLines.length - messageViewportHeight - this.scrollOffset),
      this.renderedLines.length - this.scrollOffset
    );

    // 构建显示行：对超长行做换行处理，避免内容侵入侧边栏
    const displayLines = [];
    for (const line of visibleLines) {
      if (line) {
        const wrapped = this._wrapLine(line, messageWidth);
        displayLines.push(...wrapped);
      } else {
        displayLines.push('');
      }
    }
    // 限制显示行数 ≤ viewport 高度
    // 在底部时保留最后 viewport 行（批准组件、最新输出在末尾）
    // 向上滚动时保留最前 viewport 行（用户在查看历史内容）
    if (displayLines.length > messageViewportHeight) {
      if (this.scrollOffset === 0) {
        displayLines = displayLines.slice(displayLines.length - messageViewportHeight);
      } else {
        displayLines = displayLines.slice(0, messageViewportHeight);
      }
    }

    // 增量渲染：只更新实际变化的行
    for (let i = 0; i < messageViewportHeight; i++) {
      const row = viewportStart + i;
      const line = i < displayLines.length ? displayLines[i] : '';
      const lastLine = i < this._lastRenderedVisibleLines.length ? this._lastRenderedVisibleLines[i] : null;

      // 只更新变化的行
      if (line !== lastLine) {
        if (line) {
          // 用空格填充到 messageWidth，确保不侵入侧边栏区域
          const visibleLen = this._visibleLength(line);
          const padding = messageWidth - Math.min(visibleLen, messageWidth);
          output += `\x1b[${row};1H\x1b[K${line}${' '.repeat(Math.max(0, padding))}`;
        } else {
          output += `\x1b[${row};1H\x1b[K${' '.repeat(messageWidth)}`;
        }
        // 更新缓存
        if (i < this._lastRenderedVisibleLines.length) {
          this._lastRenderedVisibleLines[i] = line;
        } else {
          this._lastRenderedVisibleLines.push(line);
        }
      }
    }

    // 如果新行数少于之前的缓存长度，清理多余部分并填充背景
    if (displayLines.length < this._lastRenderedVisibleLines.length) {
      for (let i = displayLines.length; i < this._lastRenderedVisibleLines.length; i++) {
        const row = viewportStart + i;
        output += `\x1b[${row};1H\x1b[K${' '.repeat(messageWidth)}`;
      }
      this._lastRenderedVisibleLines = this._lastRenderedVisibleLines.slice(0, displayLines.length);
    }

    // 一次性输出所有内容
    process.stdout.write(output);
  }

  /**
   * 滚动到底部（如果用户手动翻页了，暂停自动滚动）
   */
  _scrollToBottom() {
    if (this._scrollPaused) {return;}
    this.scrollOffset = 0;
  }

  /**
   * 强制滚动到底部（新用户消息时使用）
   */
  _forceScrollToBottom() {
    this._scrollPaused = false;
    this._showScrollHint = false;
    this.scrollOffset = 0;
  }

  /**
   * 向上滚动（暂停自动滚动）
   */
  scrollUp(lines = 5) {
    const maxOffset = Math.max(0, this.renderedLines.length - this.layout.messageViewportHeight);
    const prevOffset = this.scrollOffset;
    this.scrollOffset = Math.min(this.scrollOffset + lines, maxOffset);

    // 如果确实发生了滚动，暂停自动滚动并清除渲染缓存
    if (this.scrollOffset > prevOffset) {
      this._scrollPaused = true;
      this._showScrollHint = true;
      this._lastRenderedVisibleLines = []; // 强制重绘viewport
    }
  }

  /**
   * 向下滚动
   */
  scrollDown(lines = 5) {
    const prevOffset = this.scrollOffset;
    this.scrollOffset = Math.max(0, this.scrollOffset - lines);

    // 如果滚到底部了，恢复自动滚动
    if (this.scrollOffset <= 0) {
      this.scrollOffset = 0;
      this._scrollPaused = false;
      this._showScrollHint = false;
      this._lastRenderedVisibleLines = []; // 强制重绘viewport
    } else if (this.scrollOffset !== prevOffset) {
      this._lastRenderedVisibleLines = []; // scrolled changed, force redraw
    }
  }

  /**
   * 截断字符串到指定显示宽度（处理 ANSI 转义序列）
   */
  _truncateToWidth(str, maxWidth) {
    let visibleWidth = 0;
    let inEscape = false;
    let result = '';

    for (let i = 0; i < str.length; i++) {
      const char = str[i];

      if (char === '\n') {continue;}

      if (char === '\x1b') {
        inEscape = true;
        result += char;
        continue;
      }
      if (inEscape) {
        result += char;
        if (char === 'm') {inEscape = false;}
        continue;
      }

      const charWidth = this._isCJK(char) ? 2 : 1;
      if (visibleWidth + charWidth > maxWidth) {break;}
      result += char;
      visibleWidth += charWidth;
    }

    return result;
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
   * 计算字符串的可见长度（支持 CJK 双倍宽字符）
   */
  _visibleLength(str) {
    let len = 0;
    let inEscape = false;
    for (let i = 0; i < str.length; i++) {
      if (str[i] === '\x1b') { inEscape = true; continue; }
      if (inEscape) { if (str[i] === 'm') {inEscape = false;} continue; }
      len += this._isCJK(str[i]) ? 2 : 1;
    }
    return len;
  }

  /**
   * 按可见字符宽度换行（支持 ANSI 转义序列状态延续 + CJK 双倍宽字符）
   * @param {string} str - 输入字符串（含 ANSI 码）
   * @param {number} maxWidth - 最大可见字符数
   * @returns {string[]} 换行后的行数组
   */
  _wrapLine(str, maxWidth) {
    if (maxWidth <= 0 || this._visibleLength(str) <= maxWidth) {return [str];}
    const lines = [];
    let visibleWidth = 0;
    let currentLine = '';
    let openAnsi = '';
    let i = 0;

    while (i < str.length) {
      // 捕获 ANSI 转义序列
      if (str[i] === '\x1b') {
        const start = i;
        i++;
        while (i < str.length && str[i] !== 'm') {i++;}
        if (i < str.length) {i++;}
        const seq = str.slice(start, i);
        currentLine += seq;

        if (/^\x1b\[0[;m]/.test(seq) || seq === '\x1b[m') {
          openAnsi = '';
        } else if (seq.endsWith('m')) {
          openAnsi += seq;
        }
        continue;
      }

      const charWidth = this._isCJK(str[i]) ? 2 : 1;

      // 达到最大宽度，换行
      if (visibleWidth + charWidth > maxWidth) {
        if (openAnsi) {currentLine += '\x1b[0m';}
        lines.push(currentLine);
        currentLine = openAnsi;
        visibleWidth = 0;
        // 如果当前字符宽度 > maxWidth（极端情况），跳过
        if (charWidth > maxWidth) {
          i++;
          continue;
        }
      }

      currentLine += str[i];
      visibleWidth += charWidth;
      i++;
    }

    if (currentLine || openAnsi) {lines.push(currentLine || openAnsi);}
    return lines;
  }

  /**
   * 重置
   */
  reset() {
    this._inThinking = false;
    this._hasThinkingContent = false;
    this._contentStarted = false;
    this._startTime = null;
    this._thinkingBuffer = '';
    this._lastRenderedLine = null;
    this._lastRenderedVisibleLines = [];
    this.renderer.markdown.reset();
  }

  /**
   * 清空消息
   */
  clear() {
    this.messages = [];
    this.renderedLines = [];
    this.scrollOffset = 0;
    this._scrollPaused = false;
    this._showScrollHint = false;
    this._lastRenderedLine = null;
    this._lastRenderedVisibleLines = [];
    this.reset();
  }
}

module.exports = MessageBox;

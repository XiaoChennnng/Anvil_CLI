'use strict';

const chalk = require('chalk');
const { getTheme } = require('../theme');
const MessageRenderer = require('./message');
const { visibleLength } = require('../ansi');

class MessageBox {
  constructor(layout) {
    this.layout = layout;
    this.theme = getTheme();
    this.renderer = new MessageRenderer();
    this.messages = [];        // 所有消息
    this.renderedLines = [];   // 渲染后的所有行
    this.scrollOffset = 0;     // 滚动偏移
    this._scrollPaused = false; // 用户手动翻页后暂停自动滚动
    this._showScrollHint = false;
    this.isProcessing = false;
    this._lastRenderedLine = null;  // 去重
    this._thinkingBuffer = '';
    this._inThinking = false;
    this._hasThinkingContent = false;
    this._contentStarted = false;
    this._startTime = null;
    this._lastRenderedVisibleLines = [];
    this._firstContentBlock = true;
    this.MAX_RENDERED_LINES = 2000;
    // 可见长度缓存
    this._visibleLengthCache = new Map();
    // 换行缓存（按 str|maxWidth）
    this._wrapLineCache = new Map();
    this._cjkCache = new Map();
  }

  // 修剪 renderedLines 防止无限增长
  _trimRenderedLines() {
    if (this.renderedLines.length > this.MAX_RENDERED_LINES) {
      const excess = this.renderedLines.length - this.MAX_RENDERED_LINES;
      this.renderedLines.splice(0, excess);
      // 清空增量渲染缓存（行位置变了）
      this._lastRenderedVisibleLines = [];
      // scrollOffset 也做相应调整
      if (this.scrollOffset > 0) {
        this.scrollOffset = Math.max(0, this.scrollOffset - excess);
      }
    }
    // 清理缓存（行位置变了，缓存的键不再有效）
    this._visibleLengthCache.clear();
    this._wrapLineCache.clear();
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

    // 输出剩余思考缓冲（跳过空行）。注意：必须应用 thinkingFallback 灰色样式，
    // 否则流式输出时思考内容最后一行（没有 \n 结尾的残留 buffer）会以默认色显示
    if (this._thinkingBuffer && this._thinkingBuffer.trim() !== '') {
      this.renderedLines.push(this.theme.thinkingFallback(this._thinkingBuffer));
      this._thinkingBuffer = '';
    }
    // 不添加空行，让后续内容紧贴思考内容
    this._scrollToBottom();
  }

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
    // 移除工具调用行后所有空行，让结果紧贴工具调用
    while (this.renderedLines.length > 0 && this.renderedLines[this.renderedLines.length - 1].trim() === '') {
      this.renderedLines.pop();
    }
    this._scrollToBottom();
  }

  /**
   * 添加工具结果
   */
  addToolResult(name, result, toolCall) {
    // 移除工具调用和结果之间的所有空行
    while (this.renderedLines.length > 0 && this.renderedLines[this.renderedLines.length - 1].trim() === '') {
      this.renderedLines.pop();
    }
    // 先 flush markdown 渲染器的缓冲区（避免内容被截断）
    this.flushContentBuffer();

    // 错误结果限制：只显示前20行，避免长堆栈撑爆显示
    let displayResult = result;
    const MAX_RESULT_LINES = 20;
    if (result && result.error) {
      // 错误结果最多显示20行
      displayResult = { ...result };
      if (displayResult.content && displayResult.content.split('\n').length > MAX_RESULT_LINES) {
        const lines = displayResult.content.split('\n');
        displayResult.content = lines.slice(0, MAX_RESULT_LINES).join('\n') + `\n... (错误输出截断，共 ${lines.length} 行)`;
      }
    }

    const maxResultHeight = 50; // 最多显示50行，超出滚动查看
    const lines = this.renderer.renderToolResponse(name, displayResult, toolCall, this.layout.messageWidth - 2, maxResultHeight);
    this.renderedLines.push(...lines);
    this._scrollToBottom();
  }

  /**
   * 完成响应（显示模型名和耗时）
   */
  finishResponse(model) {
    const t = this.theme;

    // flush 剩余 markdown 缓冲（AI的响应由AI自己决定，代码不添加硬编码提示）
    const remaining = this.renderer.markdown.flush();
    if (remaining) {
      const lines = remaining.split('\n');
      for (const line of lines) {
        if (line.trim() === '') {continue;}
        // 去重：跳过与最后渲染行相同的行
        if (line === this._lastRenderedLine) {
          continue;
        }
        this._lastRenderedLine = line;

        if (this._firstContentBlock) {
          const marker = chalk.hex(t.colors.primary)('●');
          this.renderedLines.push(` ${marker} ${line}`);
          this._firstContentBlock = false;
        } else {
          this.renderedLines.push(` ${line}`);
        }
      }
    }

    // 过滤掉末尾的空行
    while (this.renderedLines.length > 0 && this.renderedLines[this.renderedLines.length - 1].trim() === '') {
      this.renderedLines.pop();
    }
    this._scrollToBottom();
  }

  // 渲染消息区到屏幕（双缓冲模式，减少闪烁）
  render() {
    // 渲染前检查是否需要裁剪 renderedLines
    this._trimRenderedLines();

    const { messageStartRow, messageWidth, messageViewportHeight } = this.layout;
    const t = this.theme;

    // 构建完整输出字符串
    let output = '';

    // 滚动提示（翻页时显示在 header 区域顶部）
    if (this._showScrollHint && this.scrollOffset > 0) {
      const hint = chalk.bgHex(t.colors.backgroundSecondary).hex(t.colors.textMuted)(
        ` ↑ ${this.scrollOffset} 行之前的内容 · 按 PageDown 继续向下查看 `
      );
      output += `\x1b[${messageStartRow};1H${hint}${' '.repeat(Math.max(0, messageWidth - this._visibleLength(hint)))}`;
    } else {
      output += `\x1b[${messageStartRow};1H${' '.repeat(messageWidth)}`;
    }

    // Header: Logo + 版本（opencode 风格: ⌬ Anvil）
    const icon = t.primary('⌬');
    const ver = t.textMuted('Anvil v0.1.0-alpha');
    const help = t.textMuted('Ctrl+D 退出 · /help 帮助');
    const headerLine = `  ${icon}  ${ver}  ${chalk.dim('│')}  ${help}`;
    const headerPad = ' '.repeat(Math.max(0, messageWidth - this._visibleLength(headerLine)));

    output += `\x1b[${messageStartRow + 1};1H${headerLine}${headerPad}`;
    output += `\x1b[${messageStartRow + 2};1H${' '.repeat(messageWidth)}`;

    // 计算可见行
    const viewportStart = messageStartRow + 3;
    const visibleLines = this.renderedLines.slice(
      Math.max(0, this.renderedLines.length - messageViewportHeight - this.scrollOffset),
      this.renderedLines.length - this.scrollOffset
    );

    // 构建显示行：对超长行做换行处理
    let displayLines = [];
    for (const line of visibleLines) {
      if (line) {
        const wrapped = this._wrapLine(line, messageWidth);
        displayLines.push(...wrapped);
      } else {
        displayLines.push('');
      }
    }
    // 截断到 viewport 高度（底部优先）
    if (displayLines.length > messageViewportHeight) {
      displayLines = displayLines.slice(-messageViewportHeight);
    }

    // 固定位置写入每行（每行都写，无增量比较）
    for (let i = 0; i < messageViewportHeight; i++) {
      const row = viewportStart + i;
      const line = i < displayLines.length ? displayLines[i] : '';

      if (line) {
        const visibleLen = this._visibleLength(line);
        const padding = messageWidth - Math.min(visibleLen, messageWidth);
        // 确保 ANSI 样式被关闭，防止污染 padding 空格
        const safeLine = line.includes('\x1b') ? line + '\x1b[0m' : line;
        output += `\x1b[${row};1H${safeLine}${' '.repeat(Math.max(0, padding))}\x1b[K`;
      } else {
        // 使用 \x1b[K 清除到行尾，避免终端变窄时旧内容残留
        output += `\x1b[${row};1H\x1b[K`;
      }
    }

    // 更新缓存
    this._lastRenderedVisibleLines = displayLines.slice();

    return output;
  }

  // 滚动到底部
  _scrollToBottom() {
    if (this._scrollPaused) {return;}
    this.scrollOffset = 0;
  }

  // 强制滚动到底部
  _forceScrollToBottom() {
    this._scrollPaused = false;
    this._showScrollHint = false;
    this.scrollOffset = 0;
  }

  // 向上滚动
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

  // 向下滚动
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

  // 截断字符串到指定显示宽度（处理 ANSI 转义序列）
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

  // 判断是否为 CJK 双倍宽字符（带缓存）
  _isCJK(char) {
    if (char.length === 0) {return false;}
    // 快速路径：ASCII 字符不是 CJK
    const code = char.charCodeAt(0);
    if (code < 0x1100) {return false;}

    // 查缓存
    if (this._cjkCache.has(code)) {return this._cjkCache.get(code);}

    const result = (code <= 0x115F) ||
      (code >= 0x2E80 && code <= 0xA4CF) ||
      (code >= 0xAC00 && code <= 0xD7AF) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0xFE10 && code <= 0xFE6F) ||
      (code >= 0xFF01 && code <= 0xFF60) ||
      (code >= 0xFFE0 && code <= 0xFFE6) ||
      (code >= 0x3000 && code <= 0x303F);

    // 限制缓存大小
    if (this._cjkCache.size < 200) {
      this._cjkCache.set(code, result);
    }
    return result;
  }

  // 计算字符串的可见长度（带缓存）
  _visibleLength(str) {
    if (!str) {return 0;}

    // 查缓存
    if (this._visibleLengthCache.has(str)) {
      return this._visibleLengthCache.get(str);
    }

    const len = visibleLength(str);

    // 限制缓存大小，超限时淘汰最旧的条目
    const MAX_VISIBLE_LENGTH_CACHE = 1000;
    if (this._visibleLengthCache.size >= MAX_VISIBLE_LENGTH_CACHE) {
      // 淘汰最旧的条目（Map 按插入顺序存储，第一个就是最早的）
      const firstKey = this._visibleLengthCache.keys().next().value;
      this._visibleLengthCache.delete(firstKey);
    }
    this._visibleLengthCache.set(str, len);
    return len;
  }

  // 按可见字符宽度换行（带缓存）
  _wrapLine(str, maxWidth) {
    if (maxWidth <= 0) {return [str];}

    // 查缓存
    const cacheKey = str + '|' + maxWidth;
    if (this._wrapLineCache.has(cacheKey)) {
      return this._wrapLineCache.get(cacheKey);
    }

    // 快速路径：不需要换行
    if (this._visibleLength(str) <= maxWidth) {
      const result = [str];
      if (this._wrapLineCache.size < 500) {
        this._wrapLineCache.set(cacheKey, result);
      }
      return result;
    }

    const lines = [];
    let visibleWidth = 0;
    let currentLine = '';
    let openAnsi = '';  // 追踪未关闭的 ANSI 序列
    let i = 0;

    // 完整的 ANSI 序列正则（包括 24-bit 真彩色）
    const ANSI_SEQ_PATTERN = /^(\x1b\[[0-9;]*[mHKhlA-Za-z=]|\x1b\?[0-9;]*[hl]|\x1b\][^\x07]*\x07|\x1b\\|\x1b\[\?1049[hl]|\x1b\[38;2;\d+;\d+;\d+m|\x1b\[48;2;\d+;\d+;\d+m)/;

    while (i < str.length) {
      // 捕获 ANSI 转义序列
      if (str[i] === '\x1b') {
        const rest = str.slice(i);
        const match = rest.match(ANSI_SEQ_PATTERN);
        if (match) {
          const seq = match[0];
          currentLine += seq;

          // 重置样式序列清除 openAnsi
          if (/^\x1b\[0[;m]*$/.test(seq) || seq === '\x1b[m') {
            openAnsi = '';
          } else if (seq.includes('m')) {
            openAnsi += seq;
          }
          i += seq.length;
          continue;
        }
      }

      // 使用缓存的 _isCJK 方法
      const charWidth = this._isCJK(str[i]) ? 2 : 1;

      // 达到最大宽度，换行
      if (visibleWidth + charWidth > maxWidth) {
        // 如果当前行有实际内容才添加 reset + 换行
        if (currentLine.trim()) {
          if (openAnsi) {currentLine += '\x1b[0m';}
          lines.push(currentLine);
        }
        currentLine = openAnsi;  // 只携带未关闭的 ANSI 状态
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

    // 推送最后一行（只有 ANSI 序列而无实际内容时不推送）
    const stripped = currentLine.replace(/\x1b\[[0-9;]*[mHKhlA-Za-z=]|\x1b\?[0-9;]*[hl]|\x1b\][^\x07]*\x07|\x1b\\|\x1b\[\?1049[hl]|\x1b\[38;2;\d+;\d+;\d+m|\x1b\[48;2;\d+;\d+;\d+m/g, '');
    if (stripped.trim()) {
      if (openAnsi) {currentLine += '\x1b[0m';}
      lines.push(currentLine);
    } else if (lines.length > 0) {
      // 如果最后只有 ANSI 状态没有内容，关闭它避免样式泄漏
      lines.push('\x1b[0m');
    }

    // 限制缓存大小，超限时淘汰最旧的条目
    const MAX_WRAP_LINE_CACHE = 500;
    if (this._wrapLineCache.size >= MAX_WRAP_LINE_CACHE) {
      const firstKey = this._wrapLineCache.keys().next().value;
      this._wrapLineCache.delete(firstKey);
    }
    this._wrapLineCache.set(cacheKey, lines);
    return lines;
  }

  // 重置
  reset() {
    this._inThinking = false;
    this._hasThinkingContent = false;
    this._contentStarted = false;
    this._startTime = null;
    this._thinkingBuffer = '';
    this._lastRenderedLine = null;
    this._lastRenderedVisibleLines = [];
    this.renderer.markdown.reset();
    // 渲染相关缓存
    this._visibleLengthCache.clear();
    this._wrapLineCache.clear();
  }

  // 清空消息
  clear() {
    this.messages = [];
    this.renderedLines = [];
    this.scrollOffset = 0;
    this._scrollPaused = false;
    this._showScrollHint = false;
    this._lastRenderedLine = null;
    this._lastRenderedVisibleLines = [];
    this._visibleLengthCache.clear();
    this._wrapLineCache.clear();
    this.reset();
  }
}

module.exports = MessageBox;

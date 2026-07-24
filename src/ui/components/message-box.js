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
    this.messages = [];
    this.renderedLines = [];
    this.scrollOffset = 0;
    this._scrollPaused = false; // 用户手动翻页后暂停自动滚动
    this._showScrollHint = false;
    this.isProcessing = false;
    this._lastRenderedLine = null; // 上一渲染行，用于去重
    this._thinkingBuffer = '';
    this._inThinking = false;
    this._hasThinkingContent = false;
    this._contentStarted = false;
    this._startTime = null;
    this._lastRenderedVisibleLines = [];
    this._firstContentBlock = true;
    this.MAX_RENDERED_LINES = 2000;
    this._visibleLengthCache = new Map();
    this._wrapLineCache = new Map(); // key = str|maxWidth
    this._cjkCache = new Map();

    // 工具调用执行中状态机(callId -> {toolCall, lineIndex, status, startTime, blinkVisible})
    // status: 'pending' | 'success' | 'error' | 'warning'
    this._runningToolCalls = new Map();
    // 闪烁 tick 计数器(100ms 步进),控制 ● 字符显示/隐藏
    this._loadingFrame = 0;
    this._loadingTimer = null;
    // TUI 注入的回调:runningToolCalls 数量变化时通知(用于启停 timer)
    this._onLoadingChange = null;
    // TUI 注入的 tick 回调:让 TUI 重绘消息区
    this._onLoadingTick = null;
    // 工具结果后恢复内容输出时,先空一行再渲染
    this._resumeAfterTool = false;
  }

  // 修剪 renderedLines 防止无限增长
  _trimRenderedLines() {
    if (this.renderedLines.length > this.MAX_RENDERED_LINES) {
      const excess = this.renderedLines.length - this.MAX_RENDERED_LINES;
      this.renderedLines.splice(0, excess);
      this._lastRenderedVisibleLines = []; // 行位置变了，缓存失效
      if (this.scrollOffset > 0) {
        this.scrollOffset = Math.max(0, this.scrollOffset - excess);
      }
    }
    // 行位置变了，所有按行索引的缓存键失效
    this._visibleLengthCache.clear();
    this._wrapLineCache.clear();
  }

  addUserMessage(content) {
    const width = this.layout.messageWidth - 2; // 减去边框和 padding
    const lines = this.renderer.renderMessage(content, true, width);
    this.messages.push({ type: 'user', lines });
    this.renderedLines.push(...lines, ''); // 空行分隔消息
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

    const lines = this._thinkingBuffer.split('\n');
    this._thinkingBuffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim() === '') {continue;}
      // 思考内容：灰色无斜体（跨终端兼容），不加 ● 前缀
      this.renderedLines.push(this.theme.thinkingFallback(line));
    }
    this._scrollToBottom();
  }

  startContent() {
    this._inThinking = false;
    this._contentStarted = true;
    this._firstContentBlock = true;

    // flush 残留思考缓冲必须用 thinkingFallback 灰色，否则最后一行残留 buffer 会以默认色显示
    if (this._thinkingBuffer && this._thinkingBuffer.trim() !== '') {
      this.renderedLines.push(this.theme.thinkingFallback(this._thinkingBuffer));
      this._thinkingBuffer = '';
    }
    // 思考块与内容块之间空一行
    this.renderedLines.push('');
    this._scrollToBottom();
  }

  addContentChunk(chunk) {
    // 解析 <think> 标签（部分模型如 MiniMax 将思考内容嵌入文本中）
    this._parseThinkTags(chunk);
    this._scrollToBottom();
  }

  /**
   * 解析 <think> 标签，思考内容路由到 thinking 渲染，普通内容走 markdown 渲染
   */
  _parseThinkTags(chunk) {
    let remaining = chunk;

    while (remaining.length > 0) {
      if (this._inThinking) {
        const endIdx = remaining.indexOf('</think>');
        if (endIdx === -1) {
          this.addThinkingChunk(remaining);
          return;
        }
        const thinkText = remaining.slice(0, endIdx);
        if (thinkText) {this.addThinkingChunk(thinkText);}
        this._inThinking = false;
        if (this._hasThinkingContent) {
          this._flushThinking();
        }
        remaining = remaining.slice(endIdx + 8);
      } else {
        const startIdx = remaining.indexOf('<think>');
        if (startIdx === -1) {
          this._renderContentText(remaining);
          return;
        }
        if (startIdx > 0) {
          this._renderContentText(remaining.slice(0, startIdx));
        }
        this._inThinking = true;
        this._hasThinkingContent = false;
        this._thinkingBuffer = '';
        this._startTime = Date.now();
        remaining = remaining.slice(startIdx + 7);
      }
    }
  }

  _renderContentText(text) {
    if (!text || text.trim() === '') {return;}
    const t = this.theme;
    // 流式渲染时同步主消息区宽度给 markdown,确保超宽表格能正确降级
    this.renderer.setContentWidth(this.layout.messageWidth - 2);
    const rendered = this.renderer.markdown.write(text);
    if (!rendered) {return;}

    // 刚从工具结果恢复内容输出,先空一行
    if (this._resumeAfterTool) {
      this.renderedLines.push('');
      this._firstContentBlock = true;
      this._resumeAfterTool = false;
    }

    const lines = rendered.split('\n');
    for (const line of lines) {
      if (line.trim() === '') {continue;}
      if (line === this._lastRenderedLine) {continue;}
      this._lastRenderedLine = line;

      if (this._firstContentBlock) {
        const marker = chalk.hex(t.colors.primary)('●');
        // 如果第一行是表格框线(U+2500~U+257F), ● 放单独一行,避免顶框和表身错位
        const firstCode = line.trim().charCodeAt(0);
        if (firstCode >= 0x2500 && firstCode <= 0x257F) {
          this.renderedLines.push(` ${marker}`);
          this.renderedLines.push(` ${line}`);
        } else {
          this.renderedLines.push(` ${marker} ${line}`);
        }
        this._firstContentBlock = false;
      } else {
        this.renderedLines.push(` ${line}`);
      }
    }
  }

  _flushThinking() {
    if (this._thinkingBuffer && this._thinkingBuffer.trim() !== '') {
      this.renderedLines.push(this.theme.thinkingFallback(this._thinkingBuffer));
      this._thinkingBuffer = '';
    }
    this._hasThinkingContent = false;
  }

  flushContentBuffer() {
    const t = this.theme;

    // 同步主消息区宽度,保证 flush 时表格宽度判断用的是 TUI 实际宽度
    this.renderer.setContentWidth(this.layout.messageWidth - 2);
    const remaining = this.renderer.markdown.flush();
    if (remaining) {
      const lines = remaining.split('\n');
      for (const line of lines) {
        if (line.trim() === '') {continue;}
        if (line === this._lastRenderedLine) {continue;}
        this._lastRenderedLine = line;
        if (this._firstContentBlock) {
          const marker = chalk.hex(t.colors.primary)('●');
          const firstCode = line.trim().charCodeAt(0);
          if (firstCode >= 0x2500 && firstCode <= 0x257F) {
            this.renderedLines.push(` ${marker}`);
            this.renderedLines.push(` ${line}`);
          } else {
            this.renderedLines.push(` ${marker} ${line}`);
          }
          this._firstContentBlock = false;
        } else {
          this.renderedLines.push(` ${line}`);
        }
      }
    }
  }

  addToolCall(toolCalls) {
    // 先 flush markdown 缓冲，避免未渲染内容被截断
    this.flushContentBuffer();

    // 内容与工具调用之间空一行
    this.renderedLines.push('');

    const calls = Array.isArray(toolCalls) ? toolCalls : [toolCalls];
    for (const call of calls) {
      const lines = this.renderer.renderToolCall(call, this.layout.messageWidth - 2, false, 'pending', true);
      this.renderedLines.push(...lines);
      // 记录 runningToolCall(callId 缺失时跳过闪烁)
      const callId = call.id;
      if (callId && lines.length > 0) {
        this._runningToolCalls.set(callId, {
          toolCall: call,
          lineIndex: this.renderedLines.length - lines.length,
          status: 'pending',
          startTime: Date.now(),
          lineCount: lines.length,
        });
      }
    }
    // 移除末尾空行让结果紧贴工具调用
    while (this.renderedLines.length > 0 && this.renderedLines[this.renderedLines.length - 1].trim() === '') {
      this.renderedLines.pop();
    }
    this._scrollToBottom();
    this._notifyLoadingChange();
  }

  addToolResult(name, result, toolCall) {
    while (this.renderedLines.length > 0 && this.renderedLines[this.renderedLines.length - 1].trim() === '') {
      this.renderedLines.pop();
    }
    this.flushContentBuffer();

    // 错误结果截断到 20 行，避免长堆栈撑爆显示
    let displayResult = result;
    const MAX_RESULT_LINES = 20;
    if (result && result.error) {
      displayResult = { ...result };
      if (displayResult.content && displayResult.content.split('\n').length > MAX_RESULT_LINES) {
        const lines = displayResult.content.split('\n');
        displayResult.content = lines.slice(0, MAX_RESULT_LINES).join('\n') + `\n... (错误输出截断，共 ${lines.length} 行)`;
      }
    }

    const maxResultHeight = 50; // 超出滚动查看
    const lines = this.renderer.renderToolResponse(name, displayResult, toolCall, this.layout.messageWidth - 2, maxResultHeight);
    this.renderedLines.push(...lines);

    // 标记工具调用完成后恢复内容输出时需空一行
    this._resumeAfterTool = true;

    // 标记工具调用完成(更新状态色:成功/失败/超时)
    const callId = toolCall?.id;
    if (callId && this._runningToolCalls.has(callId)) {
      const run = this._runningToolCalls.get(callId);
      run.status = result?.error
        ? 'error'
        : (result?.warning || result?.timedOut ? 'warning' : 'success');
      // 重新渲染该调用行,把 status 色(绿/红/黄)烧进 ANSI,替代原先的 pending 白色
      this._reRenderToolCallLine(run);
      // 从 running 移除(完成态不再闪烁)
      this._runningToolCalls.delete(callId);
      this._notifyLoadingChange();
    }

    this._scrollToBottom();
  }

  /**
   * 重新渲染指定 toolCall 行(替换 renderedLines 中的对应行)
   * 用于完成时把 pending 状态色换成 success/error/warning 终态色
   */
  _reRenderToolCallLine(run) {
    if (!run || run.lineIndex === null || run.lineIndex === undefined) {return;}
    const newLines = this.renderer.renderToolCall(
      run.toolCall,
      this.layout.messageWidth - 2,
      false,
      run.status,
      true, // 完成时总是显示 ●
    );
    for (let i = 0; i < run.lineCount; i++) {
      this.renderedLines[run.lineIndex + i] = newLines[i] || '';
    }
  }

  /**
   * 滚动暂停时,停止闪烁 timer(避免边滚边闪)
   */
  _maybeStopLoadingOnScroll() {
    if (this._scrollPaused && this._runningToolCalls.size > 0) {
      this._notifyLoadingChange(); // 触发 timer 暂停
    }
  }

  /**
   * 通知 TUI loading 状态变化(启用/停止 timer)
   * 由 TUI 注入 _onLoadingChange 时调用
   */
  _notifyLoadingChange() {
    if (this._onLoadingChange) {
      const shouldRun = this._runningToolCalls.size > 0 && !this._scrollPaused;
      this._onLoadingChange(shouldRun);
    }
  }

  /**
   * 闪烁 tick:由 TUI 100ms timer 触发,重新渲染所有 runningToolCall 行并标记刷帧
   * 内部递增 _loadingFrame,renderToolCall 用 _loadingFrame % 2 决定 ● 显示/隐藏
   */
  tickLoading() {
    if (this._runningToolCalls.size === 0 || this._scrollPaused) {return;}
    this._loadingFrame++;
    const visible = this._loadingFrame % 2 === 0;
    for (const run of this._runningToolCalls.values()) {
      const newLines = this.renderer.renderToolCall(
        run.toolCall,
        this.layout.messageWidth - 2,
        false,
        run.status,
        visible,
      );
      for (let i = 0; i < run.lineCount; i++) {
        this.renderedLines[run.lineIndex + i] = newLines[i] || '';
      }
    }
    if (this._onLoadingTick) {
      this._onLoadingTick();
    }
  }

  finishResponse(model) {
    const t = this.theme;

    // 同步主消息区宽度,保证 finishResponse 时表格宽度判断用的是 TUI 实际宽度
    this.renderer.setContentWidth(this.layout.messageWidth - 2);
    // flush markdown 缓冲（AI 自己决定响应结束语，代码不硬编码）
    const remaining = this.renderer.markdown.flush();
    if (remaining) {
      const lines = remaining.split('\n');
      for (const line of lines) {
        if (line.trim() === '') {continue;}
        if (line === this._lastRenderedLine) {continue;}
        this._lastRenderedLine = line;

        if (this._firstContentBlock) {
          const marker = chalk.hex(t.colors.primary)('●');
          const firstCode = line.trim().charCodeAt(0);
          if (firstCode >= 0x2500 && firstCode <= 0x257F) {
            this.renderedLines.push(` ${marker}`);
            this.renderedLines.push(` ${line}`);
          } else {
            this.renderedLines.push(` ${marker} ${line}`);
          }
          this._firstContentBlock = false;
        } else {
          this.renderedLines.push(` ${line}`);
        }
      }
    }

    while (this.renderedLines.length > 0 && this.renderedLines[this.renderedLines.length - 1].trim() === '') {
      this.renderedLines.pop();
    }
    // 消息末尾空一行，与下一条消息分开
    this.renderedLines.push('');
    this._scrollToBottom();
  }

  // 双缓冲全量重绘，减少闪烁
  render() {
    this._trimRenderedLines();

    const { messageStartRow, messageWidth, messageViewportHeight } = this.layout;
    const t = this.theme;

    let output = '';

    // 滚动提示（翻页时显示在 header 顶部）
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

    const viewportStart = messageStartRow + 3;
    const visibleLines = this.renderedLines.slice(
      Math.max(0, this.renderedLines.length - messageViewportHeight - this.scrollOffset),
      this.renderedLines.length - this.scrollOffset
    );

    let displayLines = [];
    for (const line of visibleLines) {
      if (line) {
        displayLines.push(...this._wrapLine(line, messageWidth));
      } else {
        displayLines.push('');
      }
    }
    if (displayLines.length > messageViewportHeight) {
      displayLines = displayLines.slice(-messageViewportHeight);
    }

    // 固定位置写入每行（全量覆盖，无增量比较）
    for (let i = 0; i < messageViewportHeight; i++) {
      const row = viewportStart + i;
      const line = i < displayLines.length ? displayLines[i] : '';

      if (line) {
        const visibleLen = this._visibleLength(line);
        const padding = messageWidth - Math.min(visibleLen, messageWidth);
        // 关闭 ANSI 样式防止污染 padding 空格
        const safeLine = line.includes('\x1b') ? line + '\x1b[0m' : line;
        output += `\x1b[${row};1H${safeLine}${' '.repeat(Math.max(0, padding))}\x1b[K`;
      } else {
        // \x1b[K 清除到行尾，避免终端变窄时旧内容残留
        output += `\x1b[${row};1H\x1b[K`;
      }
    }

    this._lastRenderedVisibleLines = displayLines.slice();

    return output;
  }

  _scrollToBottom() {
    if (this._scrollPaused) {return;}
    this.scrollOffset = 0;
  }

  _forceScrollToBottom() {
    this._scrollPaused = false;
    this._showScrollHint = false;
    this.scrollOffset = 0;
  }

  scrollUp(lines = 5) {
    const maxOffset = Math.max(0, this.renderedLines.length - this.layout.messageViewportHeight);
    const prevOffset = this.scrollOffset;
    this.scrollOffset = Math.min(this.scrollOffset + lines, maxOffset);

    if (this.scrollOffset > prevOffset) {
      this._scrollPaused = true;
      this._showScrollHint = true;
      this._lastRenderedVisibleLines = [];
      // 滚动暂停时停止闪烁 timer(避免边滚边闪)
      this._notifyLoadingChange();
    }
  }

  scrollDown(lines = 5) {
    const prevOffset = this.scrollOffset;
    this.scrollOffset = Math.max(0, this.scrollOffset - lines);

    if (this.scrollOffset <= 0) {
      this.scrollOffset = 0;
      this._scrollPaused = false;
      this._showScrollHint = false;
      this._lastRenderedVisibleLines = [];
      // 回到底部时恢复闪烁
      this._notifyLoadingChange();
    } else if (this.scrollOffset !== prevOffset) {
      this._lastRenderedVisibleLines = [];
    }
  }

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

  _isCJK(char) {
    if (char.length === 0) {return false;}
    const code = char.charCodeAt(0);
    if (code < 0x1100) {return false;} // ASCII 快速路径

    if (this._cjkCache.has(code)) {return this._cjkCache.get(code);}

    const result = (code <= 0x115F) ||
      (code >= 0x2E80 && code <= 0xA4CF) ||
      (code >= 0xAC00 && code <= 0xD7AF) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0xFE10 && code <= 0xFE6F) ||
      (code >= 0xFF01 && code <= 0xFF60) ||
      (code >= 0xFFE0 && code <= 0xFFE6) ||
      (code >= 0x3000 && code <= 0x303F);

    if (this._cjkCache.size < 200) {
      this._cjkCache.set(code, result);
    }
    return result;
  }

  _visibleLength(str) {
    if (!str) {return 0;}

    if (this._visibleLengthCache.has(str)) {
      return this._visibleLengthCache.get(str);
    }

    const len = visibleLength(str);

    // 缓存满时淘汰最早条目（Map 按插入顺序）
    const MAX_VISIBLE_LENGTH_CACHE = 1000;
    if (this._visibleLengthCache.size >= MAX_VISIBLE_LENGTH_CACHE) {
      const firstKey = this._visibleLengthCache.keys().next().value;
      this._visibleLengthCache.delete(firstKey);
    }
    this._visibleLengthCache.set(str, len);
    return len;
  }

  _wrapLine(str, maxWidth) {
    if (maxWidth <= 0) {return [str];}

    const cacheKey = str + '|' + maxWidth;
    if (this._wrapLineCache.has(cacheKey)) {
      return this._wrapLineCache.get(cacheKey);
    }

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
    let openAnsi = ''; // 未关闭的 ANSI 状态，换行后需延续
    let i = 0;

    // 完整的 ANSI 序列正则（覆盖 24-bit 真彩色）
    const ANSI_SEQ_PATTERN = /^(\x1b\[[0-9;]*[mHKhlA-Za-z=]|\x1b\?[0-9;]*[hl]|\x1b\][^\x07]*\x07|\x1b\\|\x1b\[\?1049[hl]|\x1b\[38;2;\d+;\d+;\d+m|\x1b\[48;2;\d+;\d+;\d+m)/;

    while (i < str.length) {
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

      const charWidth = this._isCJK(str[i]) ? 2 : 1;

      if (visibleWidth + charWidth > maxWidth) {
        if (currentLine.trim()) {
          if (openAnsi) {currentLine += '\x1b[0m';}
          lines.push(currentLine);
        }
        currentLine = openAnsi;
        visibleWidth = 0;
        // 极宽字符（如 emoji）单独超过 maxWidth，跳过避免死循环
        if (charWidth > maxWidth) {
          i++;
          continue;
        }
      }

      currentLine += str[i];
      visibleWidth += charWidth;
      i++;
    }

    const stripped = currentLine.replace(/\x1b\[[0-9;]*[mHKhlA-Za-z=]|\x1b\?[0-9;]*[hl]|\x1b\][^\x07]*\x07|\x1b\\|\x1b\[\?1049[hl]|\x1b\[38;2;\d+;\d+;\d+m|\x1b\[48;2;\d+;\d+;\d+m/g, '');
    if (stripped.trim()) {
      if (openAnsi) {currentLine += '\x1b[0m';}
      lines.push(currentLine);
    } else if (lines.length > 0) {
      // 末尾只剩 ANSI 状态没有内容，关掉避免样式泄漏
      lines.push('\x1b[0m');
    }

    const MAX_WRAP_LINE_CACHE = 500;
    if (this._wrapLineCache.size >= MAX_WRAP_LINE_CACHE) {
      const firstKey = this._wrapLineCache.keys().next().value;
      this._wrapLineCache.delete(firstKey);
    }
    this._wrapLineCache.set(cacheKey, lines);
    return lines;
  }

  reset() {
    this._inThinking = false;
    this._hasThinkingContent = false;
    this._contentStarted = false;
    this._startTime = null;
    this._thinkingBuffer = '';
    this._lastRenderedLine = null;
    this._lastRenderedVisibleLines = [];
    this.renderer.markdown.reset();
    this._visibleLengthCache.clear();
    this._wrapLineCache.clear();
  }

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

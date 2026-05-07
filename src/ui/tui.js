'use strict';

const chalk = require('chalk');
const Layout = require('./components/layout');
const MessageBox = require('./components/message-box');
const Sidebar = require('./components/sidebar');
const Editor = require('./components/editor');
const StatusBar = require('./components/status-bar');
const QuestionPanel = require('./components/question-panel');

class TUI {
  constructor(config) {
    this.config = config || {};
    this.layout = new Layout();
    this.messageBox = new MessageBox(this.layout);
    this.sidebar = new Sidebar(this.layout);
    this.editor = new Editor(this.layout);
    this.statusBar = new StatusBar(this.layout);
    this.questionPanel = new QuestionPanel(this.layout);
    this.questionPanel.messageBox = this.messageBox;  // 注入消息区引用
    this.questionPanel._refreshDisplay = () => this._refreshMessages();  // 注入刷新回调
    this._isRunning = false;
    this._onSend = null;
    this._onExit = null;
    this._onCommand = null;
    this._onContextInject = null;
    this._isProcessing = false;
    this._hasPendingContext = false;

    // 渲染节流队列（50ms 间隔）
    this._renderQueue = null;

    // 思考中状态栏定时刷新（每秒更新耗时）
    this._thinkingTimer = null;

    // 光标隐藏标志（避免频繁 hide/show 切换造成闪烁）
    this._cursorHidden = false;
  }

  /**
   * 启动 TUI
   */
  start() {
    this.layout.enterAltScreen();
    this._isRunning = true;

    // 初始渲染
    this._fullRender();

    // 注册 resize 处理
    this.layout.on('resize', () => {
      this._fullRender();
    });
  }

  /**
   * 停止 TUI
   */
  stop() {
    this._isRunning = false;
    if (this._thinkingTimer) {
      clearInterval(this._thinkingTimer);
      this._thinkingTimer = null;
    }
    this.layout.leaveAltScreen();
  }

  /**
   * 完整重绘
   */
  _fullRender() {
    this.layout.hideCursor();
    this._cursorHidden = true;
    this.layout.clearScreen();

    // 渲染各区域
    this.messageBox.render();
    this.sidebar.render();
    this.editor.render();
    this.statusBar.render();

    // 无论是否处理中，都恢复光标到输入位置
    this._restoreCursorToEditor();
  }

  /**
   * 刷新消息区 + 侧边栏（流式输出时使用，不重绘编辑器/状态栏以减少闪烁）
   */
  _refreshMessages() {
    this.messageBox.render();
    this.sidebar.render();
  }

  /**
   * 刷新全部组件（响应结束后调用）
   */
  _refreshAll() {
    this.layout.hideCursor();
    this._cursorHidden = true;
    this.messageBox.render();
    this.sidebar.render();
    this.editor.render();
    this.statusBar.render();
    this._restoreCursorToEditor();
  }

  /**
   * 恢复光标到编辑器输入位置
   */
  _restoreCursorToEditor() {
    // 只有在 cursor 当前是隐藏状态时才 show
    if (this._cursorHidden) {
      this.layout.showCursor();
      this._cursorHidden = false;
    }
    // 使用 editor 的 cursorPos（光标可在字符间移动），不再固定在末尾
    const cursorPos = this.editor.cursorPos ?? this.editor.currentInput?.length ?? 0;
    this.layout.moveTo(this.editor.promptRow, this.editor.promptCol + cursorPos);
  }

  /**
   * 请求节流渲染（用于流式输出等高频场景）
   */
  _queueRender() {
    if (!this._renderQueue) {
      const RenderQueue = require('./render-queue');
      this._renderQueue = new RenderQueue(50);  // 50ms 节流，减少闪烁
    }
    this._renderQueue.requestRender(() => {
      this._refreshMessages();
    });
  }

  /**
   * 强制立即渲染（忽略节流）
   */
  _forceRender() {
    if (!this._renderQueue) {
      this._refreshMessages();
    } else {
      this._renderQueue.forceRender(() => {
        this._refreshMessages();
      });
    }
  }

  /**
   * 仅刷新编辑器
   */
  _refreshEditor() {
    this.editor.render();
  }

  /**
   * 仅刷新状态栏
   */
  _refreshStatusBar() {
    this.statusBar.render();
  }

  /**
   * 仅刷新侧边栏（已合并到状态栏，保留方法用于兼容）
   */
  _refreshSidebar() {
    // 侧边栏已合并到状态栏，此方法不再需要
    // 但保留以兼容旧的调用方式
  }

  /**
   * 刷新侧边栏相关的信息（Todo, Context, Cache）- 更新到状态栏
   */
  refreshSidebarInfo() {
    this.statusBar.render();
    this._restoreCursorToEditor();
  }

  /**
   * 设置状态栏临时 info 消息（自动过期）
   * @param {string} msg - 消息内容
   * @param {string} [type] - info/warn/error
   */
  setStatusInfo(msg, type) {
    this.statusBar.setInfoMessage(msg, type);
    this._refreshStatusBar();
  }

  // ─────────────────────────────────────────────
  // 事件注册
  // ─────────────────────────────────────────────

  /**
   * 注册发送回调
   */
  onSend(callback) {
    this._onSend = callback;
  }

  /**
   * 注册退出回调
   */
  onExit(callback) {
    this._onExit = callback;
  }

  /**
   * 注册命令回调
   */
  onCommand(callback) {
    this._onCommand = callback;
  }

  /**
   * 注册上下文注入回调（处理期间输入的内容）
   */
  onContextInject(callback) {
    this._onContextInject = callback;
  }

  /**
   * 设置待注入上下文状态
   */
  setPendingContext(hasPending) {
    this._hasPendingContext = hasPending;
    this.statusBar.setPendingContext(hasPending);
    this._refreshStatusBar();
  }

  // ─────────────────────────────────────────────
  // 消息渲染（对接 ChatEngine 事件）
  // ─────────────────────────────────────────────

  /**
   * 渲染用户消息
   */
  renderUserMessage(content) {
    this._isProcessing = true;
    this.layout.hideCursor();
    this.messageBox.addUserMessage(content);
    this._refreshMessages();
  }

  /**
   * 开始思考
   */
  /**
   * 启动 thinking 定时器（每秒刷新状态栏更新耗时）
   */
  _startThinkingTimer() {
    if (this._thinkingTimer) {clearInterval(this._thinkingTimer);}
    this._thinkingTimer = setInterval(() => {
      if (this.statusBar.isThinking) {
        this._refreshStatusBar();
      } else {
        clearInterval(this._thinkingTimer);
        this._thinkingTimer = null;
      }
    }, 1000);
  }

  /**
   * 恢复 thinking 状态（提问回答后 AI 继续处理时调用）
   */
  resumeThinking() {
    this.statusBar.setThinking(true);
    this._refreshStatusBar();
    this._startThinkingTimer();
  }

  renderThinkingStart() {
    this.messageBox.startThinking();
    this.statusBar.setThinking(true);
    this._refreshStatusBar();
    this._startThinkingTimer();
  }

  /**
   * 思考内容（使用节流渲染）
   */
  renderThinkingChunk(chunk) {
    this.messageBox.addThinkingChunk(chunk);
    this._queueRender();
  }

  /**
   * 开始响应内容
   */
  renderContentStart() {
    this.messageBox.startContent();
  }

  /**
   * 响应内容（使用节流渲染）
   */
  renderContentChunk(chunk) {
    this.messageBox.addContentChunk(chunk);
    this._queueRender();
  }

  /**
   * 工具调用（使用节流渲染）
   */
  renderToolCall(toolCalls) {
    this.messageBox.addToolCall(toolCalls);
    this._queueRender();
  }

  /**
   * 工具结果（使用节流渲染）
   */
  renderToolResult(name, result, toolCall) {
    this.messageBox.addToolResult(name, result, toolCall);
    this._queueRender();
  }

  /**
   * Token 使用情况
   */
  renderTokenUsage(usage, pricing) {
    this.statusBar.updateTokenUsage(usage);
    if (pricing) {this.statusBar.setPricing(pricing);}
  }

  /**
   * 完成响应
   */
  finishResponse(model) {
    this.messageBox.finishResponse(model);
    this.statusBar.setThinking(false);
    this._isProcessing = false;
    // 清除 thinking 定时器
    if (this._thinkingTimer) {
      clearInterval(this._thinkingTimer);
      this._thinkingTimer = null;
    }
    this._refreshAll();
  }

  /**
   * 显示错误
   */
  renderError(message, error) {
    const t = this.layout.theme;
    // 按换行拆分，每行独立推入（避免单行超长撑爆显示）
    const msgLines = String(message).split('\n');
    for (const line of msgLines) {
      if (line.trim() === '') {continue;}
      this.messageBox.renderedLines.push(`${t.error('✖')} ${line}`);
    }
    if (error) {
      const errText = error.message || String(error);
      const errLines = errText.split('\n');
      for (const line of errLines) {
        if (line.trim() === '') {continue;}
        this.messageBox.renderedLines.push(chalk.dim(`  ${line}`));
      }
    }
    this.messageBox.renderedLines.push('');
    this._refreshMessages();
  }

  /**
   * 显示状态消息
   */
  renderStatus(msg) {
    const t = this.layout.theme;
    const marker = chalk.hex(t.colors.primary)('●');
    this.messageBox.renderedLines.push(`${marker} ${t.textMuted(msg)}`);
    this._refreshMessages();
  }

  /**
   * 显示中断消息
   */
  renderInterrupted() {
    const t = this.layout.theme;
    const marker = chalk.hex(t.colors.primary)('●');
    this.messageBox.renderedLines.push(`${marker} ${t.textMuted('⏹ 已中断')}`);
    this._isProcessing = false;
    this._refreshAll();
  }

  /**
   * 重置消息区状态
   */
  resetMessages() {
    this.messageBox.reset();
  }

  /**
   * 渲染计划批准提示（在编辑器上方显示）
   */
  renderPlanApprovalHint() {
    const t = this.layout.theme;
    const row = this.layout.editorStartRow - 1;
    this.layout.moveTo(row, 1);
    this.layout.clearLine();
    process.stdout.write(' ' + t.success('⏳ 等待批准 — 输入 yes/批准 执行，no/拒绝 修改'));
    this._restoreCursorToEditor();
  }

  /**
   * 清空消息
   */
  clearMessages() {
    this.messageBox.clear();
    this._fullRender();
  }

  /**
   * 处理键盘输入
   */
  handleKey(buf) {
    // ─── 问答面板优先处理 ───
    if (this.questionPanel.active) {
      return this.questionPanel.handleKey(buf);
    }

    // ─── 处理期间也允许翻页 ───
    if (this._isProcessing) {
      // Ctrl+C 中断
      if (buf[0] === 0x03) {
        return { action: 'interrupt' };
      }
      // Ctrl+D 退出
      if (buf[0] === 0x04) {
        return { action: 'exit' };
      }
      // PageUp
      if (buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x35 && buf[3] === 0x7e) {
        this.messageBox.scrollUp(10);
        this._refreshMessages();
        return { action: 'scroll_up' };
      }
      // PageDown
      if (buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x36 && buf[3] === 0x7e) {
        this.messageBox.scrollDown(10);
        this._refreshMessages();
        return { action: 'scroll_down' };
      }
      // 鼠标滚轮翻页（仅处理滚轮事件，点击事件忽略以允许 Shift+选择文本）
      if (buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x3c) {
        const str = buf.toString('utf8');
        const match = str.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
        if (match) {
          const button = parseInt(match[1], 10);
          if (button === 64) { this.messageBox.scrollUp(3); this._refreshMessages(); return { action: 'scroll_up' }; }
          if (button === 65) { this.messageBox.scrollDown(3); this._refreshMessages(); return { action: 'scroll_down' }; }
        }
        return null;  // 非滚轮事件（点击等），忽略
      }
      // 处理期间允许编辑器输入，发送时走上下文注入
      const result = this.editor.handleKey(buf);
      if (result) {
        if (result.action === 'send' && result.text) {
          if (this._onContextInject) {
            this._onContextInject(result.text);
          }
          this._refreshEditor();
          return { action: 'context_inject', text: result.text };
        }
        // 所有编辑器操作都刷新显示
        this._refreshEditor();
      }
      return result;
    }

    // Ctrl+C - 清空输入
    if (buf[0] === 0x03) {
      this.editor.reset();
      this._refreshEditor();
      return { action: 'clear' };
    }

    // Ctrl+D - 退出
    if (buf[0] === 0x04) {
      return { action: 'exit' };
    }

    // Ctrl+L - 清屏重绘
    if (buf[0] === 0x0c) {
      this._fullRender();
      return { action: 'redraw' };
    }

    // PageUp - 向上滚动
    if (buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x35 && buf[3] === 0x7e) {
      this.messageBox.scrollUp(10);
      this._refreshMessages();
      return { action: 'scroll_up' };
    }

    // PageDown - 向下滚动
    if (buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x36 && buf[3] === 0x7e) {
      this.messageBox.scrollDown(10);
      this._refreshMessages();
      return { action: 'scroll_down' };
    }

    // 鼠标滚轮翻页（仅处理滚轮事件，点击事件忽略以允许 Shift+选择文本）
    if (buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x3c) {
      const str = buf.toString('utf8');
      const match = str.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
      if (match) {
        const button = parseInt(match[1], 10);
        if (button === 64) { this.messageBox.scrollUp(3); this._refreshMessages(); return { action: 'scroll_up' }; }
        if (button === 65) { this.messageBox.scrollDown(3); this._refreshMessages(); return { action: 'scroll_down' }; }
      }
      return null;  // 非滚轮事件（点击等），忽略
    }

    // 交给编辑器处理
    const result = this.editor.handleKey(buf);
    if (!result) {return null;}

    switch (result.action) {
      case 'send':
        if (result.text) {
          if (this._onSend) {
            this._onSend(result.text);
          }
        }
        break;
      case 'empty':
        this._refreshEditor();
        break;
    }

    return result;
  }

  /**
   * 设置处理状态
   */
  setProcessing(processing) {
    this._isProcessing = processing;
    if (!processing) {
      this.layout.showCursor();
      this._cursorHidden = false;
    }
  }

  /**
   * 获取是否正在处理
   */
  get isProcessing() {
    return this._isProcessing;
  }
}

module.exports = TUI;

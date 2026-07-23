'use strict';

const chalk = require('chalk');
const Layout = require('./components/layout');
const MessageBox = require('./components/message-box');
const Sidebar = require('./components/sidebar');
const Editor = require('./components/editor');
const StatusBar = require('./components/status-bar');
const QuestionPanel = require('./components/question-panel');
const TeamPanel = require('./components/team-panel');
const { visibleLength, truncateToWidth, isCJK } = require('./ansi');

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
    // 工具调用执行中闪烁:MessageBox 通知 TUI 启停 100ms timer
    this.messageBox._onLoadingChange = (shouldRun) => {
      if (shouldRun) {
        this._startLoadingTimer();
      } else {
        this._stopLoadingTimer();
      }
    };
    this.messageBox._onLoadingTick = () => this._refreshMessages();
    // Team Panel(M4) — 团队事件日志 modal,共享 sidebar 数据源
    this.teamPanel = new TeamPanel(this.layout);
    this.teamPanel.setSidebar(this.sidebar);
    // K3 新增:共享主消息区 renderer,保证团队输出格式与主 Agent 一致
    // (markdown 渲染、thinking 颜色、宽度处理)
    if (this.messageBox && this.messageBox.renderer) {
      this.teamPanel.setMessageBoxRenderer(this.messageBox.renderer);
    }
    this._isRunning = false;
    this._onSend = null;
    this._onExit = null;
    this._onCommand = null;
    this._onContextInject = null;
    this._isProcessing = false;
    this._hasPendingContext = false;
    this.chatEngine = null;  // 由 index.js 注入

    // 渲染节流队列（50ms 间隔）
    this._renderQueue = null;

    // 思考中状态栏定时刷新
    this._thinkingTimer = null;

    // 工具调用执行中闪烁 timer(500ms 间隔,● 字符 1s 闪烁周期)
    this._loadingTimer = null;
    this._loadingTickInterval = 500;

    // stdout 反压检测
    this._stdoutBackedUp = false;
    this._lastWriteResult = true;
    this.MAX_RENDER_OUTPUT = 32 * 1024; // 单次渲染最大输出 32KB，防 Windows 终端阻塞

    // 光标隐藏标志
    this._cursorHidden = false;
  }

  start() {
    this.layout.enterAltScreen();
    this._isRunning = true;

    this._fullRender();
    // 注册 resize 处理
    this.layout.onResize(() => {
      this._fullRender();
    });
  }

  stop() {
    this._isRunning = false;
    if (this._thinkingTimer) {
      clearInterval(this._thinkingTimer);
      this._thinkingTimer = null;
    }
    this._stopLoadingTimer();
    this.layout.leaveAltScreen();
  }

  /**
   * 启动 100ms 闪烁 timer,定时触发 messageBox.tickLoading() 重新生成 runningToolCall 行
   * runningToolCall 全部完成或用户向下滚动到底时自动停止
   */
  _startLoadingTimer() {
    if (this._loadingTimer) {return;}
    this._loadingTimer = setInterval(() => {
      this.messageBox.tickLoading();
    }, this._loadingTickInterval);
  }

  _stopLoadingTimer() {
    if (this._loadingTimer) {
      clearInterval(this._loadingTimer);
      this._loadingTimer = null;
    }
  }

  // 完整重绘，合并所有 write 为一次
  _fullRender() {
    this.layout.startBuf();
    this.layout.hideCursor();
    this._cursorHidden = true;
    this.layout.clearScreen();
    const layoutBuf = this.layout.endBuf();

    // M4:teamPanel active 时,跳过 messageBox 渲染,主消息区"冻结但保留"
    // messageBox.renderedLines 不会清空,关闭 modal 后从断点继续
    const messageOut = this.teamPanel?.active
      ? (this.teamPanel.render() || '')
      : (this.messageBox.render() || '');

    const out = layoutBuf + messageOut + (this.sidebar.render() || '') + (this.editor.render() || '') + (this.statusBar.render() || '');
    if (out) {this._safeWrite(out, true);}

    this._restoreCursorToEditor();
  }

  // 刷新消息区 + 侧边栏（侧边栏被 \x1b[K 擦掉了需要重绘，内容稳定不会闪烁）
  _refreshMessages() {
    this.layout.startBuf();
    // M4:teamPanel active 时跳过 messageBox 渲染(保留 renderedLines 不动)
    const messageOut = this.teamPanel?.active
      ? (this.teamPanel.render() || '')
      : (this.messageBox.render() || '');
    // 消息区 \x1b[K 会擦掉右侧侧边栏区域，必须补绘
    let out = messageOut + (this.sidebar.render() || '');

    // 如果 editor 有未刷新的变化，也要重绘输入框
    if (this.editor._needsRefresh) {
      out += this.editor.render();
      this.editor._needsRefresh = false;
    }

    if (out) { this._safeWrite(out, false); }
    this.layout.endBuf();
  }

  // 仅刷新侧边栏（独立于消息流，不走 _refreshMessages 避免闪烁）
  _refreshSidebarOnly() {
    const out = this.sidebar.render() || '';
    if (out) { this._safeWrite(out, false); }
  }

  // 刷新全部组件（响应结束后调用）
  _refreshAll() {
    this.layout.hideCursor();
    this._cursorHidden = true;
    const messageOut = this.teamPanel?.active
      ? (this.teamPanel.render() || '')
      : (this.messageBox.render() || '');
    const out = messageOut + (this.sidebar.render() || '') + (this.editor.render() || '') + (this.statusBar.render() || '');
    if (out) {this._safeWrite(out, true);}
    this._restoreCursorToEditor();
  }

  // 恢复光标到编辑器输入位置
  _restoreCursorToEditor() {
    if (this._cursorHidden) {
      this.layout.showCursor();
      this._cursorHidden = false;
    }
    this.layout.moveTo(this.editor.promptRow, this.editor.getCursorColumn());
  }

  // 请求节流渲染（用于流式输出等高频场景）
  _queueRender() {
    if (!this._renderQueue) {
      const RenderQueue = require('./render-queue');
      this._renderQueue = new RenderQueue(20);  // 20ms 节流
    }
    this._renderQueue.requestRender(() => {
      this._refreshMessages();
    });
  }

  // 强制立即渲染
  _forceRender() {
    if (!this._renderQueue) {
      this._refreshMessages();
    } else {
      this._renderQueue.forceRender(() => {
        this._refreshMessages();
      });
    }
  }

  _refreshEditor() {
    const out = this.editor.render();
    if (out) {this._safeWrite(out, true);}
  }

  _refreshStatusBar() {
    const out = this.statusBar.render();
    // render() 内部已做了版本跳过，返回空时跳过写
    if (out) {this._safeWrite(out, true);}
  }

  // 仅刷新侧边栏（子 Agent 事件专用，不动消息区）
  _refreshSidebar() {
    this._refreshSidebarOnly();
  }

  /** 子 Agent 高频事件 20ms 节流渲染，仅刷侧边栏，不与消息区绑定。 */
  _queueSidebar() {
    if (!this.sidebar) {return;}
    if (this._lastSidebarVersion === this.sidebar._teamEventsVersion) {return;}
    if (!this._renderQueue) {
      const RenderQueue = require('./render-queue');
      this._renderQueue = new RenderQueue(20);
    }
    this._renderQueue.requestRender(() => {
      if (!this.sidebar || this._lastSidebarVersion === this.sidebar._teamEventsVersion) {return;}
      this._lastSidebarVersion = this.sidebar._teamEventsVersion;
      this._refreshSidebarOnly();
    });
  }

  /** 状态栏独立渲染（render() 内部版本号跳过，不写空）。 */
  _queueStatusBar() {
    if (this._lastStatusVersion === this.statusBar._renderVersion) { return; }
    this._lastStatusVersion = this.statusBar._renderVersion;
    if (!this._renderQueue) {
      const RenderQueue = require('./render-queue');
      this._renderQueue = new RenderQueue(20);
    }
    this._renderQueue.requestRender(() => this._refreshStatusBar());
  }

  /**
   * 刷新侧边栏相关的信息（Todo, Context, Cache）- 更新到状态栏
   */
  refreshSidebarInfo() {
    const out = this.statusBar.render();
    if (out) {this._safeWrite(out, true);}
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

  /**
   * 设置 Team 子 Agent 活动临显(M3)
   * @param {string} name - agent 短名
   * @param {string} status - 'thinking' / 'streaming'
   */
  setTeamActivity(name, status) {
    this.statusBar.setTeamActivity(name, status);
    this._refreshStatusBar();
  }

  /**
   * 清除 Team 活动临显
   */
  clearTeamActivity() {
    this.statusBar.clearTeamActivity();
    this._refreshStatusBar();
  }

  /**
   * 打开 Team Panel modal(M4)
   * 关键:主消息区"暂停滚动,保留显示"——消息区 renderedLines 不动,
   * 关闭 modal 后从断点继续,不会丢内容也不会被刷掉。
   */
  openTeamPanel() {
    this.teamPanel.open();
  }

  /**
   * 关闭 Team Panel modal
   */
  closeTeamPanel() {
    this.teamPanel.close();
  }

  // ─── 事件注册 ───

  onSend(callback) {
    this._onSend = callback;
  }

  onExit(callback) {
    this._onExit = callback;
  }

  onCommand(callback) {
    this._onCommand = callback;
  }

  onContextInject(callback) {
    this._onContextInject = callback;
  }

  setPendingContext(hasPending) {
    this._hasPendingContext = hasPending;
    this.statusBar.setPendingContext(hasPending);
    this._refreshStatusBar();
  }

  // ─── 消息渲染（对接 ChatEngine 事件） ───

  renderUserMessage(content) {
    this._isProcessing = true;
    this.layout.hideCursor();
    this.messageBox.addUserMessage(content);
    this._refreshMessages();
  }

  // 启动 thinking 定时器，每秒刷新状态栏，每 3 秒换一条提示语
  _startThinkingTimer() {
    if (this._thinkingTimer) {clearInterval(this._thinkingTimer);}
    let tickCount = 0;
    this._thinkingTimer = setInterval(() => {
      if (this.statusBar.isThinking) {
        tickCount++;
        if (tickCount % 30 === 0) {
          this.statusBar.updateThinkingMessage();
        }
        this._refreshStatusBar();
      } else {
        clearInterval(this._thinkingTimer);
        this._thinkingTimer = null;
      }
    }, 1000);
  }

  // 恢复 thinking 状态（提问回答后 AI 继续处理时调用）
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

  renderThinkingChunk(chunk) {
    this.messageBox.addThinkingChunk(chunk);
    this._queueRender();
  }

  renderContentStart() {
    this.messageBox.startContent();
  }

  renderContentChunk(chunk) {
    this.messageBox.addContentChunk(chunk);
    this._forceRender();
  }

  renderToolCall(toolCalls) {
    this.messageBox.addToolCall(toolCalls);
    // 根据工具名换一条相关的 thinking 提示语
    if (toolCalls?.function?.name) {
      this.statusBar.updateThinkingMessage(toolCalls.function.name);
    } else if (Array.isArray(toolCalls) && toolCalls[0]?.function?.name) {
      this.statusBar.updateThinkingMessage(toolCalls[0].function.name);
    }
    this._queueRender();
  }

  renderToolResult(name, result, toolCall) {
    this.messageBox.addToolResult(name, result, toolCall);
    this._queueRender();
  }

  renderTokenUsage(usage, pricing) {
    this.statusBar.updateTokenUsage(usage);
    if (pricing) {this.statusBar.setPricing(pricing);}
  }

  // 完成响应
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

  renderError(message, error) {
    const t = this.layout.theme;
    // 按换行拆分，每行独立推入（避免单行超长撑爆显示）
    const msgLines = String(message).split('\n');
    for (const line of msgLines) {
      if (line.trim() === '') {continue;}
      this.messageBox.renderedLines.push(`${t.error('[错误]')} ${line}`);
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

  renderStatus(msg) {
    const t = this.layout.theme;
    const marker = chalk.hex(t.colors.primary)('●');
    this.messageBox.renderedLines.push(`${marker} ${t.textMuted(msg)}`);
    this._refreshMessages();
  }

  renderInterrupted() {
    const t = this.layout.theme;
    const marker = chalk.hex(t.colors.primary)('●');
    this.messageBox.renderedLines.push(`${marker} ${t.textMuted('⏹ 已中断')}`);
    this._isProcessing = false;
    this._refreshAll();
  }

  resetMessages() {
    this.messageBox.reset();
  }

  // 渲染计划批准提示
  renderPlanApprovalHint() {
    const t = this.layout.theme;
    const width = this.layout.messageWidth - 4;

    // 保存当前选项索引（用于方向键导航）
    if (this._planApprovalCursor === undefined) {
      this._planApprovalCursor = 0;  // 0=同意, 1=拒绝, 2=其他输入
    }
    const cursor = this._planApprovalCursor;
    const options = [
      { label: '同意', desc: '批准计划并执行' },
      { label: '拒绝', desc: '拒绝并重新规划' },
      { label: '其他', desc: '输入修改建议' },
    ];

    // 记录提示块的起始行
    const startLine = this.messageBox.renderedLines.length;

    // 分隔线
    this.messageBox.renderedLines.push(` ${chalk.dim('\u2500'.repeat(Math.min(width, 40)))}`);

    // 选项列表
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const isSelected = i === cursor;
      const indicator = isSelected ? chalk.hex(t.colors.primary)('●') : chalk.hex(t.colors.textMuted)('○');
      const prefix = isSelected ? chalk.hex(t.colors.primary)('▸') : ' ';
      const label = isSelected ? chalk.hex(t.colors.text).bold(opt.label) : t.text(opt.label);
      const desc = opt.desc ? chalk.hex(t.colors.textMuted)(` \u2014 ${opt.desc}`) : '';

      let line = ` ${prefix} ${indicator} ${label}${desc}`;
      // 截断过长的行
      const visibleLen = this._visibleLength(line);
      if (width > 0 && visibleLen > width) {
        const maxDescLen = width - (this._visibleLength(` ${prefix} ${indicator} ${label} \u2014 `));
        if (maxDescLen > 10) {
          line = ` ${prefix} ${indicator} ${label}${this._truncateAnsi(desc, maxDescLen)}`;
        } else {
          line = ` ${prefix} ${indicator} ${label}`;
        }
      }
      this.messageBox.renderedLines.push(line);
    }

    // 底部分隔线和操作提示
    this.messageBox.renderedLines.push(` ${chalk.dim('\u2500'.repeat(Math.min(width, 40)))}`);
    this.messageBox.renderedLines.push(` ${chalk.dim('\u2191\u2193 选择 \u00b7 Space 选中 \u00b7 Enter 确认 \u00b7 直接输入反馈')}`);
    this.messageBox.renderedLines.push('');

    // 记录提示块的位置范围（用于后续更新/清除）
    this._planApprovalHintLines = {
      start: startLine,
      end: this.messageBox.renderedLines.length - 1,
      lineCount: this.messageBox.renderedLines.length - startLine,
    };

    // 立即渲染到屏幕（批准组件加完后必须刷新才能显示）
    this._refreshMessages();
  }

  // 更新计划批准提示
  updatePlanApprovalHint() {
    if (!this._planApprovalHintLines) {return;}

    const t = this.layout.theme;
    const width = this.layout.messageWidth - 4;
    const cursor = this._planApprovalCursor;
    const options = [
      { label: '同意', desc: '批准计划并执行' },
      { label: '拒绝', desc: '拒绝并重新规划' },
      { label: '其他', desc: '输入修改建议' },
    ];

    const { start } = this._planApprovalHintLines;

    // 重建选项行
    const newLines = [];
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const isSelected = i === cursor;
      const indicator = isSelected ? chalk.hex(t.colors.primary)('●') : chalk.hex(t.colors.textMuted)('○');
      const prefix = isSelected ? chalk.hex(t.colors.primary)('▸') : ' ';
      const label = isSelected ? chalk.hex(t.colors.text).bold(opt.label) : t.text(opt.label);
      const desc = opt.desc ? chalk.hex(t.colors.textMuted)(` \u2014 ${opt.desc}`) : '';

      let line = ` ${prefix} ${indicator} ${label}${desc}`;
      const visibleLen = this._visibleLength(line);
      if (width > 0 && visibleLen > width) {
        const maxDescLen = width - (this._visibleLength(` ${prefix} ${indicator} ${label} \u2014 `));
        if (maxDescLen > 10) {
          line = ` ${prefix} ${indicator} ${label}${this._truncateAnsi(desc, maxDescLen)}`;
        } else {
          line = ` ${prefix} ${indicator} ${label}`;
        }
      }
      newLines.push(line);
    }

    // 更新消息区中的对应行（跳过顶部分隔线，从选项行开始更新）
    const optionStart = start + 1;
    for (let i = 0; i < newLines.length; i++) {
      this.messageBox.renderedLines[optionStart + i] = newLines[i];
    }
  }

  clearPlanApprovalHint() {
    if (this._planApprovalCursor !== undefined) {
      this._planApprovalCursor = undefined;
    }
    if (this._planApprovalHintLines) {
      const { start, lineCount } = this._planApprovalHintLines;
      this.messageBox.renderedLines.splice(start, lineCount);
      this._planApprovalHintLines = undefined;
    }
  }

  // 安全写入 stdout，带反压检测和输出上限
  _safeWrite(output, critical = false) {
    if (!output) {return true;}

    // 反压检测超时自动恢复（Windows 终端 drain 可能永不触发）
    if (this._stdoutBackedUp) {
      if (critical) {
        // 关键渲染强制清标志
        this._stdoutBackedUp = false;
        if (this._backupTimer) { clearTimeout(this._backupTimer); this._backupTimer = null; }
      } else {
        // 反压期间：累积计数，超过阈值后强制恢复避免消息区完全停止
        this._backupRenderCount = (this._backupRenderCount || 0) + 1;
        if (this._backupRenderCount >= 3) {
          // 强制写入，跳过内容上限检查
          this._stdoutBackedUp = false;
          this._backupRenderCount = 0;
          if (this._backupTimer) { clearTimeout(this._backupTimer); this._backupTimer = null; }
        } else {
          return false;
        }
      }
    } else {
      this._backupRenderCount = 0;
    }

    // 非关键渲染做输出上限保护(ANSI-safe:在完整转义序列边界切,避免残影 flicker)
    let writeStr = output;
    if (!critical && output.length > this.MAX_RENDER_OUTPUT) {
      writeStr = this._truncateAnsiSafe(output, this.MAX_RENDER_OUTPUT);
    }

    this._lastWriteResult = process.stdout.write(writeStr);

    // 更新反压状态
    if (this._lastWriteResult === false) {
      this._stdoutBackedUp = true;
      // 监听 drain 事件恢复渲染
      process.stdout.once('drain', () => {
        this._stdoutBackedUp = false;
        if (this._backupTimer) { clearTimeout(this._backupTimer); this._backupTimer = null; }
      });
      // 兜底定时器：500ms 后 drain 还没来就强制恢复
      // 保存 Timer ID 用于清理
      if (this._backupTimer) {
        clearTimeout(this._backupTimer);
        this._backupTimer = null;
      }
      this._backupTimer = setTimeout(() => {
        if (this._stdoutBackedUp) {
          this._stdoutBackedUp = false;
        }
        this._backupTimer = null;
      }, 500);
    }

    return this._lastWriteResult !== false;
  }

  // 计算字符串可见长度
  _visibleLength(str) {
    return visibleLength(str);
  }

  _isCJK(char) {
    return isCJK(char);
  }

  _truncateAnsi(str, maxLen) {
    return truncateToWidth(str, maxLen, chalk.dim('...'));
  }

  /** 在完整 ANSI 转义序列边界切,防止撕开颜色代码导致残影。 */
  _truncateAnsiSafe(str, maxLen) {
    if (str.length <= maxLen) {return str;}
    let cutAt = maxLen;
    for (let i = maxLen - 1; i > maxLen - 64 && i > 0; i--) {
      const ch = str[i];
      if (ch >= '0' && ch <= '9' || ch === ';') {continue;}
      if (ch === '\x1b') {cutAt = i; break;}
      if (/[a-zA-Z]/.test(ch)) {cutAt = i + 1; break;}
    }
    return str.slice(0, cutAt) + '\x1b[0m\x1b[K';
  }

  clearMessages() {
    this.messageBox.clear();
    this._fullRender();
  }

  handleKey(buf) {
    // ─── 问答面板优先处理 ───
    if (this.questionPanel.active) {
      return this.questionPanel.handleKey(buf);
    }

    // ─── Team Panel(M4) ───
    // 优先级:questionPanel > teamPanel > editor
    // 避免审批弹窗和详情面板同时打开打架
    if (this.teamPanel.active) {
      const result = this.teamPanel.handleKey(buf);
      if (result?.action === 'team_panel_close') {
        // modal 关闭,需要完整重绘恢复主消息区
        this._refreshAll();
      } else {
        this._refreshMessages();
      }
      return result;
    }

    // ─── Ctrl+T 快捷键(M5) — 切换 Team Panel ───
    // 0x14 = Ctrl+T,打开/关闭 teamPanel
    if (buf[0] === 0x14 && buf.length === 1) {
      if (this.teamPanel.active) {
        this.closeTeamPanel();
      } else {
        this.openTeamPanel();
      }
      this._refreshAll();
      return { action: 'team_panel_toggle' };
    }

    // ─── Ctrl+? (0x1f = Ctrl+/) — 显示快捷键帮助 ───
    if (buf[0] === 0x1f && buf.length === 1) {
      if (this._onSend) {
        this._onSend('/shortcuts');
      }
      return { action: 'show_shortcuts' };
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

    // ─── 计划批准状态：拦截方向键和确认键 ───
    if (this.chatEngine && this.chatEngine._awaitingPlanApproval) {
      // 上箭头 — 选项上移
      if (buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x41) {
        if (this._planApprovalCursor > 0) {
          this._planApprovalCursor--;
          this.updatePlanApprovalHint();
          this._refreshMessages();
        }
        return { action: 'plan_approval_up' };
      }
      // 下箭头 — 选项下移
      if (buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x42) {
        if (this._planApprovalCursor < 2) {
          this._planApprovalCursor++;
          this.updatePlanApprovalHint();
          this._refreshMessages();
        }
        return { action: 'plan_approval_down' };
      }
      // Space — 选中当前选项到编辑器
      if (buf[0] === 0x20) {
        const optionMap = ['yes', 'no', ''];
        const text = optionMap[this._planApprovalCursor];
        if (text) {
          this.editor.setText(text);
          this._refreshEditor();
        }
        return { action: 'plan_approval_select' };
      }
      // Enter — 发送当前选项
      if (buf[0] === 0x0d) {
        const optionMap = ['yes', 'no', ''];
        const text = optionMap[this._planApprovalCursor];
        if (text && this._onSend) {
          this.clearPlanApprovalHint();
          this._onSend(text);
        }
        return { action: 'plan_approval_confirm' };
      }
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

  setProcessing(processing) {
    this._isProcessing = processing;
    if (!processing) {
      this.layout.showCursor();
      this._cursorHidden = false;
    }
  }

  get isProcessing() {
    return this._isProcessing;
  }

  // ─── Computer Use 支持 ───

  /**
   * 获取当前屏幕状态（用于截图）
   * @returns {Object} 屏幕状态对象
   */
  getScreenState() {
    // 获取消息区可见内容
    const visibleContent = this.messageBox?.getVisibleContent?.() || '';

    // 获取编辑器当前输入
    const editorInput = this.editor?.currentInput || '';

    // 获取光标位置
    const cursorPosition = {
      row: this.editor?.cursorRow || 0,
      col: this.editor?.cursorCol || 0,
    };

    // 获取终端尺寸
    const dimensions = {
      width: this.layout?.width || 80,
      height: this.layout?.height || 24,
    };

    // 构建屏幕文本描述
    const lines = [];
    lines.push('=== 终端屏幕状态 ===');
    lines.push(`尺寸: ${dimensions.width}x${dimensions.height}`);
    lines.push(`光标: 行${cursorPosition.row}, 列${cursorPosition.col}`);
    lines.push('');
    lines.push('--- 消息区内容 ---');
    lines.push(visibleContent || '(空)');
    lines.push('');
    lines.push('--- 编辑器输入 ---');
    lines.push(editorInput || '(空)');

    return {
      text: lines.join('\n'),
      visibleContent,
      editorInput,
      cursorPosition,
      dimensions,
    };
  }

  /**
   * 模拟键盘输入
   * @param {string} key - 要输入的字符或按键序列
   */
  simulateKeyPress(key) {
    if (!key) {return;}

    // 将字符串转换为 Buffer 并调用 handleKey
    const buf = Buffer.from(key, 'utf8');
    this.handleKey(buf);
  }
}

module.exports = TUI;

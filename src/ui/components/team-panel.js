'use strict';

const chalk = require('chalk');
const { getTheme } = require('../theme');
const MarkdownRenderer = require('../markdown');
const { visibleLength, truncateToWidth } = require('../ansi');

/**
 * Team Panel — 团队事件日志 modal
 *
 * 设计要点(M4+M5):
 *   - 复用 questionPanel 的 modal 模式:active 标志位 + handleKey 让位
 *   - 全屏覆盖消息区(messageBox 区域),侧边栏保留(显示 agent 卡片)
 *   - 数据源:sidebar.getFullEventLog() + sidebar.getAgentStatesSnapshot()
 *   - 主消息区"冻结":不渲染但保留 renderedLines,关闭后无内容丢失
 *
 * 改进(K1):
 *   - 使用 MarkdownRenderer 渲染子 Agent 的 thinking/content,和主Agent界面一致
 *   - 按 Agent 分组展示消息,每个 Agent 显示角色标签+消息内容
 *   - 支持小键盘数字键切换不同 Agent 的消息过滤
 *   - 保留两种视图:消息视图(默认) 和 事件列表视图(按 `v` 切换)
 */
class TeamPanel {
  constructor(layout) {
    this.layout = layout;
    this.theme = getTheme();
    this.active = false;
    this.sidebar = null;  // 由 TUI 注入

    // 滚动位置(从底部往上数,0 = 最新事件)
    this.scrollOffset = 0;
    // agent 过滤(null = 显示全部,数字 = 只显示指定 agent 的消息)
    this.agentFilter = null;
    // 视图模式:'message' = 消息视图(默认),'event' = 事件列表视图
    this.viewMode = 'message';
    // MarkdownRenderer 实例(按需创建,因为需要 width)
    this._mdRenderer = null;
    // 自动滚动:新消息到达时滚到底部,用户手动滚动 ↑/PgUp 时暂停
    this._autoScroll = true;
  }

  setSidebar(sidebar) {
    this.sidebar = sidebar;
  }

  // 打开 modal
  open() {
    this.active = true;
    this.scrollOffset = 0;
    this.agentFilter = null;
    this.viewMode = 'message';
    this._mdRenderer = null;
    this._autoScroll = true;
  }

  // 关闭 modal
  close() {
    this.active = false;
    this.scrollOffset = 0;
    this.agentFilter = null;
    this._mdRenderer = null;
  }

  /**
   * 懒加载 MarkdownRenderer
   */
  _getMarkdownRenderer(width) {
    if (!this._mdRenderer) {
      this._mdRenderer = new MarkdownRenderer(width);
    }
    this._mdRenderer.width = width;
    return this._mdRenderer;
  }

  /**
   * 渲染 modal 内容(行数组)
   * 调用方:TUI._fullRender 在 active 时调本方法,结果写入消息区屏幕
   */
  render() {
    if (!this.active) {return '';}

    const t = this.theme;
    const { messageStartRow, contentHeight, messageWidth } = this.layout;
    const width = messageWidth - 2;  // 留 1 列右边距

    const events = this.sidebar?.getFullEventLog?.() || [];

    // 1. Title 行
    const viewLabel = this.viewMode === 'message' ? '消息' : '事件';
    const filterLabel = this.agentFilter !== null
      ? ` · Agent #${this.agentFilter}`
      : '';
    const titleText = `[Team Panel · ${viewLabel} · ${events.length} 条`
      + filterLabel
      + ' · 主消息已暂停]';
    const titleLine = this._positionAt(messageStartRow, 1)
      + chalk.bgHex(t.colors.primary).hex(t.colors.background).bold(
        ` ${titleText} ${' '.repeat(Math.max(0, width - visibleLength(titleText) - 2))} `
      );

    // 2. Hint 行(底部第 3 行:操作提示)
    // 自动滚动:有新消息时自动滚到底部,用户按 ↑/PgUp 暂停
    const scrollHint = this._autoScroll ? '' : chalk.hex(t.colors.warning)(' [已暂停自动滚动]');
    const hintText = ' ↑↓ 滚动 · PgUp/PgDn 翻页 · 1-9 过滤 · 0 全部 · v 切换视图 · Esc 关闭';
    const hintLine = this._positionAt(messageStartRow + contentHeight - 2, 1)
      + chalk.dim(truncateToWidth(hintText + scrollHint, width, chalk.dim('...')));

    // 3. 内容区域
    const listStartRow = messageStartRow + 1;
    const listEndRow = messageStartRow + contentHeight - 3;
    const listHeight = Math.max(1, listEndRow - listStartRow + 1);

    // 每 Agent 最大行数:多 agent 时视口均分,单 agent(filter 模式)不限
    const agents = this.sidebar?.getAgentStatesSnapshot?.() || [];
    const activeAgentCount = this.agentFilter !== null ? 1 : agents.length;
    // 留 4 行给 header/hint/agent 标题栏,剩下按 agent 数量均分(至少 5 行)
    const agentMaxLines = activeAgentCount > 1
      ? Math.max(5, Math.floor((listHeight - 4) / activeAgentCount))
      : Infinity;

    // 根据视图模式渲染内容
    const contentLines = this.viewMode === 'message'
      ? this._renderMessageView(events, width, agentMaxLines)
      : this._renderEventView(events, width);

    // 计算滚动位置
    // 自动滚动:有新消息到达时始终保持在底部(scrollOffset=0)
    if (this._autoScroll) {this.scrollOffset = 0;}
    const start = Math.max(0, contentLines.length - listHeight - this.scrollOffset);
    const end = contentLines.length - this.scrollOffset;
    const visibleLines = contentLines.slice(start, end);

    // 渲染每行
    let listOutput = '';
    for (let i = 0; i < listHeight; i++) {
      const row = listStartRow + i;
      const line = visibleLines[i];
      let lineContent;
      if (line) {
        lineContent = line;
      } else {
        lineContent = '';
      }
      listOutput += this._positionAt(row, 1) + chalk.hex(t.colors.text)('\x1b[K' + lineContent);
    }

    return titleLine + listOutput + hintLine;
  }

  /**
   * 消息视图:按 Agent 分组渲染子 Agent 的 thinking/content + 工具调用
   * 格式完全和主 Agent 界面一致:
   *   - thinking: 灰色文本(无 ● 前缀)
   *   - content:   ● 前缀 + Markdown 渲染,仅首行带标记
   *   - tool_calls:  工具名+参数紧凑行
   *   - tool_result: 结果内容(缩进)
   *   - 每个 Agent 以角色头部分隔
   */
  _renderMessageView(events, width, agentMaxLines = Infinity) {
    const t = this.theme;
    const md = this._getMarkdownRenderer(width);

    // 获取目标 agents
    const agents = this._getFilteredAgents();

    // 过滤 + 按 agent 分组聚合 thinking/content
    const filtered = this._filterEvents(events);
    const agentBlocks = this._accumulateAgentOutput(filtered);

    const allLines = [];

    if (agents.length === 0) {
      allLines.push(chalk.dim('  <无活跃 Agent>'));
      return allLines;
    }

    // 渲染每个 agent 的输出块
    for (const agent of agents) {
      const output = agentBlocks.get(agent.agentId);
      const role = agent.role || 'executor';
      const agentName = agent.name || agent.agentId.slice(-4);
      const degradedTag = agent.degraded ? chalk.hex(t.colors.warning)(' [降级]') : '';

      // 角色头
      const roleTag = this._formatRoleTag(role);
      allLines.push(` ${chalk.hex(t.colors.primary).bold(agentName)} ${roleTag}${degradedTag}`);

      // 收集当前 agent 的内容行
      const agentLines = [];

      // Thinking 内容(灰色)
      if (output?.thinking) {
        const tLines = output.thinking.split('\n');
        for (const line of tLines) {
          if (line.trim()) {
            agentLines.push(t.thinkingFallback(line));
          }
        }
      }

      // 工具调用/结果(按事件顺序,插入在 thinking 和 content 之间)
      const toolLines = this._renderAgentToolEvents(filtered, agent.agentId, width);
      agentLines.push(...toolLines);

      // Content 内容(Markdown 渲染,首行带 ●)
      if (output?.content) {
        const rendered = md.write(output.content + '\n');
        const cLines = rendered.split('\n').filter(l => l.trim());
        let firstContentLine = true;
        for (const line of cLines) {
          if (firstContentLine) {
            agentLines.push(` ${chalk.hex(t.colors.primary)('●')} ${line}`);
            firstContentLine = false;
          } else {
            agentLines.push(`   ${line}`);
          }
        }
      }

      if (agentLines.length === 0) {
        allLines.push(chalk.dim('  <无消息>'));
        allLines.push('');
        continue;
      }

      // 截断:超出 agentMaxLines 时折叠
      if (agentLines.length > agentMaxLines) {
        const folded = agentLines.length - agentMaxLines;
        agentLines.length = agentMaxLines;
        const foldedMsg = `  ${chalk.dim('⋯')} ${chalk.dim(`(+${folded} 行已折叠, 按数字键过滤查看)`)}`;
        agentLines.push(foldedMsg);
      }

      for (const line of agentLines) {
        allLines.push(line);
      }
      allLines.push(''); // Agent 间空行
    }

    if (allLines.length === 0) {
      allLines.push(chalk.dim('  <无团队事件>'));
    }

    return allLines;
  }

  /**
   * 渲染指定 Agent 的工具调用/结果事件
   * 格式匹配主 Agent 的 tool-renderer 风格:
   *   ● read_file(file="...")
   *   └─ Lines 1-50 of ...
   * @param {Array} events - 全量过滤后事件
   * @param {string} agentId - 目标 agentId
   * @param {number} width - 可用宽度
   * @returns {string[]}
   */
  _renderAgentToolEvents(events, agentId, width) {
    const t = this.theme;
    const lines = [];
    const toolEvents = events.filter(e =>
      (e.event === 'tool_calls' || e.event === 'tool_result')
      && e.data?.agentId === agentId
    );
    // 按时间正序(events 最新在前,反转)
    toolEvents.reverse();

    for (const ev of toolEvents) {
      if (ev.event === 'tool_calls' && ev.data?.toolCall) {
        const tc = ev.data.toolCall;
        const rawName = tc.function?.name || tc.name || 'unknown';
        let args = {};
        try {
          args = typeof tc.function?.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : (tc.function?.arguments || {});
        } catch { args = {}; }
        const paramsStr = Object.entries(args).slice(0, 2)
          .map(([k, v]) => {
            const vs = typeof v === 'string' ? v : JSON.stringify(v);
            return `${k}=${vs.length > 40 ? vs.slice(0, 40) + '…' : vs}`;
          }).join(', ');
        const marker = chalk.hex(t.colors.primary)('●');
        const nameStyle = chalk.hex(t.colors.primary)(rawName);
        lines.push(` ${marker} ${nameStyle}${paramsStr ? ` ${t.dim(`(${paramsStr})`)}` : ''}`);
      } else if (ev.event === 'tool_result') {
        const { toolName, result, args: callArgs } = ev.data;
        if (result?.error) {
          const errText = `Error: ${result.error}`.replace(/\n/g, ' ');
          lines.push(`   ${chalk.hex(t.colors.primary)('└─')} ${t.error(errText.length > 60 ? errText.slice(0, 60) + '…' : errText)}`);
        } else if (toolName === 'read_file' || toolName === 'view') {
          const filePath = result?.filePath || callArgs?.filePath || '';
          const content = result?.content || '';
          const totalLines = content ? content.split('\n').length : 0;
          const args = callArgs || {};
          const startLine = (args.offset || 0) + 1;
          const limit = args.limit || totalLines;
          const endLine = Math.min(startLine + limit - 1, totalLines);
          if (totalLines > 0) {
            lines.push(`   ${chalk.hex(t.colors.primary)('└─')} ${t.dim(`Lines ${startLine}-${endLine} of ${filePath} (${totalLines} total)`)}`);
          } else {
            lines.push(`   ${chalk.hex(t.colors.primary)('└─')} ${t.dim(filePath)}`);
          }
        } else if (toolName === 'execute_command' || toolName === 'bash') {
          const output = result?.stdout || result?.content || result?.output || '';
          if (output) {
            const firstLine = output.split('\n').find(l => l.trim()) || '';
            lines.push(`   ${chalk.hex(t.colors.primary)('└─')} ${t.dim(firstLine.length > 60 ? firstLine.slice(0, 60) + '…' : firstLine)}`);
          } else if (result?.success) {
            lines.push(`   ${chalk.hex(t.colors.primary)('└─')} ${t.success('✓')} ${t.dim('Done')}`);
          }
        } else if (result?.success) {
          lines.push(`   ${chalk.hex(t.colors.primary)('└─')} ${t.success('✓')} ${t.dim('Done')}`);
        } else {
          lines.push(`   ${chalk.hex(t.colors.primary)('└─')} ${t.dim('Done')}`);
        }
      }
    }
    return lines;
  }

  /**
   * 事件列表视图:紧凑显示每条事件(原来面板的显示方式)
   */
  _renderEventView(events, width) {
    const filtered = this._filterEvents(events);

    if (filtered.length === 0) {
      return [chalk.dim('  <无事件>')];
    }

    // 按 agent 分组,每 agent 最多显示 events 数,防止单个 agent 刷屏
    const agents = this.sidebar?.getAgentStatesSnapshot?.() || [];
    const activeAgentCount = this.agentFilter !== null ? 1 : agents.length;
    const agentMaxEvents = activeAgentCount > 1
      ? Math.max(5, Math.ceil(filtered.length / activeAgentCount * 0.5))
      : Infinity;

    const grouped = new Map(); // agentName -> events[]
    const ungrouped = [];
    for (const ev of filtered) {
      if (ev.agentName) {
        if (!grouped.has(ev.agentName)) {grouped.set(ev.agentName, []);}
        if (grouped.get(ev.agentName).length < agentMaxEvents) {
          grouped.get(ev.agentName).push(ev);
        }
      } else {
        ungrouped.push(ev);
      }
    }

    const result = [];
    for (const [, evts] of grouped) {
      result.push(...evts);
    }
    result.push(...ungrouped);
    // 按时间从新到旧排序(保持原事件视图最新靠上)
    result.sort((a, b) => (b.time || 0) - (a.time || 0));

    const lines = result.map(event => this._formatEvent(event, width));

    if (activeAgentCount > 1) {
      lines.push(chalk.dim(`  ${'─'.repeat(Math.min(15, width - 2))} (每 agent 最多 ${agentMaxEvents} 条, 按数字键过滤看全量)`));
    }

    return lines;
  }

  /**
   * 按 agent 聚合所有 thinking/content chunk:直接拼接成完整字符串
   * 返回 Map<agentId, {thinking:string, content:string}>
   * 不再分割成多条消息,直接拼成两大块(thinking + content),跟主界面渲染一致
   */
  _accumulateAgentOutput(events) {
    const agentMap = new Map();  // agentId -> {thinking: '', content: ''}

    for (const event of events) {
      const agentId = event.data?.agentId;
      if (!agentId) {continue;}
      if (!agentMap.has(agentId)) {
        agentMap.set(agentId, { thinking: '', content: '' });
      }
      const acc = agentMap.get(agentId);

      if (event.event === 'thinking' && event.data?.chunk) {
        acc.thinking += event.data.chunk;
      } else if (event.event === 'content' && event.data?.chunk) {
        acc.content += event.data.chunk;
      }
    }

    return agentMap;
  }

  /**
   * 获取过滤后的 Agent 列表(按 agentFilter)
   */
  _getFilteredAgents() {
    const agents = this.sidebar?.getAgentStatesSnapshot?.() || [];
    if (this.agentFilter === null) {return agents;}
    const target = agents[this.agentFilter - 1];
    return target ? [target] : [];
  }

  /**
   * 格式化单条事件为 1 行(事件视图用)
   */
  _formatEvent(event, width) {
    const t = this.theme;
    const date = new Date(event.time || Date.now());
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');

    const timeStr = chalk.dim(`[${hh}:${mm}:${ss}]`);

    // 事件名简化
    const eventBase = event.event.replace(/^(agent|team|subagent)_/, '');
    const eventLabel = `[${eventBase}]`;

    // 颜色按事件类型分
    let eventColor = t.colors.text;
    if (event.event.includes('failed') || event.event.includes('terminated')) {
      eventColor = t.colors.error;
    } else if (event.event.includes('completed') || event.event.includes('done')) {
      eventColor = t.colors.success;
    } else if (event.event.includes('thinking') || event.event.includes('content')) {
      eventColor = t.colors.info;
    }

    const agentName = event.agentName
      ? chalk.hex(t.colors.primary)(event.agentName)
      : '';

    // chunk preview(仅 thinking/content 有 data.chunk)
    // 流式 chunk 已被 sidebar.handleTeamEvent 合并为完整内容,取前 60 字符
    let preview = '';
    if (event.data?.chunk) {
      const text = event.data.chunk.replace(/\n/g, ' ');
      const totalLen = text.length;
      const head = text.slice(0, 60);
      preview = totalLen > 60
        ? ` "${head}…(+${totalLen - 60}字)"`
        : ` "${text}"`;
    } else if (event.data?.role) {
      preview = ` ${event.data.role}`;
    } else if (event.data?.success !== undefined) {
      preview = ` success=${event.data.success}`;
    } else if (event.data?.to) {
      preview = ` → ${event.data.to}`;
    }

    // 组装
    const parts = [timeStr];
    if (agentName) {parts.push(agentName);}
    parts.push(chalk.hex(eventColor)(eventLabel));
    if (preview) {parts.push(chalk.dim(preview));}

    const line = ' ' + parts.join(' ');
    return truncateToWidth(line, width, chalk.dim('...'));
  }

  /**
   * 格式化角色标签
   */
  _formatRoleTag(role) {
    const t = this.theme;
    const roleColors = {
      architect: t.colors.accent,
      executor: t.colors.success,
      reviewer: t.colors.info,
      coordinator: t.colors.warning,
    };
    const color = roleColors[role] || t.colors.textMuted;
    return chalk.hex(color).dim(`[${role}]`);
  }

  /**
   * Agent 状态图标
   */
  _agentStatusIcon(status) {
    const t = this.theme;
    switch (status) {
      case 'thinking': return t.info('◐');
      case 'streaming': return t.primary('●');
      case 'done': return t.success('✓');
      case 'failed': return t.error('✗');
      case 'idle':
      default:
        return t.textMuted('·');
    }
  }

  /**
   * 按 agentFilter 过滤事件
   */
  _filterEvents(events) {
    if (this.agentFilter === null) {return events;}
    const agents = this.sidebar?.getAgentStatesSnapshot?.() || [];
    const targetAgent = agents[this.agentFilter - 1];
    if (!targetAgent) {return [];}
    const targetSuffix = targetAgent.name;
    return events.filter(e => e.agentName === targetSuffix);
  }

  _positionAt(row, col) {
    return `\x1b[${row};${col}H`;
  }

  /**
   * 键盘处理
   * 由 TUI.handleKey 在 active 时路由到这里
   */
  handleKey(buf) {
    if (!this.active) {return null;}

    // Esc — 关闭
    if (buf[0] === 0x1b && buf.length === 1) {
      this.close();
      return { action: 'team_panel_close' };
    }

    // ↑ — 向上滚动(暂停自动滚动)
    if (buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x41) {
      this._autoScroll = false;
      this.scrollOffset = Math.min(this.scrollOffset + 1, this._maxScroll());
      return { action: 'team_panel_scroll_up' };
    }

    // ↓ — 向下滚动(到底部时恢复自动滚动)
    if (buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x42) {
      const newOffset = Math.max(0, this.scrollOffset - 1);
      this.scrollOffset = newOffset;
      if (newOffset === 0) {this._autoScroll = true;}
      return { action: 'team_panel_scroll_down' };
    }

    // PageUp (CSI ~ mode: \x1b[5~) — 暂停自动滚动
    if (buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x35 && buf[3] === 0x7e) {
      this._autoScroll = false;
      this.scrollOffset = Math.min(this.scrollOffset + 10, this._maxScroll());
      return { action: 'team_panel_page_up' };
    }

    // PageDown (CSI ~ mode: \x1b[6~) — 到底部时恢复自动滚动
    if (buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x36 && buf[3] === 0x7e) {
      const newOffset = Math.max(0, this.scrollOffset - 10);
      this.scrollOffset = newOffset;
      if (newOffset === 0) {this._autoScroll = true;}
      return { action: 'team_panel_page_down' };
    }

    // v/V — 切换视图(message <-> event)
    if (buf[0] === 0x76 || buf[0] === 0x56) {
      this.viewMode = this.viewMode === 'message' ? 'event' : 'message';
      this.scrollOffset = 0;
      return { action: 'team_panel_toggle_view', viewMode: this.viewMode };
    }

    // 0 — 清除 agent 过滤
    if (buf[0] === 0x30) {
      this.agentFilter = null;
      this.scrollOffset = 0;
      return { action: 'team_panel_filter_clear' };
    }

    // 1-9 (主键盘数字) — 按数字键过滤 agent
    if (buf[0] >= 0x31 && buf[0] <= 0x39) {
      return this._setAgentFilter(buf[0] - 0x30);
    }

    // 小键盘数字键支持(SS3 模式: \x1bOp / \x1bOq / \x1bOr ...)
    // xterm DECNKM: 一些终端小键盘数字键发 SS3 序列
    // \x1bOp = 小键盘1, \x1bOq = 小键盘2, ... \x1bOy = 小键盘0
    if (buf[0] === 0x1b && buf[1] === 0x4f) {
      const numpadKeys = {
        0x70: 1, 0x71: 2, 0x72: 3,
        0x73: 4, 0x74: 5, 0x75: 6,
        0x76: 7, 0x77: 8, 0x78: 9,
        0x79: 0,
      };
      const digit = numpadKeys[buf[2]];
      if (digit !== undefined) {
        if (digit === 0) {
          this.agentFilter = null;
          this.scrollOffset = 0;
          return { action: 'team_panel_filter_clear' };
        }
        return this._setAgentFilter(digit);
      }
    }

    // 小键盘数字键(CSI ~ 模式: \x1b[1~ 到 \x1b[9~)
    // 一些终端/模拟器在特定模式下小键盘数字键发 \x1b[N~ 序列
    if (buf[0] === 0x1b && buf[1] === 0x5b && buf[3] === 0x7e) {
      const digit = buf[2] - 0x30;  // ASCII '1'-'9' → 1-9
      if (digit >= 1 && digit <= 9) {
        return this._setAgentFilter(digit);
      }
    }

    return null;
  }

  /**
   * 设置 agent 过滤
   */
  _setAgentFilter(idx) {
    const agents = this.sidebar?.getAgentStatesSnapshot?.() || [];
    if (idx >= 1 && idx <= agents.length) {
      this.agentFilter = idx;
      this.scrollOffset = 0;
    }
    return { action: 'team_panel_filter_agent', index: idx };
  }

  /**
   * 计算最大滚动偏移
   */
  _maxScroll() {
    const events = this.sidebar?.getFullEventLog?.() || [];
    const agents = this.sidebar?.getAgentStatesSnapshot?.() || [];

    let totalLines;
    if (this.viewMode === 'message') {
      // 消息视图:按 agent 分组后估算行数(按 agent 数量 + 消息数量的粗略估算)
      const targetAgents = this.agentFilter !== null
        ? [agents[this.agentFilter - 1]].filter(Boolean)
        : agents;
      // 每个 agent 至少占 1 行(header),可能有 n 条消息
      totalLines = targetAgents.length * 3;  // 粗略估算
      // 加上实际消息行数
      const filtered = this._filterEvents(events);
      const agentOutputs = this._accumulateAgentOutput(filtered);
      for (const [, output] of agentOutputs) {
          if (output.thinking) {totalLines += output.thinking.split('\n').filter(l => l.trim()).length;}
          if (output.content) {totalLines += output.content.split('\n').filter(l => l.trim()).length;}
        }
    } else {
      const filtered = this._filterEvents(events);
      totalLines = filtered.length;
    }

    const viewportHeight = Math.max(5, this.layout.contentHeight - 3);
    return Math.max(0, totalLines - viewportHeight);
  }
}

module.exports = TeamPanel;

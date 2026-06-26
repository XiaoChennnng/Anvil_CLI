'use strict';

const chalk = require('chalk');
const { getTheme } = require('../theme');
const MarkdownRenderer = require('../markdown');
const { visibleLength, truncateToWidth } = require('../ansi');

// team-panel 容量与滚动配置:防止渲染输出超 32KB 截断导致 ANSI 残影
const TEAM_PANEL_MAX_BYTES = 12 * 1024;
const TEAM_PANEL_WARN_BYTES = 8 * 1024;
const MAX_AGENT_OUTPUT_LINES = 80;        // 单 agent 最大行数
const AGENT_OUTPUT_HEAD_LINES = 30;       // 折叠保留头
const AGENT_OUTPUT_TAIL_LINES = 50;       // 折叠保留尾
const MAX_AGENT_CONTENT_CHARS = 8000;     // 单 agent 内容上限
const MAX_TOTAL_THINKING_CHARS = 4000;    // thinking 总上限

/**
 * Team Panel — 团队事件日志 modal
 *
 * 设计要点:
 *   - 全屏覆盖消息区,侧边栏保留显示 agent 卡片
 *   - 数据源:sidebar.getFullEventLog() + getAgentStatesSnapshot()
 *   - 主消息区"冻结但保留":关闭后从断点继续渲染
 *   - 与主 Agent 一致:Markdown 渲染、thinking 颜色、行宽处理
 */
class TeamPanel {
  constructor(layout) {
    this.layout = layout;
    this.theme = getTheme();
    this.active = false;
    this.sidebar = null;  // 由 TUI 注入
    // TUI 注入的主消息区渲染器,保证 Markdown/宽度处理与主 Agent 一致
    this.messageBoxRenderer = null;

    this.scrollOffset = 0;     // 滚动位置(0 = 底部)
    this.agentFilter = null;   // agent 过滤(null = 全部)
    this.viewMode = 'message'; // 'message' | 'event'
    this._mdRenderer = null;
    this._autoScroll = true;   // 新消息到达时滚到底部
  }

  setSidebar(sidebar) {
    this.sidebar = sidebar;
  }

  /** 注入主消息区渲染器,确保团队面板输出与主 Agent 一致。 */
  setMessageBoxRenderer(renderer) {
    this.messageBoxRenderer = renderer;
  }

  open() {
    this.active = true;
    this.scrollOffset = 0;
    this.agentFilter = null;
    this.viewMode = 'message';
    this._mdRenderer = null;
    this._autoScroll = true;
  }

  close() {
    this.active = false;
    this.scrollOffset = 0;
    this.agentFilter = null;
    this._mdRenderer = null;
  }

  /** 优先用注入的共享 renderer,未注入时兜底独立创建。 */
  _getMarkdownRenderer(width) {
    if (this.messageBoxRenderer && this.messageBoxRenderer.markdown) {
      this.messageBoxRenderer.markdown.width = width;
      return this.messageBoxRenderer.markdown;
    }
    if (!this._mdRenderer) {
      this._mdRenderer = new MarkdownRenderer(width);
    }
    this._mdRenderer.width = width;
    return this._mdRenderer;
  }

  /**
   * 渲染 modal 内容。
   * 容量保护:估算字节数,超 WARN 降级(去 tool 详细),超 MAX 兜底(只显示 chunkPreview)。
   */
  render() {
    if (!this.active) {return '';}

    const t = this.theme;
    const { messageStartRow, contentHeight, messageWidth } = this.layout;
    const width = messageWidth - 2;  // 留 1 列右边距

    const events = this.sidebar?.getFullEventLog?.() || [];

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

    const scrollHint = this._autoScroll ? '' : chalk.hex(t.colors.warning)(' [已暂停自动滚动]');
    const hintText = ' ↑↓ 滚动 · PgUp/PgDn 翻页 · 1-9 过滤 · 0 全部 · v 切换视图 · Esc 关闭';
    const hintLine = this._positionAt(messageStartRow + contentHeight - 2, 1)
      + chalk.dim(truncateToWidth(hintText + scrollHint, width, chalk.dim('...')));

    const listStartRow = messageStartRow + 1;
    const listEndRow = messageStartRow + contentHeight - 3;
    const listHeight = Math.max(1, listEndRow - listStartRow + 1);

    // 单 agent 视口分配,硬上限 MAX_AGENT_OUTPUT_LINES 防止撑爆
    const agents = this.sidebar?.getAgentStatesSnapshot?.() || [];
    const activeAgentCount = this.agentFilter !== null ? 1 : agents.length;
    let agentMaxLines;
    if (activeAgentCount > 1) {
      agentMaxLines = Math.max(5, Math.min(MAX_AGENT_OUTPUT_LINES, Math.floor((listHeight - 4) / activeAgentCount)));
    } else {
      agentMaxLines = Math.min(MAX_AGENT_OUTPUT_LINES, listHeight - 4);
    }

    let contentLines = this.viewMode === 'message'
      ? this._renderMessageView(events, width, agentMaxLines)
      : this._renderEventView(events, width);

    let estimatedBytes = this._estimateLinesBytes(titleLine) + this._estimateLinesBytes(hintLine);
    for (const line of contentLines) {
      estimatedBytes += this._estimateLineBytes(line);
    }

    // 降级:超 WARN 去 tool 详细,超 MAX 只显示 chunkPreview
    if (estimatedBytes > TEAM_PANEL_WARN_BYTES) {
      contentLines = this._renderMessageView(events, width, Math.max(5, Math.floor(agentMaxLines / 2)), { compact: true });
      estimatedBytes = 0;
      for (const line of contentLines) {
        estimatedBytes += this._estimateLineBytes(line);
      }
    }
    if (estimatedBytes > TEAM_PANEL_MAX_BYTES) {
      contentLines = this._renderMinimalView(agents, width);
    }

    if (this._autoScroll) {this.scrollOffset = 0;}
    const start = Math.max(0, contentLines.length - listHeight - this.scrollOffset);
    const end = contentLines.length - this.scrollOffset;
    const visibleLines = contentLines.slice(start, end);

    let listOutput = '';
    for (let i = 0; i < listHeight; i++) {
      const row = listStartRow + i;
      const line = visibleLines[i];
      const lineContent = line || '';
      listOutput += this._positionAt(row, 1) + chalk.hex(t.colors.text)('\x1b[K' + lineContent);
    }

    return titleLine + listOutput + hintLine;
  }

  /** 估算单行字节:ANSI 序列按字符计 + CJK 按 3 字节计,防 _safeWrite 截断撕开颜色代码。 */
  _estimateLineBytes(line) {
    if (!line) {return 1;}
    let bytes = 0;
    let inEscape = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '\x1b') {inEscape = true; bytes += 2; continue;}
      if (inEscape) {
        bytes += 1;
        if (ch === 'm' || ch === 'K' || ch === 'H' || ch === 'J') {inEscape = false;}
        continue;
      }
      bytes += ch.charCodeAt(0) > 0x7F ? 3 : 1;
    }
    return bytes;
  }

  /** 估算多行字节(含换行符)。 */
  _estimateLinesBytes(str) {
    if (!str) {return 0;}
    return this._estimateLineBytes(str) + str.split('\n').length;
  }

  /** 极简渲染兜底:每个 agent 只显示 1 行 chunkPreview,保证不撑爆 _safeWrite。 */
  _renderMinimalView(agents, width) {
    const t = this.theme;
    const lines = [];
    for (const agent of agents) {
      const role = agent.role || 'executor';
      const name = agent.name || agent.agentId.slice(-4);
      const preview = (agent.chunkPreview || '...').slice(-Math.max(0, width - 12));
      const status = agent.status || 'idle';
      lines.push(
        ` ${chalk.hex(t.colors.primary)(name)} ${chalk.dim(`[${role}]`)} ${this._agentStatusIcon(status)} ${chalk.dim(preview)}`
      );
    }
    if (lines.length === 0) {
      lines.push(chalk.dim('  <无活跃 Agent>'));
    }
    return lines;
  }

  /**
   * 消息视图:按 Agent 分组渲染子 Agent 的 thinking/content + 工具调用
   * 格式完全和主 Agent 界面一致:
   *   - thinking: 灰色文本(无 ● 前缀)
   *   - content:   ● 前缀 + Markdown 渲染,仅首行带标记
   *   - tool_calls:  工具名+参数紧凑行
   *   - tool_result: 结果内容(缩进)
   *   - 每个 Agent 以角色头部分隔
   *
   * Ring Buffer 滚动(K2 新增):
   *   - 超出 agentMaxLines 时折叠:保留 head (前 30 行) + 折叠提示 + tail (后 50 行)
   *   - 新输出到达时,tail 部分会"滚动"出新内容,符合"超出承受值后滚动新输出"语义
   *   - 完整历史保留在 sidebar.teamEvents,UI 只显示窗口
   *
   * @param {Array} events - 事件列表
   * @param {number} width - 可用宽度
   * @param {number|object} agentMaxLinesOrOpts - 单 agent 最大行数,或 {maxLines, compact}
   */
  _renderMessageView(events, width, agentMaxLinesOrOpts = Infinity) {
    const t = this.theme;
    const md = this._getMarkdownRenderer(width);

    const opts = typeof agentMaxLinesOrOpts === 'object'
      ? agentMaxLinesOrOpts
      : { maxLines: agentMaxLinesOrOpts, compact: false };
    const agentMaxLines = opts.maxLines || Infinity;
    const compact = opts.compact || false;

    const agents = this._getFilteredAgents();
    const filtered = this._filterEvents(events);
    const agentBlocks = this._accumulateAgentOutput(filtered);
    const allLines = [];

    if (agents.length === 0) {
      allLines.push(chalk.dim('  <无活跃 Agent>'));
      return allLines;
    }

    for (const agent of agents) {
      const output = agentBlocks.get(agent.agentId);
      const role = agent.role || 'executor';
      const agentName = agent.name || agent.agentId.slice(-4);
      const degradedTag = agent.degraded ? chalk.hex(t.colors.warning)(' [降级]') : '';
      const roleTag = this._formatRoleTag(role);
      allLines.push(` ${chalk.hex(t.colors.primary).bold(agentName)} ${roleTag}${degradedTag}`);
      const agentLines = [];

      // thinking 与主 Agent 一致:跳空行、thinkingFallback 灰色、无前缀
      if (output?.thinking) {
        let tLines = output.thinking.split('\n').filter(l => l.trim());
        let totalThinkingChars = tLines.reduce((sum, l) => sum + l.length, 0);
        if (totalThinkingChars > MAX_TOTAL_THINKING_CHARS) {
          let accChars = 0;
          let cutIdx = tLines.length;
          for (let i = tLines.length - 1; i >= 0; i--) {
            accChars += tLines[i].length;
            if (accChars > MAX_TOTAL_THINKING_CHARS) {cutIdx = i + 1; break;}
          }
          tLines = tLines.slice(cutIdx);
          agentLines.push(chalk.dim(`  ⋯ (前面 ${cutIdx} 行 thinking 已省略)`));
        }
        if (compact && tLines.length > 10) {
          agentLines.push(chalk.dim(`  ⋯ (省略 ${tLines.length - 10} 行 thinking)`));
          tLines = tLines.slice(-10);
        }
        for (const line of tLines) {
          agentLines.push(t.thinkingFallback(line));
        }
      }

      const toolLines = compact
        ? this._renderAgentToolEventsCompact(filtered, agent.agentId, width)
        : this._renderAgentToolEvents(filtered, agent.agentId, width);
      agentLines.push(...toolLines);

      // content 与主 Agent 一致:Markdown 渲染、跳空行、首行带 ●、后续 3 空格缩进
      if (output?.content) {
        let contentText = output.content;
        if (contentText.length > MAX_AGENT_CONTENT_CHARS) {
          const cutAt = contentText.length - MAX_AGENT_CONTENT_CHARS;
          contentText = '⋯ ' + contentText.slice(cutAt + 2);
          agentLines.push(chalk.dim(`  ⋯ (前 ${cutAt} 字符 content 已省略)`));
        }
        let cLines = md.write(contentText + '\n').split('\n').filter(l => l.trim());
        if (compact && cLines.length > 15) {
          agentLines.push(chalk.dim(`  ⋯ (省略 ${cLines.length - 15} 行 content)`));
          cLines = cLines.slice(-15);
        }
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

      // 超出 agentMaxLines 时折叠为 head + tail ring buffer
      if (agentLines.length > agentMaxLines) {
        const folded = agentLines.length - agentMaxLines;
        const headCount = Math.min(AGENT_OUTPUT_HEAD_LINES, Math.floor((agentMaxLines - 1) / 2));
        const tailCount = agentMaxLines - 1 - headCount;
        const head = agentLines.slice(0, headCount);
        const tail = agentLines.slice(-tailCount);
        agentLines.length = 0;
        agentLines.push(...head);
        agentLines.push(`  ${chalk.dim('⋯')} ${chalk.dim(`(+${folded} 行已折叠)`)}`);
        agentLines.push(...tail);
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

  /** Compact 模式工具渲染:每个工具调用压成 1 行,降低字节数。 */
  _renderAgentToolEventsCompact(events, agentId, width) {
    const t = this.theme;
    const lines = [];
    const toolEvents = events.filter(e =>
      (e.event === 'tool_calls' || e.event === 'tool_result')
      && e.data?.agentId === agentId
    );
    toolEvents.reverse();
    const paired = [];
    const pendingCalls = new Map();
    for (const ev of toolEvents) {
      if (ev.event === 'tool_calls' && ev.data?.toolCall) {
        const tc = ev.data.toolCall;
        pendingCalls.set(tc.id, { tc, result: null });
      } else if (ev.event === 'tool_result' && ev.data?.toolCall?.id) {
        const callId = ev.data.toolCall.id;
        if (pendingCalls.has(callId)) {
          const item = pendingCalls.get(callId);
          item.result = ev.data;
          paired.push(item);
          pendingCalls.delete(callId);
        } else {
          // 孤立 result
          paired.push({ tc: ev.data.toolCall, result: ev.data });
        }
      }
    }

    for (const { tc, result } of paired) {
      const rawName = tc.function?.name || tc.name || result?.name || 'unknown';
      const success = result?.result?.success !== false && !result?.result?.error;
      const icon = success ? t.success('✓') : t.error('✗');
      lines.push(` ${icon} ${chalk.dim(rawName)}`);
    }
    return lines;
  }

  /**
   * 渲染指定 agent 的工具调用/结果(主 Agent tool-renderer 风格):
   *   ● read_file(file="...")
   *   └─ Lines 1-50 of ...
   */
  _renderAgentToolEvents(events, agentId, width) {
    const t = this.theme;
    const lines = [];
    const toolEvents = events.filter(e =>
      (e.event === 'tool_calls' || e.event === 'tool_result')
      && e.data?.agentId === agentId
    );
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

  /** 事件列表视图:每条事件 1 行紧凑显示。 */
  _renderEventView(events, width) {
    const filtered = this._filterEvents(events);
    if (filtered.length === 0) {return [chalk.dim('  <无事件>')];}

    // 每 agent 限流,防止单 agent 刷屏
    const agents = this.sidebar?.getAgentStatesSnapshot?.() || [];
    const activeAgentCount = this.agentFilter !== null ? 1 : agents.length;
    const agentMaxEvents = activeAgentCount > 1
      ? Math.max(5, Math.ceil(filtered.length / activeAgentCount * 0.5))
      : Infinity;

    const grouped = new Map();
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
    for (const [, evts] of grouped) {result.push(...evts);}
    result.push(...ungrouped);
    result.sort((a, b) => (b.time || 0) - (a.time || 0));

    const lines = result.map(event => this._formatEvent(event, width));

    if (activeAgentCount > 1) {
      lines.push(chalk.dim(`  ${'─'.repeat(Math.min(15, width - 2))} (每 agent 最多 ${agentMaxEvents} 条, 按数字键过滤看全量)`));
    }

    return lines;
  }

  /**
   * 按 agent 聚合 thinking/content chunk。
   * 优先从 sidebar._accumulator(单一权威源)读取,避免双累加器不一致。
   */
  _accumulateAgentOutput(events) {
    const agentMap = new Map();
    const sidebarAccumulator = this.sidebar?.getAgentAccumulatedOutput?.() || {};

    for (const event of events) {
      const agentId = event.data?.agentId;
      if (!agentId) {continue;}
      if (!agentMap.has(agentId)) {
        agentMap.set(agentId, { thinking: '', content: '' });
      }
      const acc = agentMap.get(agentId);
      if (event.event === 'thinking' && event.data?.chunk) {acc.thinking += event.data.chunk;}
      else if (event.event === 'content' && event.data?.chunk) {acc.content += event.data.chunk;}
    }

    // 累加器兜底(events 可能没收到完整内容)
    for (const [agentId, srcAcc] of Object.entries(sidebarAccumulator)) {
      const acc = agentMap.get(agentId) || { thinking: '', content: '' };
      if (!acc.thinking && srcAcc.thinking) {acc.thinking = srcAcc.thinking;}
      if (!acc.content && srcAcc.content) {acc.content = srcAcc.content;}
      agentMap.set(agentId, acc);
    }
    return agentMap;
  }

  /** 按 agentFilter 过滤 agent 列表(数字键 1-9 切换)。 */
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

    const eventBase = event.event.replace(/^(agent|team|subagent)_/, '');
    const eventLabel = `[${eventBase}]`;

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

    let preview = '';
    if (event.data?.chunk) {
      const text = event.data.chunk.replace(/\n/g, ' ');
      const totalLen = text.length;
      const head = text.slice(0, 60);
      preview = totalLen > 60 ? ` "${head}…(+${totalLen - 60}字)"` : ` "${text}"`;
    } else if (event.data?.role) {
      preview = ` ${event.data.role}`;
    } else if (event.data?.success !== undefined) {
      preview = ` success=${event.data.success}`;
    } else if (event.data?.to) {
      preview = ` → ${event.data.to}`;
    }

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

    if (buf[0] === 0x1b && buf.length === 1) {
      this.close();
      return { action: 'team_panel_close' };
    }

    if (buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x41) {
      this._autoScroll = false;
      this.scrollOffset = Math.min(this.scrollOffset + 1, this._maxScroll());
      return { action: 'team_panel_scroll_up' };
    }

    if (buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x42) {
      const newOffset = Math.max(0, this.scrollOffset - 1);
      this.scrollOffset = newOffset;
      if (newOffset === 0) {this._autoScroll = true;}
      return { action: 'team_panel_scroll_down' };
    }

    if (buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x35 && buf[3] === 0x7e) {
      this._autoScroll = false;
      this.scrollOffset = Math.min(this.scrollOffset + 10, this._maxScroll());
      return { action: 'team_panel_page_up' };
    }

    if (buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x36 && buf[3] === 0x7e) {
      const newOffset = Math.max(0, this.scrollOffset - 10);
      this.scrollOffset = newOffset;
      if (newOffset === 0) {this._autoScroll = true;}
      return { action: 'team_panel_page_down' };
    }

    if (buf[0] === 0x76 || buf[0] === 0x56) {
      this.viewMode = this.viewMode === 'message' ? 'event' : 'message';
      this.scrollOffset = 0;
      return { action: 'team_panel_toggle_view', viewMode: this.viewMode };
    }

    if (buf[0] === 0x30) {
      this.agentFilter = null;
      this.scrollOffset = 0;
      return { action: 'team_panel_filter_clear' };
    }

    if (buf[0] >= 0x31 && buf[0] <= 0x39) {
      return this._setAgentFilter(buf[0] - 0x30);
    }

    // 小键盘 SS3 数字键: \x1bOp~\x1bOy 对应 1~9/0
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

    // 小键盘 CSI ~ 数字键: \x1b[N~
    if (buf[0] === 0x1b && buf[1] === 0x5b && buf[3] === 0x7e) {
      const digit = buf[2] - 0x30;
      if (digit >= 1 && digit <= 9) {return this._setAgentFilter(digit);}
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
      const targetAgents = this.agentFilter !== null
        ? [agents[this.agentFilter - 1]].filter(Boolean)
        : agents;
      totalLines = targetAgents.length * 3;
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
module.exports.TEAM_PANEL_MAX_BYTES = TEAM_PANEL_MAX_BYTES;
module.exports.TEAM_PANEL_WARN_BYTES = TEAM_PANEL_WARN_BYTES;
module.exports.MAX_AGENT_OUTPUT_LINES = MAX_AGENT_OUTPUT_LINES;
module.exports.AGENT_OUTPUT_HEAD_LINES = AGENT_OUTPUT_HEAD_LINES;
module.exports.AGENT_OUTPUT_TAIL_LINES = AGENT_OUTPUT_TAIL_LINES;
module.exports.MAX_AGENT_CONTENT_CHARS = MAX_AGENT_CONTENT_CHARS;
module.exports.MAX_TOTAL_THINKING_CHARS = MAX_TOTAL_THINKING_CHARS;

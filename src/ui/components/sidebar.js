'use strict';

const chalk = require('chalk');
const { getTheme } = require('../theme');

class Sidebar {
  constructor(layout) {
    this.layout = layout;
    this.theme = getTheme();
    this.sessionTitle = 'New Session';
    this.modifiedFiles = [];
    this.diagnostics = { errors: 0, warnings: 0 };

    this.contextManager = null;
    this.messages = [];
    this.chatEngine = null;

    this.cacheStats = {
      totalRequests: 0,
      cacheHits: 0,
      totalInputTokens: 0,
      cachedTokens: 0,
    };

    this.todos = [];

    // Team Mode 状态(由 chatEngine 事件驱动)
    this.teamStatus = {
      active: false,
      teamId: null,
      agentCount: 0,
      currentState: null,
    };
    this.teamEvents = []; // 最近 N 条 team 事件(用于侧栏显示进度)

    // 每活跃 agent 一张状态卡(name/role/status/startedAt/lastChunkAt/chunkPreview)
    this.agentStates = new Map();

    this._contextInfoCache = null;
    this._contextBreakdownCache = null;
    this._messagesVersion = 0;
    this._todosVersion = 0;
    this._teamEventsVersion = 0;

    this._progressAnimation = {
      active: false,
      from: 0,
      to: 0,
      startTime: 0,
      duration: 0,
    };
    this._progressAnimationTimer = null;

    // Agent 流式 chunk 累加器:key=agentId, value={thinking:'',content:''}
    // 避免 subagent_thinking/content 逐 token 刷出几百条碎词事件
    // 同 agent 同类流式事件只保留一条记录,data.chunk 持续追加
    this._accumulator = new Map();
  }

  setChatEngine(chatEngine) {
    this.chatEngine = chatEngine;
    if (chatEngine) {
      this.contextManager = chatEngine.contextManager;
      this.messages = chatEngine.messages || [];
      this.toolRegistry = chatEngine.toolRegistry || null;
    }
  }

  updateMessages(messages) {
    this.messages = messages || [];
    this._messagesVersion++;
  }

  updateCacheStats(usage) {
    if (usage) {
      this.cacheStats.totalRequests++;
      // 支持多种输入 token 字段名
      const inputTokens = usage.prompt_tokens || usage.promptTokens || usage.input_tokens || 0;
      this.cacheStats.totalInputTokens += inputTokens;

      // 支持多种缓存命中字段名（不同提供商命名不同）
      const cached = usage.prompt_cache_hit_tokens // DeepSeek
        || usage.prompt_caching_tokens // Anthropic prompt caching
        || usage.cached_tokens // OpenAI / 通用
        || 0;
      this.cacheStats.cachedTokens += cached;

      if (cached > 0) {
        this.cacheStats.cacheHits++;
      }
    }
  }

  setTodos(todos) {
    this.todos = todos || [];
  }

  // 设置 Team Mode 整体状态(由 team_mode_start/end 事件触发)
  setTeamStatus(status) {
    this.teamStatus = { ...this.teamStatus, ...status };
    this._teamEventsVersion++;
  }

  // 接收 team_* 事件,更新 sidebar 显示
  handleTeamEvent(eventName, data) {
    const maxEvents = 500;

    // tool_calls/tool_result 存成结构化数据供 team-panel 渲染
    if ((eventName === 'tool_calls' || eventName === 'tool_result') && data?._subAgent) {
      this.teamEvents.unshift({
        event: eventName,
        data: {
          agentId: data.agentId,
          toolCall: data.toolCall,
          toolName: data.name,
          args: data.args,
          result: data.result,
          _subAgent: true,
        },
        _subAgent: true,
        time: Date.now(),
      });
    } else if ((eventName === 'thinking' || eventName === 'content') && data?.chunk && data?._subAgent) {
      // Step 1: 累加到 accumulator
      let acc = this._accumulator.get(data.agentId);
      if (!acc) {
        acc = { thinking: '', content: '' };
        this._accumulator.set(data.agentId, acc);
      }
      if (eventName === 'thinking') {
        acc.thinking += data.chunk;
      } else {
        acc.content += data.chunk;
      }

      // Step 2: 在 teamEvents 中查找同 agent 同类型事件,更新或新建
      const fullText = eventName === 'thinking' ? acc.thinking : acc.content;
      const existingIdx = this.teamEvents.findIndex(
        e => e.event === eventName && e.data?.agentId === data.agentId && e._subAgent
      );
      if (existingIdx >= 0) {
        // 更新已有事件的内容(直接替换 data 引用,保留原位置和时间戳)
        this.teamEvents[existingIdx] = {
          ...this.teamEvents[existingIdx],
          data: { agentId: data.agentId, chunk: fullText },
          _subAgent: true,
        };
      } else {
        this.teamEvents.unshift({
          event: eventName,
          data: { agentId: data.agentId, chunk: fullText },
          _subAgent: true,
          time: Date.now(),
        });
      }
    } else {
      // 非流式事件:直接入队
      this.teamEvents.unshift({ event: eventName, data, time: Date.now() });
      // agent_completed 不清 _accumulator(team-panel 需要完整历史),统一在 team_dissolved 清理
      if (eventName === 'team_dissolved') {this._accumulator.clear();}
    }

    if (this.teamEvents.length > maxEvents) {
      this.teamEvents = this.teamEvents.slice(0, maxEvents);
    }

    // 关键:同步维护 agentStates Map(M2 会用它做 agent 卡片渲染)
    // per-agent 150ms 节流:subagent_thinking 高频 chunk 不会每帧都触发 version++
    this._updateAgentState(eventName, data);

    // 根据事件类型更新聚合状态
    switch (eventName) {
      case 'team_created':
        this.teamStatus = {
          active: true,
          teamId: data?.teamId || this.teamStatus.teamId,
          agentCount: 0,
          currentState: 'planning',
        };
        // 重置 agentStates(新团队)
        this.agentStates.clear();
        break;
      case 'state_changed':
        if (data?.to) {this.teamStatus.currentState = data.to;}
        break;
      case 'agent_created':
        this.teamStatus.agentCount = (this.teamStatus.agentCount || 0) + 1;
        break;
      case 'agent_respawned':
        // respawn 替换槽位,不计 agentCount(否则任务失败重试会显示 3 变 4)
        break;
      case 'team_dissolved':
        this.teamStatus.active = false;
        // 保留 agentStates 几秒供 M4 modal 历史展示,实际 dispose 由调用方决定
        break;
      default:
        break;
    }
    this._teamEventsVersion++;
  }

  /**
   * 根据事件更新 agentStates Map
   * 内部方法,被 handleTeamEvent 调用
   * 路由表(对应 plan A.1):
   *   agent_created → 新建 idle 卡片
   *   agent_respawned → 替换槽位:继承旧 state(在 agentId 检查前单独处理)
   *   agent_started → thinking
   *   subagent_thinking 帧 → thinking + chunkPreview(150ms 节流)
   *   subagent_content 帧 → streaming + chunkPreview(150ms 节流)
   *   agent_completed → done
   *   agent_terminated → failed
   *   team_degraded → 在 active agents 标 degraded 标志
   */
  _updateAgentState(eventName, data) {
    // team_degraded 必须放在 agentId 检查之前,否则 case 被吞掉
    if (eventName === 'team_degraded') {
      for (const state of this.agentStates.values()) {
        if (state.status === 'thinking' || state.status === 'streaming') {
          state.degraded = true;
        }
      }
      return;
    }

    // agent_respawned 必须在 agentId 检查之前:payload 只有 oldAgentId/newAgentId,没有顶层 agentId
    // respawn 替换槽位:删除旧 state,新建 state 并继承 role/startedAt,避免新卡片丢失上下文
    if (eventName === 'agent_respawned') {
      const oldId = data?.oldAgentId;
      const newId = data?.newAgentId;
      if (!newId) { return; }
      const oldState = oldId ? this.agentStates.get(oldId) : null;
      this.agentStates.set(newId, {
        name: newId.slice(-4),
        role: data?.role || oldState?.role || 'executor',
        status: 'idle',
        startedAt: oldState?.startedAt || Date.now(),
        lastChunkAt: 0,
        chunkPreview: '',
        degraded: false,
      });
      if (oldId && oldId !== newId) {
        this.agentStates.delete(oldId);
      }
      return;
    }

    const agentId = data?.agentId;
    if (!agentId) {return;}

    switch (eventName) {
      case 'agent_created': {
        this.agentStates.set(agentId, {
          name: agentId.slice(-4),
          role: data?.role || 'executor',
          status: 'idle',
          startedAt: Date.now(),
          lastChunkAt: 0,
          chunkPreview: '',
          degraded: false,
        });
        break;
      }
      case 'agent_started': {
        const state = this.agentStates.get(agentId) || {
          name: agentId.slice(-4),
          lastChunkAt: 0,
          chunkPreview: '',
          degraded: false,
        };
        state.role = data?.role || state.role;
        state.status = 'thinking';
        state.startedAt = state.startedAt || Date.now();
        this.agentStates.set(agentId, state);
        break;
      }
      case 'thinking':
      case 'content': {
        const state = this.agentStates.get(agentId);
        if (!state) {break;}
        const chunk = data?.chunk || '';
        const newStatus = eventName === 'thinking' ? 'thinking' : 'streaming';

        // per-agent 150ms 节流:高频 chunk 仅更新 preview,不触发 version++
        // 老逻辑:每个 chunk 都触发重绘,sidebar 帧率爆炸
        const now = Date.now();
        if (now - state.lastChunkAt < 150) {
          state.chunkPreview = chunk.slice(-30);
          return; // 仅更新数据,version 留给下次节流窗口到期
        }
        state.lastChunkAt = now;
        state.chunkPreview = chunk.slice(-30);
        state.status = newStatus;
        break;
      }
      case 'agent_completed': {
        const state = this.agentStates.get(agentId);
        if (state) {state.status = data?.success === false ? 'failed' : 'done';}
        break;
      }
      case 'agent_terminated': {
        const state = this.agentStates.get(agentId);
        if (state) {state.status = 'failed';}
        break;
      }
      default:
        break;
    }
  }

  /**
   * 暴露给 team-panel modal 用:返回当前所有 agent 的事件日志
   * 不限条数,team-panel 自己管理滚动
   */
  getFullEventLog() {
    return this.teamEvents.map(e => ({
      ...e,
      agentName: e.data?.agentId ? e.data.agentId.slice(-4) : null,
    }));
  }

  /** 给 team-panel 用:返回每个 agent 累加的 thinking + content 完整文本,由 team-panel 自己负责折叠。 */
  getAgentAccumulatedOutput() {
    const result = {};
    for (const [agentId, acc] of this._accumulator.entries()) {
      result[agentId] = {
        thinking: acc.thinking || '',
        content: acc.content || '',
      };
    }
    return result;
  }

  /**
   * 暴露给 team-panel modal 用:返回当前所有 agent 状态快照
   */
  getAgentStatesSnapshot() {
    return Array.from(this.agentStates.entries()).map(([id, s]) => ({
      agentId: id,
      ...s,
    }));
  }

  setSessionTitle(title) {
    this.sessionTitle = title || 'New Session';
  }

  setModifiedFiles(files) {
    this.modifiedFiles = files || [];
  }

  setDiagnostics(errors, warnings) {
    this.diagnostics = { errors: errors || 0, warnings: warnings || 0 };
  }

  /**
   * 判断是否为 CJK 双倍宽字符
   */
  /**
   * agent 状态图标
   * idle → ·, thinking → ◐, streaming → ●, done → ✓, failed → ✗
   * 关键:用 unicode 字符而不是 emoji(emoji 在某些终端会变彩色方块)
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

  _isCJK(char) {
    const code = char.charCodeAt(0);
    return (code >= 0x1100 && code <= 0x115F) || // Hangul Jamo
      (code >= 0x2E80 && code <= 0xA4CF) ||   // CJK Radicals, Ideographs
      (code >= 0xAC00 && code <= 0xD7AF) ||   // Hangul Syllables
      (code >= 0xF900 && code <= 0xFAFF) ||   // CJK Compatibility
      (code >= 0xFE10 && code <= 0xFE6F) ||   // Vertical/Compatibility Forms
      (code >= 0xFF01 && code <= 0xFF60) ||   // Fullwidth Forms
      (code >= 0xFFE0 && code <= 0xFFE6) ||   // Fullwidth Signs
      (code >= 0x3000 && code <= 0x303F);     // CJK Symbols & Punctuation
  }

  /**
   * 获取字符串的可见宽度（支持 CJK 双倍宽字符）
   */
  _visibleWidth(str) {
    let width = 0;
    let inEscape = false;
    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      if (char === '\x1b') { inEscape = true; continue; }
      if (inEscape) { if (char === 'm') {inEscape = false;} continue; }
      width += this._isCJK(char) ? 2 : 1;
    }
    return width;
  }

  // 渲染侧边栏（完全重绘整个区域，简单可靠）
  render() {
    const { messageStartRow, contentHeight, sidebarWidth, messageWidth } = this.layout;
    const viewportHeight = contentHeight;

    // 关键:计算 team 区最大 agent 行数(viewport - 16 保留给 context/cache/breakdown)
    // 自适应,窄终端降到 2 行,宽终端可上探到 viewport - 16
    // 16 = context 区 1 + progress 1 + token 1 + breakdown 4 + files 2 + cache 3 + 间隔 2 + headers 2
    const teamAgentRows = this.teamStatus.active
      ? Math.max(2, Math.min(this.agentStates.size || 0, Math.max(2, viewportHeight - 16)))
      : 0;
    this._maxAgentRows = teamAgentRows;

    // 生成所有行内容
    const lines = [];
    for (let i = 0; i < viewportHeight; i++) {
      const line = this._renderLine(i, sidebarWidth - 1);
      lines.push(line ? this._truncateToWidth(line, sidebarWidth - 1) : '');
    }

    // 完全重绘：清空整个 sidebar 区域后重新输出
    let output = '';
    const startCol = messageWidth + 1;

    for (let i = 0; i < viewportHeight; i++) {
      const row = messageStartRow + i;
      const line = lines[i] || '';
      // 定位到行首，清除该行，输出内容
      output += `\x1b[${row};${startCol}H\x1b[K${line}`;
    }

    return output;
  }

  // 渲染单行内容
  _renderLine(lineIndex, width) {
    const t = this.theme;
    let line = 0;

    // ─── 标题区 ───
    if (lineIndex === line) {
      const icon = t.primary('⌬');
      const title = t.text('Anvil');
      const version = t.textMuted('0.1.0');
      return ` ${icon} ${title} ${version}`;
    }
    line++;

    if (lineIndex === line) {
      return ` ${t.textMuted('─'.repeat(Math.max(0, width - 1)))}`;
    }
    line++;

    // ─── Todo List 区 ───
    if (lineIndex === line) {
      const stats = this._getTodoStats();
      return ` ${t.textMuted('Todo')} ${t.textMuted(stats)}`;
    }
    line++;

    if (this.todos.length > 0) {
      for (let i = 0; i < Math.min(this.todos.length, 5); i++) {
        if (lineIndex === line) {
          const todo = this.todos[i];
          const status = todo.completed ? t.success('✓') : t.textMuted('[ ]');
          // 使用可见宽度截断，兼容 CJK 双倍宽字符
          const text = this._visibleWidth(todo.text) > width - 6
            ? this._truncateToWidth(todo.text, width - 9) + '...'
            : todo.text;
          return ` ${status} ${t.text(text)}`;
        }
        line++;
      }
    } else {
      if (lineIndex === line) {
        return ` ${t.textMuted('(empty)')}`;
      }
      line++;
    }

    if (lineIndex === line) {
      return '';
    }
    line++;

    // ─── Team Mode 区(仅在团队活跃时显示) ───
    if (this.teamStatus.active) {
      if (lineIndex === line) {
        return ` ${t.textMuted('Team Mode')}`;
      }
      line++;

      if (lineIndex === line) {
        const shortId = this.teamStatus.teamId
          ? this.teamStatus.teamId.slice(-8)
          : '-';
        return ` ${t.textMuted('ID:')} ${t.token(shortId)}`;
      }
      line++;

      if (lineIndex === line) {
        return ` ${t.textMuted('Agents:')} ${t.token(String(this.teamStatus.agentCount || 0))}`;
      }
      line++;

      if (lineIndex === line) {
        return ` ${t.textMuted('State:')} ${t.token(this.teamStatus.currentState || 'idle')}`;
      }
      line++;

      // 关键:agent 卡片区(替代原来 3 条简化事件名)
      // 每个 agent 占 1 行,展示 role + status + chunkPreview
      // 行数自适应:_maxAgentRows 在 render() 入口算出
      const maxAgentRows = this._maxAgentRows || 0;
      if (maxAgentRows > 0 && this.agentStates.size > 0) {
        const agentList = Array.from(this.agentStates.values());
        for (let i = 0; i < maxAgentRows; i++) {
          if (lineIndex === line) {
            if (i < agentList.length) {
              const s = agentList[i];
              const statusIcon = this._agentStatusIcon(s.status);
              const nameRole = `${s.name} ${s.role}`;
              const degradedMark = s.degraded ? t.warning(' ⚠') : '';
              // 算剩余宽度给 preview:总宽 - 缩进 - icon - 空格 - nameRole - 空格 - 状态符号
              const fixed = 2 + 1 + 1 + nameRole.length + 1 + 1 + degradedMark.length;
              const previewMaxLen = Math.max(0, width - fixed);
              const preview = this._truncateToWidth(s.chunkPreview || '...', previewMaxLen);
              return ` ${statusIcon} ${t.text(nameRole)}${degradedMark} ${t.textMuted(preview)}`;
            }
            // 占位空行(实际 agent 数 < maxAgentRows 时填空白)
            return '';
          }
          line++;
        }
        // "more" 提示行(只在 agent 数超过 maxAgentRows 时显示)
        if (lineIndex === line) {
          if (agentList.length > maxAgentRows) {
            return ` ${t.textMuted('+ ' + (agentList.length - maxAgentRows) + ' more (Ctrl+T 展开)')}`;
          }
          return '';
        }
        line++;
      } else {
        // agentStates 还没数据,降级显示 3 条事件(向后兼容)
        const recentEvents = this.teamEvents.slice(0, 3);
        for (const ev of recentEvents) {
          if (lineIndex === line) {
            const label = ev.event.replace(/^(agent|team|subagent)_/, '');
            return ` ${t.textMuted('› ' + label)}`;
          }
          line++;
        }
      }

      if (lineIndex === line) {
        return '';
      }
      line++;
    }

    // ─── 上下文状况区 ───
    if (lineIndex === line) {
      return ` ${t.textMuted('Context')}`;
    }
    line++;

    // 进度条
    if (lineIndex === line) {
      const contextInfo = this._getContextInfo();
      // 动画进度优先于实际进度
      const displayPercent = this._getAnimationProgress() ?? contextInfo.percent;
      const progressBar = this._renderProgressBar(displayPercent, width - 4);
      const percentText = `${Math.round(displayPercent)}%`;
      return ` ${progressBar} ${t.text(percentText)}`;
    }
    line++;

    // Token 统计
    if (lineIndex === line) {
      const contextInfo = this._getContextInfo();
      const used = this._formatTokens(contextInfo.used);
      const total = this._formatTokens(contextInfo.total);
      return ` ${t.textMuted('Used:')} ${t.token(used)} / ${t.token(total)}`;
    }
    line++;

    // 压缩级别
    if (lineIndex === line) {
      const contextInfo = this._getContextInfo();
      if (contextInfo.compressionLabel && contextInfo.compressionLevel > 0) {
        return ` ${t.warning(contextInfo.compressionLabel)}`;
      }
      return '';
    }
    line++;

    if (lineIndex === line) {
      return '';
    }
    line++;

    // ─── 上下文明细区（分类分解） ───
    const ctxDetail = this._getContextBreakdown();

    // 先显示各分类 breakdown（最多5行）
    if (ctxDetail.breakdown && ctxDetail.breakdown.length > 0) {
      const maxRows = 5;
      for (let i = 0; i < Math.min(ctxDetail.breakdown.length, maxRows); i++) {
        if (lineIndex === line) {
          const item = ctxDetail.breakdown[i];
          const label = item.label.padEnd(9);
          const tokens = this._formatTokens(item.tokens).padStart(6);
          const pct = `${item.percent}%`.padStart(5);
          const colorFn = item.label === 'Free' ? t.success : t.text;
          return ` ${t.textMuted(label)} ${t.token(tokens)} ${colorFn(pct)}`;
        }
        line++;
      }

      if (ctxDetail.breakdown.length > maxRows) {
        if (lineIndex === line) {
          const more = ctxDetail.breakdown.length - maxRows;
          return ` ${t.textMuted(`  ... +${more} more`)}`;
        }
        line++;
      }
    } else {
      // 旧格式兜底（兼容）
      if (lineIndex === line) {
        const sysTokens = this._formatTokens(ctxDetail.systemPrompt);
        return ` ${t.textMuted('System Prompt:')} ${t.token(sysTokens)}`;
      }
      line++;

      if (lineIndex === line) {
        const overview = this._formatTokens(ctxDetail.projectOverview);
        return ` ${t.textMuted('Project:')} ${t.token(overview)}`;
      }
      line++;
    }

    // 注入文件列表（紧凑显示）
    if (ctxDetail.fileContexts.length > 0) {
      if (lineIndex === line) {
        const totalFiles = this._formatTokens(ctxDetail.totalFileTokens);
        const fileCount = ctxDetail.fileContexts.length;
        return ` ${t.textMuted('Files:')} ${t.token(totalFiles)} ${t.textMuted(`(${fileCount})`)}`;
      }
      line++;

      const maxFiles = Math.min(ctxDetail.fileContexts.length, 4);
      for (let i = 0; i < maxFiles; i++) {
        if (lineIndex === line) {
          const fc = ctxDetail.fileContexts[i];
          const name = fc.path.length > width - 18
            ? '..' + fc.path.substring(fc.path.length - (width - 22))
            : fc.path;
          const tokens = this._formatTokens(fc.tokens);
          return ` ${t.dim('·' + name)} ${t.token(tokens)}`;
        }
        line++;
      }

      if (ctxDetail.fileContexts.length > maxFiles) {
        if (lineIndex === line) {
          return ` ${t.textMuted(`  +${ctxDetail.fileContexts.length - maxFiles} more`)}`;
        }
        line++;
      }
    }

    // Skills 数量
    const skillCount = this._getSkillCount();
    if (skillCount > 0) {
      if (lineIndex === line) {
        return ` ${t.textMuted('Skills:')} ${t.token(skillCount.toString())}`;
      }
      line++;
    }

    if (lineIndex === line) {
      return '';
    }
    line++;

    // ─── 缓存命中区 ───
    if (lineIndex === line) {
      return ` ${t.textMuted('Cache')}`;
    }
    line++;

    if (lineIndex === line) {
      const cacheInfo = this._getCacheInfo();
      const hitRate = cacheInfo.hitRate;
      const rateColor = hitRate >= 50 ? t.success : hitRate >= 20 ? t.warning : t.error;
      return ` ${t.textMuted('Hit Rate:')} ${rateColor(hitRate + '%')}`;
    }
    line++;

    if (lineIndex === line) {
      const cacheInfo = this._getCacheInfo();
      const cached = this._formatTokens(cacheInfo.cachedTokens);
      const total = this._formatTokens(cacheInfo.totalInputTokens);
      return ` ${t.textMuted('Cached:')} ${t.token(cached)} / ${t.token(total)}`;
    }
    line++;

    if (lineIndex === line) {
      const cacheInfo = this._getCacheInfo();
      return ` ${t.textMuted('Requests:')} ${t.token(String(cacheInfo.totalRequests))}`;
    }
    line++;

    if (lineIndex === line) {
      return '';
    }
    line++;

    // ─── 修改的文件区 ───
    if (this.modifiedFiles.length > 0) {
      if (lineIndex === line) {
        return ` ${t.textMuted('Modified Files')}`;
      }
      line++;

      for (let i = 0; i < Math.min(this.modifiedFiles.length, 5); i++) {
        if (lineIndex === line) {
          const file = this.modifiedFiles[i];
          const fileName = file.name || file;
          const changes = file.changes || '';
          const truncatedName = fileName.length > width - 10
            ? fileName.substring(0, width - 13) + '...'
            : fileName;
          return ` ${t.text(truncatedName)} ${t.textMuted(changes)}`;
        }
        line++;
      }
    }

    return '';
  }

  // 获取上下文信息（带缓存）
  _getContextInfo() {
    const defaultInfo = {
      used: 0,
      total: 1000000,
      percent: 0,
      compressionLevel: 0,
      compressionLabel: '',
    };

    if (!this.contextManager) {return defaultInfo;}

    // 缓存检查
    if (this._contextInfoCache && this._messagesVersion === this._contextInfoCache._ver) {
      return this._contextInfoCache;
    }

    try {
      const status = this.contextManager.getStatusReport(this.messages);
      this._contextInfoCache = {
        used: status.currentTokens || 0,
        total: status.windowSize || 1000000,
        percent: status.usagePercent || 0,
        compressionLevel: status.compressionLevel || 0,
        compressionLabel: status.compressionLabel || '',
        _ver: this._messagesVersion,
      };
      return this._contextInfoCache;
    } catch {
      return defaultInfo;
    }
  }

  // 获取上下文各层 Token 明细
  _getContextBreakdown() {
    if (!this.contextManager) {return { systemPrompt: 0, projectOverview: 0, fileContexts: [], totalFileTokens: 0 };}

    // 缓存检查
    if (this._contextBreakdownCache && this._messagesVersion === this._contextBreakdownCache._ver) {
      return this._contextBreakdownCache;
    }

    try {
      this._contextBreakdownCache = this.contextManager.getContextBreakdown(this.messages);
      this._contextBreakdownCache._ver = this._messagesVersion;
      return this._contextBreakdownCache;
    } catch {
      return { systemPrompt: 0, projectOverview: 0, fileContexts: [], totalFileTokens: 0 };
    }
  }

  _getSkillCount() {
    if (!this.toolRegistry) {return 0;}
    const skills = this.toolRegistry.listSkills();
    return skills.length;
  }

  _getCacheInfo() {
    const { totalRequests, cacheHits, totalInputTokens, cachedTokens } = this.cacheStats;
    const hitRate = totalInputTokens > 0
      ? Math.round((cachedTokens / totalInputTokens) * 100)
      : totalRequests > 0
        ? Math.round((cacheHits / totalRequests) * 100)
        : 0;

    return {
      totalRequests,
      cacheHits,
      totalInputTokens,
      cachedTokens,
      hitRate,
    };
  }

  // 渲染进度条
  _renderProgressBar(percent, width) {
    const t = this.theme;
    const barWidth = Math.max(10, width - 6);
    const filled = Math.round((percent / 100) * barWidth);
    const empty = barWidth - filled;

    let barColor;
    if (percent >= 90) {barColor = t.colors.error;}
    else if (percent >= 70) {barColor = t.colors.warning;}
    else if (percent >= 50) {barColor = t.colors.textEmphasized;}
    else {barColor = t.colors.success;}

    const filledBar = chalk.hex(barColor)('█'.repeat(filled));
    const emptyBar = chalk.hex(t.colors.borderDim)('░'.repeat(empty));

    return `${filledBar}${emptyBar}`;
  }

  // 格式化 token 数
  _formatTokens(count) {
    if (count >= 1000000) {return (count / 1000000).toFixed(1) + 'M';}
    if (count >= 1000) {return (count / 1000).toFixed(1) + 'K';}
    return String(count);
  }

  // 启动进度条动画
  startProgressAnimation(fromPercent, toPercent, durationMs) {
    // 清除之前的动画
    if (this._progressAnimationTimer) {
      clearInterval(this._progressAnimationTimer);
      this._progressAnimationTimer = null;
    }

    this._progressAnimation = {
      active: true,
      from: fromPercent,
      to: toPercent,
      startTime: Date.now(),
      duration: durationMs,
    };

    const tick = () => {
      const elapsed = Date.now() - this._progressAnimation.startTime;
      const progress = Math.min(elapsed / this._progressAnimation.duration, 1);

      // 动画结束
      if (progress >= 1) {
        this._progressAnimation.active = false;
        if (this._progressAnimationTimer) {
          clearInterval(this._progressAnimationTimer);
          this._progressAnimationTimer = null;
        }
      }
    };

    this._progressAnimationTimer = setInterval(tick, 30);
    tick(); // 立即执行一次
  }

  _getAnimationProgress() {
    if (!this._progressAnimation.active) {return null;}

    const elapsed = Date.now() - this._progressAnimation.startTime;
    const progress = Math.min(elapsed / this._progressAnimation.duration, 1);

    return this._progressAnimation.from +
      (this._progressAnimation.to - this._progressAnimation.from) * progress;
  }

  _getTodoStats() {
    const total = this.todos.length;
    if (total === 0) {return '';}
    const completed = this.todos.filter(t => t.completed).length;
    return `(${completed}/${total})`;
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
      if (visibleWidth + charWidth > maxWidth) {
        if (visibleWidth + 1 <= maxWidth) {
          result += '…';
        }
        break;
      }
      result += char;
      visibleWidth += charWidth;
    }

    return result;
  }
}

module.exports = Sidebar;

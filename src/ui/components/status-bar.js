'use strict';

const chalk = require('chalk');
const { getTheme } = require('../theme');
const { calculateCost } = require('../tokens');
const { visibleLength } = require('../ansi');

class StatusBar {
  constructor(layout) {
    this.layout = layout;
    this.theme = getTheme();
    this.model = '';
    this.tokenUsage = {
      roundInput: 0,
      roundOutput: 0,
      roundCacheHit: 0,
      totalInput: 0,
      totalOutput: 0,
      totalCacheHit: 0,
    };
    this.pricing = null;
    this.diagnostics = { errors: 0, warnings: 0 };
    this.hasPendingContext = false;
    this.isThinking = false;
    this.thinkingStartTime = null;

    // 侧边栏信息（保留数据，但不显示在状态栏中）
    this.todoStats = { total: 0, completed: 0 };
    this.contextInfo = { used: 0, total: 1000000, percent: 0 };
    this.cacheInfo = { hitRate: 0, cachedTokens: 0, totalTokens: 0 };

    // Info 消息（opencode 风格中间填充区域）
    this.infoMessage = null;
    this._infoMessageTime = 0;

    // 关键:Team 子 Agent 活动临显(M3)
    // 用户能看到"现在 X agent 在思考/输出",1 行临时显示
    // 优先级:主 Agent thinking > teamActivity > infoMessage
    // 3 秒无新事件自动清空(TTL 兜底,正常路径由事件精确驱动)
    this.teamActivity = null; // { name, status, startedAt }
    this._teamActivityTimer = null;
    this.TEAM_ACTIVITY_TTL = 3000;

    // Plan Mode 标识
    this.planMode = false;

    // Team Mode 标识
    this.teamMode = false;
    this.teamAgentCount = 0;
  }

  setPlanMode(enabled) {
    this.planMode = enabled;
  }

  // 设置 Team Mode 状态 + agent 数（供 widget 显示）
  setTeamMode(enabled, agentCount = 0) {
    this.teamMode = !!enabled;
    this.teamAgentCount = agentCount;
  }

  setPendingContext(hasPending) {
    this.hasPendingContext = hasPending;
  }

  setTodoStats(total, completed) {
    this.todoStats = { total: total || 0, completed: completed || 0 };
  }

  setContextInfo(used, total, percent) {
    this.contextInfo = {
      used: used || 0,
      total: total || 1000000,
      percent: percent || 0,
    };
  }

  setCacheInfo(hitRate, cachedTokens, totalTokens) {
    this.cacheInfo = {
      hitRate: hitRate || 0,
      cachedTokens: cachedTokens || 0,
      totalTokens: totalTokens || 0,
    };
  }

  setThinking(thinking) {
    this.isThinking = thinking;
    if (thinking) {
      this.thinkingStartTime = Date.now();
    } else {
      this.thinkingStartTime = null;
    }
  }

  updateTokenUsage(usage) {
    if (usage) {
      this.tokenUsage.roundInput = usage.prompt_tokens || usage.promptTokens || 0;
      this.tokenUsage.roundOutput = usage.completion_tokens || usage.completionTokens || 0;
      this.tokenUsage.roundCacheHit = usage.prompt_cache_hit_tokens || 0;
      this.tokenUsage.totalInput += this.tokenUsage.roundInput;
      this.tokenUsage.totalOutput += this.tokenUsage.roundOutput;
      this.tokenUsage.totalCacheHit = (this.tokenUsage.totalCacheHit || 0) + this.tokenUsage.roundCacheHit;
    }
  }

  setPricing(pricing) {
    this.pricing = pricing;
  }

  setDiagnostics(errors, warnings) {
    this.diagnostics = { errors: errors || 0, warnings: warnings || 0 };
  }

  setInfoMessage(msg, type, ttl) {
    this.infoMessage = { msg, type: type || 'info', ttl: ttl || 10000 };
    this._infoMessageTime = Date.now();
  }

  /**
   * 设置 Team 子 Agent 活动临显(M3)
   * status: 'thinking' | 'streaming' | 'done' | 'failed'
   * 3s TTL 兜底,正常路径由 agent_completed/team_mode_end 事件显式 clear
   */
  setTeamActivity(name, status = 'thinking') {
    this.teamActivity = {
      name: name || 'agent',
      status,
      startedAt: Date.now(),
    };
    // 清除旧 timer
    if (this._teamActivityTimer) {
      clearTimeout(this._teamActivityTimer);
    }
    // TTL 兜底
    this._teamActivityTimer = setTimeout(() => {
      this.teamActivity = null;
    }, this.TEAM_ACTIVITY_TTL);
  }

  /**
   * 清除 Team 活动临显
   */
  clearTeamActivity() {
    this.teamActivity = null;
    if (this._teamActivityTimer) {
      clearTimeout(this._teamActivityTimer);
      this._teamActivityTimer = null;
    }
  }

  /**
   * 渲染 teamActivity 中间填充区内容
   * 格式: "▸ researcher [thinking 1.2s]"
   * 返回 null 表示无活动
   */
  _renderTeamActivity(maxLen) {
    if (!this.teamActivity) {return null;}
    const elapsed = this._getTeamActivityElapsed();
    const label = `▸ ${this.teamActivity.name} [${this.teamActivity.status} ${elapsed}]`;
    if (this._visibleLength(label) > maxLen && maxLen > 3) {
      return label.substring(0, maxLen - 3) + '...';
    }
    return label;
  }

  _getTeamActivityElapsed() {
    if (!this.teamActivity?.startedAt) {return '';}
    const elapsed = Date.now() - this.teamActivity.startedAt;
    if (elapsed < 1000) {return `${elapsed}ms`;}
    if (elapsed < 60000) {return `${(elapsed / 1000).toFixed(1)}s`;}
    return `${Math.floor(elapsed / 60000)}m${Math.floor((elapsed % 60000) / 1000)}s`;
  }

  // 渲染状态栏
  render(model) {
    if (model) {this.model = model;}
    const t = this.theme;
    const { statusBarRow, _width } = this.layout;

    let output = `\x1b[${statusBarRow};1H\x1b[2K`;

    // ─── Help Widget ───
    // bg=TextMuted(#6a6a6a), fg=BackgroundDarker(#121212), bold
    const helpText = 'ctrl+? help';
    const helpWidget = chalk.bgHex(t.colors.textMuted).hex(t.colors.backgroundDarker).bold(` ${helpText} `);

    // ─── Thinking Indicator ───
    let thinkingWidget = '';
    if (this.isThinking) {
      const elapsed = this._getElapsedTime();
      thinkingWidget = chalk.bgHex(t.colors.warning).hex(t.colors.background).bold(` thinking ${elapsed} `);
    }

    // ─── Plan Mode Indicator ───
    let planModeWidget = '';
    if (this.planMode) {
      planModeWidget = chalk.bgHex(t.colors.primary).hex(t.colors.background).bold(' ⎔ Plan Mode ');
    }

    // ─── Team Mode Indicator ───
    let teamModeWidget = '';
    let teamModeWidth = 0;
    if (this.teamMode) {
      const label = this.teamAgentCount > 0
        ? ` ⫼ Team (${this.teamAgentCount}) `
        : ' ⫼ Team ';
      teamModeWidget = chalk.bgHex(t.colors.secondary).hex(t.colors.background).bold(label);
      teamModeWidth = this._visibleLength(teamModeWidget);
    }

    // ─── Cost Widget ───
    let tokenWidget = '';
    let tokenWidgetWidth = 0;
    const { totalInput, totalOutput, totalCacheHit } = this.tokenUsage;

    if (this.pricing) {
      const cost = calculateCost(
        totalInput - totalCacheHit,
        totalCacheHit,
        totalOutput,
        this.pricing
      );
      if (cost > 0) {
        const costText = `Cost: ¥${cost.toFixed(2)} `;
        tokenWidget = chalk.bgHex(t.colors.text).hex(t.colors.backgroundSecondary)(costText);
        tokenWidgetWidth = this._visibleLength(tokenWidget);
      }
    }

    // ─── Diagnostics ───
    const { errors, warnings } = this.diagnostics;
    let diagWidget = '';
    let diagWidth = 0;
    if (errors > 0 || warnings > 0) {
      const diagParts = [];
      if (errors > 0) {
        diagParts.push(chalk.hex(t.colors.error)(`[错误] ${errors}`));
      }
      if (warnings > 0) {
        diagParts.push(chalk.hex(t.colors.warning)(`[警告] ${warnings}`));
      }
      const diagInner = diagParts.join(' ');
      diagWidget = chalk.bgHex(t.colors.backgroundDarker)(` ${diagInner} `);
      diagWidth = this._visibleLength(diagWidget);
    }

    // ─── Model Widget ───
    let modelWidget = '';
    let modelWidth = 0;
    if (this.model) {
      modelWidget = chalk.bgHex(t.colors.secondary).hex(t.colors.background).bold(` ${this.model} `);
      modelWidth = this._visibleLength(modelWidget);
    }

    // ─── 计算中间 Info 消息区域宽度 ───
    const thinkingWidth = this._visibleLength(thinkingWidget);
    const planModeWidth = this._visibleLength(planModeWidget);
    const usedWidth = this._visibleLength(helpWidget) + thinkingWidth + planModeWidth + teamModeWidth + tokenWidgetWidth + 1 + diagWidth + modelWidth;
    const availableWidth = Math.max(0, _width - usedWidth);

    // ─── 组装状态栏 ───
    let statusBar = helpWidget;
    if (thinkingWidget) {statusBar += thinkingWidget;}
    statusBar += planModeWidget;
    statusBar += teamModeWidget;
    statusBar += tokenWidget;

    // Info 消息区域（opencode 风格，填充剩余宽度）
    if (availableWidth > 3) {
      // 优先级:主 Agent thinking > teamActivity > infoMessage
      // teamActivity 是用户主动关心的事件(子 Agent 活动),优先级高于系统 info
      const teamActivityText = this._renderTeamActivity(availableWidth - 4);
      if (teamActivityText) {
        // teamActivity 用 info 蓝底色 + 加粗,提示"子 Agent 正在干活"
        const padLen = Math.max(0, availableWidth - this._visibleLength(teamActivityText) - 2);
        statusBar += chalk.bgHex(t.colors.info).hex(t.colors.background).bold(` ${teamActivityText}${' '.repeat(padLen)} `);
      } else {
        // 检查是否有 info 消息（10s TTL）
        const hasValidInfo = this.infoMessage && (Date.now() - this._infoMessageTime < (this.infoMessage.ttl || 10000));
        if (hasValidInfo && this.infoMessage.msg) {
          let infoBg = t.colors.info;
          if (this.infoMessage.type === 'warn') {infoBg = t.colors.warning;}
          if (this.infoMessage.type === 'error') {infoBg = t.colors.error;}
          // 截断消息到可用宽度
          let msg = this.infoMessage.msg;
          const maxMsgLen = availableWidth - 4; // 留边距
          if (this._visibleLength(msg) > maxMsgLen && maxMsgLen > 3) {
            msg = msg.substring(0, maxMsgLen - 3) + '...';
          }
          statusBar += chalk.bgHex(infoBg).hex(t.colors.background)(` ${msg}${' '.repeat(Math.max(0, availableWidth - this._visibleLength(msg) - 2))} `);
        } else {
          // 填充空白
          statusBar += chalk.bgHex(t.colors.backgroundSecondary).hex(t.colors.text)(' '.repeat(availableWidth));
        }
      }
    }

    statusBar += diagWidget;
    statusBar += modelWidget;

    output += statusBar;
    return output;
  }

  resetTokenUsage() {
    this.tokenUsage = {
      roundInput: 0,
      roundOutput: 0,
      roundCacheHit: 0,
      totalInput: 0,
      totalOutput: 0,
      totalCacheHit: 0,
    };
  }

  // 获取已经过的时间
  _getElapsedTime() {
    if (!this.thinkingStartTime) {return '';}
    const elapsed = Date.now() - this.thinkingStartTime;
    if (elapsed < 1000) {return `${elapsed}ms`;}
    if (elapsed < 60000) {return `${(elapsed / 1000).toFixed(1)}s`;}
    return `${Math.floor(elapsed / 60000)}m${Math.floor((elapsed % 60000) / 1000)}s`;
  }

  _visibleLength(str) {
    return visibleLength(str);
  }
}

module.exports = StatusBar;

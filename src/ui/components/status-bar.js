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

    // Plan Mode 标识
    this.planMode = false;
  }

  /**
   * 设置 Plan Mode 状态
   */
  setPlanMode(enabled) {
    this.planMode = enabled;
  }

  /**
   * 设置待注入上下文状态
   */
  setPendingContext(hasPending) {
    this.hasPendingContext = hasPending;
  }

  /**
   * 设置 Todo 统计
   */
  setTodoStats(total, completed) {
    this.todoStats = { total: total || 0, completed: completed || 0 };
  }

  /**
   * 设置上下文信息
   */
  setContextInfo(used, total, percent) {
    this.contextInfo = {
      used: used || 0,
      total: total || 1000000,
      percent: percent || 0,
    };
  }

  /**
   * 设置缓存信息
   */
  setCacheInfo(hitRate, cachedTokens, totalTokens) {
    this.cacheInfo = {
      hitRate: hitRate || 0,
      cachedTokens: cachedTokens || 0,
      totalTokens: totalTokens || 0,
    };
  }

  /**
   * 设置思考状态
   */
  setThinking(thinking) {
    this.isThinking = thinking;
    if (thinking) {
      this.thinkingStartTime = Date.now();
    } else {
      this.thinkingStartTime = null;
    }
  }

  /**
   * 更新 token 使用情况
   */
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

  /**
   * 设置定价信息
   */
  setPricing(pricing) {
    this.pricing = pricing;
  }

  /**
   * 设置诊断信息
   */
  setDiagnostics(errors, warnings) {
    this.diagnostics = { errors: errors || 0, warnings: warnings || 0 };
  }

  /**
   * 设置信息消息（opencode 风格 info message 区域）
   */
  setInfoMessage(msg, type, ttl) {
    this.infoMessage = { msg, type: type || 'info', ttl: ttl || 10000 };
    this._infoMessageTime = Date.now();
  }

  /**
   * 移除格式后缀（如 ".0K" → "K", ".0M" → "M"）
   */
  _cleanTokenSuffix(str) {
    return str.replace('.0K', 'K').replace('.0M', 'M');
  }

  /**
   * 渲染状态栏（1:1 复刻 opencode status.go）
   *
   * 布局:
   * [ctrl+? help] [Context: 110K(85%), Cost: ¥0.50] [Info Msg...] [✖ N ⚠ N] [ModelName]
   */
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
      thinkingWidget = chalk.bgHex(t.colors.warning).hex(t.colors.background).bold(` ✦ thinking ${elapsed} `);
    }

    // ─── Plan Mode Indicator ───
    let planModeWidget = '';
    if (this.planMode) {
      planModeWidget = chalk.bgHex(t.colors.primary).hex(t.colors.background).bold(' ⎔ Plan Mode ');
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
        diagParts.push(chalk.hex(t.colors.error)(`✖ ${errors}`));
      }
      if (warnings > 0) {
        diagParts.push(chalk.hex(t.colors.warning)(`⚠ ${warnings}`));
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
    const usedWidth = this._visibleLength(helpWidget) + thinkingWidth + planModeWidth + tokenWidgetWidth + 1 + diagWidth + modelWidth;
    const availableWidth = Math.max(0, _width - usedWidth);

    // ─── 组装状态栏 ───
    let statusBar = helpWidget;
    if (thinkingWidget) {statusBar += thinkingWidget;}
    statusBar += planModeWidget;
    statusBar += tokenWidget;

    // Info 消息区域（opencode 风格，填充剩余宽度）
    if (availableWidth > 3) {
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

    statusBar += diagWidget;
    statusBar += modelWidget;

    output += statusBar;
    return output;
  }

  /**
   * 重置 token 统计
   */
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

  /**
   * 获取已经过的时间
   */
  _getElapsedTime() {
    if (!this.thinkingStartTime) {return '';}
    const elapsed = Date.now() - this.thinkingStartTime;
    if (elapsed < 1000) {return `${elapsed}ms`;}
    if (elapsed < 60000) {return `${(elapsed / 1000).toFixed(1)}s`;}
    return `${Math.floor(elapsed / 60000)}m${Math.floor((elapsed % 60000) / 1000)}s`;
  }

  /**
   * 格式化 token 数为人类可读格式
   */
  _formatTokens(count) {
    if (count >= 1000000) {return (count / 1000000).toFixed(1) + 'M';}
    if (count >= 1000) {return (count / 1000).toFixed(1) + 'K';}
    return String(count);
  }

  /**
   * 计算字符串的可见长度（使用 ANSI_PATTERN 正则完整匹配）
   */
  _visibleLength(str) {
    return visibleLength(str);
  }
}

module.exports = StatusBar;

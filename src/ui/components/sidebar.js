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

    // 上下文信息
    this.contextManager = null;
    this.messages = [];
    this.chatEngine = null;

    // 缓存统计
    this.cacheStats = {
      totalRequests: 0,
      cacheHits: 0,
      totalInputTokens: 0,
      cachedTokens: 0,
    };

    // Todo 状态
    this.todos = [];

    // 增量渲染缓存
    this._lastRenderedContent = [];
  }

  setChatEngine(chatEngine) {
    this.chatEngine = chatEngine;
    if (chatEngine) {
      this.contextManager = chatEngine.contextManager;
      this.messages = chatEngine.messages || [];
    }
  }

  updateMessages(messages) {
    this.messages = messages || [];
  }

  updateCacheStats(usage) {
    if (usage) {
      this.cacheStats.totalRequests++;
      this.cacheStats.totalInputTokens += usage.prompt_tokens || usage.promptTokens || 0;
      const cached = usage.prompt_cache_hit_tokens || 0;
      this.cacheStats.cachedTokens += cached;
      if (cached > 0) {
        this.cacheStats.cacheHits++;
      }
    }
  }

  setTodos(todos) {
    this.todos = todos || [];
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
   * 将 hex 颜色转换为 ANSI 256 色码
   * @param {string} hex - hex 颜色值如 "#fab283"
   * @returns {number} ANSI 256 色码
   */
  _hexToAnsi256(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!result) {return 0;}

    const r = parseInt(result[1], 16);
    const g = parseInt(result[2], 16);
    const b = parseInt(result[3], 16);

    // 简化的 RGB 转 256 色算法
    if (r === g && g === b) {
      // 灰度
      if (r < 8) {return 16;}
      if (r > 248) {return 231;}
      return Math.round((r - 8) / 10) + 232;
    }

    return 16 + Math.round(r / 51) * 36 + Math.round(g / 51) * 6 + Math.round(b / 51);
  }

  /**
   * 判断是否为 CJK 双倍宽字符
   */
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

  /**
   * 渲染侧边栏（双缓冲模式，减少闪烁）
   * 将所有输出合并为一次 write 调用
   */
  render() {
    const { messageStartRow, contentHeight, sidebarWidth, messageWidth } = this.layout;
    const viewportHeight = contentHeight;

    // 构建完整输出字符串
    let output = '';

    for (let i = 0; i < viewportHeight; i++) {
      const row = messageStartRow + i;
      const col = messageWidth + 1;
      const line = this._renderLine(i, sidebarWidth - 1);

      if (line) {
        const truncated = this._truncateToWidth(line, sidebarWidth - 1);
        output += `\x1b[${row};${col}H\x1b[K${truncated}`;
      } else {
        output += `\x1b[${row};${col}H\x1b[K`;
      }
    }

    // 一次性输出
    process.stdout.write(output);
  }

  /**
   * 渲染单行内容
   */
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
          const status = todo.completed ? t.success('✔') : t.textMuted('◻');
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

    // ─── 上下文状况区 ───
    if (lineIndex === line) {
      return ` ${t.textMuted('Context')}`;
    }
    line++;

    // 进度条
    if (lineIndex === line) {
      const contextInfo = this._getContextInfo();
      const progressBar = this._renderProgressBar(contextInfo.percent, width - 4);
      const percentText = `${contextInfo.percent}%`;
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

  /**
   * 获取上下文信息
   */
  _getContextInfo() {
    const defaultInfo = {
      used: 0,
      total: 1000000,
      percent: 0,
      compressionLevel: 0,
      compressionLabel: '',
    };

    if (!this.contextManager) {return defaultInfo;}

    try {
      const status = this.contextManager.getStatusReport(this.messages);
      return {
        used: status.currentTokens || 0,
        total: status.windowSize || 1000000,
        percent: status.usagePercent || 0,
        compressionLevel: status.compressionLevel || 0,
        compressionLabel: status.compressionLabel || '',
      };
    } catch {
      return defaultInfo;
    }
  }

  /**
   * 获取注入的文件列表
   */
  _getInjectedFiles() {
    if (!this.contextManager) {return [];}

    try {
      const fileContexts = this.contextManager._fileContexts;
      if (!fileContexts) {return [];}

      return [...fileContexts.keys()].map(key => {
        // key 可能是 "file.js:0:100" 格式
        const parts = key.split(':');
        return parts[0];
      });
    } catch {
      return [];
    }
  }

  /**
   * 获取上下文各层 Token 明细
   * @returns {{ systemPrompt: number, projectOverview: number, fileContexts: Array, totalFileTokens: number }}
   */
  _getContextBreakdown() {
    if (!this.contextManager) {return { systemPrompt: 0, projectOverview: 0, fileContexts: [], totalFileTokens: 0 };}
    try {
      return this.contextManager.getContextBreakdown(this.messages);
    } catch {
      return { systemPrompt: 0, projectOverview: 0, fileContexts: [], totalFileTokens: 0 };
    }
  }

  /**
   * 获取缓存信息
   */
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

  /**
   * 渲染进度条
   */
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

  /**
   * 格式化 token 数
   */
  _formatTokens(count) {
    if (count >= 1000000) {return (count / 1000000).toFixed(1) + 'M';}
    if (count >= 1000) {return (count / 1000).toFixed(1) + 'K';}
    return String(count);
  }

  /**
   * 获取 Todo 统计摘要
   */
  _getTodoStats() {
    const total = this.todos.length;
    if (total === 0) {return '';}
    const completed = this.todos.filter(t => t.completed).length;
    return `(${completed}/${total})`;
  }

  /**
   * 从扁平文件路径构建目录树渲染行
   * @param {string[]} files - 文件路径数组
   * @param {number} width - 可用宽度
   * @returns {string[]} 渲染后的行数组
   */
  _buildFileTree(files, width) {
    if (files.length === 0) {return [];}

    // 构建树结构（嵌套对象，null 表示文件，{} 表示目录）
    const tree = {};
    for (const file of files) {
      const parts = file.replace(/\\/g, '/').split('/');
      let node = tree;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (i === parts.length - 1) {
          // 最后一段是文件名
          node[part] = null;
        } else {
          // 中间段是目录
          if (!node[part] || node[part] === null) {
            node[part] = {};
          }
          node = node[part];
        }
      }
    }

    // 递归渲染树
    const lines = [];
    const renderNode = (node, prefix) => {
      // 排序：目录在前，文件在后，同类型按字母排序
      const entries = Object.entries(node).sort(([aName, aChild], [bName, bChild]) => {
        const aIsDir = aChild !== null;
        const bIsDir = bChild !== null;
        if (aIsDir && !bIsDir) {return -1;}
        if (!aIsDir && bIsDir) {return 1;}
        return aName.localeCompare(bName);
      });
      entries.forEach(([name, child], index) => {
        const isLastEntry = index === entries.length - 1;
        const connector = isLastEntry ? '└── ' : '├── ';
        const childPrefix = isLastEntry ? '    ' : '│   ';

        // 截断过长的文件名
        const maxNameLen = width - prefix.length - 4;
        const displayName = name.length > maxNameLen
          ? name.substring(0, maxNameLen - 3) + '...'
          : name;

        if (child === null) {
          // 文件
          lines.push(`${prefix}${connector}${displayName}`);
        } else {
          // 目录
          lines.push(`${prefix}${connector}${displayName}/`);
          renderNode(child, prefix + childPrefix);
        }
      });
    };

    renderNode(tree, '');
    return lines;
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

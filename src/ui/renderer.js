'use strict';

const { EventEmitter } = require('events');
const chalk = require('chalk');
const Spinner = require('./spinner');
const MarkdownRenderer = require('./markdown');
const { getTheme } = require('./theme');
const { calculateCost } = require('./tokens');

const TOOL_NAME_MAP = {
  read_file: 'View',
  write_file: 'Write',
  edit_file: 'Edit',
  delete_file: 'Delete',
  create_directory: 'Mkdir',
  list_directory: 'List',
  glob_files: 'Glob',
  search_in_files: 'Grep',
  move_file: 'Move',
  execute_command: 'Bash',
  get_document_symbols: 'Symbols',
  find_definition: 'Definition',
  find_references: 'References',
  get_hover_info: 'Hover',
  analyze_dependencies: 'Deps',
  format_code: 'Format',
};

class AnvilRenderer extends EventEmitter {
  constructor(config) {
    super();
    this.config = config || {};
    this.theme = getTheme();
    this.spinner = new Spinner();
    this.markdown = new MarkdownRenderer();
    this.tokenUsage = { roundInput: 0, roundOutput: 0, totalInput: 0, totalOutput: 0, roundCacheHit: 0, totalCacheHit: 0 };
    this.inThinking = false;
    this.inResponse = false;
    this._width = process.stdout.columns || 80;
    this._height = process.stdout.rows || 24;
    this._pendingUsage = null;
    this._startTime = null;
    this._thinkingBuffer = '';
    this._isAltScreen = false;

    // 布局行号（1-based）
    this._messageStartRow = 1;
    this._currentRow = 1;
    this._updateLayout();
  }

  _updateLayout() {
    this._width = process.stdout.columns || 80;
    this._height = process.stdout.rows || 24;
    // 消息区: 1 ~ height-2, 输入区: height-1, 状态栏: height
    this._messageEndRow = this._height - 2;
    this._inputRow = this._height - 1;
    this._statusRow = this._height;
  }

  // ─── Alt Screen 管理 ───

  enterAltScreen() {
    if (this._isAltScreen) {return;}
    this._isAltScreen = true;
    process.stdout.write('\x1b[?1049h'); // 进入 alt screen
    process.stdout.write('\x1b[2J');      // 清屏
    process.stdout.write('\x1b[?25l');    // 隐藏光标
    this._currentRow = 1;
    this._updateLayout();

    // 监听 resize
    this._onResize = () => {
      this._updateLayout();
      this._fullRedraw();
    };
    process.stdout.on('resize', this._onResize);
  }

  leaveAltScreen() {
    if (!this._isAltScreen) {return;}
    this._isAltScreen = false;
    process.stdout.write('\x1b[?25h');    // 显示光标
    process.stdout.write('\x1b[?1049l');  // 退出 alt screen
    if (this._onResize) {
      process.stdout.removeListener('resize', this._onResize);
    }
  }

  // ─── 光标定位工具 ───

  _moveTo(row, col) {
    process.stdout.write(`\x1b[${row};${col || 1}H`);
  }

  _clearLine() {
    process.stdout.write('\x1b[2K');
  }

  _hideCursor() {
    process.stdout.write('\x1b[?25l');
  }

  _showCursor() {
    process.stdout.write('\x1b[?25h');
  }

  /**
   * 在消息区输出一行，自动滚动
   */
  _writeLine(line) {
    if (this._currentRow > this._messageEndRow) {
      // 滚动：删除消息区第一行
      this._moveTo(this._messageStartRow);
      process.stdout.write('\x1b[1M');
      this._currentRow = this._messageEndRow;
    }
    this._moveTo(this._currentRow);
    this._clearLine();
    process.stdout.write(line);
    this._currentRow++;
  }

  /**
   * 清空消息区并重绘（用于 resize）
   */
  _fullRedraw() {
    this._hideCursor();
    // 清屏
    process.stdout.write('\x1b[2J');
    this._currentRow = 1;
    // 重绘输入提示和状态栏
    this.renderInputPrompt();
    this.renderStatusBar(this._currentModel);
    this._showCursor();
  }

  // ─── 渲染方法 ───

  renderHeader(model) {
    this._currentModel = model;
    const t = this.theme;
    const icon = t.primary('⚒');
    const ver = t.textMuted('Anvil v0.1.0-alpha');
    const modelName = t.secondary(model || 'deepseek-v4-flash');
    const help = t.textMuted('Ctrl+D 退出 · /help 帮助');

    this._writeLine('');
    this._writeLine(`  ${icon}  ${ver}  ${chalk.dim('│')}  ${modelName}  ${chalk.dim('│')}  ${help}`);
    this._writeLine('');
  }

  renderUserMessage(content) {
    const t = this.theme;
    const marker = t.secondary('●');
    const lines = content.split('\n');

    this._writeLine('');
    for (const line of lines) {
      this._writeLine(`${marker} ${line}`);
    }
    this._writeLine('');
  }

  renderThinkingStart() {
    this.inThinking = true;
    this._hasThinkingContent = false;
    this._startTime = Date.now();
    this._thinkingBuffer = '';
    // 定位光标到消息区，spinner 在此处显示
    this._moveTo(this._currentRow);
    // 启动闪烁 spinner
    this.spinner.start('Thinking...');
  }

  renderThinkingChunk(chunk) {
    if (!this.inThinking) {return;}
    this._hasThinkingContent = true;
    this._thinkingBuffer += chunk;

    // 按行输出完整行
    const lines = this._thinkingBuffer.split('\n');
    this._thinkingBuffer = lines.pop() || '';

    const t = this.theme;
    const marker = t.textMuted('●');
    for (const line of lines) {
      if (line) {
        this._writeLine(`${marker} ${t.thinking(line)}`);
      }
    }
  }

  renderContentStart() {
    this.spinner.stop();  // 停止闪烁
    this.inThinking = false;
    this.inResponse = true;

    // 输出剩余思考缓冲
    if (this._thinkingBuffer) {
      const t = this.theme;
      const marker = t.textMuted('●');
      this._writeLine(`${marker} ${t.thinking(this._thinkingBuffer)}`);
      this._thinkingBuffer = '';
    }
    if (this._hasThinkingContent) {
      this._writeLine('');
    }
  }

  renderContentChunk(chunk) {
    const t = this.theme;
    const marker = t.primary('●');
    const rendered = this.markdown.write(chunk);
    if (rendered) {
      const lines = rendered.split('\n');
      for (const line of lines) {
        if (line) {
          this._writeLine(`${marker} ${line}`);
        }
      }
    }
  }

  renderToolCall(toolCalls) {
    const t = this.theme;
    const calls = Array.isArray(toolCalls) ? toolCalls : [toolCalls];
    const marker = t.primary('●');

    for (const call of calls) {
      let args = {};
      try {
        args = typeof call.function?.arguments === 'string'
          ? JSON.parse(call.function.arguments)
          : (call.function?.arguments || {});
      } catch { args = {}; }

      const rawName = call.function?.name || call.type || 'unknown';
      const displayName = TOOL_NAME_MAP[rawName] || rawName;
      let params = '';

      switch (rawName) {
        case 'read_file': case 'write_file': case 'edit_file': case 'delete_file':
          params = args.filePath || ''; break;
        case 'create_directory': params = args.path || ''; break;
        case 'list_directory': params = args.dirPath || '.'; break;
        case 'glob_files': case 'search_in_files': params = args.pattern || ''; break;
        case 'move_file': params = `${args.source || ''} → ${args.destination || ''}`; break;
        case 'execute_command': params = (args.command || '').split('\n')[0]; break;
        default: params = JSON.stringify(args).substring(0, 80);
      }
      if (params.length > 60) {params = params.substring(0, 57) + '...';}

      this._writeLine(`${marker} ${t.textMuted(displayName + ':')} ${params}`);
    }
  }

  renderToolResult(name, result) {
    if (!result) {return;}
    const t = this.theme;
    const marker = t.primary('●');

    if (result.error) {
      this._writeLine(`${marker} ${t.error('Error:')} ${result.error}`);
    } else if (result.success) {
      if (result.filePath) {
        this._writeLine(`${marker} ${t.success('✓')} ${result.filePath}`);
      } else if (result.output) {
        const lines = result.output.split('\n').slice(0, 10);
        for (const line of lines) {this._writeLine(`${marker} ${t.textMuted(line)}`);}
        if (result.output.split('\n').length > 10) {this._writeLine(`${marker} ${t.textMuted('...')}`);}
      }
    }
  }

  renderCommandOutput(data, isError) {
    const t = this.theme;
    const marker = t.primary('●');
    this._writeLine(`${marker} ${isError ? t.error(data) : data}`);
  }

  renderTokenUsage(usage, pricing) {
    if (usage) {
      this.tokenUsage.roundInput = usage.prompt_tokens || usage.promptTokens || 0;
      this.tokenUsage.roundOutput = usage.completion_tokens || usage.completionTokens || 0;
      this.tokenUsage.roundCacheHit = usage.prompt_cache_hit_tokens || 0;
      this.tokenUsage.totalInput += this.tokenUsage.roundInput;
      this.tokenUsage.totalOutput += this.tokenUsage.roundOutput;
      this.tokenUsage.totalCacheHit = (this.tokenUsage.totalCacheHit || 0) + this.tokenUsage.roundCacheHit;
    }
    this._pendingUsage = { usage, pricing };
  }

  flushTokenUsage(model) {
    const t = this.theme;
    const marker = t.primary('●');

    const elapsed = this._startTime ? ((Date.now() - this._startTime) / 1000).toFixed(1) + 's' : '';
    const modelName = model || this.config.defaultModel || '';
    const info = elapsed ? `${modelName} (${elapsed})` : modelName;
    if (info) {this._writeLine(`${marker} ${t.textMuted(info)}`);}

    if (this._pendingUsage) {
      const { pricing } = this._pendingUsage;
      const { roundInput, roundOutput, roundCacheHit } = this.tokenUsage;
      const totalTokens = roundInput + roundOutput;

      let cost = 0;
      if (pricing) {
        cost = calculateCost(roundInput - roundCacheHit, roundCacheHit, roundOutput, pricing);
      }

      let stats = `${t.token(totalTokens.toLocaleString())} tokens`;
      if (roundCacheHit > 0) {
        const hitRate = Math.round((roundCacheHit / roundInput) * 100);
        stats += ` ${chalk.dim('·')} ${t.textMuted('💾')} ${t.token(roundCacheHit.toLocaleString())} cached (${hitRate}%)`;
      }
      if (cost > 0) {stats += ` ${chalk.dim('·')} ${t.accent('¥' + cost.toFixed(4))}`;}

      this._writeLine(`${marker} ${t.textMuted('📊')} ${stats}`);
    }

    this._writeLine('');
    this._pendingUsage = null;
  }

  /**
   * 渲染输入提示（固定在底部）
   */
  renderInputPrompt() {
    const t = this.theme;
    this._moveTo(this._inputRow);
    this._clearLine();
    process.stdout.write(t.accent('> '));
  }

  renderStatusBar(model) {
    const t = this.theme;
    this._moveTo(this._statusRow);
    this._clearLine();

    const help = t.textMuted('[ctrl+?] help');
    const sep = chalk.dim(' │ ');

    const { totalInput, totalOutput, totalCacheHit } = this.tokenUsage;
    const totalTokens = totalInput + totalOutput;
    let tokenInfo = '';
    if (totalTokens > 0) {
      const formatted = totalTokens >= 1000000
        ? (totalTokens / 1000000).toFixed(1) + 'M'
        : totalTokens >= 1000
          ? (totalTokens / 1000).toFixed(1) + 'K'
          : String(totalTokens);
      tokenInfo = `${t.textMuted('Context:')} ${t.token(formatted)}`;
      if (this._pendingUsage?.pricing) {
        const cost = calculateCost(totalInput - totalCacheHit, totalCacheHit, totalOutput, this._pendingUsage.pricing);
        if (cost > 0) {tokenInfo += `, ${t.textMuted('Cost:')} ${t.accent('¥' + cost.toFixed(2))}`;}
      }
    }

    const modelName = model || this.config.defaultModel || '';
    const modelWidget = modelName ? ` ${t.secondary(modelName)} ` : '';

    let statusLine = help;
    if (tokenInfo) {statusLine += sep + tokenInfo;}
    statusLine += sep + modelWidget;
    process.stdout.write(statusLine);
  }

  renderError(message, error) {
    this.spinner.stop();  // 停止闪烁
    const t = this.theme;
    this._writeLine('');
    this._writeLine(`${t.error('✖')} ${message}`);
    if (error) {this._writeLine(chalk.dim(`  ${error.message || error}`));}
  }

  renderStatus(msg) {
    const t = this.theme;
    this._writeLine(`${t.primary('●')} ${t.textMuted(msg)}`);
  }

  renderInterrupted() {
    const t = this.theme;
    this._writeLine(`${t.primary('●')} ${t.textMuted('⏹ 已中断')}`);
  }

  reset() {
    this.spinner.stop();  // 停止闪烁
    this.inThinking = false;
    this.inResponse = false;
    this._hasThinkingContent = false;
    this._startTime = null;
    this._thinkingBuffer = '';
    this.markdown = new MarkdownRenderer();
  }

  resetTokenUsage() {
    this.tokenUsage = { roundInput: 0, roundOutput: 0, totalInput: 0, totalOutput: 0, roundCacheHit: 0, totalCacheHit: 0 };
  }
}

module.exports = AnvilRenderer;

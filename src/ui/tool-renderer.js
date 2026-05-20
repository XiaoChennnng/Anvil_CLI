'use strict';

const chalk = require('chalk');
const { getTheme } = require('./theme');
const { parseUnifiedDiff } = require('./diff');

const TOOL_NAME_MAP = {
  bash: 'Bash',
  edit: 'Update',
  view: 'View',
  write: 'Write',
  glob: 'Glob',
  grep: 'Grep',
  ls: 'List',
  fetch: 'Fetch',
  patch: 'Patch',
  task: 'Task',
  execute_command: 'Bash',
  read_file: 'View',
  write_file: 'Write',
  edit_file: 'Update',
  delete_file: 'Delete',
  create_directory: 'Mkdir',
  list_directory: 'List',
  glob_files: 'Glob',
  search_in_files: 'Grep',
  move_file: 'Move',
  get_document_symbols: 'Symbols',
  find_definition: 'Definition',
  find_references: 'References',
  get_hover_info: 'Hover',
  analyze_dependencies: 'Deps',
  format_code: 'Format',
  // Todo 工具
  add_todo: 'Todo',
  complete_todo: 'Todo',
  remove_todo: 'Todo',
  list_todos: 'Todo',
  clear_completed_todos: 'Todo',
};

// 工具执行状态文本
const TOOL_ACTION_MAP = {
  bash: 'Building command...',
  edit: 'Preparing edit...',
  view: 'Reading file...',
  write: 'Preparing write...',
  glob: 'Finding files...',
  grep: 'Searching content...',
  ls: 'Listing directory...',
  fetch: 'Writing fetch...',
  patch: 'Preparing patch...',
  task: 'Preparing prompt...',
  execute_command: 'Building command...',
  read_file: 'Reading file...',
  write_file: 'Preparing write...',
  edit_file: 'Preparing edit...',
  delete_file: 'Deleting file...',
  create_directory: 'Creating directory...',
  move_file: 'Moving file...',
  format_code: 'Formatting code...',
};

class ToolRenderer {
  constructor(theme) {
    this.theme = theme || getTheme();
  }

  /**
   * 获取工具显示名称
   * @param {string} name - 原始工具名
   * @returns {string}
   */
  getToolName(name) {
    return TOOL_NAME_MAP[name] || name;
  }

  /**
   * 获取工具执行状态文本
   * @param {string} name - 工具名
   * @returns {string}
   */
  getToolAction(name) {
    return TOOL_ACTION_MAP[name] || 'Processing...';
  }

  /**
   * 渲染工具调用行（单行，opencode 风格）
   * 格式: ● View: path=src/index.js
   * @param {Object} toolCall - 工具调用对象
   * @param {number} width - 可用宽度
   * @param {boolean} nested - 是否嵌套
   * @param {boolean} withMarker - 是否显示 ● 前缀，默认 true
   * @returns {string[]} 渲染后的行数组
   */
  renderToolCall(toolCall, width, nested = false, withMarker = true) {
    const t = this.theme;
    const result = [];

    const rawName = toolCall.function?.name || toolCall.type || 'unknown';
    const displayName = this.getToolName(rawName);

    // 解析参数
    let args = {};
    try {
      args = typeof toolCall.function?.arguments === 'string'
        ? JSON.parse(toolCall.function.arguments)
        : (toolCall.function?.arguments || {});
    } catch { args = {}; }

    // 可用宽度（减去边框和空格）
    const availableWidth = width - 4;
    const namePart = displayName;
    const namePartLen = namePart.length;
    const remainingWidth = availableWidth - namePartLen - 1; // -1 for space

    // read_file/view 不需要特殊处理，使用通用渲染
    // 渲染参数
    const paramsStr = this._renderParams(rawName, args, remainingWidth);

    // 组装行: ● ToolName(params)
    const marker = withMarker ? chalk.hex(t.colors.primary)('●') : '';
    const nameStyle = chalk.hex(t.colors.primary)(namePart);
    const paramsStyled = paramsStr ? ` ${t.dim(paramsStr)}` : '';
    const content = `${nameStyle}${paramsStyled}`;

    if (nested) {
      const prefix = chalk.hex(t.colors.primary)('└ ');
      result.push(`${prefix}${content}`);
    } else if (withMarker) {
      result.push(`${marker} ${content}`);
    } else {
      result.push(content);
    }

    return result;
  }

  /**
   * 渲染工具参数
   * @param {string} name - 工具名
   * @param {Object} args - 参数对象
   * @param {number} maxWidth - 最大宽度
   * @returns {string}
   */
  _renderParams(name, args, maxWidth) {
    let mainParam = '';
    const subParams = [];

    switch (name) {
      case 'execute_command':
      case 'bash':
        mainParam = this._truncate(this._escape(args.command || '').replace(/\n/g, ' '), Math.min(50, maxWidth));
        if (args.cwd) {subParams.push(`cwd=${this._escape(args.cwd)}`);}
        break;

      case 'read_file':
      case 'view':
        mainParam = this._formatPath(args.filePath || '');
        if (args.offset) {subParams.push(`offset=${args.offset}`);}
        if (args.limit) {subParams.push(`limit=${args.limit}`);}
        break;

      case 'write_file':
      case 'write':
        mainParam = this._formatPath(args.filePath || '');
        if (args.mode) {subParams.push(`mode=${args.mode}`);}
        break;

      case 'edit_file':
      case 'edit':
        mainParam = this._formatPath(args.filePath || '');
        // 原子编辑：只显示文件名，具体变更在 diff 结果中展示
        break;

      case 'delete_file':
      case 'delete':
        mainParam = this._formatPath(args.filePath || '');
        break;

      case 'create_directory':
      case 'mkdir':
        mainParam = this._formatPath(args.path || '');
        break;

      case 'list_directory':
      case 'ls':
        mainParam = this._formatPath(args.dirPath || args.path || '.');
        if (args.recursive) {subParams.push('recursive');}
        break;

      case 'glob_files':
      case 'glob':
        mainParam = this._escape(args.pattern || '');
        if (args.path) {subParams.push(`path=${this._formatPath(args.path)}`);}
        break;

      case 'search_in_files':
      case 'grep':
        mainParam = this._escape(args.pattern || '');
        if (args.path) {subParams.push(`path=${this._formatPath(args.path)}`);}
        if (args.include) {subParams.push(`include=${args.include}`);}
        if (args.literal) {subParams.push('literal');}
        break;

      case 'move_file':
        mainParam = `${this._formatPath(args.source || '')} → ${this._formatPath(args.destination || '')}`;
        break;

      case 'fetch':
        mainParam = this._truncate(args.url || '', 50);
        if (args.format) {subParams.push(`format=${args.format}`);}
        break;

      // Todo 工具
      case 'add_todo':
      case 'complete_todo':
      case 'remove_todo':
        if (args.text) {
          mainParam = this._truncate(`"${args.text}"`, 40);
        }
        if (args.id) {subParams.push(`id=${args.id}`);}
        if (args.priority) {subParams.push(`priority=${args.priority}`);}
        break;

      case 'list_todos':
        if (args.filter) {subParams.push(`filter=${args.filter}`);}
        mainParam = subParams.length > 0 ? '' : 'all';
        break;

      case 'ask_user_question': {
        const qs = args.questions || [];
        if (qs.length === 1) {
          mainParam = `"${this._truncate(qs[0].question || '', 40)}"`;
        } else {
          mainParam = `${qs.length} questions`;
          subParams.push(...qs.map(q => q.header));
        }
        break;
      }

      case 'request_plan_approval':
        mainParam = this._truncate(args.summary || '', 50);
        if (args.steps) {
          const stepCount = (args.steps.match(/^\d+[.、]/gm) || []).length || 1;
          subParams.push(`${stepCount} steps`);
        }
        if (args.files) {
          const fileCount = args.files.split('\n').filter(l => l.trim()).length;
          if (fileCount > 0) {subParams.push(`${fileCount} files`);}
        }
        break;

      case 'enter_plan_mode':
        if (args.reason) {
          mainParam = this._truncate(args.reason, 50);
        } else {
          mainParam = 'complex task';
        }
        break;

      default:
        // 通用格式
        const entries = Object.entries(args);
        if (entries.length === 1) {
          mainParam = this._formatPath(String(entries[0][1]));
        } else {
          const keyValues = entries.slice(0, 3).map(([k, v]) => `${k}=${this._escape(String(v))}`);
          return keyValues.join(', ');
        }
    }

    // 组装最终字符串: (mainParam, subParam1=val, ...)
    let result = '';
    const allParts = mainParam ? [mainParam, ...subParams] : subParams;
    if (allParts.length > 0) {
      result = `(${allParts.join(', ')})`;
    }
    return this._truncate(result, maxWidth);
  }

  /**
   * 格式化路径（移除工作目录前缀）
   * @param {string} path
   * @returns {string}
   */
  _formatPath(path) {
    if (!path) {return '';}
    let result = path;
    if (result.startsWith('./')) {result = result.substring(2);}
    if (result.startsWith('../')) {result = result.substring(3);}
    return result;
  }

  /**
   * 转义字符串
   * @param {string} str
   * @returns {string}
   */
  _escape(str) {
    if (!str) {return '';}
    return str.replace(/"/g, '\\"').replace(/\n/g, '\\n');
  }

  /**
   * 截断字符串
   * @param {string} str
   * @param {number} maxLen
   * @returns {string}
   */
  _truncate(str, maxLen) {
    if (!str || str.length <= maxLen) {return str;}
    return str.substring(0, maxLen - 3) + '...';
  }

  /**
   * 渲染工具响应（任务列表样式：层级缩进 + ⎿ 续行标记）
   * @param {string} name - 工具名
   * @param {Object} result - 工具结果
   * @param {Object} toolCall - 原始工具调用（用于获取参数）
   * @param {number} width - 可用宽度
   * @param {number} maxLines - 最大行数
   * @returns {string[]} 渲染后的行数组
   */
  renderToolResponse(name, result, toolCall, width, maxLines = 10) {
    if (!result) {return [];}

    const t = this.theme;
    const indent = '  ';  // 二级缩进
    const branch = chalk.hex(t.colors.primary)('└─');  // 树状分支符号

    // 错误情况
    if (result.error) {
      const errText = `Error: ${result.error}`.replace(/\n/g, ' ');
      const truncated = this._truncate(errText, width - 4);
      return [`${indent}${branch} ${t.error(truncated)}`];
    }

    const lines = [];
    const contentWidth = width - 6; // 减去缩进和续行标记

    switch (name) {
      case 'execute_command':
      case 'bash': {
        // 显示超时警告
        if (result.warning) {
          lines.push(`${indent}${branch} ${t.warning(result.warning)}`);
        }
        const output = result.stdout || result.output || result.content || '';
        if (output) {
          const outputLines = output.split('\n').filter(l => l.trim());
          if (outputLines.length === 0) {
            lines.push(`${indent}${branch} ${t.success('✓')} Command executed successfully`);
          } else {
            const displayCount = maxLines > 0 ? Math.min(outputLines.length, maxLines) : outputLines.length;
            const contIndent = indent + '   ';
            for (let i = 0; i < displayCount; i++) {
              const line = outputLines[i];
              const isError = /\b(error|failed|exception|cannot|unable)\b/i.test(line);
              const trimmed = line.replace(/^\s+/, '');
              const styled = isError ? t.error(this._truncate(trimmed, contentWidth)) : t.dim(this._truncate(trimmed, contentWidth));
              if (i === 0) {
                lines.push(`${indent}${branch} ${styled}`);
              } else {
                lines.push(`${contIndent}${styled}`);
              }
            }
            if (maxLines > 0 && outputLines.length > maxLines) {
              const overflow = `... ↑ 滚动查看更多 (共 ${outputLines.length} 行)`;
              lines.push(`${contIndent}${t.textMuted(overflow)}`);
            }
          }
        } else if (result.success) {
          lines.push(`${indent}${branch} ${t.success('✓')} Command executed successfully`);
        }
        break;
      }

      case 'edit_file':
      case 'edit': {
        if (result.diff) {
          // 原子编辑 diff 显示（用户要求格式）
          const parsed = parseUnifiedDiff(result.diff);

          // 统计摘要: Added N lines, removed N lines
          const add = result.additions || 0;
          const rem = result.removals || 0;
          const statParts = [];
          if (add > 0) {statParts.push(`Added ${add} line${add > 1 ? 's' : ''}`);}
          if (rem > 0) {statParts.push(`removed ${rem} line${rem > 1 ? 's' : ''}`);}
          const summary = statParts.length > 0 ? statParts.join(', ') : 'No changes';
          lines.push(`${indent}${branch} ${t.dim(summary)}`);

          // 渲染 diff 行（无 hunk header，对齐格式: NNNNNN -/+ content）
          let lineCount = 0;
          const LN_WIDTH = 6; // 行号宽度
          for (const hunk of parsed.hunks) {
            if (lineCount >= maxLines) {break;}
            for (const diffLine of hunk.lines) {
              if (lineCount >= maxLines) {break;}
              const ln = diffLine.kind === 'removed' ? diffLine.oldLineNo : diffLine.newLineNo;
              const lnStr = String(ln || 0).padStart(LN_WIDTH);
              const maxContentLen = contentWidth - LN_WIDTH - 4; // 行号 + 前缀 + 缩进
              let styledLine;
              if (diffLine.kind === 'removed') {
                styledLine = t.diff.removed(`${lnStr} - ${this._truncate(diffLine.content, maxContentLen)}`);
              } else if (diffLine.kind === 'added') {
                styledLine = t.diff.added(`${lnStr} + ${this._truncate(diffLine.content, maxContentLen)}`);
              } else {
                styledLine = t.dim(`${lnStr}   ${this._truncate(diffLine.content, maxContentLen)}`);
              }
              lines.push(`${indent}${indent}${styledLine}`);
              lineCount++;
            }
          }
        } else if (result.additions > 0 || result.removals > 0) {
          const add = result.additions || 0;
          const rem = result.removals || 0;
          const statParts = [];
          if (add > 0) {statParts.push(`Added ${add} line${add > 1 ? 's' : ''}`);}
          if (rem > 0) {statParts.push(`removed ${rem} line${rem > 1 ? 's' : ''}`);}
          lines.push(`${indent}${branch} ${t.dim(statParts.join(', '))}`);
        } else if (result.success) {
          lines.push(`${indent}${branch} ${t.success('✓')} Updated ${this._formatPath(result.filePath || '')}`);
        }
        break;
      }

      case 'read_file':
      case 'view': {
        const filePath = this._formatPath(result.filePath || toolCall?.function?.arguments?.filePath || '');
        const content = result.content || result.output || '';
        const totalLines = content ? content.split('\n').length : 0;

        // 获取实际行号偏移
        let args = {};
        try {
          args = typeof toolCall?.function?.arguments === 'string'
            ? JSON.parse(toolCall.function.arguments)
            : (toolCall?.function?.arguments || {});
        } catch { args = {}; }
        const startLine = (args.offset || 0) + 1;
        const limit = args.limit || totalLines;
        const endLine = Math.min(startLine + limit - 1, totalLines);

        if (totalLines > 0) {
          lines.push(`${indent}${branch} ${t.dim(`Lines ${startLine}-${endLine} of ${filePath} (${totalLines} total)`)}`);
        } else {
          lines.push(`${indent}${branch} ${t.dim(filePath)}`);
        }
        break;
      }

      case 'write_file':
      case 'write': {
        if (result.success) {
          const filePath = this._formatPath(result.filePath || '');
          const size = result.size ? ` (${this._formatSize(result.size)})` : '';

          // 从工具调用参数中获取写入的内容
          let args = {};
          try {
            args = typeof toolCall?.function?.arguments === 'string'
              ? JSON.parse(toolCall.function.arguments)
              : (toolCall?.function?.arguments || {});
          } catch { args = {}; }

          // 显示摘要：新建/覆盖 + 文件路径 + 大小
          const modeLabel = result.mode === 'append' ? 'Appended to' : 'Written to';
          lines.push(`${indent}${branch} ${t.success('✓')} ${modeLabel} ${filePath}${t.dim(size)}`);

          // 展示写入的内容（正常颜色+行号，不用全绿）
          const content = args.content || '';
          if (content) {
            const contentLines = content.split('\n');
            const displayLines = contentLines.slice(0, maxLines);
            const LN_WIDTH = 6;
            for (let i = 0; i < displayLines.length; i++) {
              const ln = String(i + 1).padStart(LN_WIDTH);
              const sep = t.dim('│');
              const maxContentLen = contentWidth - LN_WIDTH - 10;
              lines.push(`${indent}${indent}${t.dim(ln)} ${sep} ${t.text(this._truncate(displayLines[i], maxContentLen))}`);
            }
            if (contentLines.length > maxLines) {
              const overflow = `... +${contentLines.length - maxLines} more lines`;
              const pad = Math.max(0, Math.floor((contentWidth - overflow.length) / 2));
              lines.push(`${indent}${' '.repeat(pad)}${t.textMuted(overflow)}`);
            }
          }
        }
        break;
      }

      case 'delete_file':
      case 'delete': {
        if (result.success) {
          lines.push(`${indent}${branch} ${t.success('✓')} Deleted ${this._formatPath(result.filePath || '')}`);
        }
        break;
      }

      case 'create_directory':
      case 'mkdir': {
        if (result.success) {
          lines.push(`${indent}${branch} ${t.success('✓')} Created ${this._formatPath(result.path || '')}`);
        }
        break;
      }

      case 'move_file': {
        if (result.success) {
          lines.push(`${indent}${branch} ${t.success('✓')} Moved to ${this._formatPath(result.destination || '')}`);
        }
        break;
      }

      case 'list_directory':
      case 'ls':
      case 'glob_files':
      case 'glob':
      case 'search_in_files':
      case 'grep': {
        const output = result.output || result.content || '';
        if (output) {
          const outputLines = output.split('\n').filter(l => l.trim());
          const displayLines = outputLines.slice(0, maxLines);
          for (const line of displayLines) {
            lines.push(`${indent}${branch} ${t.dim(this._truncate(line, contentWidth))}`);
          }
          if (outputLines.length > maxLines) {
            const overflow = `... +${outputLines.length - maxLines} more`;
            const pad = Math.max(0, Math.floor((contentWidth - overflow.length) / 2));
            lines.push(`${indent}${' '.repeat(pad)}${t.textMuted(overflow)}`);
          }
        }
        break;
      }

      // Todo 工具
      case 'add_todo':
      case 'complete_todo':
      case 'remove_todo': {
        if (result.success) {
          const args = toolCall?.function?.arguments || {};
          const todoText = args.text || '';
          const todoId = args.id || '';
          const action = name === 'add_todo' ? 'Added' : name === 'complete_todo' ? 'Completed' : 'Removed';
          let desc = todoText ? this._truncate(todoText, 40) : '';
          if (!desc && todoId) {desc = `id=${todoId.substring(0, 10)}...`;}
          // 如果有 todo 完整对象，优先使用其 text
          if (!desc && result.todo?.text) {desc = this._truncate(result.todo.text, 40);}
          lines.push(`${indent}${branch} ${t.success('✓')} ${action}${desc ? ': ' + t.dim(desc) : ''}`);
        }
        break;
      }

      case 'ask_user_question':
        // 用户已回答，不需要重复展示结果
        break;

      case 'list_todos': {
        if (result.todos && result.todos.length > 0) {
          const completed = result.todos.filter(td => td.completed).length;
          lines.push(`${indent}${branch} ${t.dim(`Tasks (${completed}/${result.todos.length})`)}`);
          for (const todo of result.todos.slice(0, maxLines - 1)) {
            const status = todo.completed ? t.success('✔') : t.textMuted('◻');
            const text = todo.text || '';
            lines.push(`${indent}${indent}${status} ${t.text(this._truncate(text, contentWidth - 4))}`);
          }
        } else if (result.todos && result.todos.length === 0) {
          lines.push(`${indent}${branch} ${t.textMuted('No tasks')}`);
        }
        break;
      }

      default: {
        if (result.success) {
          lines.push(`${indent}${branch} ${t.success('✓')} Done`);
        } else if (result.output || result.content) {
          const output = (result.output || result.content || '').split('\n').filter(l => l.trim()).slice(0, maxLines);
          for (const line of output) {
            lines.push(`${indent}${branch} ${t.dim(this._truncate(line, contentWidth))}`);
          }
        }
      }
    }

    return lines;
  }

  /**
   * 格式化文件大小
   * @param {number} bytes
   * @returns {string}
   */
  _formatSize(bytes) {
    if (bytes < 1024) {return bytes + 'B';}
    if (bytes < 1024 * 1024) {return (bytes / 1024).toFixed(1) + 'KB';}
    return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
  }
}

module.exports = ToolRenderer;

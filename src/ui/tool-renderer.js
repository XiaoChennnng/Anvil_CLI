'use strict';

const chalk = require('chalk');
const { getTheme } = require('./theme');
const { parseUnifiedDiff } = require('./diff');
const { normalizeToMarkdownList } = require('../tools/plan_mode');

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
  // 内部状态机信号——主路径已屏蔽 emit,这里兜底,防止其他路径误触时显示原名
  task_complete: 'TaskComplete',
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
   */
  getToolName(name) {
    return TOOL_NAME_MAP[name] || name;
  }

  /**
   * 获取工具执行状态文本
   */
  getToolAction(name) {
    return TOOL_ACTION_MAP[name] || 'Processing...';
  }

  /**
   * 渲染工具调用行（单行，opencode 风格）
   * @param {Object} toolCall
   * @param {number} width
   * @param {boolean} nested
   * @param {boolean} withMarker - 是否显示 ● 前缀，默认 true
   * @param {string} status - 工具状态: 'pending'(执行中) | 'success' | 'error' | 'warning'
   * @param {boolean} blinkVisible - 闪烁可见状态(true 显示 ●，false 显示空格)
   * @returns {string[]}
   */
  renderToolCall(toolCall, width, nested = false, withMarker = true, status = 'pending', blinkVisible = true) {
    const t = this.theme;
    const result = [];

    const rawName = toolCall.function?.name || toolCall.type || 'unknown';
    const displayName = this.getToolName(rawName);

    // 解析参数
    let args = {};
    try {
      args = typeof toolCall.function.arguments === 'string'
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

    // 状态色编码:pending=默认/白,success=绿,error=红,warning=黄
    const markerColor = status === 'success' ? t.colors.success
      : status === 'error' ? t.colors.error
      : status === 'warning' ? t.colors.warning
      : t.colors.text; // pending 用默认文字色(白色)

    // 闪烁:pending 状态下按 blinkVisible 切换显示/隐藏
    const markerChar = (status === 'pending' && !blinkVisible) ? ' ' : '●';
    const marker = withMarker ? chalk.hex(markerColor)(markerChar) : '';
    const nameStyle = t.text(namePart);
    const paramsStyled = paramsStr ? ` ${t.dim(paramsStr)}` : '';
    const content = `${nameStyle}${paramsStyled}`;

    if (nested) {
      const prefix = chalk.hex(markerColor)('└─');
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
   * @param {string} name
   * @param {Object} args
   * @param {number} maxWidth
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
          // 先规范化（处理 LLM 传数组 / 对象 / 字面 \n 字符串的乱象）
          const stepsStr = normalizeToMarkdownList(args.steps, { ordered: true });
          const stepCount = (stepsStr.match(/^\d+[.、]/gm) || []).length || 1;
          subParams.push(`${stepCount} steps`);
        }
        if (args.files) {
          const filesStr = normalizeToMarkdownList(args.files, { ordered: false });
          const fileCount = filesStr.split('\n').filter(l => l.trim()).length;
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

      case 'start_team_task':
        mainParam = this._truncate(args.task || '', 50);
        if (args.force) {subParams.push('force=true');}
        if (Array.isArray(args.suggestedRoles) && args.suggestedRoles.length > 0) {
          // 关键修复:数组不能直接 toString,旧代码会显示 [object Object],[object Object]
          // 改成 "[role × count, ...]" 简短摘要
          const rolesStr = args.suggestedRoles
            .map(r => `${r.role}×${r.count || 1}`)
            .join(', ');
          subParams.push(`roles=[${this._truncate(rolesStr, 60)}]`);
        }
        break;

      default:
        // 通用格式
        const entries = Object.entries(args);
        if (entries.length === 1) {
          mainParam = this._formatPath(this._stringifyValue(entries[0][1]));
        } else {
          const keyValues = entries.slice(0, 3).map(([k, v]) =>
            `${k}=${this._escape(this._stringifyValue(v))}`);
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
   * 把任意值转成可显示的字符串
   * 关键修复:对象/数组直接 String() 会变 "[object Object]",导致 TUI 渲染糊掉
   * - 数组 → JSON.stringify(短截断)
   * - 对象 → JSON.stringify(短截断)
   * - 其他 → String()
   */
  _stringifyValue(v) {
    if (v === null || v === undefined) {return String(v);}
    if (Array.isArray(v)) {
      // 数组:简短摘要,避免 JSON 全文糊一坨
      try {
        const json = JSON.stringify(v);
        return this._truncate(json, 50);
      } catch {
        return '[array]';
      }
    }
    if (typeof v === 'object') {
      try {
        const json = JSON.stringify(v);
        return this._truncate(json, 50);
      } catch {
        return '[object]';
      }
    }
    return String(v);
  }

  /**
   * 渲染工具响应（任务列表样式：层级缩进）
   * @param {string} name
   * @param {Object} result
   * @param {Object} toolCall
   * @param {number} width
   * @param {number} maxLines
   * @returns {string[]}
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
        const output = result.stdout || result.content || result.output || result.result || result.summary || result.message || '';
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
        const add = result.additions || 0;
        const rem = result.removals || 0;
        const filePath = this._formatPath(result.filePath || '');
        const LN_WIDTH = 6;

        if (result.diff) {
          const parsed = parseUnifiedDiff(result.diff);
          const statParts = [];
          if (add > 0) {statParts.push(`+${add}`);}
          if (rem > 0) {statParts.push(`-${rem}`);}
          lines.push(`${indent}${branch} ${t.dim(statParts.join(' ') || 'No changes')}  ${filePath}`);

          let lineCount = 0;
          const diffMax = Math.min(8, maxLines);
          for (const hunk of parsed.hunks) {
            if (lineCount >= diffMax) {break;}
            for (const diffLine of hunk.lines) {
              if (lineCount >= diffMax) {break;}
              const ln = diffLine.kind === 'added' ? diffLine.newLineNo : diffLine.oldLineNo;
              const lnStr = String(ln || 0).padStart(LN_WIDTH);
              const maxContentLen = contentWidth - LN_WIDTH - 4;
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
          if (parsed.hunks.reduce((c, h) => c + h.lines.length, 0) > diffMax) {
            lines.push(`${indent}${indent}${t.textMuted(`... ${parsed.hunks.reduce((c, h) => c + h.lines.length, 0) - diffMax} more lines`)}`);
          }
        } else if (add > 0 || rem > 0) {
          // diff 为空时，直接显示 oldString -> newString
          lines.push(`${indent}${branch} ${t.dim(`+${add} -${rem}`)}  ${filePath}`);

          // 尝试从 result 获取 oldString/newString
          const oldContent = result.oldContent || result.oldString || '';
          const newContent = result.newContent || result.newString || '';

          if (oldContent || newContent) {
            const maxContentLen = contentWidth - LN_WIDTH - 8;
            if (oldContent) {
              const oldLines = oldContent.split('\n');
              for (let i = 0; i < oldLines.length && i < maxLines; i++) {
                const lnStr = String(i + 1).padStart(LN_WIDTH);
                lines.push(`${indent}${indent}${t.diff.removed(`${lnStr} - ${this._truncate(oldLines[i], maxContentLen)}`)}`);
              }
            }
            if (newContent) {
              const newLines = newContent.split('\n');
              for (let i = 0; i < newLines.length && i < maxLines; i++) {
                const lnStr = String(i + 1).padStart(LN_WIDTH);
                lines.push(`${indent}${indent}${t.diff.added(`${lnStr} + ${this._truncate(newLines[i], maxContentLen)}`)}`);
              }
            }
          }
        } else if (result.success) {
          lines.push(`${indent}${branch} ${t.success('✓')} Updated ${filePath}`);
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

          // 展示写入的内容（绿色标注，新增/写入的代码）
          const content = args.content || '';
          if (content) {
            const contentLines = content.split('\n');
            const displayLines = contentLines.slice(0, maxLines);
            const LN_WIDTH = 6;
            const lineOffset = result.mode === 'append' ? (result.appendStartLine || 0) : 0;
            for (let i = 0; i < displayLines.length; i++) {
              const ln = String(lineOffset + i + 1).padStart(LN_WIDTH);
              const sep = t.dim('│');
              const maxContentLen = contentWidth - LN_WIDTH - 10;
              lines.push(`${indent}${indent}${t.dim(ln)} ${sep} ${t.diff.added(this._truncate(displayLines[i], maxContentLen))}`);
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
        // 没 output 时至少给个统计摘要，别干巴巴啥也没有
        if (!output) {
          let summary = '';
          if (name === 'glob_files' || name === 'glob') {
            summary = `Found ${result.count || 0} files`;
          } else if (name === 'search_in_files' || name === 'grep') {
            summary = `Found ${result.count || 0} matches`;
            if (result.truncated) {summary += ' (truncated, set maxResults to see more)';}
          } else if (name === 'list_directory' || name === 'ls') {
            const files = result.totalFiles || 0;
            const dirs = result.totalDirs || 0;
            summary = `${files} files, ${dirs} directories`;
          }
          lines.push(`${indent}${branch} ${t.dim(summary)}`);
        } else {
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

      // ─── 代码分析工具结果（symbol/grep 类，统计摘要先行） ───
      case 'get_document_symbols': {
        const count = result.count || 0;
        const filePath = this._formatPath(result.filePath || '');
        lines.push(`${indent}${branch} ${t.dim(`Found ${count} symbols in ${filePath}`)}`);
        if (result.symbols && result.symbols.length > 0) {
          for (const sym of result.symbols.slice(0, maxLines)) {
            lines.push(`${indent}${indent}${t.dim(`${sym.kind}: ${sym.name}  (${sym.filePath}:${sym.line})`)}`);
          }
          if (result.symbols.length > maxLines) {
            lines.push(`${indent}${indent}${t.textMuted(`... +${result.symbols.length - maxLines} more`)}`);
          }
        }
        break;
      }
      case 'find_definition': {
        const count = result.count || 0;
        const symbol = result.symbol || '';
        lines.push(`${indent}${branch} ${t.dim(`Found ${count} definitions for "${symbol}"`)}`);
        if (result.definitions && result.definitions.length > 0) {
          for (const def of result.definitions.slice(0, maxLines)) {
            lines.push(`${indent}${indent}${t.dim(`${def.file}:${def.line}  (${def.kind})`)}`);
          }
          if (result.definitions.length > maxLines) {
            lines.push(`${indent}${indent}${t.textMuted(`... +${result.definitions.length - maxLines} more`)}`);
          }
        }
        break;
      }
      case 'find_references': {
        const count = result.count || 0;
        const symbol = result.symbol || '';
        const truncated = result.truncated ? ` (truncated at ${count})` : '';
        lines.push(`${indent}${branch} ${t.dim(`Found ${count} references for "${symbol}"${truncated}`)}`);
        if (result.references && result.references.length > 0) {
          for (const ref of result.references.slice(0, maxLines)) {
            lines.push(`${indent}${indent}${t.dim(`${ref.file}:${ref.line}  ${this._truncate(ref.content, 60)}`)}`);
          }
          if (result.references.length > maxLines) {
            lines.push(`${indent}${indent}${t.textMuted(`... +${result.references.length - maxLines} more`)}`);
          }
        }
        break;
      }
      case 'analyze_dependencies': {
        const filePath = this._formatPath(result.file || result.filePath || '');
        const deps = result.summary?.totalDependencies || (result.requires?.length || 0) + (result.imports?.length || 0);
        const depFiles = result.summary?.totalDependents || result.dependents?.length || 0;
        lines.push(`${indent}${branch} ${t.dim(`${filePath} — ${deps} dependencies, ${depFiles} dependents`)}`);
        // 显示外部依赖模块
        const extMods = result.summary?.externalModules || [];
        if (extMods.length > 0) {
          const maxMods = Math.min(extMods.length, maxLines);
          for (let i = 0; i < maxMods; i++) {
            lines.push(`${indent}${indent}${t.dim(extMods[i])}`);
          }
          if (extMods.length > maxMods) {
            lines.push(`${indent}${indent}${t.textMuted(`... +${extMods.length - maxMods} more`)}`);
          }
        }
        break;
      }
      case 'get_hover_info': {
        const word = result.word || '';
        let hoverFilePath = this._formatPath(result.filePath || '');
        // 从工具参数拿文件路径（result 可能没有顶层 filePath）
        if (!hoverFilePath && toolCall?.function?.arguments) {
          try {
            const args = typeof toolCall.function.arguments === 'string'
              ? JSON.parse(toolCall.function.arguments)
              : toolCall.function.arguments;
            hoverFilePath = this._formatPath(args.filePath || '');
          } catch {}
        }
        if (word) {
          lines.push(`${indent}${branch} ${t.dim(`"${word}" at ${hoverFilePath}:${result.line}:${result.column}`)}`);
          if (result.definition) {
            lines.push(`${indent}${indent}${t.dim(`Defined at ${result.definition.file}:${result.definition.line} (${result.definition.kind})`)}`);
          }
        } else {
          lines.push(`${indent}${branch} ${t.dim(`No symbol at cursor`)}`);
        }
        break;
      }
      case 'format_code': {
        if (result.changed) {
          const sizeDelta = result.saved ? ` (${result.saved > 0 ? '-' : '+'}${Math.abs(result.saved)}B)` : '';
          lines.push(`${indent}${branch} ${t.success('✓')} Formatted ${this._formatPath(result.filePath || '')}${t.dim(sizeDelta)}`);
        } else if (result.message) {
          lines.push(`${indent}${branch} ${t.dim(result.message)}`);
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

      case 'task_complete':
        // 任务完成摘要已由 AI 文字回复输出，不再重复渲染
        break;

      case 'compact_context': {
        // 语义压缩：由 default 通道统一渲染 summary（已带 ✓ 前缀，避免重复）
        const outputText = result.content || result.output || result.result || result.summary || result.message || '';
        if (outputText) {
          const outputLines = outputText.split('\n').filter(l => l.trim()).slice(0, maxLines);
          for (const line of outputLines) {
            lines.push(`${indent}${branch} ${t.dim(this._truncate(line, contentWidth))}`);
          }
        } else if (result.success) {
          lines.push(`${indent}${branch} ${t.success('✓')} Done`);
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
            const status = todo.completed ? t.success('✓') : t.textMuted('[ ]');
            const text = todo.text || '';
            lines.push(`${indent}${indent}${status} ${t.text(this._truncate(text, contentWidth - 4))}`);
          }
        } else if (result.todos && result.todos.length === 0) {
          lines.push(`${indent}${branch} ${t.textMuted('No tasks')}`);
        }
        break;
      }

      default: {
        const outputText = result.content || result.output || result.result || result.summary || result.message || '';
        if (outputText) {
          // 检测是否为搜索结果格式（由 MCP manager 预处理过）
          if (outputText.includes('[SEARCH_RESULTS:')) {
            // 搜索结果：整个作为一整个分支显示
            lines.push(...this._renderSearchResultsBlock(outputText, indent, branch, contentWidth, t));
          } else {
            // 普通文本：按行渲染，每行一个分支
            const outputLines = outputText.split('\n').filter(l => l.trim()).slice(0, maxLines);
            for (const line of outputLines) {
              lines.push(`${indent}${branch} ${t.dim(this._truncate(line, contentWidth))}`);
            }
          }
        } else if (result.success) {
          lines.push(`${indent}${branch} ${t.success('✓')} Done`);
        }
      }
    }

    return lines;
  }

  // 格式化文件大小
  _formatSize(bytes) {
    if (bytes < 1024) {return bytes + 'B';}
    if (bytes < 1024 * 1024) {return (bytes / 1024).toFixed(1) + 'KB';}
    return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
  }

  // 渲染搜索结果块（整体一个分支）
  _renderSearchResultsBlock(text, indent, branch, contentWidth, t) {
    const lines = [];
    const subIndent = indent + '  ';

    // 解析行
    const rawLines = text.split('\n');

    for (const rawLine of rawLines) {
      if (!rawLine.trim()) {continue;}

      // 检测是否为 [SEARCH_RESULTS: 开头的行（标题行）
      const match = rawLine.match(/^\[SEARCH_RESULTS:(\d+)\]$/);
      if (match) {
        lines.push(`${indent}${branch} ${t.primary('搜索结果')} ${t.dim(`(${match[1]} 条)`)}`);
        continue;
      }

      // 子内容行（以两个空格开头）
      if (rawLine.startsWith('  ')) {
        const content = rawLine.slice(2);
        const colonIndex = content.indexOf(':');
        if (colonIndex > 0) {
          const key = content.slice(0, colonIndex);
          const value = content.slice(colonIndex + 1).trim();

          // 根据字段类型选择样式
          let styledLine;
          if (key === '标题') {
            styledLine = `${t.text(this._truncate(value, contentWidth - 6))}`;
          } else if (key === '摘要') {
            styledLine = `${t.dim(this._truncate(value, contentWidth - 6))}`;
          } else if (key === '链接') {
            styledLine = `${t.textMuted(this._truncate(value, contentWidth - 6))}`;
          } else {
            styledLine = `${t.textMuted(this._truncate(content, contentWidth - 6))}`;
          }
          lines.push(`${subIndent}${t.dim('│')} ${styledLine}`);
        } else {
          lines.push(`${subIndent}${t.dim('│')} ${t.dim(this._truncate(content, contentWidth - 6))}`);
        }
      } else {
        // 普通行
        lines.push(`${indent}${branch} ${t.dim(this._truncate(rawLine, contentWidth - 4))}`);
      }
    }

    return lines;
  }
}

module.exports = ToolRenderer;
module.exports.TOOL_NAME_MAP = TOOL_NAME_MAP;

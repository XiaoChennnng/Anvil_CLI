'use strict';

const chalk = require('chalk');
const { getTheme } = require('./theme');

const LineType = {
  CONTEXT: 'context',
  ADDED: 'added',
  REMOVED: 'removed',
};

function parseUnifiedDiff(diffText) {
  const result = { fileName: '', hunks: [] };
  let currentHunk = null;
  let oldLine = 0;
  let newLine = 0;

  const hunkHeaderRe = /^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/;
  const lines = diffText.split('\n');

  // 解析文件名
  for (const line of lines) {
    if (line.startsWith('--- a/')) {
      result.fileName = line.substring(5).split('\t')[0];
      break;
    }
    if (line.startsWith('+++ b/')) {
      result.fileName = line.substring(5).split('\t')[0];
    }
  }

  for (const line of lines) {
    // 跳过文件头
    if (line.startsWith('--- a/') || line.startsWith('+++ b/')) {
      continue;
    }

    // 解析 hunk 头
    const matches = hunkHeaderRe.exec(line);
    if (matches) {
      if (currentHunk) {
        result.hunks.push(currentHunk);
      }
      currentHunk = {
        header: line,
        lines: [],
      };
      oldLine = parseInt(matches[1], 10);
      newLine = parseInt(matches[3], 10);
      continue;
    }

    // 跳过 "No newline at end of file"
    if (line.startsWith('\\ No newline at end of file')) {
      continue;
    }

    if (!currentHunk) {
      continue;
    }

    // 根据行前缀判断类型
    if (line.length > 0) {
      switch (line[0]) {
        case '+':
          currentHunk.lines.push({
            oldLineNo: 0,
            newLineNo: newLine,
            kind: LineType.ADDED,
            content: line.substring(1),
          });
          newLine++;
          break;
        case '-':
          currentHunk.lines.push({
            oldLineNo: oldLine,
            newLineNo: 0,
            kind: LineType.REMOVED,
            content: line.substring(1),
          });
          oldLine++;
          break;
        default:
          currentHunk.lines.push({
            oldLineNo: oldLine,
            newLineNo: newLine,
            kind: LineType.CONTEXT,
            content: line.startsWith(' ') ? line.substring(1) : line,
          });
          oldLine++;
          newLine++;
      }
    } else {
      // 空行当作上下文行
      currentHunk.lines.push({
        oldLineNo: oldLine,
        newLineNo: newLine,
        kind: LineType.CONTEXT,
        content: '',
      });
      oldLine++;
      newLine++;
    }
  }

  // 添加最后一个 hunk
  if (currentHunk) {
    result.hunks.push(currentHunk);
  }

  return result;
}

function renderDiffLine(line, lineWidth) {
  const t = getTheme();

  // 固定行号宽度为 4 位
  const lineNumWidth = 4;

  // 计算内容最大宽度
  // 格式: -001│ content -> 1(标记) + 4(行号) + 2(│ + 空格) = 7
  const prefixLen = 7;
  const maxContentWidth = Math.max(0, lineWidth - prefixLen);

  // 截断内容
  let content = line.content;
  if (content.length > maxContentWidth) {
    content = content.substring(0, maxContentWidth - 3) + '...';
  }

  // 格式化行号
  let lineNoStr;
  if (line.kind === LineType.REMOVED) {
    lineNoStr = String(line.oldLineNo).padStart(lineNumWidth);
  } else if (line.kind === LineType.ADDED) {
    lineNoStr = String(line.newLineNo).padStart(lineNumWidth);
  } else {
    lineNoStr = String(line.oldLineNo).padStart(lineNumWidth);
  }

  // 填充内容到固定宽度
  const paddedContent = content.padEnd(maxContentWidth);

  // 组合前缀: 标记 + 行号背景 + 行号 + 分隔符
  // opencode 格式:
  //   removed: marker=diffRemoved fg, linenumber=diffRemoved fg + diffRemovedLineNumberBg bg
  //   added:  marker=diffAdded fg, linenumber=diffAdded fg + diffAddedLineNumberBg bg
  //   context: marker=diffContext fg, linenumber=diffLineNumber fg + diffContextBg bg
  let lineStr;
  switch (line.kind) {
    case LineType.REMOVED:
      lineStr = t.diff.removed('-') +
        chalk.bgHex(t.colors.diffRemovedLineNumberBg).hex(t.colors.diffRemoved)(lineNoStr) +
        t.diff.removed(`│ ${paddedContent}`);
      break;
    case LineType.ADDED:
      lineStr = t.diff.added('+') +
        chalk.bgHex(t.colors.diffAddedLineNumberBg).hex(t.colors.diffAdded)(lineNoStr) +
        t.diff.added(`│ ${paddedContent}`);
      break;
    default:
      lineStr = t.diff.context(' ') +
        chalk.bgHex(t.colors.diffContextBg).hex(t.colors.diffLineNumber)(lineNoStr) +
        t.diff.context(`│ ${paddedContent}`);
  }

  return lineStr;
}

function renderDiffBox(diffText, width, maxLines = 10) {
  const result = [];
  const t = getTheme();
  const parsed = parseUnifiedDiff(diffText);

  if (parsed.hunks.length === 0) {
    return [];
  }

  // 计算边框宽度
  const borderWidth = width - 1; // 减去边框字符
  const contentWidth = borderWidth - 4; // 减去左右的 padding

  // 顶部边框: ┌─ filename ─┐
  const fileName = parsed.fileName || 'diff';
  const topBorder = `┌─ ${fileName} ${'─'.repeat(Math.max(0, borderWidth - fileName.length - 4))}┐`;
  result.push(topBorder);

  // 渲染每个 hunk
  let lineCount = 0;
  for (const hunk of parsed.hunks) {
    // Hunk header（opencode 风格: 显示 @@ -old,count +new,count @@）
    if (hunk.header) {
      result.push(`│ ${t.diff.hunkHeader(chalk.dim(hunk.header))}${' '.repeat(Math.max(0, contentWidth - hunk.header.length))} │`);
    }

    for (const line of hunk.lines) {
      if (lineCount >= maxLines) {
        // 超出最大行数，显示省略
        result.push(chalk.dim(`│ ... (${hunk.lines.length - lineCount} more lines) ${' '.repeat(Math.max(0, contentWidth - 30))}│`));
        break;
      }

      const rendered = renderDiffLine(line, contentWidth);
      result.push(`│ ${rendered}${' '.repeat(Math.max(0, contentWidth - rendered.length))} │`);
      lineCount++;
    }
    if (lineCount >= maxLines) {break;}
  }

  // 底部边框
  result.push(`└${'─'.repeat(borderWidth)}┘`);

  return result;
}

/**
 * 渲染带边框的代码块
 * @param {string} code - 代码内容
 * @param {string} language - 语言标识
 * @param {string} fileName - 文件名（可选）
 * @param {number} width - 总宽度
 * @param {number} maxLines - 最大行数
 * @returns {string[]} 渲染后的行数组
 */
function renderCodeBox(code, language, fileName, width, maxLines = 10) {
  const result = [];
  const t = getTheme();
  const borderWidth = width - 1;

  // 标题：可以是语言或文件名
  const title = fileName || language || 'code';
  const topBorder = `┌─ ${title} ${'─'.repeat(Math.max(0, borderWidth - title.length - 4))}┐`;
  result.push(topBorder);

  // 分割代码行
  const lines = code.split('\n');
  const displayLines = lines.slice(0, maxLines);

  for (const line of displayLines) {
    // 截断过长的行
    const maxContentWidth = borderWidth - 4;
    let content = line;
    if (content.length > maxContentWidth) {
      content = content.substring(0, maxContentWidth - 3) + '...';
    }

    // 行号（可选，简化版不显示）
    const lineStr = t.syntax.string(content);
    result.push(`│ ${lineStr}${' '.repeat(Math.max(0, maxContentWidth - lineStr.replace(/\x1b\[\d+m/g, '').length))} │`);
  }

  // 如果有更多行
  if (lines.length > maxLines) {
    result.push(chalk.dim(`│ ... (${lines.length - maxLines} more lines) ${' '.repeat(Math.max(0, borderWidth - 26))}│`));
  }

  // 底部边框
  result.push(`└${'─'.repeat(borderWidth)}┘`);

  return result;
}

/**
 * 渲染 Bash 命令输出
 * @param {string} output - 命令输出
 * @param {number} width - 总宽度
 * @param {number} maxLines - 最大行数
 * @returns {string[]} 渲染后的行数组
 */
function renderBashBox(output, width, maxLines = 10) {
  const result = [];
  const t = getTheme();
  const borderWidth = width - 1;
  const contentWidth = borderWidth - 4;

  // 顶部边框
  const topBorder = `┌─ bash ${'─'.repeat(Math.max(0, borderWidth - 7))}┐`;
  result.push(topBorder);

  // 分割输出行
  const lines = output.split('\n');
  const displayLines = lines.slice(0, maxLines);

  for (const line of displayLines) {
    let content = line;
    if (content.length > contentWidth) {
      content = content.substring(0, contentWidth - 3) + '...';
    }

    // 检查是否包含错误关键字
    const isError = /\b(error|failed|exception|cannot|unable)\b/i.test(content);
    const lineColor = isError ? t.error : t.text;
    const lineStr = lineColor(content);
    result.push(`│ ${lineStr}${' '.repeat(Math.max(0, contentWidth - content.length))} │`);
  }

  // 如果有更多行
  if (lines.length > maxLines) {
    result.push(chalk.dim(`│ ... (${lines.length - maxLines} more lines) ${' '.repeat(Math.max(0, contentWidth - 26))}│`));
  }

  // 底部边框
  result.push(`└${'─'.repeat(borderWidth)}┘`);

  return result;
}

/**
 * 格式化 diff（兼容旧接口）
 * @param {string} diffText - unified diff 文本
 * @param {number} width - 总宽度
 * @param {number} maxLines - 最大行数
 * @returns {string} 格式化后的字符串
 */
function formatDiff(diffText, width, maxLines = 10) {
  const lines = renderDiffBox(diffText, width, maxLines);
  return lines.join('\n');
}

/**
 * 生成 unified diff
 * @param {string} oldContent - 旧内容
 * @param {string} newContent - 新内容
 * @param {string} fileName - 文件名
 * @returns {Object} { diff, additions, removals }
 */
function generateDiff(oldContent, newContent, fileName) {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  // 简单的 diff 生成：逐行比较
  const diffLines = [];
  let additions = 0;
  let removals = 0;

  // 找到共同前缀
  let commonPrefix = 0;
  while (commonPrefix < oldLines.length && commonPrefix < newLines.length &&
         oldLines[commonPrefix] === newLines[commonPrefix]) {
    diffLines.push(` ${oldLines[commonPrefix]}`);
    commonPrefix++;
  }

  // 找到共同后缀
  let commonSuffix = 0;
  while (commonSuffix < (oldLines.length - commonPrefix) &&
         commonSuffix < (newLines.length - commonPrefix) &&
         oldLines[oldLines.length - 1 - commonSuffix] === newLines[newLines.length - 1 - commonSuffix]) {
    commonSuffix++;
  }

  // 处理中间的差异部分
  const oldMiddle = oldLines.slice(commonPrefix, oldLines.length - commonSuffix);
  const newMiddle = newLines.slice(commonPrefix, newLines.length - commonSuffix);

  // 标记删除的行
  for (const line of oldMiddle) {
    diffLines.push(`-${line}`);
    removals++;
  }

  // 标记新增的行
  for (const line of newMiddle) {
    diffLines.push(`+${line}`);
    additions++;
  }

  // 添加共同后缀
  for (let i = commonSuffix - 1; i >= 0; i--) {
    diffLines.push(` ${oldLines[oldLines.length - 1 - i]}`);
  }

  // 构建 unified diff 格式
  const diff = `--- a/${fileName}\n+++ b/${fileName}\n@@ -1,${oldLines.length} +1,${newLines.length} @@\n${diffLines.join('\n')}`;

  return { diff, additions, removals };
}

/**
 * 从文件内容生成 diff（用于展示修改）
 * @param {string} oldContent - 旧内容
 * @param {string} newContent - 新内容
 * @param {string} fileName - 文件名
 * @returns {string} unified diff 格式
 */
function createDiffFromContent(oldContent, newContent, fileName) {
  const { diff } = generateDiff(oldContent, newContent, fileName);
  return diff;
}

module.exports = {
  // 常量
  LineType,

  // 解析
  parseUnifiedDiff,

  // 渲染
  renderDiffLine,
  renderDiffBox,
  renderCodeBox,
  renderBashBox,

  // 格式化（兼容）
  formatDiff,

  // 生成
  generateDiff,
  createDiffFromContent,
};

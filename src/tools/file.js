'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { generateDiff } = require('../ui/diff');
const { minimatch } = require('minimatch');

// 缓存 projectDir 的真实路径（解析符号链接后的绝对路径）
// 同一 projectDir 多次访问时只解析一次，避免重复 IO
const _projectDirRealpathCache = new Map();

function _getProjectDirRealpath(projectDir) {
  if (!projectDir) {return projectDir;}
  if (_projectDirRealpathCache.has(projectDir)) {
    return _projectDirRealpathCache.get(projectDir);
  }
  try {
    // 用 native 版本，行为在 Win/macOS/Linux 一致
    const realpath = fs.realpathSync.native(projectDir);
    _projectDirRealpathCache.set(projectDir, realpath);
    return realpath;
  } catch {
    // 解析失败时 fallback 到原路径（不缓存，下次重试）
    return projectDir;
  }
}

// 解析路径的真实路径，文件不存在时逐级向上解析到已存在的祖先目录
// 返回 null 表示无法安全解析
function _realpathFor(targetPath) {
  try {
    return fs.realpathSync.native(targetPath);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      // 文件不存在 → 解析父目录 + 拼回 basename
      const parent = path.dirname(targetPath);
      if (parent === targetPath) {return null;} // 已到根
      const parentReal = _realpathFor(parent);
      if (!parentReal) {return null;}
      return path.join(parentReal, path.basename(targetPath));
    }
    return null; // EACCES 等其他错误：保守拒绝
  }
}

/**
 * 路径安全检查：解析符号链接后判断是否在项目目录内（防 symlink 穿越）。
 * @param {string} targetPath - 目标路径（绝对路径）
 * @param {string} projectDir - 项目根目录（绝对路径）
 * @returns {boolean} 是否安全
 */
function isPathSafe(targetPath, projectDir) {
  if (!targetPath || !projectDir) {return false;}

  const projectReal = _getProjectDirRealpath(projectDir);
  const targetReal = _realpathFor(targetPath);

  // 无法解析真实路径（权限/不存在），保守拒绝
  if (!targetReal) {return false;}

  const relative = path.relative(projectReal, targetReal);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

// 测试钩子：清空 realpath 缓存
function _clearRealpathCache() {
  _projectDirRealpathCache.clear();
}

const MAX_FILE_READ_SIZE = 2 * 1024 * 1024;

async function readFile(params, context) {
  const { filePath } = params;
  const projectDir = context.projectDir;
  const resolvedPath = path.resolve(projectDir, filePath);

  if (!isPathSafe(resolvedPath, projectDir)) {
    return { error: `访问被拒绝: 路径超出项目目录 (${filePath})` };
  }

  try {
    let fileHandle;
    let stat;
    try {
      fileHandle = await fsp.open(resolvedPath, 'r');
      stat = await fileHandle.stat();
    } catch (openErr) {
      if (openErr.code === 'ENOENT') {
        return { error: `文件不存在: ${filePath}` };
      }
      throw openErr;
    }

    // 二进制文件检测：前 512 字节出现 \0 即视为二进制
    let isBinary = false;
    if (stat.size > 0) {
      const readSize = Math.min(512, stat.size);
      const buffer = Buffer.alloc(readSize);
      const { bytesRead } = await fileHandle.read(buffer, 0, readSize, 0);
      await fileHandle.close();
      isBinary = bytesRead > 0 && buffer.includes(0);
    } else {
      await fileHandle.close();
    }

    if (isBinary) {
      return {
        filename: path.basename(filePath),
        type: 'binary',
        size: stat.size,
        note: '二进制文件，仅返回文件名',
      };
    }

    // 按 maxLines/limit 分段读取，否则按字节上限截断
    const maxLines = params.maxLines || params.limit || 0;
    let content;
    if (maxLines > 0) {
      const allContent = await fsp.readFile(resolvedPath, 'utf8');
      const lines = allContent.split(/\r?\n/);
      const startLine = params.offset || 0;
      const selected = lines.slice(startLine, startLine + maxLines);
      content = selected.join('\n');
    } else {
      content = await fsp.readFile(resolvedPath, 'utf8');
      if (content.length > MAX_FILE_READ_SIZE) {
        content = content.substring(0, MAX_FILE_READ_SIZE)
          + `\n\n... (文件过大，仅读取前 ${MAX_FILE_READ_SIZE} 字符，共 ${stat.size} 字节)`;
      }
    }

    return {
      filename: path.basename(filePath),
      filePath,
      content,
      size: stat.size,
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { error: `文件不存在: ${filePath}` };
    }
    return { error: `读取文件失败 ${filePath}: ${err.message}` };
  }
}

async function writeFile(params, context) {
  const { filePath, content, mode } = params;
  const projectDir = context.projectDir;
  const resolvedPath = path.resolve(projectDir, filePath);

  // 计划模式下禁止写入 Anvil.md 以外的文件
  if (context.planModeRestricted && filePath !== 'Anvil.md') {
    return { error: '计划模式下禁止写入文件（Anvil.md 除外）' };
  }

  if (!isPathSafe(resolvedPath, projectDir)) {
    return { error: `访问被拒绝: 路径超出项目目录 (${filePath})` };
  }

  try {
    await fsp.mkdir(path.dirname(resolvedPath), { recursive: true });

    // 文件冲突检测（mtime 检查）
    if (params.checkConflict && context.fileTimestamps) {
      const prevTimestamp = context.fileTimestamps[filePath];
      if (prevTimestamp) {
        try {
          const currentStat = await fsp.stat(resolvedPath);
          const current = currentStat.mtimeMs;
          if (current > prevTimestamp) {
            return {
              conflict: true,
              filePath,
              message: `文件已被外部修改，是否覆盖？\n  上次读取时间: ${new Date(prevTimestamp).toISOString()}\n  当前修改时间: ${new Date(current).toISOString()}`,
            };
          }
        } catch {
          // 文件不存在，无冲突
        }
      }
    }

    const writeMode = mode === 'append' ? 'a' : 'w';
    await fsp.writeFile(resolvedPath, content, { encoding: 'utf8', flag: writeMode });

    // 记录 mtime 用于冲突检测
    if (context.fileTimestamps) {
      context.fileTimestamps[filePath] = Date.now();
    }

    const stat = await fsp.stat(resolvedPath);

    // 追加模式：找到追加起始行号（用于 UI 标记）
    let appendStartLine = 0;
    if (writeMode === 'a') {
      const existingContent = await fsp.readFile(resolvedPath, 'utf8');
      const linesWithoutNewContent = existingContent.slice(0, -content.length);
      appendStartLine = linesWithoutNewContent.split('\n').length - 1;
      if (appendStartLine < 0) { appendStartLine = 0; }
    }

    return {
      success: true,
      filePath,
      mode: writeMode === 'a' ? 'append' : 'overwrite',
      size: stat.size,
      timestamp: stat.mtimeMs,
      appendStartLine,
    };
  } catch (err) {
    return { error: `写入文件失败 ${filePath}: ${err.message}` };
  }
}

async function editFile(params, context) {
  const { filePath, oldString, newString, replaceAll } = params;
  const projectDir = context.projectDir;
  const resolvedPath = path.resolve(projectDir, filePath);

  if (context.planModeRestricted) {
    return { error: '计划模式下禁止编辑文件' };
  }

  if (!isPathSafe(resolvedPath, projectDir)) {
    return { error: `访问被拒绝: 路径超出项目目录 (${filePath})` };
  }

  if (!oldString) {
    return { error: 'oldString 不能为空' };
  }

  try {
    let content;
    try {
      content = await fsp.readFile(resolvedPath, 'utf8');
    } catch (readErr) {
      if (readErr.code === 'ENOENT') {
        return { error: `文件不存在: ${filePath}` };
      }
      throw readErr;
    }

    const positions = [];
    let pos = 0;
    while (true) {
      const idx = content.indexOf(oldString, pos);
      if (idx === -1) {break;}
      positions.push(idx);
      pos = idx + oldString.length;
    }

    const count = positions.length;

    if (count === 0) {
      return {
        error: `未找到匹配内容。请确保 oldString 与文件内容完全一致（包括缩进和换行）`,
        hint: '提示: 使用 search_in_files 工具先搜索确认内容位置',
      };
    }

    if (count > 1 && !replaceAll) {
      const matchLines = positions.map(idx =>
        content.substring(0, idx).split('\n').length
      );

      return {
        error: `找到 ${count} 处匹配（行: ${matchLines.join(', ')}）。请提供更多上下文缩小范围，或设置 replaceAll=true 替换所有`,
        matchCount: count,
        matchLines,
      };
    }

    let newContent;
    let replacedCount;
    if (replaceAll) {
      newContent = content.replaceAll(oldString, newString);
      replacedCount = count;
    } else {
      const idx = positions[0];
      newContent = content.substring(0, idx) + newString + content.substring(idx + oldString.length);
      replacedCount = 1;
    }

    await fsp.writeFile(resolvedPath, newContent, 'utf8');

    if (context.fileTimestamps) {
      context.fileTimestamps[filePath] = Date.now();
    }

    // 复用第一个匹配位置计算行范围（避免再次 indexOf）
    const beforeLines = content.substring(0, positions[0]).split('\n').length;
    const oldLines = oldString.split('\n').length;
    const newLines = newString.split('\n').length;

    const { diff, additions, removals } = generateDiff(content, newContent, filePath);

    return {
      success: true,
      filePath,
      replacedCount,
      lineRange: { start: beforeLines, end: beforeLines + oldLines - 1 },
      linesAdded: newLines - oldLines,
      diff,
      additions,
      removals,
      content: newContent,
      oldContent: oldString,
      newContent: newString,
    };
  } catch (err) {
    return { error: `编辑文件失败 ${filePath}: ${err.message}` };
  }
}

async function deleteFile(params, context) {
  const { filePath } = params;
  const projectDir = context.projectDir;
  const resolvedPath = path.resolve(projectDir, filePath);

  if (context.planModeRestricted) {
    return { error: '计划模式下禁止删除文件' };
  }

  if (!isPathSafe(resolvedPath, projectDir)) {
    return { error: `访问被拒绝: 路径超出项目目录 (${filePath})` };
  }

  try {
    let stat;
    try {
      stat = await fsp.stat(resolvedPath);
    } catch {
      return { error: `文件不存在: ${filePath}` };
    }

    await fsp.unlink(resolvedPath);

    return {
      success: true,
      filePath,
      size: stat.size,
    };
  } catch (err) {
    return { error: `删除文件失败 ${filePath}: ${err.message}` };
  }
}

async function createDirectory(params, context) {
  const dirPath = params.path;
  const projectDir = context.projectDir;
  const resolvedPath = path.resolve(projectDir, dirPath);

  if (!isPathSafe(resolvedPath, projectDir)) {
    return { error: `访问被拒绝: 路径超出项目目录 (${dirPath})` };
  }

  try {
    await fsp.mkdir(resolvedPath, { recursive: true });
    return { success: true, path: dirPath };
  } catch (err) {
    return { error: `创建目录失败 ${dirPath}: ${err.message}` };
  }
}

async function listDirectory(params, context) {
  const dirPath = params.dirPath || '.';
  const projectDir = context.projectDir;
  const resolvedPath = path.resolve(projectDir, dirPath);

  if (!isPathSafe(resolvedPath, projectDir)) {
    return { error: `访问被拒绝: 路径超出项目目录 (${dirPath})` };
  }

  try {
    let dirStat;
    try {
      dirStat = await fsp.stat(resolvedPath);
    } catch {
      return { error: `目录不存在: ${dirPath}` };
    }
    if (!dirStat.isDirectory()) {
      return { error: `不是目录: ${dirPath}` };
    }

    const maxDepth = params.maxDepth || 2;
    const recursive = params.recursive || false;
    const pattern = params.pattern;

    const scanDir = async (dirPath, depth) => {
      if (depth > maxDepth) {return [];}

      const entries = await fsp.readdir(dirPath, { withFileTypes: true });
      const result = [];

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const relativePath = path.relative(projectDir, fullPath);

        if (entry.name === 'node_modules' || entry.name === '.git') {continue;}

        if (pattern && depth === 0) {
          if (!minimatch(entry.name, pattern)) {continue;}
        }

        if (entry.isDirectory()) {
          const children = recursive ? await scanDir(fullPath, depth + 1) : [];
          result.push({
            name: entry.name,
            path: relativePath,
            type: 'directory',
            children: children.length > 0 ? children : undefined,
          });
        } else {
          result.push({
            name: entry.name,
            path: relativePath,
            type: 'file',
            size: 0,
          });
        }
      }

      // 排序：目录在前，文件在后
      result.sort((a, b) => {
        if (a.type === b.type) {return a.name.localeCompare(b.name);}
        return a.type === 'directory' ? -1 : 1;
      });

      return result;
    };

    const entries = await scanDir(resolvedPath, 0);

    return {
      path: dirPath,
      entries,
      totalFiles: entries.filter((e) => e.type === 'file').length,
      totalDirs: entries.filter((e) => e.type === 'directory').length,
    };
  } catch (err) {
    return { error: `读取目录失败 ${dirPath}: ${err.message}` };
  }
}

async function globFiles(params, context) {
  const { pattern, ignore } = params;
  const cwd = params.cwd || '.';
  const projectDir = context.projectDir;
  const resolvedCwd = path.resolve(projectDir, cwd);

  if (!isPathSafe(resolvedCwd, projectDir)) {
    return { error: `访问被拒绝: 路径超出项目目录 (${cwd})` };
  }

  try {
    const glob = require('glob');
    const files = await glob.glob(pattern, {
      cwd: resolvedCwd,
      ignore: ignore || ['node_modules/**', '.git/**'],
      nodir: true,
    });

    return {
      pattern,
      cwd,
      files: files.map((f) => ({
        path: f,
        fullPath: path.resolve(resolvedCwd, f),
      })),
      count: files.length,
    };
  } catch (err) {
    return { error: `glob 搜索失败: ${err.message}` };
  }
}

async function searchInFiles(params, context) {
  const { pattern, include, maxResults, contextLines } = params;
  const cwd = params.cwd || '.';
  const projectDir = context.projectDir;
  const resolvedCwd = path.resolve(projectDir, cwd);

  if (!isPathSafe(resolvedCwd, projectDir)) {
    return { error: `访问被拒绝: 路径超出项目目录 (${cwd})` };
  }

  try {
    const results = [];
    const max = maxResults || 50;
    const ctx = contextLines || 0;
    const regex = new RegExp(pattern, 'gi');

    const searchFile = async (filePath) => {
      if (results.length >= max) {return;}

      // 跳过二进制文件和大文件的最小化检查
      let stat;
      try {
        stat = await fsp.stat(filePath);
      } catch { return; }
      if (stat.size > 1024 * 1024) {return;}

      let content;
      try {
        content = await fsp.readFile(filePath, 'utf8');
      } catch { return; }
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        if (results.length >= max) {break;}

        if (regex.test(lines[i])) {
          const match = {
            file: path.relative(projectDir, filePath),
            line: i + 1,
            content: lines[i].trim(),
          };

          // 添加上下文
          if (ctx > 0) {
            match.context = {
              before: lines.slice(Math.max(0, i - ctx), i),
              after: lines.slice(i + 1, i + 1 + ctx),
            };
          }

          results.push(match);
        }

        regex.lastIndex = 0;
      }
    };

    const walkDir = async (dir) => {
      if (results.length >= max) {return;}

      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch { return; }

      for (const entry of entries) {
        if (results.length >= max) {break;}

        const fullPath = path.join(dir, entry.name);

        if (entry.name === 'node_modules' || entry.name === '.git') {continue;}

        if (entry.isDirectory()) {
          await walkDir(fullPath);
        } else {
          if (include) {
            if (!minimatch(entry.name, include)) {continue;}
          }

          await searchFile(fullPath);
        }
      }
    };

    await walkDir(resolvedCwd);

    return {
      pattern,
      results,
      count: results.length,
      truncated: results.length >= max,
    };
  } catch (err) {
    return { error: `搜索失败: ${err.message}` };
  }
}

async function moveFile(params, context) {
  const { source, destination, overwrite } = params;
  const projectDir = context.projectDir;
  const resolvedSource = path.resolve(projectDir, source);
  const resolvedDest = path.resolve(projectDir, destination);

  if (context.planModeRestricted) {
    return { error: '计划模式下禁止移动/重命名文件' };
  }

  if (!isPathSafe(resolvedSource, projectDir)) {
    return { error: `访问被拒绝: 源路径超出项目目录 (${source})` };
  }
  if (!isPathSafe(resolvedDest, projectDir)) {
    return { error: `访问被拒绝: 目标路径超出项目目录 (${destination})` };
  }

  try {
    try {
      await fsp.access(resolvedSource, fs.constants.F_OK);
    } catch {
      return { error: `源文件不存在: ${source}` };
    }

    try {
      await fsp.access(resolvedDest, fs.constants.F_OK);
      if (!overwrite) {
        return { error: `目标已存在: ${destination}。设置 overwrite=true 覆盖` };
      }
    } catch {
    }

    // 确保目标父目录存在
    await fsp.mkdir(path.dirname(resolvedDest), { recursive: true });

    await fsp.rename(resolvedSource, resolvedDest);

    return {
      success: true,
      source,
      destination,
    };
  } catch (err) {
    return { error: `移动文件失败: ${err.message}` };
  }
}

function registerFileTools(registry) {
  registry.register({
    name: 'read_file',
    description: '读取文件内容。大文件可指定 maxLines 分段读取，二进制文件仅返回文件名。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '文件路径（相对项目根目录）' },
        offset: { type: 'number', description: '起始行数（可选）' },
        maxLines: { type: 'number', description: '最大读取行数（可选，大文件时使用）' },
      },
      required: ['filePath'],
    },
    execute: readFile,
    requiresConfirm: false,
  });

  registry.register({
    name: 'write_file',
    description: '创建或修改文件。AI 自动判断追加(append)或覆盖(overwrite)模式。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '文件路径（相对项目根目录）' },
        content: { type: 'string', description: '文件内容' },
        mode: {
          type: 'string',
          enum: ['overwrite', 'append'],
          description: '写入模式: overwrite 覆盖, append 追加',
        },
      },
      required: ['filePath', 'content'],
    },
    execute: writeFile,
    requiresConfirm: true,
  });

  registry.register({
    name: 'delete_file',
    description: '删除文件。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '文件路径（相对项目根目录）' },
      },
      required: ['filePath'],
    },
    execute: deleteFile,
    requiresConfirm: true,
  });

  registry.register({
    name: 'create_directory',
    description: '创建新的目录。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径（相对项目根目录）' },
      },
      required: ['path'],
    },
    execute: createDirectory,
    requiresConfirm: true,
  });

  registry.register({
    name: 'edit_file',
    description: '精确编辑文件（搜索替换）。指定旧内容和新内容，自动定位并替换。比 write_file 更精确，适合修改文件的特定部分。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '文件路径（相对项目根目录）' },
        oldString: { type: 'string', description: '要替换的旧内容（必须与文件内容完全一致，包括缩进和换行）' },
        newString: { type: 'string', description: '替换后的新内容' },
        replaceAll: { type: 'boolean', description: '是否替换所有匹配（默认 false，只替换第一个）' },
      },
      required: ['filePath', 'oldString', 'newString'],
    },
    execute: editFile,
    requiresConfirm: false,
  });

  registry.register({
    name: 'list_directory',
    description: '列出目录内容，支持递归遍历。用于了解项目结构。',
    parameters: {
      type: 'object',
      properties: {
        dirPath: { type: 'string', description: '目录路径（默认当前目录）' },
        recursive: { type: 'boolean', description: '是否递归遍历子目录（默认 false）' },
        maxDepth: { type: 'number', description: '最大递归深度（默认 2）' },
        pattern: { type: 'string', description: '过滤模式，如 *.js' },
      },
    },
    execute: listDirectory,
    requiresConfirm: false,
  });

  registry.register({
    name: 'glob_files',
    description: '按模式匹配查找文件。支持 **/*.js 等 glob 模式。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式，如 **/*.js' },
        cwd: { type: 'string', description: '搜索根目录（默认当前目录）' },
        ignore: { type: 'array', items: { type: 'string' }, description: '忽略的模式' },
      },
      required: ['pattern'],
    },
    execute: globFiles,
    requiresConfirm: false,
  });

  registry.register({
    name: 'search_in_files',
    description: '在多个文件中搜索内容（类似 grep）。支持正则表达式。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '搜索模式（支持正则）' },
        include: { type: 'string', description: '文件过滤，如 *.js' },
        cwd: { type: 'string', description: '搜索根目录（默认当前目录）' },
        maxResults: { type: 'number', description: '最大结果数（默认 50）' },
        contextLines: { type: 'number', description: '显示匹配行的上下文行数（默认 0）' },
      },
      required: ['pattern'],
    },
    execute: searchInFiles,
    requiresConfirm: false,
  });

  registry.register({
    name: 'move_file',
    description: '移动或重命名文件/目录。',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: '源路径' },
        destination: { type: 'string', description: '目标路径' },
        overwrite: { type: 'boolean', description: '是否覆盖已存在文件（默认 false）' },
      },
      required: ['source', 'destination'],
    },
    execute: moveFile,
    requiresConfirm: true,
  });
}

module.exports = {
  readFile,
  writeFile,
  editFile,
  deleteFile,
  createDirectory,
  listDirectory,
  globFiles,
  searchInFiles,
  moveFile,
  registerFileTools,
  isPathSafe,
  _clearRealpathCache, // 测试用：清空 realpath 缓存
};

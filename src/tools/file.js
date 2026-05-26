'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { generateDiff } = require('../ui/diff');
const { minimatch } = require('minimatch');

function isPathSafe(targetPath, projectDir) {
  const relative = path.relative(projectDir, targetPath);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

const MAX_FILE_READ_SIZE = 2 * 1024 * 1024; // 2MB — 大文件安全读取上限

async function readFile(params, context) {
  const { filePath } = params;
  const projectDir = context.projectDir;
  const resolvedPath = path.resolve(projectDir, filePath);

  // 安全校验
  if (!isPathSafe(resolvedPath, projectDir)) {
    return { error: `访问被拒绝: 路径超出项目目录 (${filePath})` };
  }

  try {
    // 异步打开文件，失败抛 ENOENT
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

    // 二进制文件检测（读取前512字节检查 \0）
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

    // 处理大文件：如果有 maxLines 或 offset/limit，分段读取
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

  // 安全校验
  if (!isPathSafe(resolvedPath, projectDir)) {
    return { error: `访问被拒绝: 路径超出项目目录 (${filePath})` };
  }

  try {
    // 确保父目录存在
    await fsp.mkdir(path.dirname(resolvedPath), { recursive: true });

    // 文件冲突检测（P1: mtime 检查）
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

    // 写入
    const writeMode = mode === 'append' ? 'a' : 'w';
    await fsp.writeFile(resolvedPath, content, { encoding: 'utf8', flag: writeMode });

    // 记录时间戳用于冲突检测
    if (context.fileTimestamps) {
      context.fileTimestamps[filePath] = Date.now();
    }

    const stat = await fsp.stat(resolvedPath);
    return {
      success: true,
      filePath,
      mode: writeMode === 'a' ? 'append' : 'overwrite',
      size: stat.size,
      timestamp: stat.mtimeMs,
    };
  } catch (err) {
    return { error: `写入文件失败 ${filePath}: ${err.message}` };
  }
}

async function editFile(params, context) {
  const { filePath, oldString, newString, replaceAll } = params;
  const projectDir = context.projectDir;
  const resolvedPath = path.resolve(projectDir, filePath);

  // 计划模式下禁止编辑文件
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

    // 单次遍历：查找所有匹配位置（替代 split 计数 + 循环查找 + 再次 indexOf 的三次扫描）
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
      // 找到所有匹配位置的行号
      const matchLines = positions.map(idx =>
        content.substring(0, idx).split('\n').length
      );

      return {
        error: `找到 ${count} 处匹配（行: ${matchLines.join(', ')}）。请提供更多上下文缩小范围，或设置 replaceAll=true 替换所有`,
        matchCount: count,
        matchLines,
      };
    }

    // 执行替换
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

    // 写回文件
    await fsp.writeFile(resolvedPath, newContent, 'utf8');

    // 记录时间戳
    if (context.fileTimestamps) {
      context.fileTimestamps[filePath] = Date.now();
    }

    // 计算修改的行范围（复用第一个匹配位置，避免再次 indexOf）
    const beforeLines = content.substring(0, positions[0]).split('\n').length;
    const oldLines = oldString.split('\n').length;
    const newLines = newString.split('\n').length;

    // 生成 diff
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
    };
  } catch (err) {
    return { error: `编辑文件失败 ${filePath}: ${err.message}` };
  }
}

/**
 * 删除文件
 * @param {Object} params
 * @param {string} params.filePath
 * @param {Object} context
 * @returns {Promise<Object>}
 */
async function deleteFile(params, context) {
  const { filePath } = params;
  const projectDir = context.projectDir;
  const resolvedPath = path.resolve(projectDir, filePath);

  // 计划模式下禁止删除文件
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

/**
 * 创建目录
 * @param {Object} params
 * @param {string} params.path - 目录路径
 * @param {Object} context
 * @returns {Promise<Object>}
 */
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

/**
 * 目录列表
 * @param {Object} params
 * @param {string} [params.dirPath='.'] - 目录路径
 * @param {boolean} [params.recursive=false] - 是否递归遍历
 * @param {number} [params.maxDepth=2] - 最大递归深度
 * @param {string} [params.pattern] - 过滤模式（如 *.js）
 * @param {Object} context
 * @returns {Promise<Object>}
 */
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

        // 跳过 node_modules 和 .git
        if (entry.name === 'node_modules' || entry.name === '.git') {continue;}

        // 模式过滤
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

/**
 * 文件名模式匹配搜索（glob）
 * @param {Object} params
 * @param {string} params.pattern - glob 模式（如 **\/*.js）
 * @param {string} [params.cwd] - 搜索根目录
 * @param {string[]} [params.ignore] - 忽略的模式
 * @param {Object} context
 * @returns {Promise<Object>}
 */
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

/**
 * 跨文件内容搜索（类似 grep）
 * @param {Object} params
 * @param {string} params.pattern - 搜索模式（正则）
 * @param {string} [params.include] - 文件过滤（如 *.js）
 * @param {string} [params.cwd] - 搜索根目录
 * @param {number} [params.maxResults=50] - 最大结果数
 * @param {number} [params.contextLines=0] - 上下文行数
 * @param {Object} context
 * @returns {Promise<Object>}
 */
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

      // 跳过二进制文件和大文件
      let stat;
      try {
        stat = await fsp.stat(filePath);
      } catch { return; }
      if (stat.size > 1024 * 1024) {return;} // 跳过 >1MB

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

        // 重置 regex lastIndex
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

        // 跳过 node_modules 和 .git
        if (entry.name === 'node_modules' || entry.name === '.git') {continue;}

        if (entry.isDirectory()) {
          await walkDir(fullPath);
        } else {
          // 文件过滤
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

/**
 * 移动/重命名文件
 * @param {Object} params
 * @param {string} params.source - 源路径
 * @param {string} params.destination - 目标路径
 * @param {boolean} [params.overwrite=false] - 是否覆盖已存在文件
 * @param {Object} context
 * @returns {Promise<Object>}
 */
async function moveFile(params, context) {
  const { source, destination, overwrite } = params;
  const projectDir = context.projectDir;
  const resolvedSource = path.resolve(projectDir, source);
  const resolvedDest = path.resolve(projectDir, destination);

  // 计划模式下禁止移动/重命名文件
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
      // 目标不存在，可以继续
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

/**
 * 注册文件操作工具到 registry
 * @param {Object} registry - ToolRegistry 实例
 */
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
};

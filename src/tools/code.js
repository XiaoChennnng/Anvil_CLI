'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 代码智能工具
 * 基于静态分析实现符号查找、定义跳转、引用查找等
 * 无 LSP 依赖，纯正则解析
 */

/**
 * 安全校验
 */
function isPathSafe(targetPath, projectDir) {
  const relative = path.relative(projectDir, targetPath);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * 解析文件中的符号（函数、类、变量）
 */
function parseSymbols(content, filePath) {
  const lines = content.split('\n');
  const symbols = [];

  const patterns = [
    // 函数声明: function name(...) { ... }
    { regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm, kind: 'function' },
    // 箭头函数/变量函数: const name = (...) => { ... } 或 const name = function(...)
    { regex: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*=>/gm, kind: 'function' },
    { regex: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/gm, kind: 'function' },
    // 类声明: class Name { ... }
    { regex: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/gm, kind: 'class' },
    // 方法定义: name(...) { ... } (在类内部)
    { regex: /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/gm, kind: 'method' },
    // 常量: const NAME = ...
    { regex: /^(?:export\s+)?const\s+(\w+)\s*=/gm, kind: 'constant' },
    // 接口: interface Name { ... }
    { regex: /^(?:export\s+)?interface\s+(\w+)/gm, kind: 'interface' },
    // 类型: type Name = ...
    { regex: /^(?:export\s+)?type\s+(\w+)/gm, kind: 'type' },
    // 枚举: enum Name { ... }
    { regex: /^(?:export\s+)?enum\s+(\w+)/gm, kind: 'enum' },
    // 模块导出: module.exports = { ... }
    { regex: /^module\.exports\s*=/gm, kind: 'export' },
  ];

  for (const { regex, kind } of patterns) {
    let match;
    while ((match = regex.exec(content)) !== null) {
      const name = match[1];
      if (!name) {continue;}

      const lineNum = content.substring(0, match.index).split('\n').length;
      const lineContent = lines[lineNum - 1]?.trim() || '';

      symbols.push({
        name,
        kind,
        line: lineNum,
        column: match.index - content.lastIndexOf('\n', match.index) - 1,
        content: lineContent,
        filePath,
      });
    }
  }

  // 去重（同名同类型的只保留第一个）
  const seen = new Set();
  return symbols.filter((s) => {
    const key = `${s.name}:${s.kind}:${s.line}`;
    if (seen.has(key)) {return false;}
    seen.add(key);
    return true;
  });
}

/**
 * 获取文件中的符号列表
 */
async function getDocumentSymbols(params, context) {
  const { filePath } = params;
  const projectDir = context.projectDir;
  const resolvedPath = path.resolve(projectDir, filePath);

  if (!isPathSafe(resolvedPath, projectDir)) {
    return { error: `访问被拒绝: 路径超出项目目录 (${filePath})` };
  }

  try {
    if (!fs.existsSync(resolvedPath)) {
      return { error: `文件不存在: ${filePath}` };
    }

    const content = fs.readFileSync(resolvedPath, 'utf8');
    const symbols = parseSymbols(content, filePath);

    return {
      filePath,
      symbols,
      count: symbols.length,
    };
  } catch (err) {
    return { error: `解析文件失败: ${err.message}` };
  }
}

/**
 * 查找符号定义位置
 */
async function findDefinition(params, context) {
  const { symbol, include } = params;
  const projectDir = context.projectDir;

  try {
    const results = [];

    function searchFile(filePath) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const symbols = parseSymbols(content, path.relative(projectDir, filePath));

        for (const sym of symbols) {
          if (sym.name === symbol) {
            results.push({
              file: sym.filePath,
              line: sym.line,
              kind: sym.kind,
              content: sym.content,
            });
          }
        }
      } catch {
        // 跳过无法读取的文件
      }
    }

    function walkDir(dir, depth = 0) {
      if (depth > 5 || results.length > 20) {return;}

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.name === 'node_modules' || entry.name === '.git') {continue;}

          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            walkDir(fullPath, depth + 1);
          } else {
            // 文件过滤
            if (include) {
              const ext = path.extname(entry.name);
              const includeExts = include.split(',').map((e) => e.trim().replace('*', ''));
              if (!includeExts.some((e) => ext === e || ext === `.${e}`)) {continue;}
            }

            // 只搜索代码文件
            const ext = path.extname(entry.name);
            if (['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'].includes(ext)) {
              searchFile(fullPath);
            }
          }
        }
      } catch {
        // 跳过无法读取的目录
      }
    }

    walkDir(projectDir);

    return {
      symbol,
      definitions: results,
      count: results.length,
    };
  } catch (err) {
    return { error: `查找定义失败: ${err.message}` };
  }
}

/**
 * 查找符号的所有引用
 */
async function findReferences(params, context) {
  const { symbol, include, maxResults } = params;
  const projectDir = context.projectDir;
  const max = maxResults || 50;

  try {
    const results = [];
    const regex = new RegExp(`\\b${escapeRegex(symbol)}\\b`, 'g');

    function searchFile(filePath) {
      if (results.length >= max) {return;}

      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        const relativePath = path.relative(projectDir, filePath);

        for (let i = 0; i < lines.length; i++) {
          if (results.length >= max) {break;}

          if (regex.test(lines[i])) {
            results.push({
              file: relativePath,
              line: i + 1,
              content: lines[i].trim(),
            });
          }
          regex.lastIndex = 0;
        }
      } catch {
        // 跳过无法读取的文件
      }
    }

    function walkDir(dir, depth = 0) {
      if (depth > 5 || results.length >= max) {return;}

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (results.length >= max) {break;}
          if (entry.name === 'node_modules' || entry.name === '.git') {continue;}

          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            walkDir(fullPath, depth + 1);
          } else {
            if (include) {
              const ext = path.extname(entry.name);
              const includeExts = include.split(',').map((e) => e.trim().replace('*', ''));
              if (!includeExts.some((e) => ext === e || ext === `.${e}`)) {continue;}
            }

            const ext = path.extname(entry.name);
            if (['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'].includes(ext)) {
              searchFile(fullPath);
            }
          }
        }
      } catch {
        // 跳过无法读取的目录
      }
    }

    walkDir(projectDir);

    return {
      symbol,
      references: results,
      count: results.length,
      truncated: results.length >= max,
    };
  } catch (err) {
    return { error: `查找引用失败: ${err.message}` };
  }
}

/**
 * 获取符号的类型/文档信息
 */
async function getHoverInfo(params, context) {
  const { filePath, line, column } = params;
  const projectDir = context.projectDir;
  const resolvedPath = path.resolve(projectDir, filePath);

  if (!isPathSafe(resolvedPath, projectDir)) {
    return { error: `访问被拒绝: 路径超出项目目录 (${filePath})` };
  }

  try {
    if (!fs.existsSync(resolvedPath)) {
      return { error: `文件不存在: ${filePath}` };
    }

    const content = fs.readFileSync(resolvedPath, 'utf8');
    const lines = content.split('\n');

    if (line < 1 || line > lines.length) {
      return { error: `行号超出范围: ${line}（文件共 ${lines.length} 行）` };
    }

    const targetLine = lines[line - 1];
    const symbols = parseSymbols(content, filePath);

    // 查找当前行的符号
    const lineSymbols = symbols.filter((s) => s.line === line);

    // 查找光标位置的单词
    const wordMatch = targetLine.substring(Math.max(0, column - 1)).match(/^(\w+)/);
    const word = wordMatch ? wordMatch[1] : null;

    // 查找该符号的定义
    let definition = null;
    if (word) {
      for (const sym of symbols) {
        if (sym.name === word) {
          definition = sym;
          break;
        }
      }
    }

    return {
      line,
      column,
      content: targetLine.trim(),
      word,
      symbolsOnLine: lineSymbols,
      definition: definition
        ? {
            file: definition.filePath,
            line: definition.line,
            kind: definition.kind,
            content: definition.content,
          }
        : null,
    };
  } catch (err) {
    return { error: `获取信息失败: ${err.message}` };
  }
}

/**
 * 分析文件依赖关系
 */
async function analyzeDependencies(params, context) {
  const { filePath } = params;
  const projectDir = context.projectDir;
  const resolvedPath = path.resolve(projectDir, filePath);

  if (!isPathSafe(resolvedPath, projectDir)) {
    return { error: `访问被拒绝: 路径超出项目目录 (${filePath})` };
  }

  try {
    if (!fs.existsSync(resolvedPath)) {
      return { error: `文件不存在: ${filePath}` };
    }

    const content = fs.readFileSync(resolvedPath, 'utf8');
    const relativePath = path.relative(projectDir, resolvedPath);

    // 解析 require 和 import
    const requires = [];
    const imports = [];

    // require('xxx') 或 require("xxx")
    const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let match;
    while ((match = requireRegex.exec(content)) !== null) {
      const dep = match[1];
      const lineNum = content.substring(0, match.index).split('\n').length;
      requires.push({
        module: dep,
        line: lineNum,
        isRelative: dep.startsWith('.') || dep.startsWith('/'),
        resolvedPath: dep.startsWith('.') ? path.resolve(path.dirname(resolvedPath), dep) : null,
      });
    }

    // import ... from 'xxx'
    const importRegex = /import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g;
    while ((match = importRegex.exec(content)) !== null) {
      const dep = match[1];
      const lineNum = content.substring(0, match.index).split('\n').length;
      imports.push({
        module: dep,
        line: lineNum,
        isRelative: dep.startsWith('.') || dep.startsWith('/'),
        resolvedPath: dep.startsWith('.') ? path.resolve(path.dirname(resolvedPath), dep) : null,
      });
    }

    // 分析被依赖（谁引用了这个文件）
    const dependents = [];
    const targetRel = relativePath.replace(/\\/g, '/').replace(/\.(js|ts|jsx|tsx)$/, '');

    function searchForDependants(dir, depth = 0) {
      if (depth > 4) {return;}

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.name === 'node_modules' || entry.name === '.git') {continue;}

          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            searchForDependants(fullPath, depth + 1);
          } else if (/\.(js|ts|jsx|tsx)$/.test(entry.name)) {
            try {
              const fileContent = fs.readFileSync(fullPath, 'utf8');
              const fileRel = path.relative(projectDir, fullPath).replace(/\\/g, '/');

              if (fileRel === relativePath.replace(/\\/g, '/')) {continue;}

              // 检查是否引用了目标文件
              const patterns = [
                `require('${targetRel}')`,
                `require("./${targetRel}")`,
                `require('../${targetRel}')`,
                `from '${targetRel}'`,
                `from "./${targetRel}"`,
                `from '../${targetRel}'`,
              ];

              for (const pattern of patterns) {
                if (fileContent.includes(pattern)) {
                  dependents.push({
                    file: fileRel,
                    pattern: pattern.substring(0, 50),
                  });
                  break;
                }
              }
            } catch {
              // 跳过
            }
          }
        }
      } catch {
        // 跳过
      }
    }

    searchForDependants(projectDir);

    return {
      file: relativePath,
      requires,
      imports,
      dependents,
      summary: {
        totalDependencies: requires.length + imports.length,
        totalDependents: dependents.length,
        externalModules: [...new Set([...requires, ...imports].filter((d) => !d.isRelative).map((d) => d.module))],
      },
    };
  } catch (err) {
    return { error: `分析依赖失败: ${err.message}` };
  }
}

/**
 * 代码格式化（简化版，使用 prettier 如果可用）
 */
async function formatCode(params, context) {
  const { filePath, parser } = params;
  const projectDir = context.projectDir;
  const resolvedPath = path.resolve(projectDir, filePath);

  if (!isPathSafe(resolvedPath, projectDir)) {
    return { error: `访问被拒绝: 路径超出项目目录 (${filePath})` };
  }

  try {
    if (!fs.existsSync(resolvedPath)) {
      return { error: `文件不存在: ${filePath}` };
    }

    const content = fs.readFileSync(resolvedPath, 'utf8');

    // 尝试使用 prettier
    try {
      const prettier = require('prettier');
      const ext = path.extname(filePath);
      const inferredParser = parser || {
        '.js': 'babel',
        '.jsx': 'babel',
        '.ts': 'typescript',
        '.tsx': 'typescript',
        '.json': 'json',
        '.css': 'css',
        '.html': 'html',
        '.md': 'markdown',
      }[ext] || 'babel';

      const formatted = await prettier.format(content, {
        parser: inferredParser,
        semi: true,
        singleQuote: true,
        trailingComma: 'es5',
        printWidth: 100,
      });

      if (formatted === content) {
        return {
          filePath,
          changed: false,
          message: '文件已经格式化，无需修改',
        };
      }

      fs.writeFileSync(resolvedPath, formatted, 'utf8');

      return {
        filePath,
        changed: true,
        originalSize: content.length,
        formattedSize: formatted.length,
        saved: content.length - formatted.length,
      };
    } catch (prettierErr) {
      // prettier 不可用，返回提示
      return {
        filePath,
        changed: false,
        error: `Prettier 不可用: ${prettierErr.message}`,
        hint: '请安装 prettier: npm install prettier --save-dev',
      };
    }
  } catch (err) {
    return { error: `格式化失败: ${err.message}` };
  }
}

/**
 * 转义正则特殊字符
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 注册代码智能工具
 */
function registerCodeTools(registry) {
  registry.register({
    name: 'get_document_symbols',
    description: '获取文件中的符号列表（函数、类、变量、接口等）。用于快速了解文件结构。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '文件路径（相对项目根目录）' },
      },
      required: ['filePath'],
    },
    execute: getDocumentSymbols,
    requiresConfirm: false,
  });

  registry.register({
    name: 'find_definition',
    description: '查找符号的定义位置。在项目中搜索函数、类、变量的定义。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '要查找的符号名称' },
        include: { type: 'string', description: '文件类型过滤（如 .js,.ts）' },
      },
      required: ['symbol'],
    },
    execute: findDefinition,
    requiresConfirm: false,
  });

  registry.register({
    name: 'find_references',
    description: '查找符号的所有引用位置。找出项目中所有使用该符号的地方。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '要查找的符号名称' },
        include: { type: 'string', description: '文件类型过滤（如 .js,.ts）' },
        maxResults: { type: 'number', description: '最大结果数（默认 50）' },
      },
      required: ['symbol'],
    },
    execute: findReferences,
    requiresConfirm: false,
  });

  registry.register({
    name: 'get_hover_info',
    description: '获取指定位置的符号信息（类型、定义等）。类似 IDE 的悬停提示。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '文件路径' },
        line: { type: 'number', description: '行号（1-based）' },
        column: { type: 'number', description: '列号（1-based）' },
      },
      required: ['filePath', 'line', 'column'],
    },
    execute: getHoverInfo,
    requiresConfirm: false,
  });

  registry.register({
    name: 'analyze_dependencies',
    description: '分析文件的依赖关系（require/import）和被依赖关系。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '文件路径' },
      },
      required: ['filePath'],
    },
    execute: analyzeDependencies,
    requiresConfirm: false,
  });

  registry.register({
    name: 'format_code',
    description: '格式化代码文件（使用 Prettier）。自动检测文件类型。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '文件路径' },
        parser: { type: 'string', description: '解析器类型（可选，自动检测）' },
      },
      required: ['filePath'],
    },
    execute: formatCode,
    requiresConfirm: true,
  });
}

module.exports = {
  getDocumentSymbols,
  findDefinition,
  findReferences,
  getHoverInfo,
  analyzeDependencies,
  formatCode,
  registerCodeTools,
  parseSymbols,
};

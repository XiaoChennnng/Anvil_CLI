'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');

// 模块级缓存 detectShell 结果，避免每次 executeCommand 都重新检测
let _cachedShell = null;

function detectShell() {
  if (_cachedShell) {return _cachedShell;}

  if (process.platform !== 'win32') {
    _cachedShell = process.env.SHELL || '/bin/bash';
    return _cachedShell;
  }

  // Git Bash
  const shell = process.env.SHELL;
  if (shell && shell.includes('bash')) {
    _cachedShell = shell;
    return _cachedShell;
  }

  // PowerShell
  const psPath = path.join(process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (fs.existsSync(psPath)) {
    _cachedShell = psPath;
    return _cachedShell;
  }

  // cmd.exe
  _cachedShell = process.env.COMSPEC || 'cmd.exe';
  return _cachedShell;
}

/**
 * 将 GBK/GB2312/GB18030 编码的 Buffer 转换为 UTF-8
 */
function convertEncoding(buffer, fallbackEncoding = 'gbk') {
  // 首先尝试 UTF-8
  try {
    const utf8Str = buffer.toString('utf8');
    // 检查是否是有效的 UTF-8（没有替换字符）
    if (!utf8Str.includes('\uFFFD')) {
      return utf8Str;
    }
  } catch {}

  // 回退到 GBK（Windows 中文默认编码）
  try {
    const iconv = require('iconv-lite');
    return iconv.decode(buffer, 'gbk');
  } catch {
    // iconv-lite 不可用，使用原生方式
    return buffer.toString('latin1');
  }
}

function executeCommand(params, context) {
  return new Promise((resolve) => {
    const { command, timeout } = params;
    const cwd = params.cwd || context.projectDir;
    const logger = context.logger;
    const maxDisplayLines = context.maxOutputLines || 50;

    if (!command || !command.trim()) {
      return resolve({ error: '命令不能为空' });
    }

    const shell = detectShell();
    const shellFlag = process.platform === 'win32' ? '/c' : '-c';

    // Windows 下 cmd.exe 用 /c，PowerShell 用 -Command
    const isPowerShell = shell && shell.toLowerCase().includes('powershell');
    const cmdFlag = isPowerShell ? '-Command' : shellFlag;

    const proc = spawn(shell, [cmdFlag, command], {
      cwd,
      env: {
        ...process.env,
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    const displayLines = [];
    let timedOut = false;
    const MAX_OUTPUT_LEN = 2000; // stdout/stderr 返回给 AI 的最大字符数
    const MAX_OUTPUT_BUFFER = 100 * 1024; // 100KB — stdout/stderr 内存硬上限

    // 滚动输出状态：累积内容在同一行滚动刷新
    let _scrollLine = '';
    let _scrollTimer = null;

    // 刷新滚动行显示
    const flushScrollLine = () => {
      const cols = process.stdout.columns || 80;
      const display = _scrollLine.length > cols
        ? _scrollLine.slice(-cols)
        : _scrollLine;
      process.stdout.write(`\r${display}${' '.repeat(Math.max(0, cols - display.length))}`);
    };

    // 立即刷新滚动行（防抖）
    const scheduleFlush = () => {
      if (_scrollTimer) {clearTimeout(_scrollTimer);}
      _scrollTimer = setTimeout(() => {
        flushScrollLine();
        _scrollTimer = null;
      }, 50);
    };

    // 实时流式输出（滚动模式）
    if (proc.stdout) {
      proc.stdout.on('data', (data) => {
        const text = convertEncoding(data);
        if (stdout.length < MAX_OUTPUT_BUFFER) {
          stdout += text;
        }

        // 环形缓冲：slice(-n) 替代 push + shift 的 O(n²)
        const lines = text.split('\n');
        for (const line of lines) {
          displayLines.push(line);
        }
        if (displayLines.length > maxDisplayLines) {
          displayLines.splice(0, displayLines.length - maxDisplayLines);
        }

        // 滚动展示：累积到当前行，不换行
        for (const ch of text) {
          if (ch === '\n') {
            // 遇到换行符：输出当前行并清空
            if (_scrollLine) {
              const cols = process.stdout.columns || 80;
              process.stdout.write(`\r${_scrollLine}${' '.repeat(Math.max(0, cols - _scrollLine.length))}\n`);
              _scrollLine = '';
            }
          } else {
            _scrollLine += ch;
            // 限制单行长度，防止刷屏
            const maxScrollLen = (process.stdout.columns || 80) * 2;
            if (_scrollLine.length > maxScrollLen) {
              _scrollLine = _scrollLine.slice(-maxScrollLen);
            }
            scheduleFlush();
          }
        }

        // 触发输出事件（给 AI 上下文用）
        if (context.onOutput) {
          context.onOutput(text, false);
        }
      });
    }

    if (proc.stderr) {
      proc.stderr.on('data', (data) => {
        const text = convertEncoding(data);
        if (stderr.length < MAX_OUTPUT_BUFFER) {
          stderr += text;
        }

        const lines = text.split('\n');
        for (const line of lines) {
          displayLines.push(line);
        }
        if (displayLines.length > maxDisplayLines) {
          displayLines.splice(0, displayLines.length - maxDisplayLines);
        }

        // stderr 也用滚动模式（红色标记）
        for (const ch of text) {
          if (ch === '\n') {
            if (_scrollLine) {
              const cols = process.stdout.columns || 80;
              process.stdout.write(`\r${chalk.red(_scrollLine)}${' '.repeat(Math.max(0, cols - _scrollLine.length))}\n`);
              _scrollLine = '';
            }
          } else {
            _scrollLine += ch;
            const maxScrollLen = (process.stdout.columns || 80) * 2;
            if (_scrollLine.length > maxScrollLen) {
              _scrollLine = _scrollLine.slice(-maxScrollLen);
            }
            scheduleFlush();
          }
        }

        if (context.onOutput) {
          context.onOutput(text, true);
        }
      });
    }

    // 超时处理
    let timer = null;
    if (timeout && timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        // Windows fallback
        if (process.platform === 'win32') {
          setTimeout(() => {
            try { proc.kill('SIGKILL'); } catch {}
          }, 2000);
        }
      }, timeout);
    }

    proc.on('close', (code) => {
      if (timer) {clearTimeout(timer);}
      if (_scrollTimer) {clearTimeout(_scrollTimer);}

      // 关闭前刷新剩余的滚动内容
      if (_scrollLine) {
        const cols = process.stdout.columns || 80;
        process.stdout.write(`\r${_scrollLine}${' '.repeat(Math.max(0, cols - _scrollLine.length))}\n`);
        _scrollLine = '';
      }

      // 截断 stdout/stderr 防止塞爆 AI 上下文
      const trimmedStdout = stdout.trim();
      const trimmedStderr = stderr.trim();
      const truncStdout = trimmedStdout.length > MAX_OUTPUT_LEN
        ? trimmedStdout.slice(0, MAX_OUTPUT_LEN) + `\n... (截断，共 ${trimmedStdout.length} 字符)`
        : trimmedStdout;
      const truncStderr = trimmedStderr.length > MAX_OUTPUT_LEN
        ? trimmedStderr.slice(0, MAX_OUTPUT_LEN) + `\n... (截断，共 ${trimmedStderr.length} 字符)`
        : trimmedStderr;

      const result = {
        command,
        exitCode: code,
        timedOut,
        stdout: truncStdout,
        stderr: timedOut ? `(命令执行超时，已强制终止)\n${truncStderr}` : truncStderr,
        displayOutput: displayLines.join('\n').trim(),
        warning: timedOut ? `命令执行超时（${timeout}ms），已强制终止` : null,
      };

      // 记录到日志（完整内容）
      if (logger) {
        logger.logCommandOutput(command, stdout, stderr);
      }

      resolve(result);
    });

    proc.on('error', (err) => {
      if (timer) {clearTimeout(timer);}
      resolve({
        command,
        error: `命令执行失败: ${err.message}`.slice(0, 500),
        stdout: stdout.trim().slice(0, MAX_OUTPUT_LEN),
        stderr: stderr.trim().slice(0, MAX_OUTPUT_LEN),
      });
    });
  });
}

async function checkCommandExists(command) {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const shell = detectShell();
    const isPowerShell = shell && shell.toLowerCase().includes('powershell');
    const cmdFlag = isPowerShell ? '-Command' : (process.platform === 'win32' ? '/c' : '-c');

    const proc = spawn(shell, [cmdFlag, `${cmd} ${command.split(' ')[0]}`], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.on('close', (code) => {
      resolve(code === 0);
    });
  });
}

/**
 * 注册命令执行工具
 * @param {Object} registry - ToolRegistry 实例
 */
function registerCommandTool(registry) {
  registry.register({
    name: 'execute_command',
    description: '在终端执行命令（异步后台执行，实时显示输出，限制显示最近50行）。需要用户确认后才能执行。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: { type: 'string', description: '工作目录（可选，默认项目目录）' },
        timeout: { type: 'number', description: '超时时间（毫秒，可选）' },
      },
      required: ['command'],
    },
    execute: executeCommand,
    requiresConfirm: true,
  });
}

module.exports = { executeCommand, detectShell, checkCommandExists, registerCommandTool };

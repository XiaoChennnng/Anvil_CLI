'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

function detectShell() {
  if (process.platform !== 'win32') {
    return process.env.SHELL || '/bin/bash';
  }

  // Git Bash
  const shell = process.env.SHELL;
  if (shell && shell.includes('bash')) {
    return shell;
  }

  // PowerShell
  const psPath = path.join(process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (fs.existsSync(psPath)) {
    return psPath;
  }

  // cmd.exe
  return process.env.COMSPEC || 'cmd.exe';
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

    // 实时流式输出
    if (proc.stdout) {
      proc.stdout.on('data', (data) => {
        const text = convertEncoding(data);
        stdout += text;

        // 维护最近 maxDisplayLines 行
        const lines = text.split('\n');
        for (const line of lines) {
          displayLines.push(line);
          if (displayLines.length > maxDisplayLines) {
            displayLines.shift();
          }
        }

        // 触发输出事件
        if (context.onOutput) {
          context.onOutput(text, false);
        }
      });
    }

    if (proc.stderr) {
      proc.stderr.on('data', (data) => {
        const text = convertEncoding(data);
        stderr += text;

        const lines = text.split('\n');
        for (const line of lines) {
          displayLines.push(line);
          if (displayLines.length > maxDisplayLines) {
            displayLines.shift();
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

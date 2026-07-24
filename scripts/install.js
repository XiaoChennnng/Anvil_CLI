#!/usr/bin/env node
'use strict';

/**
 * Anvil 一键安装脚本
 *
 * 流程:
 * 1. 检查 Node 版本
 * 2. 检查 npm 是否可用
 * 3. 检查是否已全局安装
 * 4. 执行 npm link (本地包链接到全局)
 * 5. 验证安装结果
 * 6. 输出使用说明
 */

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// 颜色输出 (不依赖 chalk 以减少依赖)
const c = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
};

const log = {
  info: (msg) => console.log(`${c.blue}ℹ${c.reset} ${msg}`),
  ok: (msg) => console.log(`${c.green}✓${c.reset} ${msg}`),
  warn: (msg) => console.log(`${c.yellow}⚠${c.reset} ${msg}`),
  err: (msg) => console.log(`${c.red}✗${c.reset} ${msg}`),
  step: (n, msg) => console.log(`\n${c.bold}${c.cyan}[${n}]${c.reset} ${c.bold}${msg}${c.reset}`),
};

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      ...opts,
    });
  } catch {
    return null;
  }
}

function checkNodeVersion() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 18) {
    log.err(`Node 版本过低: ${process.versions.node} (需要 >= 18.0.0)`);
    process.exit(1);
  }
  log.ok(`Node ${process.versions.node}`);
}

function checkNpm() {
  const version = run('npm --version');
  if (!version) {
    log.err('npm 不可用, 请先安装 Node.js');
    process.exit(1);
  }
  log.ok(`npm ${version.trim()}`);
}

function getNpmCmd() {
  // Windows 上 spawnSync('npm') 找不到 npm, 需要 .cmd 后缀
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function isAlreadyInstalled() {
  const prefix = run('npm config get prefix');
  if (!prefix) {return false;}
  const installDir = prefix.trim();
  // npm 全局 wrapper 实际放在 prefix/ 下 (Windows 是 prefix\, 不是 prefix/bin/)
  const variants = process.platform === 'win32'
    ? ['anvil.cmd', 'anvil.ps1', 'anvil']
    : ['anvil', 'bin/anvil'];
  return variants.some((f) => fs.existsSync(path.join(installDir, f)));
}

function runNpmLink() {
  // 在 anvil 包根目录执行 npm link
  // Windows 上需要 shell: true 才能执行 .cmd 脚本
  const result = spawnSync(getNpmCmd(), ['link'], {
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..'),
    shell: process.platform === 'win32',
  });
  return result.status === 0;
}

function runNpmInstallGlobal() {
  // 备用方案: npm install -g .
  const result = spawnSync(getNpmCmd(), ['install', '-g', '.'], {
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..'),
    shell: process.platform === 'win32',
  });
  return result.status === 0;
}

function verifyInstall() {
  // 验证 anvil --keys 能否跑
  // Windows 上用 .cmd + shell:true 才能正确传递 PATH
  const anvilCmd = process.platform === 'win32' ? 'anvil.cmd' : 'anvil';
  const result = spawnSync(anvilCmd, ['--keys'], {
    stdio: 'pipe',
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  return result.status === 0;
}

function printUsage() {
  const prefix = run('npm config get prefix');
  const installDir = prefix ? prefix.trim() : null;
  console.log(`\n${c.bold}${c.green}安装成功!${c.reset}\n`);
  console.log(`${c.bold}使用方法:${c.reset}`);
  console.log(`  ${c.cyan}cd /path/to/your/project${c.reset}`);
  console.log(`  ${c.cyan}anvil${c.reset}                    ${c.gray}# 在当前目录启动 Anvil${c.reset}`);
  console.log();
  console.log(`${c.bold}常用选项:${c.reset}`);
  console.log(`  ${c.cyan}anvil -d <path>${c.reset}          ${c.gray}# 指定工作目录${c.reset}`);
  console.log(`  ${c.cyan}anvil -m deepseek-v4-pro${c.reset} ${c.gray}# 指定模型${c.reset}`);
  console.log(`  ${c.cyan}anvil --keys${c.reset}             ${c.gray}# 查看快捷键${c.reset}`);
  console.log(`  ${c.cyan}anvil --help${c.reset}             ${c.gray}# 查看帮助${c.reset}`);
  console.log();

  if (installDir) {
    console.log(`${c.bold}全局安装位置:${c.reset} ${c.gray}${installDir}${c.reset}`);
    // PATH 检查: npm 把 wrapper 放在 prefix/ 下, 用户通常把这个目录加到 PATH
    const pathEnv = process.env.PATH || process.env.Path || '';
    const pathList = pathEnv.split(path.delimiter);
    if (!pathList.some((p) => p === installDir || p.toLowerCase() === installDir.toLowerCase())) {
      log.warn(`全局安装目录不在 PATH 中, 需手动添加:`);
      console.log(`  ${c.gray}${installDir}${c.reset}`);
    } else {
      log.ok('PATH 已配置, 任意目录可直接输入 anvil');
    }
  }

  console.log(`\n${c.bold}卸载:${c.reset}`);
  console.log(`  ${c.cyan}npm unlink -g anvil${c.reset}      ${c.gray}# 卸载全局链接${c.reset}`);
  console.log();
}

function main() {
  console.log(`\n${c.bold}⚒  Anvil 一键安装${c.reset}\n`);

  // [1] 环境检查
  log.step(1, '环境检查');
  checkNodeVersion();
  checkNpm();

  // [2] 检查已安装
  log.step(2, '检查现有安装');
  if (isAlreadyInstalled()) {
    log.warn('Anvil 已经全局安装, 重新链接...');
  } else {
    log.info('未检测到现有安装, 开始安装');
  }

  // [3] 执行安装
  log.step(3, '链接到全局 (npm link)');
  let ok = runNpmLink();

  if (!ok) {
    log.warn('npm link 失败, 尝试 npm install -g .');
    log.step(3, '备选方案: npm install -g .');
    ok = runNpmInstallGlobal();
  }

  if (!ok) {
    log.err('安装失败, 请检查上方 npm 错误信息');
    process.exit(1);
  }
  log.ok('链接完成');

  // [4] 验证
  log.step(4, '验证安装');
  if (verifyInstall()) {
    log.ok('anvil --keys 命令可正常执行');
  } else {
    log.warn('anvil --keys 执行失败, 可能 PATH 未生效');
    log.info('请尝试: 重启终端 / 检查 PATH');
  }

  // [5] 使用说明
  printUsage();
}

main();

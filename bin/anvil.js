#!/usr/bin/env node
'use strict';

/**
 * Anvil CLI 入口
 * AI-driven CLI programming assistant
 */

// 设置进程标题（Windows 上设置窗口标题）
process.title = 'Anvil';

// ============================================================================
// 修复 npm start 启动 cwd 错误的问题
// ============================================================================
// npm 在执行 lifecycle 脚本 (npm start / npm run xxx) 时会把 cwd 切换到
// package.json 所在目录, 这导致用户在 D:\myproject 执行 `npm start` 时,
// Anvil 拿到的 process.cwd() 反而是 Anvil 包根 (D:\Anvil).
//
// npm 提供了 INIT_CWD 环境变量保留用户调用前的原始目录, 用它修正.
// 仅在 npm lifecycle 脚本中生效, 直接 node bin/anvil.js 启动不受影响.
if (process.env.npm_lifecycle_event && process.env.INIT_CWD) {
  try {
    process.chdir(process.env.INIT_CWD);
  } catch {
    // INIT_CWD 不存在等异常情况下, 静默回退到 npm 切换后的 cwd
    // 不抛出错误, 避免影响主流程
  }
}

require('../src/cli/index');

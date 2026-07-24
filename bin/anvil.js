#!/usr/bin/env node
'use strict';

// Anvil CLI 入口

// Windows 上让窗口标题显示 Anvil
process.title = 'Anvil';

// npm start 时 npm 会把 cwd 切到包根，用 INIT_CWD 恢复用户原始目录
if (process.env.npm_lifecycle_event && process.env.INIT_CWD) {
  try {
    process.chdir(process.env.INIT_CWD);
  } catch {
    // 静默回退到 npm 切换后的 cwd，不影响主流程
  }
}

require('../src/cli/index');

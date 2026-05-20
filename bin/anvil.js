#!/usr/bin/env node
'use strict';

/**
 * Anvil CLI 入口
 * AI-driven CLI programming assistant
 */

// 设置进程标题（Windows 上设置窗口标题）
process.title = 'Anvil';

require('../src/cli/index');

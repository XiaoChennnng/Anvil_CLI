'use strict';
const chalk = require('chalk');
if (!chalk.level || chalk.level < 3) {chalk.level = 3;}
const MarkdownRenderer = require('./src/ui/markdown');

const r1 = new MarkdownRenderer(80);
console.log('=== Test 1: 标准 GFM 表格（带 \n）===');
const ok = '| 事件 | 要点 |\n|------|------|\n| 中美关税战升级 | 加征 34% |\n| 俄乌冲突加剧 | 普京提议 |\n';
console.log(JSON.stringify(r1.write(ok)));

console.log('\n=== Test 2: 整段挤一行（无 \n）===');
const r2 = new MarkdownRenderer(80);
const bad = '| 事件 | 要点 | |------|------| | 中美关税战升级 | 加征 34% | | 俄乌冲突加剧 | 普京提议 |';
console.log(JSON.stringify(r2.write(bad)));

console.log('\n=== Test 3: 用户截图里的"国内大事"格式 ===');
const r3 = new MarkdownRenderer(80);
const user = '### 🇨🇳国内大事|事件 |要点 | |------|------| | 神舟二十号发射成功 |4月24日 | | 国产飞机C909老挝首航 |4月12日 |';
console.log(JSON.stringify(r3.write(user)));

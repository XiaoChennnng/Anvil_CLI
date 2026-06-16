'use strict';

const { program } = require('commander');

function setupOptions() {
  program
    .name('anvil')
    .description('AI-driven CLI programming assistant — Forge Code in the Terminal')
    .version('0.1.0-alpha')
    .option('-d, --dir <path>', '工作目录（默认当前目录）')
    .option('-p, --provider <name>', '模型提供商 (deepseek / kimi / openai / anthropic / 自定义)')
    .option('-m, --model <name>', '指定模型 (支持内置和自定义模型)')
    .option('-r, --resume <sessionId>', '恢复之前的会话')
    .option('-k, --keys', '显示快捷键和命令列表')
    .option('--no-thinking', '禁用思考模式')
    .parse(process.argv);

  return program.opts();
}

function showKeyBindings() {
  console.log(`
快捷键:
  Ctrl+C          中断当前 AI 回复
  Ctrl+D          退出 Anvil
  Ctrl+L          清屏
  Ctrl+U          清空当前输入
  ↑/↓             浏览历史输入
  Enter           发送消息
  Ctrl+J          换行（多行模式）

内置命令:
  /review [file]      触发代码审查
  /provider [id]      切换/查看提供商，子命令: add/list/remove
  /model [id]         切换/查看模型，子命令: add/list
  /undo               撤销上一个操作
  /redo               重做上一个操作
  /keys, /shortcuts   查看快捷键和命令
  /clear              清屏
  /help               显示帮助信息
`);
}

module.exports = { setupOptions, showKeyBindings };

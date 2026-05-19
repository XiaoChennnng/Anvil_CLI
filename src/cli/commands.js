'use strict';

const { isValidModel } = require('../ai/models');

const COMMANDS = {
  skills: {
    name: '/skills',
    description: '查看所有已加载的 Skills',
    usage: '/skills',
  },
  review: {
    name: '/review',
    description: '触发代码审查（可指定文件）',
    usage: '/review [file]',
  },
  model: {
    name: '/model',
    description: '切换模型',
    usage: '/model <deepseek-v4-flash | deepseek-v4-pro>',
  },
  undo: {
    name: '/undo',
    description: '撤销上一个操作',
    usage: '/undo',
  },
  redo: {
    name: '/redo',
    description: '重做上一个操作',
    usage: '/redo',
  },
  keys: {
    name: '/keys',
    description: '查看所有快捷键和命令',
    usage: '/keys',
  },
  shortcuts: {
    name: '/shortcuts',
    description: '查看快捷键和命令',
    usage: '/shortcuts',
  },
  clear: {
    name: '/clear',
    description: '清屏',
    usage: '/clear',
  },
  help: {
    name: '/help',
    description: '显示帮助信息',
    usage: '/help',
  },
  todo: {
    name: '/todo',
    description: '管理任务列表',
    usage: '/todo [add <text> | done <id> | clear | list]',
  },
  plan: {
    name: '/plan',
    description: '切换 Plan Mode（计划模式）',
    usage: '/plan',
  },
  compact: {
    name: '/compact',
    description: '手动压缩上下文，释放 token 空间',
    usage: '/compact [keep <aspects>] [/compact light|heavy]',
  },
  mcp: {
    name: '/mcp',
    description: '查看 MCP 服务器状态',
    usage: '/mcp',
  },
};

function isCommand(input) {
  if (!input || !input.startsWith('/')) {return false;}
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  return !!COMMANDS[cmd.slice(1)];
}

async function handleCommand(input, chatEngine, options = {}) {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase().slice(1); // 去掉 /
  const args = parts.slice(1);

  switch (cmd) {
    case 'review': {
      // P1: 触发代码审查
      const fileToReview = args[0] || null;
      const reviewPrompt = fileToReview
        ? `请审查以下文件: ${fileToReview}\n从代码质量、安全性、性能、最佳实践等维度进行分析。`
        : '请审查当前对话涉及的文件，从代码质量、安全性、性能、最佳实践等维度进行分析。';
      return { handled: false, response: reviewPrompt };
    }

    case 'model': {
      const modelName = args[0];
      if (!modelName) {
        return {
          handled: true,
          response: `当前模型: ${chatEngine.model}\n可用模型: deepseek-v4-flash, deepseek-v4-pro\n使用 /model <模型名> 切换`,
        };
      }
      if (!isValidModel(modelName)) {
        return {
          handled: true,
          response: `❌ 未知模型: ${modelName}\n可用模型: deepseek-v4-flash, deepseek-v4-pro`,
        };
      }
      chatEngine.switchModel(modelName);
      return {
        handled: true,
        response: `✅ 已切换到 ${modelName}`,
      };
    }

    case 'undo': {
      // P1: 撤销 - 需要在 chatEngine 中集成 undo 管理器
      return {
        handled: true,
        response: '⏳ /undo 功能开发中（P1 特性）',
      };
    }

    case 'redo': {
      return {
        handled: true,
        response: '⏳ /redo 功能开发中（P1 特性）',
      };
    }

    case 'keys':
    case 'shortcuts': {
      const { showKeyBindings } = require('./options');
      showKeyBindings();
      return { handled: true, response: null };
    }

    case 'clear': {
      console.clear();
      return { handled: true, response: null };
    }

    case 'help': {
      console.log(`
Anvil — AI-driven CLI Programming Assistant

用法:
  anvil                          启动 Anvil
  anvil --dir /path/to/project   指定工作目录
  anvil --model <name>           指定模型
  anvil --resume <id>            恢复会话
  anvil --help                   显示帮助
  anvil --keys                   显示快捷键
  anvil --version                显示版本

使用 ${Object.keys(COMMANDS).map((k) => '/' + k).join(', ')} 等命令

更多信息请查看: /keys
`);
      return { handled: true, response: null };
    }

    case 'todo': {
      const todoManager = options.todoManager;
      if (!todoManager) {
        return { handled: true, response: '❌ Todo 管理器未初始化' };
      }

      const subCmd = (args[0] || 'list').toLowerCase();

      switch (subCmd) {
        case 'add': {
          const text = args.slice(1).join(' ');
          if (!text) {
            return { handled: true, response: '用法: /todo add <任务描述>' };
          }
          const todo = todoManager.add(text);
          return { handled: true, response: `✅ 已添加: ${todo.text}` };
        }

        case 'done':
        case 'complete': {
          const idOrText = args.slice(1).join(' ');
          if (!idOrText) {
            return { handled: true, response: '用法: /todo done <id 或文本>' };
          }
          // 尝试按 ID 完成
          let success = todoManager.complete(idOrText);
          // 如果失败，尝试按文本匹配
          if (!success) {
            success = todoManager.completeByText(idOrText);
          }
          return {
            handled: true,
            response: success ? '✅ 已完成' : '❌ 未找到匹配的任务',
          };
        }

        case 'clear': {
          todoManager.clearAll();
          return { handled: true, response: '✅ 已清空所有任务' };
        }

        case 'list':
        default: {
          const stats = todoManager.getStats();
          const todos = todoManager.getAll();

          if (todos.length === 0) {
            return { handled: true, response: '📋 任务列表为空' };
          }

          let output = `📋 任务列表 (${stats.completed}/${stats.total} 完成)\n\n`;

          for (const todo of todos) {
            const status = todo.completed ? '✅' : '○';
            const id = todo.id.substring(0, 6);
            output += `  ${status} [${id}] ${todo.text}\n`;
          }

          return { handled: true, response: output.trim() };
        }
      }
    }

    case 'plan': {
      const enabled = chatEngine.togglePlanMode();
      return {
        handled: true,
        response: `Plan Mode ${enabled ? '✅ 已开启' : '⏸ 已关闭'}。${enabled ? '复杂任务将先展示计划，等待批准后执行。' : ''}`,
      };
    }

    case 'compact': {
      const chatEngine = options.chatEngine;
      if (!chatEngine || !chatEngine.contextManager) {
        return { handled: true, response: '❌ 对话引擎未初始化' };
      }

      const argStr = args.join(' ').toLowerCase();
      let level = 'auto';
      let keep = ['recent', 'decisions'];

      // 解析参数: /compact keep files,project 或 /compact light 或 /compact keep files
      if (/keep/.test(argStr)) {
        // /compact keep files,project,tools
        const keepPart = argStr.replace(/keep\s*/i, '').trim();
        if (keepPart) {
          const aspects = keepPart.split(/[,，\s]+/).filter(Boolean);
          const validAspects = ['files', 'project', 'recent', 'tools', 'decisions', 'all'];
          const requested = aspects.filter(a => validAspects.includes(a));
          if (requested.length > 0) {
            keep = requested;
          }
        }
      } else if (/light|轻度/.test(argStr)) {
        level = 'light';
      } else if (/medium|中度/.test(argStr)) {
        level = 'medium';
      } else if (/heavy|深度/.test(argStr) || /deep/.test(argStr)) {
        level = 'heavy';
      } else if (/critical|极限/.test(argStr)) {
        level = 'critical';
      }

      try {
        const result = await chatEngine.compactContext({ level, keep });
        const stats = result.stats || {};

        if (stats.compressed) {
          return {
            handled: true,
            response: `✅ 上下文已压缩\n\n级别: ${stats.name || level}\n${stats.beforeTokens.toLocaleString()} → ${stats.afterTokens.toLocaleString()} tokens\n节省 ${stats.savedPercent}%\n保留: ${(stats.preserved || keep).join(', ')}\n${stats.message || ''}`,
          };
        }
        return { handled: true, response: '📊 上下文使用率不高，无需压缩' };
      } catch (err) {
        return { handled: true, response: `❌ 压缩失败: ${err.message}` };
      }
    }

    case 'mcp': {
      const mcpManager = options.mcpManager;
      if (!mcpManager) {
        return { handled: true, response: 'MCP 管理器未初始化' };
      }
      const status = mcpManager.getStatus();
      if (status.length === 0) {
        return { handled: true, response: '没有配置 MCP 服务器\n可使用 /mcp add 或在配置文件 .anvil/config.json 中添加 mcpServers' };
      }
      let output = '';
      for (const s of status) {
        const icon = s.status === 'connected' ? '✅' :
                     s.status === 'connecting' ? '⏳' :
                     s.status === 'error' ? '❌' : '🔴';
        output += `${icon} ${s.name} (${s.status})\n`;
        if (s.error) {output += `  错误: ${s.error}\n`;}
        if (s.tools.length > 0) {
          output += `  工具 (${s.tools.length}): ${s.tools.map(t => t.name).join(', ')}\n`;
        }
        output += '\n';
      }
      return { handled: true, response: output.trim() };
    }

    case 'skills': {
      const toolRegistry = options.toolRegistry;
      if (!toolRegistry) {
        return { handled: true, response: '❌ 工具注册表未初始化' };
      }

      const skills = toolRegistry.listSkills();
      if (skills.length === 0) {
        return {
          handled: true,
          response: '📦 暂无已加载的 Skills\n\n将 Skills 文件放入 .anvil/skills/ 目录即可自动加载\n支持 SKILL.md 文件或 skill-name/SKILL.md 目录结构',
        };
      }

      let output = `📦 已加载 ${skills.length} 个 Skills:\n\n`;
      for (const skill of skills) {
        const triggers = skill.triggers && skill.triggers.length > 0
          ? ` (触发: ${skill.triggers.join(', ')})`
          : '';
        output += `  • ${skill.name}: ${skill.description || '无描述'}${triggers}\n`;
      }
      output += '\n提示：Skills 支持目录结构 - skill-name/SKILL.md';
      return { handled: true, response: output.trim() };
    }

    default: {
      // 未知命令：当作普通消息发送给 AI（PRD 决策 #32）
      return { handled: false, response: input };
    }
  }
}

module.exports = { COMMANDS, isCommand, handleCommand };

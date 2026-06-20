'use strict';

const { isValidModel } = require('../ai/models');
const { isValidProvider, getProviderList, getModelList, getProvider, registerCustomProvider, registerCustomModel, listCustomProviders, listCustomModels, removeCustomProvider } = require('../ai/providers');

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
  provider: {
    name: '/provider',
    description: '切换模型提供商或管理自定义提供商',
    usage: '/provider [id] | /provider add <id> <name> <url> <key> [format] [thinking] | /provider list | /provider remove <id>',
  },
  model: {
    name: '/model',
    description: '切换模型或管理自定义模型',
    usage: '/model [id] | /model add <id> <name> [vision] [thinking] [contextWindow] | /model list',
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
    usage: '/compact [keep <aspects>] [/compact light|medium|heavy|semantic [2w|3w]]',
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

// 解析 /compact 命令中的预算数字（"2w" / "3w" / "20000 tokens" / "2万"）
// 严格限制在 1w-5w 范围内，超出返回 null
function parseCompactBudget(text) {
  if (!text) {return null;}
  let value = null;

  // "2w" / "3.5w" / "1W"
  const wMatch = text.match(/(\d+(?:\.\d+)?)\s*w\b/i);
  if (wMatch) {
    value = Math.round(parseFloat(wMatch[1]) * 10_000);
  } else {
    // "2万" / "3.5万"
    const wanMatch = text.match(/(\d+(?:\.\d+)?)\s*万/);
    if (wanMatch) {
      value = Math.round(parseFloat(wanMatch[1]) * 10_000);
    } else {
      // "20000 tokens" / "30000 tok" / "40000 t"
      const tokMatch = text.match(/(\d{4,6})\s*(?:tokens?|tok|t)\b/i);
      if (tokMatch) {
        value = parseInt(tokMatch[1], 10);
      } else {
        // 纯 4-6 位数字
        const numMatch = text.match(/(\d{4,6})/);
        if (numMatch) {
          value = parseInt(numMatch[1], 10);
        }
      }
    }
  }

  if (value !== null && value >= 10_000 && value <= 50_000) {
    return value;
  }
  return null;
}

async function handleCommand(input, chatEngine, options = {}) {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase().slice(1); // 去掉 /
  const args = parts.slice(1);

  switch (cmd) {
    case 'review': {
      const fileToReview = args[0] || null;
      const reviewPrompt = fileToReview
        ? `请审查以下文件: ${fileToReview}\n从代码质量、安全性、性能、最佳实践等维度进行分析。`
        : '请审查当前对话涉及的文件，从代码质量、安全性、性能、最佳实践等维度进行分析。';
      return { handled: false, response: reviewPrompt };
    }

      case 'provider': {
      const subCmd = args[0];

      // 子命令: add, list, remove, switch(默认)
      if (subCmd === 'add') {
        // /provider add <id> <name> <baseURL> <apiKey> [format] [thinkingMode]
        const [, id, name, baseURL, apiKey, format = 'openai', thinkingMode = 'false'] = args;
        if (!id || !name || !baseURL || !apiKey) {
          return {
            handled: true,
            response: '用法: /provider add <id> <名称> <baseURL> <apiKey> [format:openai|anthropic] [thinkingMode:true|false]\n例: /provider add my-openai "My OpenAI" https://api.openai.com/v1 sk-xxx openai false',
          };
        }
        try {
          registerCustomProvider({
            id,
            name,
            baseURL,
            apiKey,
            format,
            thinkingMode: thinkingMode === 'true',
          });
          return {
            handled: true,
            response: `[完成]已添加自定义提供商: ${name} (${id})\n格式: ${format}\n支持思考模式: ${thinkingMode}`,
          };
        } catch (err) {
          return { handled: true, response: `[失败]添加失败: ${err.message}` };
        }
      }

      if (subCmd === 'list') {
        const customProviders = listCustomProviders();
        if (customProviders.length === 0) {
          return { handled: true, response: '[列表] 暂无自定义提供商' };
        }
        let response = `[列表] 自定义提供商 (${customProviders.length}个):\n\n`;
        for (const p of customProviders) {
          response += `  • ${p.name} (${p.id})\n`;
          response += `    URL: ${p.baseURL}\n`;
          response += `    格式: ${p.format}, 思考模式: ${p.thinkingMode}\n\n`;
        }
        return { handled: true, response };
      }

      if (subCmd === 'remove') {
        const providerId = args[1];
        if (!providerId) {
          return { handled: true, response: '用法: /provider remove <id>' };
        }
        removeCustomProvider(providerId);
        return { handled: true, response: `[完成]已移除自定义提供商: ${providerId}` };
      }

      // 默认: 切换或显示提供商
      const providerId = subCmd;
      if (!providerId) {
        const providers = getProviderList();
        const currentProvider = chatEngine.getProvider?.() || 'deepseek';
        let response = `当前提供商: ${currentProvider}\n\n可用提供商:\n`;
        for (const p of providers) {
          const marker = p.id === currentProvider ? '▶' : ' ';
          response += `  ${marker} ${p.name}\n`;
        }
        response += '\n使用 /provider <id> 切换';
        response += '\n使用 /provider add 添加自定义提供商';
        response += '\n\n注意: openai 和 anthropic 提供商无预设模型，请使用 /model add 添加';
        return { handled: true, response };
      }

      if (!isValidProvider(providerId)) {
        const providers = getProviderList();
        let response = `[失败]未知提供商: ${providerId}\n\n可用提供商:\n`;
        for (const p of providers) {
          response += `  • ${p.name} (${p.id})\n`;
        }
        return { handled: true, response };
      }

      // 切换提供商
      if (chatEngine.switchProvider) {
        chatEngine.switchProvider(providerId);
        const provider = getProvider(providerId);
        return {
          handled: true,
          response: `[完成]已切换到 ${provider.name} (${providerId})\n默认模型: ${provider.defaultModel}\n可用模型: ${Object.keys(provider.models).join(', ')}`,
        };
      }
      return { handled: true, response: '[等待]提供商切换功能开发中' };
    }

    case 'model': {
      const subCmd = args[0];
      const currentProvider = chatEngine.getProvider?.() || 'deepseek';

      // 子命令: add, list
      if (subCmd === 'add') {
        // /model add <id> <name> [vision] [thinkingMode] [contextWindow]
        const [, id, name, vision = 'false', thinkingMode = 'false', contextWindow = '128000'] = args;
        if (!id || !name) {
          return {
            handled: true,
            response: '用法: /model add <id> <名称> [vision:true|false] [thinkingMode:true|false] [contextWindow]\n例: /model add my-model "My Model" true false 128000',
          };
        }
        try {
          const parsedContextWindow = parseInt(contextWindow, 10);
          registerCustomModel({
            id,
            provider: currentProvider,
            name,
            vision: vision === 'true',
            thinkingMode: thinkingMode === 'true',
            contextWindow: Number.isNaN(parsedContextWindow) ? 128_000 : parsedContextWindow,
          });
          return {
            handled: true,
            response: `[完成]已添加自定义模型: ${name} (${id}) 到提供商 ${currentProvider}\n多模态: ${vision}, 思考模式: ${thinkingMode}, 上下文窗口: ${parsedContextWindow.toLocaleString()} tokens`,
          };
        } catch (err) {
          return { handled: true, response: `[失败]添加失败: ${err.message}` };
        }
      }

      if (subCmd === 'list') {
        const customModels = listCustomModels().filter(m => m.provider === currentProvider);
        if (customModels.length === 0) {
          return { handled: true, response: `[列表] 提供商 ${currentProvider} 暂无自定义模型` };
        }
        let response = `[列表] 自定义模型 (${customModels.length}个):\n\n`;
        for (const m of customModels) {
          response += `  • ${m.name} (${m.id})\n`;
          response += `    多模态: ${m.vision}, 思考模式: ${m.thinkingMode}\n`;
          response += `    上下文窗口: ${(m.contextWindow || 128000).toLocaleString()} tokens\n\n`;
        }
        return { handled: true, response };
      }

      // 默认: 切换或显示模型
      const modelName = subCmd;
      const availableModels = getModelList(currentProvider);
      const modelIds = availableModels.map(m => m.id);

      if (!modelName) {
        let response = `当前模型: ${chatEngine.model}\n当前提供商: ${currentProvider}\n\n可用模型:\n`;
        if (availableModels.length === 0) {
          response += '  (暂无模型)\n';
          response += `\n提示: 请使用 /model add 添加模型`;
          if (currentProvider === 'openai') {
            response += '\n例: /model add gpt-4o "GPT-4o" true false';
          } else if (currentProvider === 'anthropic') {
            response += '\n例: /model add claude-3-5-sonnet-20241022 "Claude 3.5 Sonnet" true false';
          }
        } else {
          for (const m of availableModels) {
            const marker = m.id === chatEngine.model ? '▶' : ' ';
            const customMark = m.isCustom ? '[自定义] ' : '';
            response += `  ${marker} ${m.name}${customMark ? ' - ' + customMark : ''}\n`;
          }
          response += '\n使用 /model <模型名> 切换';
          response += '\n使用 /model add 添加自定义模型';
        }
        return { handled: true, response };
      }
      if (!isValidModel(currentProvider, modelName)) {
        return {
          handled: true,
          response: `[失败]未知模型: ${modelName}\n可用模型: ${modelIds.join(', ')}`,
        };
      }
      chatEngine.switchModel(modelName);
      return {
        handled: true,
        response: `[完成]已切换到 ${modelName}`,
      };
    }

    case 'undo': {
      return {
        handled: true,
        response: '[等待]/undo 功能开发中（P1 特性）',
      };
    }

    case 'redo': {
      return {
        handled: true,
        response: '[等待]/redo 功能开发中（P1 特性）',
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
        return { handled: true, response: '[失败]Todo 管理器未初始化' };
      }

      const subCmd = (args[0] || 'list').toLowerCase();

      switch (subCmd) {
        case 'add': {
          const text = args.slice(1).join(' ');
          if (!text) {
            return { handled: true, response: '用法: /todo add <任务描述>' };
          }
          const todo = todoManager.add(text);
          return { handled: true, response: `[完成]已添加: ${todo.text}` };
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
            response: success ? '[完成]已完成' : '[失败]未找到匹配的任务',
          };
        }

        case 'clear': {
          todoManager.clearAll();
          return { handled: true, response: '[完成]已清空所有任务' };
        }

        case 'list':
        default: {
          const stats = todoManager.getStats();
          const todos = todoManager.getAll();

          if (todos.length === 0) {
            return { handled: true, response: '[列表] 任务列表为空' };
          }

          let output = `[列表] 任务列表 (${stats.completed}/${stats.total} 完成)\n\n`;

          for (const todo of todos) {
            const status = todo.completed ? '[完成]' : '○';
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
        response: `Plan Mode ${enabled ? '[完成]已开启' : '[暂停]已关闭'}。${enabled ? '复杂任务将先展示计划，等待批准后执行。' : ''}`,
      };
    }

    case 'compact': {
      const chatEngine = options.chatEngine;
      if (!chatEngine || !chatEngine.contextManager) {
        return { handled: true, response: '[失败]对话引擎未初始化' };
      }

      const argStr = args.join(' ').toLowerCase();
      let level = 'auto';
      let keep = ['recent', 'decisions'];
      let budgetTokens = null;

      if (/keep/.test(argStr)) {
        const keepPart = argStr.replace(/keep\s*/i, '').trim();
        if (keepPart) {
          const aspects = keepPart.split(/[,，\s]+/).filter(Boolean);
          const validAspects = ['files', 'project', 'recent', 'tools', 'decisions', 'all'];
          const requested = aspects.filter(a => validAspects.includes(a));
          if (requested.length > 0) {
            keep = requested;
          }
        }
      } else if (/semantic|语义/.test(argStr)) {
        // 语义压缩：/compact semantic 2w
        level = 'semantic';
        budgetTokens = parseCompactBudget(argStr);
      } else if (/light|轻度/.test(argStr)) {
        level = 'light';
      } else if (/medium|中度/.test(argStr)) {
        level = 'medium';
      } else if (/heavy|深度/.test(argStr) || /deep/.test(argStr)) {
        level = 'heavy';
      } else if (/critical|极限/.test(argStr)) {
        level = 'critical';
      } else {
        // 只有数字（"2w"）也走语义压缩
        const parsedBudget = parseCompactBudget(argStr);
        if (parsedBudget !== null) {
          level = 'semantic';
          budgetTokens = parsedBudget;
        }
      }

      try {
        const compactOptions = { level, keep };
        if (level === 'semantic') {
          compactOptions.budgetTokens = budgetTokens;
          compactOptions.force = true;
          compactOptions.rebuild = true;
        }
        const result = await chatEngine.compactContext(compactOptions);
        const stats = result.stats || {};

        if (stats.compressed) {
          if (level === 'semantic') {
            return {
              handled: true,
              response: `语义压缩完成\n\n级别: 语义预算压缩\n${stats.beforeTokens.toLocaleString()} → ${stats.afterTokens.toLocaleString()} tokens\n预算: ${stats.budget.toLocaleString()} tokens\n节省 ${stats.savedPercent}%\n${stats.rebuilt ? '[完成] System Prompt 已重建' : ''}${stats.fallback ? '\n[警告] 降级: ' + stats.fallback : ''}`,
            };
          }
          return {
            handled: true,
            response: `[完成]上下文已压缩\n\n级别: ${stats.name || level}\n${stats.beforeTokens.toLocaleString()} → ${stats.afterTokens.toLocaleString()} tokens\n节省 ${stats.savedPercent}%\n保留: ${(stats.preserved || keep).join(', ')}\n${stats.message || ''}`,
          };
        }
        if (level === 'semantic' && stats.name === 'SEMANTIC_BUDGET_SKIPPED') {
          return {
            handled: true,
            response: `[统计] 上下文使用率较低 (${stats.beforeTokens.toLocaleString()} tokens, <30%)，跳过语义压缩`,
          };
        }
        return { handled: true, response: '[统计] 上下文使用率不高，无需压缩' };
      } catch (err) {
        return { handled: true, response: `[失败]压缩失败: ${err.message}` };
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
        const icon = s.status === 'connected' ? '[完成]' :
                     s.status === 'connecting' ? '[等待]' :
                     s.status === 'error' ? '[失败]' : '[离线]';
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
        return { handled: true, response: '[失败]工具注册表未初始化' };
      }

      const skills = toolRegistry.listSkills();
      if (skills.length === 0) {
        return {
          handled: true,
          response: '暂无已加载的 Skills\n\n将 Skills 文件放入 .anvil/skills/ 目录即可自动加载\n支持 SKILL.md 文件或 skill-name/SKILL.md 目录结构',
        };
      }

      let output = `已加载 ${skills.length} 个 Skills:\n\n`;
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

'use strict';

const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
// 必须最先设置 chalk.level，否则 cli-highlight 加载时颜色功能被禁用
if (!chalk.level || chalk.level < 3) {
  chalk.level = 3;
}

const { setupOptions, showKeyBindings } = require('./options');
const { isCommand, handleCommand } = require('./commands');
const { loadConfig } = require('../config/loader');
const Logger = require('../config/logger');
const { setupWizard } = require('../config/setup');
const AnvilAIClient = require('../ai/client');
const ToolRegistry = require('../tools/registry');
const { registerFileTools } = require('../tools/file');
const { registerCommandTool } = require('../tools/command');
const { registerCodeTools } = require('../tools/code');
const { registerTodoTools } = require('../tools/todo');
const { registerMCPTools } = require('../tools/mcp');
const MCPManager = require('../mcp/manager');
const { wireMCPEvents } = require('../mcp/integration');
const { ContextManager } = require('../core/context');
const ChatEngine = require('../core/chat');
const TUI = require('../ui/tui');
const { showLogo } = require('../ui/logo');
const { getModel } = require('../ai/models');

async function main() {
  const cliOptions = setupOptions();

  if (cliOptions.keys) {
    showKeyBindings();
    process.exit(0);
  }

  const { config, projectDir, isFirstRun } = loadConfig(cliOptions);

  const projectName = path.basename(projectDir);
  showLogo({ projectName });

  let currentProjectDir = projectDir;
  if (isFirstRun) {
    const setupResult = await setupWizard({ projectDir });
    currentProjectDir = setupResult.projectDir;

    const reloaded = loadConfig({ ...cliOptions, dir: currentProjectDir });
    Object.assign(config, reloaded.config);
  }

  const anvilDir = path.join(currentProjectDir, '.anvil');
  fs.mkdirSync(anvilDir, { recursive: true });
  fs.mkdirSync(path.join(anvilDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(anvilDir, 'logs'), { recursive: true });

  const logger = new Logger(path.join(anvilDir, 'logs')).init();
  logger.info('Anvil 启动', {
    projectDir: currentProjectDir,
    model: config.defaultModel,
  });

  const toolRegistry = new ToolRegistry();
  registerFileTools(toolRegistry);
  registerCommandTool(toolRegistry);
  registerCodeTools(toolRegistry);
  registerTodoTools(toolRegistry);
  const { registerQuestionTool } = require('../tools/question');
  registerQuestionTool(toolRegistry);
  const { registerTaskCompleteTool } = require('../tools/task_complete');
  const { registerPlanModeTools } = require('../tools/plan_mode');
  logger.debug('工具注册完成', { tools: toolRegistry.list() });

  const mcpManager = new MCPManager(config, logger);
  wireMCPEvents(toolRegistry, mcpManager, logger);
  registerMCPTools(toolRegistry, mcpManager, config, logger);

  mcpManager.start().then(() => {
    const status = mcpManager.getStatus();
    const connected = status.filter(s => s.status === 'connected').length;
    if (status.length > 0) {
      logger.info(`MCP 初始化完成: ${connected}/${status.length} 服务器已连接`);
    }
  }).catch(err => {
    logger.warn('MCP 启动失败', err.message);
  });

  let contextToolsRegistered = false;
  function ensureContextToolsRegistered() {
    if (!contextToolsRegistered && chatEngine) {
      const { registerContextTools } = require('../tools/context');
      registerContextTools(toolRegistry, chatEngine, logger);
      contextToolsRegistered = true;
      logger.debug('上下文管理工具注册完成');
    }
  }

  const TodoManager = require('../core/todo');
  const todoManager = new TodoManager({ projectDir: currentProjectDir });
  registerTaskCompleteTool(toolRegistry, todoManager);

  const aiClient = new AnvilAIClient(config);

  const contextManager = new ContextManager({
    ...config,
    projectDir: currentProjectDir,
  });

  const chatEngine = new ChatEngine({
    config: { ...config, projectDir: currentProjectDir },
    aiClient,
    toolRegistry,
    contextManager,
    logger,
    todoManager,
  });

  ensureContextToolsRegistered();

  // 注册 Plan Mode 工具（在 chatEngine 创建后）
  registerPlanModeTools(toolRegistry, chatEngine);

  const tui = new TUI(config);

  let thinkingStarted = false;
  let contentStarted = false;
  let pendingContextBuffer = '';

  // Plan Mode 状态变化
  chatEngine.on('plan_mode_changed', (enabled) => {
    tui.statusBar.setPlanMode(enabled);
    tui._refreshStatusBar();
  });

  chatEngine.on('thinking_start', () => {
    if (!thinkingStarted) {
      tui.renderThinkingStart();
      thinkingStarted = true;
    }
  });

  chatEngine.on('thinking', (chunk) => {
    tui.renderThinkingChunk(chunk);
  });

  chatEngine.on('content', (chunk) => {
    if (!contentStarted) {
      tui.renderContentStart();
      contentStarted = true;
    }
    tui.renderContentChunk(chunk);
  });

  chatEngine.on('tool_calls', (toolCalls) => {
    if (!contentStarted) {
      tui.renderContentStart();
      contentStarted = true;
    }
    tui.renderToolCall(toolCalls);
  });

  chatEngine.on('tool_result', ({ name, result, toolCall }) => {
    tui.renderToolResult(name, result, toolCall);
  });

  chatEngine.on('command_output', (data, isError) => {
    const t = tui.layout.theme;
    const border = chalk.hex(t.colors.primary)('┃');
    // 按行分割输出，避免多行内容作为单行导致显示溢出
    const lines = data.split('\n');
    for (const line of lines) {
      if (line.trim()) {
        tui.messageBox.renderedLines.push(
          `${border} ${isError ? t.error(line) : line}`
        );
      } else {
        tui.messageBox.renderedLines.push('');
      }
    }
    tui._queueRender();
  });

  chatEngine.on('usage', (usage) => {
    const modelInfo = getModel(chatEngine.model);
    const pricing = modelInfo?.pricing || config.pricing?.[chatEngine.model] || { input: 0.001, output: 0.002 };
    tui.renderTokenUsage(usage, pricing);

    tui.sidebar.updateCacheStats(usage);

    const cacheStats = tui.sidebar.cacheStats;
    const hitRate = cacheStats.totalInputTokens > 0
      ? Math.round((cacheStats.cachedTokens / cacheStats.totalInputTokens) * 100)
      : cacheStats.totalRequests > 0
        ? Math.round((cacheStats.cacheHits / cacheStats.totalRequests) * 100)
        : 0;
    tui.statusBar.setCacheInfo(hitRate, cacheStats.cachedTokens, cacheStats.totalInputTokens);

    tui.sidebar.updateMessages(chatEngine.messages);
  });

  chatEngine.on('status', (msg) => {
    if (msg.includes('任务进行中')) {
      tui.setStatusInfo(msg);
    } else {
      tui.renderStatus(msg);
    }
  });

  chatEngine.on('error', (msg) => {
    tui.renderError(msg);
  });

  chatEngine.on('todo_change', (todos) => {
    tui.sidebar.setTodos(todos);
    const completed = todos.filter(t => t.completed).length;
    tui.statusBar.setTodoStats(todos.length, completed);
    tui.refreshSidebarInfo();
  });

  chatEngine.on('check_pending_context', () => {
    if (pendingContextBuffer) {
      const context = pendingContextBuffer;
      pendingContextBuffer = '';
      tui.setPendingContext(false);
      chatEngine.emit('pending_context_response', context);
    } else {
      chatEngine.emit('pending_context_response', null);
    }
  });

  chatEngine.on('question', async (params) => {
    tui.statusBar.setThinking(false);
    tui._refreshStatusBar();

    tui.renderContentStart();
    const answerPromise = tui.questionPanel.show(params);
    tui._refreshMessages();
    const answers = await answerPromise;
    tui._refreshMessages();

    tui.resumeThinking();

    if (answers === null) {
      chatEngine.resolveQuestion({ cancelled: true });
    } else {
      chatEngine.resolveQuestion(answers);
    }
  });

  chatEngine.on('interrupted', () => {
    tui.renderInterrupted();
  });

  chatEngine.on('plan_ready', (plan) => {
    const t = tui.layout.theme;
    const marker = chalk.hex(t.colors.primary)('●');
    const planLines = String(plan).split('\n');
    for (const line of planLines) {
      tui.messageBox.renderedLines.push(`${marker} ${line}`);
    }
    tui.messageBox.renderedLines.push('');
    tui._refreshMessages();
    tui.renderPlanApprovalHint();
  });

  if (cliOptions.resume) {
    const SessionManager = require('../core/session');
    const sessionManager = new SessionManager({ projectDir: currentProjectDir });
    const session = sessionManager.loadSession(cliOptions.resume);
    if (session && session.messages.length > 0) {
      chatEngine.restoreMessages(session.messages);
      logger.info(`会话恢复: ${cliOptions.resume}`);
      tui.renderStatus(`已恢复会话: ${cliOptions.resume}`);
    } else {
      tui.renderStatus(`未找到会话: ${cliOptions.resume}，开始新会话`);
    }
  }

  try {
    await chatEngine.init(true);
  } catch (err) {
    logger.warn('项目概览构建失败', err.message);
  }

  tui.statusBar.model = chatEngine.model;
  tui.statusBar.setPlanMode(chatEngine._planMode);
  tui.sidebar.setChatEngine(chatEngine);
  tui.chatEngine = chatEngine;  // 注入 chatEngine 引用供 handleKey 使用
  const todos = todoManager.getAll();
  tui.sidebar.setTodos(todos);

  const completed = todos.filter(t => t.completed).length;
  tui.statusBar.setTodoStats(todos.length, completed);

  try {
    const contextStatus = chatEngine.contextManager?.getStatusReport(chatEngine.messages);
    if (contextStatus) {
      tui.statusBar.setContextInfo(
        contextStatus.currentTokens || 0,
        contextStatus.windowSize || 1000000,
        contextStatus.usagePercent || 0
      );
    }
  } catch {}

  tui.start();

  if (isFirstRun) {
    tui.messageBox.renderedLines.push(
      `  ${chalk.green('✅ 配置完成！')} Anvil 已就绪。`
    );
    tui.messageBox.renderedLines.push(
      `  输入 /help 查看帮助，输入 /keys 查看快捷键。`
    );
    tui.messageBox.renderedLines.push('');
    tui._fullRender();
  }

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  tui.onSend(async (text) => {
    await sendMessage(text);
  });

  tui.onExit(() => {
    handleExit();
  });

  tui.onContextInject((text) => {
    pendingContextBuffer += (pendingContextBuffer ? '\n' : '') + text;
    tui.setPendingContext(true);
    if (logger) {
      logger.debug('收到待注入上下文', { text: text.slice(0, 100) });
    }
  });

  async function sendMessage(text) {
    const input = text.trim();

    thinkingStarted = false;
    contentStarted = false;
    tui.resetMessages();

    if (chatEngine._awaitingPlanApproval) {
      // 清除计划批准提示
      tui.clearPlanApprovalHint();
      tui.resetMessages();

      const trimmed = input.trim().toLowerCase();
      if (/^(yes|y|ok|批准|确认|同意|开始|继续|行|好|可以)$/.test(trimmed)) {
        await chatEngine.approvePlan();
        return;
      }
      if (/^(no|n|否|拒绝|取消|重新|不对|不行)$/.test(trimmed)) {
        await chatEngine.rejectPlan();
        return;
      }
      // 其他输入作为对计划的反馈
      await chatEngine.editPlan(input.trim());
      return;
    }

    if (isCommand(input)) {
      const result = await handleCommand(input, chatEngine, { todoManager, mcpManager, chatEngine });
      if (result.handled) {
        if (input.startsWith('/todo')) {
            const todos = todoManager.getAll();
            tui.sidebar.setTodos(todos);
            const completed = todos.filter(t => t.completed).length;
            tui.statusBar.setTodoStats(todos.length, completed);
            tui.refreshSidebarInfo();

            if (input.includes('clear')) {
              chatEngine.clearTask('任务列表已清空');
            }
          }
          if (input === '/plan') {
            // 确保计划模式切换后状态栏被刷新
            tui._refreshAll();
          } else if (result.response) {
          const t = tui.layout.theme;
          const border = chalk.hex(t.colors.primary)('┃');
          tui.messageBox.renderedLines.push(`${border} ${result.response}`);
          tui.messageBox.renderedLines.push('');
          tui._refreshMessages();
        }
        tui.setProcessing(false);
        return;
      }
    }

    contentStarted = false;
    tui.renderUserMessage(input);

    try {
      const response = await chatEngine.processInput(input);

      if (response.error && !contentStarted) {
      }

      // 有待批准的计划时，结束当前响应（显示模型信息）但保持编辑器可用
      if (response.plan) {
        tui.finishResponse(chatEngine.model);
        tui.sidebar.updateMessages(chatEngine.messages);
        tui.setProcessing(false);
        return;
      }
    } catch (err) {
      tui.renderError('对话处理失败', err);
      if (logger) {
        logger.error('对话处理失败', err.message);
      }
    }

    tui.finishResponse(chatEngine.model);

    tui.sidebar.updateMessages(chatEngine.messages);
    tui.sidebar.setTodos(todoManager.getAll());

    try {
      const contextStatus = chatEngine.contextManager?.getStatusReport(chatEngine.messages);
      if (contextStatus) {
        tui.statusBar.setContextInfo(
          contextStatus.currentTokens || 0,
          contextStatus.windowSize || 1000000,
          contextStatus.usagePercent || 0
        );
      }
    } catch {}
  }

  process.stdin.on('data', async (buf) => {
    // 处理 Ctrl+C 和 Ctrl+D
    if (buf[0] === 0x03 || buf[0] === 0x04) {
      if (tui.isProcessing) {
        if (buf[0] === 0x03) {
          chatEngine.interrupt();
        }
      } else {
        if (buf[0] === 0x04) {
          handleExit();
        } else {
          tui.editor.reset();
          tui._refreshEditor();
        }
      }
      return;
    }

    const result = tui.handleKey(buf);
    if (result && result.action === 'exit') {
      handleExit();
    }
  });

  function handleExit() {
    todoManager.clearAll();
    tui.stop();

    if (mcpManager) {
      mcpManager.stop().catch(() => {});
    }

    console.log('\n  👋 再见！');

    if (logger) {
      logger.info('Anvil 退出');
      logger.close();
    }

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.removeAllListeners('data');
    process.stdin.pause();
    process.exit(0);
  }

  process.on('SIGINT', () => {
    if (chatEngine.isProcessing) {
      chatEngine.interrupt();
    } else {
      handleExit();
    }
  });

  process.on('uncaughtException', (err) => {
    todoManager.clearAll();
    tui.stop();

    if (mcpManager) {
      mcpManager.stop().catch(() => {});
    }
    if (logger) {
      logger.error('未捕获异常', err.message);
      logger.error('堆栈', err.stack);
    }
    console.error(`\n  ${chalk.red('✖')} 发生错误: ${err.message}`);
    console.error(`  ${chalk.dim('详细信息已记录到日志')}`);

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.removeAllListeners('data');
    process.stdin.pause();
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    if (logger) {
      logger.error('未处理的 Promise 拒绝', String(reason));
    }
  });
}

main().catch((err) => {
  console.error(`\n✖ 启动失败: ${err.message}`);
  process.exit(1);
});

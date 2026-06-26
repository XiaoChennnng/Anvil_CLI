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
const { registerWebSearchTool } = require('../tools/web_search');
const { registerWebFetchTool } = require('../tools/web_fetch');
const { registerMCPTools } = require('../tools/mcp');
const MCPManager = require('../mcp/manager');
const { wireMCPEvents } = require('../mcp/integration');
const ContextManager = require('../core/context');
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
  // 加载用户自定义 Skills（从 .anvil/skills/ 目录）
  const skillCount = toolRegistry.loadSkills(currentProjectDir);
  if (skillCount > 0) {
    logger.info(`已加载 ${skillCount} 个用户 Skills`);
  }
  registerFileTools(toolRegistry);
  registerCommandTool(toolRegistry);
  registerCodeTools(toolRegistry);
  registerTodoTools(toolRegistry);
  registerWebSearchTool(toolRegistry, config);
  registerWebFetchTool(toolRegistry, config);
  const { registerQuestionTool } = require('../tools/question');
  registerQuestionTool(toolRegistry);
  const { registerTaskCompleteTool } = require('../tools/task_complete');
  const { registerPlanModeTools } = require('../tools/plan_mode');
  const { registerComputerUseTools, unregisterComputerUseTools } = require('../tools/computer_use');
  const { isVisionModel } = require('../ai/providers');
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
      // 注册 Memory 工具（用户长期记忆）
      const { registerMemoryTools } = require('../tools/memory');
      registerMemoryTools(toolRegistry, contextManager, config);
      // 注册 Prompt 分层按需加载工具（get_system_layer）
      const { registerSystemLayerTools } = require('../tools/system_layer');
      registerSystemLayerTools(toolRegistry, chatEngine);
      contextToolsRegistered = true;
      logger.debug('上下文管理工具注册完成（含 system_layer）');
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

  // 注册 Team Mode 工具
  const { registerTeamTools } = require('../tools/team_tools');
  registerTeamTools(toolRegistry, chatEngine);

  const tui = new TUI(config);

  // ─── Computer Use 工具动态注册 ───
  // 根据当前模型是否支持 vision 动态注册/注销 computer use 工具
  function updateComputerUseTools() {
    const currentModel = chatEngine.model;
    const currentProvider = chatEngine.getProvider?.() || config.provider || 'deepseek';
    const supportsVision = isVisionModel(currentProvider, currentModel);

    const hasComputerTools = toolRegistry.get('computer_screenshot') !== undefined;

    if (supportsVision && !hasComputerTools) {
      // 注册 computer use 工具
      registerComputerUseTools(toolRegistry, { tui, chatEngine });
      logger.debug('已注册 Computer Use 工具（多模态模型）', { model: currentModel });
    } else if (!supportsVision && hasComputerTools) {
      // 注销 computer use 工具
      unregisterComputerUseTools(toolRegistry);
      logger.debug('已注销 Computer Use 工具（非多模态模型）', { model: currentModel });
    }
  }

  // 初始注册
  updateComputerUseTools();

  // 监听模型切换事件
  chatEngine.on('model_changed', () => {
    updateComputerUseTools();
  });

  let thinkingStarted = false;
  let contentStarted = false;
  let pendingContextBuffer = '';

  // Plan Mode 状态变化
  chatEngine.on('plan_mode_changed', (enabled) => {
    tui.statusBar.setPlanMode(enabled);
    tui._refreshStatusBar();
  });

  // ─── Team Mode 事件订阅 ───
  // 团队模式生命周期（核心 2 个）
  chatEngine.on('team_mode_start', (data) => {
    const agentCount = data?.suggestedAgents?.length || 0;
    tui.statusBar.setTeamMode(true, agentCount);
    tui._refreshStatusBar();
    tui.renderStatus(`[团队模式] 已启动 (${agentCount} 个 Agent)`);
  });

  chatEngine.on('team_mode_end', (data) => {
    tui.statusBar.setTeamMode(false, 0);
    tui.clearTeamActivity(); // M3:团队结束时清掉活动临显
    tui._refreshStatusBar();
    tui.renderStatus(`[团队模式] 已结束 (原因: ${data?.reason || 'unknown'})`);
  });

  // Team 内部事件(透传到 sidebar 显示,走 20ms 节流避免逐 chunk 重绘)
  ['team_created', 'team_dissolved', 'agent_created', 'agent_started',
   'agent_completed', 'agent_terminated', 'agent_respawned', 'state_changed'].forEach(eventName => {
    chatEngine.on(eventName, (data) => {
      if (tui.sidebar && tui.sidebar.handleTeamEvent) {
        tui.sidebar.handleTeamEvent(eventName, data);
        tui._queueSidebar();
      }
    });
  });

  // 子 Agent 发标准 thinking/content + _subAgent:true,消费端按标记路由
  chatEngine.on('thinking', (data) => {
    if (!data?._subAgent) {return;}
    if (tui.sidebar && tui.sidebar.handleTeamEvent) {
      tui.sidebar.handleTeamEvent('thinking', data);
      tui._queueSidebar();
    }
    if (data?.agentId && tui.statusBar.teamActivity?.status !== 'thinking') {
      tui.setTeamActivity(data.agentId.slice(-4), 'thinking');
    }
  });

  chatEngine.on('content', (data) => {
    if (!data?._subAgent) {return;}
    if (tui.sidebar && tui.sidebar.handleTeamEvent) {
      tui.sidebar.handleTeamEvent('content', data);
      tui._queueSidebar();
    }
    if (data?.agentId && tui.statusBar.teamActivity?.status !== 'streaming') {
      tui.setTeamActivity(data.agentId.slice(-4), 'streaming');
      tui._queueStatusBar();
    }
  });

  chatEngine.on('subagent_usage', (data) => {
    // 子 Agent token 计费归属主会话
    if (data?.usage && tui.sidebar) {
      tui.sidebar.updateCacheStats(data.usage);
      tui._queueStatusBar();
    }
  });

  // M3:agent 终止时清掉 teamActivity
  chatEngine.on('agent_completed', (data) => {
    if (tui.statusBar.teamActivity && data?.agentId?.slice(-4) === tui.statusBar.teamActivity.name) {
      tui.clearTeamActivity();
      tui._queueStatusBar();
    }
  });

  chatEngine.on('agent_terminated', (data) => {
    if (tui.statusBar.teamActivity && data?.agentId?.slice(-4) === tui.statusBar.teamActivity.name) {
      tui.clearTeamActivity();
      tui._queueStatusBar();
    }
  });

  // 补全未消费事件:team_degraded 和 subagent_heartbeat 转发到 sidebar
  ['team_degraded', 'subagent_heartbeat'].forEach(eventName => {
    chatEngine.on(eventName, (data) => {
      if (tui.sidebar && tui.sidebar.handleTeamEvent) {
        tui.sidebar.handleTeamEvent(eventName, data);
        tui._queueSidebar();
      }
    });
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

  // complete 事件保底清理 thinking 状态，避免提前 return 的分支遗漏
  chatEngine.on('complete', (data) => {
    tui.statusBar.setThinking(false);
    if (tui._thinkingTimer) {
      clearInterval(tui._thinkingTimer);
      tui._thinkingTimer = null;
    }
    // 如果有 usage 数据，先更新再刷新状态栏
    if (data && data.usage) {
      const modelInfo = getModel(chatEngine.model);
      const pricing = modelInfo?.pricing || config.pricing?.[chatEngine.model] || { input: 0.001, output: 0.002 };
      tui.renderTokenUsage(data.usage, pricing);
      tui.sidebar.updateCacheStats(data.usage);
    }
    // 刷新状态栏，确保 Context 和 Cost 显示最新值
    tui._refreshStatusBar();
  });

  chatEngine.on('content', (chunk) => {
    if (!contentStarted) {
      tui.renderContentStart();
      contentStarted = true;
    }
    tui.renderContentChunk(chunk);
  });

  chatEngine.on('tool_calls', (data) => {
    // 子 Agent 的工具调用 → sidebar/team-panel(走节流)
    if (data?._subAgent) {
      if (tui.sidebar && tui.sidebar.handleTeamEvent) {
        tui.sidebar.handleTeamEvent('tool_calls', data);
        tui._queueSidebar();
      }
      return;
    }
    // 主 Agent 的工具调用 → 消息区
    if (!contentStarted) { tui.renderContentStart(); contentStarted = true; }
    tui.renderToolCall(data);
  });

  // 缓冲实时输出，等 tool_result 统一渲染
  let _cmdBuf = [];
  chatEngine.on('command_output', (data, isError) => {
    const lines = data.replace(/\r/g, '').split('\n').filter(l => l.trim());
    _cmdBuf.push(...lines);
  });

  chatEngine.on('tool_result', ({ name, result, toolCall, _subAgent, agentId, args }) => {
    // 子 Agent 的工具结果 → sidebar/team-panel(走节流)
    if (_subAgent) {
      if (tui.sidebar && tui.sidebar.handleTeamEvent) {
        tui.sidebar.handleTeamEvent('tool_result', { name, result, toolCall, agentId, args, _subAgent: true });
        tui._queueSidebar();
      }
      return;
    }
    // 主 Agent 的工具结果 → 消息区
    if (_cmdBuf.length > 0 && (name === 'execute_command' || name === 'bash')) {
      result = { ...result, stdout: _cmdBuf.join('\n') };
      _cmdBuf = [];
    }
    tui.renderToolResult(name, result, toolCall);
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

  chatEngine.on('compression_animation', (data) => {
    const duration = 600;
    tui.sidebar.startProgressAnimation(data.fromPercent, data.toPercent, duration);
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

  // Question 路由:主 Agent + 子 Agent 提问统一通过 teamQuestionQueue 串行调度
  chatEngine.teamQuestionQueue.on('show', async (entry) => {
    tui.statusBar.setThinking(false);
    tui._refreshStatusBar();

    // 主 Agent 提问时不显示提示,子 Agent 提问时显示 "Agent #xxx 向主 Agent 提问"
    const t = tui.layout.theme;
    const isMain = entry.agentId === '__main__';
    if (!isMain && tui.messageBox) {
      const roleTag = entry.meta?.role || 'agent';
      const agentLabel = `[Agent #${entry.agentId.slice(-4)} · ${roleTag}]`;
      tui.messageBox.renderedLines.push('');
      tui.messageBox.renderedLines.push(
        `${chalk.hex(t.colors.warning)('●')} ${chalk.hex(t.colors.warning)(agentLabel)} 向主 Agent 提问`
      );
      tui._refreshMessages();
    }

    tui.renderContentStart();
    const showParams = { ...entry.params, _agentContext: { agentId: entry.agentId, ...(entry.meta || {}) } };
    const answerPromise = tui.questionPanel.show(showParams);
    tui._refreshMessages();
    const answers = await answerPromise;
    tui._refreshMessages();

    tui.resumeThinking();

    if (answers === null) {
      chatEngine.teamQuestionQueue.resolve({ cancelled: true });
    } else {
      chatEngine.teamQuestionQueue.resolve(answers);
    }
  });

  // 占位:question 已走 queue,这里仅防止 unhandled
  chatEngine.on('question', () => {});

  chatEngine.on('interrupted', () => {
    tui.renderInterrupted();
  });

  chatEngine.on('plan_ready', (plan) => {
    const t = tui.layout.theme;
    const marker = chalk.hex(t.colors.primary)('●');
    const planText = String(plan);

    tui.messageBox.flushContentBuffer();
    tui.messageBox.renderedLines.push(` ${marker} ${chalk.bold(t.text('计划方案'))}`);
    tui.messageBox.renderedLines.push('');
    const rendered = tui.messageBox.renderer.markdown.render(planText);
    for (const line of rendered.split('\n')) {
      tui.messageBox.renderedLines.push(`   ${line}`);
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
      `  ${chalk.green('✓ 配置就绪！')} Anvil 已就绪。`
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
    const MAX_PENDING_CONTEXT = 10000;
    if (pendingContextBuffer.length + text.length > MAX_PENDING_CONTEXT) {
      const excess = pendingContextBuffer.length + text.length - MAX_PENDING_CONTEXT;
      pendingContextBuffer = pendingContextBuffer.slice(excess);
    }
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
      const result = await handleCommand(input, chatEngine, { todoManager, mcpManager, chatEngine, toolRegistry });
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
          } else if (result.action === 'open_team_panel') {
          // /team panel → 打开 Team Panel modal,不开新内容进消息区
          tui.openTeamPanel();
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

    tui.finishResponse(chatEngine.model);
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

    console.log('\n  [再见] 再见！');

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
    console.error(`\n  ${chalk.red('[错误]')} 发生错误: ${err.message}`);
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
  console.error(`\n[错误] 启动失败: ${err.message}`);
  process.exit(1);
});

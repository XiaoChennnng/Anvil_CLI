'use strict';

const crypto = require('crypto');
const path = require('path');
const { EventEmitter } = require('events');
const SessionCache = require('../ai/cache');
const TeamQuestionQueue = require('./team/question-queue');
const { getSystemPrompt, getLayerContent, getAgentCheckPrompt, getAgentContinuePrompt, PromptLayer, L3Granularity } = require('../ai/prompts');

const DEFAULT_MAX_ITERATIONS = 100;

function parseTaskCompleteResult(content) {
  if (!content) { return { complete: null, reason: 'no_result', summary: '' }; }
  try {
    const result = JSON.parse(content);
    return {
      complete: result.complete === true,
      reason: 'json_parse',
      summary: typeof result.summary === 'string' ? result.summary : '',
    };
  } catch {
    let summary = '';
    if (/任务完成|已完成|all\s+done|completed/i.test(content)) {
      // 文本模式:截取"完成说明"部分,去除前缀关键词
      summary = content.replace(/^\s*(任务完成|已完成|all\s+done|completed)[：:。\s]*/i, '').trim();
      return { complete: true, reason: 'text_affirmative', summary };
    }
    if (/\d+\s*个?未完成|还有.*要做|pending/i.test(content)) {
      return { complete: false, reason: 'text_unfinished', summary: '' };
    }
    return { complete: null, reason: 'parse_failed', summary: '' };
  }
}

function generateTaskFingerprint(task) {
  if (!task) { return { keyWords: [], full: '' }; }
  const words = task.split(/[\s,.，、。]+/).filter(w => w.length > 1);
  const stopWords = new Set(['的', '了', '和', '与', '或', '一个', '一些', '相关', '以及']);
  const keyWords = words.filter(w => !stopWords.has(w) && w.length > 2);
  return { keyWords: keyWords.slice(0, 5), full: task.slice(0, 80), length: task.length };
}

function isTaskLost(messages, fingerprint) {
  if (!fingerprint.keyWords.length) { return false; }
  const allText = messages.map(m => m.content || '').join('');
  const foundCount = fingerprint.keyWords.filter(w => allText.includes(w)).length;
  return foundCount < fingerprint.keyWords.length * 0.6;
}

class ChatEngine extends EventEmitter {
  constructor(options) {
    super();
    this.config = options.config || {};
    this.aiClient = options.aiClient;
    this.toolRegistry = options.toolRegistry;
    this.todoManager = options.todoManager;
    this.contextManager = options.contextManager;
    this.logger = options.logger;

    this.model = this.config.defaultModel || 'deepseek-v4-flash';
    this.messages = [];
    this.cache = new SessionCache();
    this.isProcessing = false;
    this._aborted = false;

    this.fileTimestamps = {};
    this._currentTask = null;
    this._suppressUI = false; // _agentLoop 内部消息不渲染到 UI
    this._planMode = false;
    this._planModeFilePath = null;
    this._awaitingPlanApproval = false;

    // Memory 定期总结计数器：每 N 轮注入一次 reminder，让 AI 主动提取偏好
    this._memoryCheckInterval = 5;
    this._roundSinceMemoryCheck = 0;
    this._totalRoundsProcessed = 0;
    this._planApproved = false;
    this._pendingPlan = null;
    this._pendingQuestionResolve = null;
    // 统一管理主 Agent + 子 Agent 提问,避免单值 resolve 被覆盖
    this.teamQuestionQueue = new TeamQuestionQueue();
    this.teamManager = null;
    this.teamMode = false;

    // 监听 AI 客户端事件并转发（内部检查消息不转发到 UI）
    if (this.aiClient) {
      this.aiClient.on('thinking', (chunk) => {
        if (!this._suppressUI) {this.emit('thinking', chunk);}
      });
      this.aiClient.on('content', (chunk) => {
        if (!this._suppressUI) {this.emit('content', chunk);}
      });
      this.aiClient.on('usage', (usage) => this.emit('usage', usage));
      this.aiClient.on('status', (msg) => this.emit('status', msg));
    }
  }

  async init(withProjectOverview = true) {
    if (withProjectOverview && this.contextManager) {
      try {
        await this.contextManager.buildProjectOverview();
      } catch (err) {
        if (this.logger) {
          this.logger.warn('构建项目概览失败', err.message);
        }
      }
    }

    // 使用 assembleMessages 构建初始消息
    // 保证 System Prompt + Project Overview 在消息前端 → 最大化缓存命中
    const sysPrompt = this._buildSystemPrompt();
    if (this.contextManager) {
      this.messages = this.contextManager.assembleMessages(sysPrompt, []);
    } else {
      this.messages = [{ role: 'system', content: sysPrompt }];
    }

    if (this.contextManager && this.logger) {
      const status = this.contextManager.getStatusReport(this.messages);
      this.logger.info('上下文初始化', status);
    }
  }

  restoreMessages(messages) {
    if (Array.isArray(messages)) {
      const systemMsgs = this.messages.filter((m) => m.role === 'system');
      const historyMsgs = messages.filter((m) => m.role !== 'system' || m._archiveTier !== undefined);
      this.messages = [...systemMsgs, ...this._validateToolPairs(historyMsgs)];
    }
  }

  // OpenAI 要求 tool 必须跟在带 tool_calls 的 assistant 之后,过滤孤立 tool 避免 400
  _validateToolPairs(messages) {
    const validToolIds = new Set();
    for (const m of messages) {
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (tc && tc.id) {validToolIds.add(tc.id);}
        }
      }
    }
    return messages.filter((m) => {
      if (m.role === 'tool') {
        return m.tool_call_id && validToolIds.has(m.tool_call_id);
      }
      return true;
    });
  }

  // 中断后清理:删除没有配对 tool 的 assistant(tool_calls) 和孤立 tool
  _cleanupInterruptedToolCalls() {
    const before = this.messages.length;
    this.messages = this._validateToolPairs(this.messages);

    // 额外处理:assistant 声明了 tool_calls 但所有 tool 都被丢弃的情况
    const existingToolIds = new Set();
    for (const m of this.messages) {
      if (m.role === 'tool' && m.tool_call_id) {existingToolIds.add(m.tool_call_id);}
    }
    this.messages = this.messages.filter((m) => {
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        const hasAnyTool = m.tool_calls.some((tc) => tc.id && existingToolIds.has(tc.id));
        return hasAnyTool;
      }
      return true;
    });

    const dropped = before - this.messages.length;
    if (dropped > 0 && this.logger) {
      this.logger.info('中断清理孤立 tool 调用', { dropped });
    }
  }

  async processInput(input) {
    if (this.isProcessing) {
      return { error: '正在处理上一个请求，请等待...' };
    }

    this._aborted = false;
    this.isProcessing = true;

    try {
      if (this._isTodoClearRequest(input)) {
        this.clearTask('用户清空了任务列表');
        this.isProcessing = false;
        return { content: '[完成]任务列表已清空，等待新的指令。', cleaned: true };
      }

      this.messages.push({ role: 'user', content: input });

      if (this.contextManager && typeof this.contextManager.detectRegret === 'function') {
        const hadRegret = this.contextManager.detectRegret(input);
        if (hadRegret && this.logger) {
          this.logger.info('检测到压缩遗憾模式', { input: input.slice(0, 80) });
        }
      }

      // 构建对话上下文 hash，确保缓存感知对话状态
      const recentMsgs = this.messages.slice(-12);
      const contextHash = crypto.createHash('md5')
        .update(JSON.stringify(recentMsgs.map((m) => ({
          role: m.role,
          content: (m.content || '').slice(0, 200),
          hasTools: !!(m.tool_calls && m.tool_calls.length),
          toolCount: m.tool_calls?.length || 0,
        }))))
        .digest('hex');

      // 检查缓存（带上上下文 hash，避免不同对话上下文命中同一缓存）
      const cached = this.cache.get(input, { model: this.model, contextHash });
      if (cached) {
        this.isProcessing = false;
        this.messages.push({ role: 'assistant', ...cached });
        return cached;
      }

      // 渐进式压缩:超阈值时压缩,中低阈值只提示
      if (this.contextManager) {
        const currentTokens = this.contextManager.estimateMessagesTokenCount(this.messages);
        const compLevel = this.contextManager.getCompressionLevel(this.messages, currentTokens);

        if (compLevel.needsCompression) {
	          this.emit('status', `[警告]${compLevel.label} — 使用率 ${Math.round(compLevel.ratio * 100)}%`);

	          // 压缩上下文（实际执行压缩的方法是 compactContext）
	          const compressResult = this.contextManager.compactContext(this.messages);
	          this.messages = compressResult.messages;
	          const stats = compressResult.stats;

          if (stats.compressed) {
            this.emit('status',
              `[完成]压缩完成 (L${stats.level}): ${stats.beforeTokens.toLocaleString()} → ${stats.afterTokens.toLocaleString()} tokens (节省 ${stats.savedPercent}%)`
            );

            if (this.logger) {
              this.logger.info('上下文压缩', stats);
            }
          }
        } else if (compLevel.level >= 1) {
          this.emit('status', `[提示]${compLevel.label} (${Math.round(compLevel.ratio * 100)}%)`);
        }
      }

      this._currentTask = input;
      this._awaitingPlanApproval = false;

      const result = await this._agentLoop(input);

      if (result.plan) {
        this.emit('plan_ready', result.plan);
        if (this.logger) {this.logger.info('产出了计划，等待用户批准');}
        this.isProcessing = false;
        return { plan: result.plan };
      }

      this.isProcessing = false;

      // 避免重复:如果 _agentLoop 已推入同一条 assistant 消息则跳过
      const lastMsg = this.messages[this.messages.length - 1];
      const isDuplicate = lastMsg && lastMsg.role === 'assistant'
        && lastMsg.content === (result.content || '')
        && JSON.stringify(lastMsg.tool_calls || null) === JSON.stringify(result.toolCalls || null);
      if (!isDuplicate) {
        this.messages.push({
          role: 'assistant',
          content: result.content || '',
          reasoning_content: result.thinking || null,
          toolCalls: result.toolCalls || null,
        });
      }

      // 主动后台压缩(非阻塞,失败不影响主流程)
      if (this.contextManager && typeof this.contextManager.proactiveCompress === 'function') {
        try {
          this.messages = this.contextManager.proactiveCompress(this.messages);
        } catch {}
      }

      // 每 N 轮注入一次 reminder,让 AI 主动提取偏好
      this._roundSinceMemoryCheck++;
      this._totalRoundsProcessed++;
      if (this._roundSinceMemoryCheck >= this._memoryCheckInterval) {
        this._injectMemoryCheckReminder();
        this._roundSinceMemoryCheck = 0;
      }

      // 任务指纹提高缓存复用率
      const taskFingerprint = generateTaskFingerprint(input);
      this.cache.set(input, { model: this.model, contextHash, taskFingerprint: taskFingerprint.full }, {
        thinking: result.thinking,
        content: result.content,
        toolCalls: result.toolCalls,
      });

      this.emit('complete', {
        thinking: result.thinking,
        content: result.content,
        toolCalls: result.toolCalls,
        usage: result.usage,
      });

      return result;
    } catch (err) {
      this.isProcessing = false;
      this.emit('error', err.message);

      if (this.logger) {
        this.logger.error('对话处理异常', err.message);
      }

      return { error: err.message };
    }
  }

  async _agentLoop(originalTask) {
    const maxIterations = DEFAULT_MAX_ITERATIONS;
    const startTime = Date.now();
    const HARD_TIMEOUT = 4 * 60 * 60 * 1000;
    const SOFT_TIMEOUT = 3.5 * 60 * 60 * 1000;
    let lastSoftWarning = 0;
    let iterationCount = 0;
    let fullContent = '';
    let fullThinking = '';
    let lastUsage = null;
    const taskFingerprint = generateTaskFingerprint(originalTask);

    let result = await this._sendAndProcess();
    fullContent += result.content || '';
    fullThinking += result.thinking || '';
    lastUsage = result.usage;

    // Plan Mode:AI 调用 request_plan_approval → 暂停等用户确认
    if (this._planMode && this._awaitingPlanApproval) {
      this.logger?.info('Plan Mode: AI 调用了 request_plan_approval，暂停等待确认');
      return {
        thinking: fullThinking,
        content: fullContent,
        toolCalls: [],
        usage: lastUsage,
        plan: this._pendingPlan,
      };
    }

    // Plan Mode 下调了非规划工具 → 重新引导 AI 先提交计划
    if (this._planMode && !this._planApproved && !this._awaitingPlanApproval && result.hadToolCalls) {
      const requestedApproval = result.toolCalls?.some(
        tc => tc.function?.name === 'request_plan_approval'
      );
      if (!requestedApproval) {
        this.logger?.info('Plan Mode: AI 调用了非规划工具，重新引导');

        this.messages.push({
          role: 'assistant',
          content: result.content || '',
          reasoning_content: result.thinking || '',
        });

        this.messages.push({
          role: 'user',
          content: '[系统提示] 你在 Plan Mode 下，必须先输出结构化计划方案并调用 request_plan_approval 工具请求批准，然后才能执行其他操作。请立即回到规划阶段。',
        });

        result = await this._sendAndProcess();
        fullContent += result.content || '';
        fullThinking += result.thinking || '';
        lastUsage = result.usage || lastUsage;

        if (this._planMode && this._awaitingPlanApproval) {
          this.logger?.info('Plan Mode: AI 在重新引导后调用了 request_plan_approval');
          return {
            thinking: fullThinking,
            content: fullContent,
            toolCalls: [],
            usage: lastUsage,
            plan: this._pendingPlan,
          };
        }
      }
    }

    // 没有工具调用直接返回(闲聊/问答/纯文字回复都不弹窗)
    if (!result.hadToolCalls) {
      return {
        thinking: fullThinking,
        content: fullContent,
        toolCalls: [],
        usage: lastUsage,
      };
    }

    while (iterationCount < maxIterations && !this._aborted) {
      iterationCount++;
      const elapsed = Date.now() - startTime;

      // 硬性超时:运行超过 4 小时强制停止
      if (elapsed >= HARD_TIMEOUT) {
        this.logger?.warn('Agent 达到硬性超时，强制停止', {
          iterationCount,
          elapsed: Math.round(elapsed / 60000) + 'min',
        });
        break;
      }

      // 软性超时警告:运行超过 3.5 小时发出警告,10 分钟只发一次
      if (elapsed >= SOFT_TIMEOUT && elapsed - lastSoftWarning >= 10 * 60 * 1000) {
        const remaining = HARD_TIMEOUT - elapsed;
        this.logger?.warn('Agent 软性超时警告', {
          iterationCount,
          elapsed: Math.round(elapsed / 60000) + 'min',
          remaining: Math.round(remaining / 60000) + 'min',
        });
        lastSoftWarning = elapsed;
      }

      // 上下文使用率检查:第 1、4、7... 轮触发,作为低成本周期性监控
      if (this.contextManager && (iterationCount % 3 === 1)) {
        try {
          const compLevel = this.contextManager.getCompressionLevel(this.messages);
          if (compLevel.needsCompression || compLevel.ratio > 0.85) {
            const compressResult = await this.compactContext({ level: 'auto', keep: ['recent', 'decisions'] });
            if (compressResult.stats?.compressed) {
              if (isTaskLost(compressResult.messages, taskFingerprint)) {
                compressResult.messages.push({
                  role: 'system',
                  content: `[长期任务提醒] 你的原始任务是：${originalTask}。已进行 ${iterationCount} 次迭代，请继续完成此任务。`,
                  _taskReminder: true,
                });
              }
              this.messages = compressResult.messages;
              this.logger?.info('Agent 循环自动压缩', {
                beforeTokens: compressResult.stats.beforeTokens,
                afterTokens: compressResult.stats.afterTokens,
                savedPercent: compressResult.stats.savedPercent,
              });
            }
          }
        } catch (err) {
          this.logger?.warn('Agent 循环压缩失败', err.message);
        }
      }

      const lastMsg = this.messages[this.messages.length - 1];
      const isDuplicate = lastMsg && lastMsg.role === 'assistant'
        && lastMsg.content === (result.content || '')
        && JSON.stringify(lastMsg.tool_calls || null) === JSON.stringify(result.toolCalls || null);
      if (!isDuplicate) {
        this.messages.push({
          role: 'assistant',
          content: result.content || '',
          reasoning_content: result.thinking || '',
        });
      }

      const injectedContext = await this._checkPendingContext();

      let checkMsg = getAgentCheckPrompt(originalTask);
      if (injectedContext) {
        checkMsg += `\n\n[用户补充说明]\n${injectedContext}`;
      }

      this.messages.push({
        role: 'user',
        content: checkMsg,
      });

      // 内部消息,不渲染到 UI
      this._suppressUI = true;
      const checkResult = await this._sendAndProcess();
      this._suppressUI = false;
      fullContent += checkResult.content || '';
      fullThinking += checkResult.thinking || '';
      lastUsage = checkResult.usage || lastUsage;

      this.messages.push({
        role: 'assistant',
        content: checkResult.content || '',
        reasoning_content: checkResult.thinking || '',
      });

      // 完成检测:只有 task_complete 返回 complete=true 才停止
      const calledTaskComplete = checkResult.toolCalls?.some(
        tc => tc.function?.name === 'task_complete'
      );

      if (calledTaskComplete) {
        const lastToolMsg = [...this.messages].reverse().find(m => m.role === 'tool');
        const parsed = parseTaskCompleteResult(lastToolMsg?.content || '');
        if (parsed.complete === true) {
          this.logger?.info('任务完成', { reason: parsed.reason, iterationCount });
          // 只渲染 task_complete 工具的 summary 参数(写给用户的完成说明)
          const userFacingSummary = parsed.summary || '';
          if (userFacingSummary) {
            this.emit('content', userFacingSummary);
          }
          // 把 content 替换成 summary,避免 'complete' 事件 payload 里残留 AI 内部汇报
          result = { ...checkResult, content: userFacingSummary };
          break;
        }
      }

      // AI 在干活就不该停,maxIterations 只是最终保护
      this.messages.push({
        role: 'user',
        content: getAgentContinuePrompt(),
      });

      result = await this._sendAndProcess();
      fullContent += result.content || '';
      fullThinking += result.thinking || '';
      lastUsage = result.usage || lastUsage;

      // "继续"后无工具调用:连续多次卡住才停(给 AI 多次机会)
      if (!result.hadToolCalls) {
        if (result.toolCalls?.some(tc => tc.function?.name === 'task_complete')) {
          break;
        }

        this.messages.push({
          role: 'user',
          content: '如果任务已完成，请调用 task_complete 工具。如果还有工作要做，请继续执行。' +
                   '不要只回复文字，用行动回答。',
        });

        const recheckResult = await this._sendAndProcess();

        if (recheckResult.toolCalls?.some(tc => tc.function?.name === 'task_complete')) {
          break;
        }

        // 两轮无工具调用 + 无实质内容 = 卡住,退出避免 token 浪费
        const hasSubstantialContent = (recheckResult.content || '').length > 200;
        if (!hasSubstantialContent) {
          this.logger?.warn('AI 可能卡住', { iterationCount });
          break;
        }

        // 有实质内容但无工具调用,可能是输出阶段,继续
        result = recheckResult;
        fullContent += recheckResult.content || '';
        fullThinking += recheckResult.thinking || '';
        lastUsage = recheckResult.usage || lastUsage;
      }

    }

    return {
      thinking: fullThinking,
      content: fullContent,
      toolCalls: result.toolCalls || [],
      usage: lastUsage,
    };
  }

  async _sendAndProcess() {
    let loopCount = 0;
    const maxLoops = 10; // 防止无限工具调用循环
    let fullContent = '';
    let fullThinking = '';
    let lastContent = '';
    let lastThinking = '';
    let lastUsage = null;
    let lastHadToolCalls = false;  // 标记本批次是否执行了工具调用（供 _agentLoop 使用）
    let lastToolCalls = null;      // 保存实际的 toolCalls（供完成检测使用）
    let continueCount = 0;
    const maxContinues = 5; // 最多自动继续 5 次，防止死循环

    while (loopCount < maxLoops) {
      loopCount++;

      // 关键防线：过滤孤立 tool 消息（避免 OpenAI 400）
      const safeMessages = this._validateToolPairs(this.messages);

      // 准备 API 请求：带 tool_calls 的 assistant 消息必须携带 reasoning_content
      const apiMessages = safeMessages.map((m) => {
        const msg = {
          role: m.role,
          content: m.content || '',
        };

        // tool 消息：传递 tool_call_id
        if (m.role === 'tool' && m.tool_call_id) {
          msg.tool_call_id = m.tool_call_id;
        }

        // assistant 消息：传递 tool_calls 和 reasoning_content
        if (m.role === 'assistant') {
          if (m.tool_calls && m.tool_calls.length > 0) {
            msg.tool_calls = m.tool_calls;
          }
          // 思考内容：有工具调用的必须传，无工具调用的传了也没事（API 忽略）
          if (m.reasoning_content) {
            msg.reasoning_content = m.reasoning_content;
          }
        }

        return msg;
      });

      const tools = this.toolRegistry ? this.toolRegistry.getOpenAITools() : [];

      if (this._aborted) {
        throw new Error('请求已被中断');
      }

      if (!this._suppressUI) {this.emit('thinking_start');}
      const response = await this.aiClient.chat(apiMessages, {
        model: this.model,
        thinkingMode: this.config.thinkingMode !== false,
        tools: tools,
      });

      lastContent = response.content || '';
      lastThinking = response.thinking || '';
      lastUsage = response.usage;

      // 累积内容（自动继续时拼接多次响应）
      fullContent += lastContent;
      fullThinking += lastThinking;

      // 反馈实际 token 消耗给上下文管理器（校准估算）
      if (lastUsage && lastUsage.prompt_tokens && this.contextManager) {
        const estimated = this.contextManager.estimateMessagesTokenCount(apiMessages);
        if (typeof this.contextManager.calibrateFromUsage === 'function') {
          this.contextManager.calibrateFromUsage(estimated, lastUsage.prompt_tokens);
        }
      }

      // 处理工具调用
      if (response.toolCalls && response.toolCalls.length > 0) {
        lastHadToolCalls = true;  // 标记：本批次执行了工具调用
        lastToolCalls = response.toolCalls;  // 保存实际 toolCalls（供完成检测使用）

        // 注意：内容已通过 AI 客户端的流式发射（aiClient.on('content')）发送到 UI
        // 这里不需要再次发射 response.content，避免重复

        // AI 回复（含 tool_calls + reasoning_content）加入消息历史
        const assistantMsg = {
          role: 'assistant',
          content: response.content || null,
          reasoning_content: response.thinking || '',  // 思考内容，必须有
          tool_calls: response.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.function?.name || '',
              arguments: typeof tc.function?.arguments === 'string'
                ? tc.function.arguments
                : JSON.stringify(tc.function?.arguments || {}),
            },
          })),
        };
        this.messages.push(assistantMsg);

        // 逐个执行工具调用，request_plan_approval 触发后中断后续工具
        let awaitingPlanBreak = false;
        for (const toolCall of response.toolCalls) {
          // request_plan_approval 已触发：跳过后续工具（仍需推入 tool result）
          if (awaitingPlanBreak) {
            if (!this._suppressUI) {this.emit('tool_calls', toolCall);}
            this.messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify({
                skipped: true,
                reason: 'plan approval 已触发，等待用户批准后再执行',
              }),
            });
            if (this.logger) {
              this.logger.info(`工具调用被跳过: ${toolCall.function?.name || ''} (plan approval 触发)`);
            }
            continue;
          }

          // 逐个发射工具调用事件（UI 逐个展示）
          if (!this._suppressUI) {this.emit('tool_calls', toolCall);}
          const name = toolCall.function?.name || '';
          let args = {};
          try {
            args = typeof toolCall.function?.arguments === 'string'
              ? JSON.parse(toolCall.function.arguments)
              : (toolCall.function?.arguments || {});
          } catch {
            args = {};
          }

          // start_team_task 单独用 30 分钟超时,其余工具 120s
          const TOOL_TIMEOUT = name === 'start_team_task' ? 30 * 60 * 1000 : 120 * 1000;
          let result;
          let toolTimeoutId;
          try {
            result = await Promise.race([
              this.toolRegistry.execute(name, args, {
                projectDir: this.config.projectDir,
                logger: this.logger,
                fileTimestamps: this.fileTimestamps,
                maxOutputLines: this.config.maxOutputLines || 50,
                planModeRestricted: this._planMode && !this._planApproved,
                chatEngine: this,  // 让工具可以访问 chatEngine（如 enter_plan_mode）
                onOutput: (data, isError) => {
                  if (!this._suppressUI) {this.emit('command_output', data, isError);}
                },
                todoManager: this.todoManager,
                onTodoChange: (todos) => this.emit('todo_change', todos),
                onQuestion: (params) => {
                  if (this._suppressUI) {return { answers: [] };}
                  this.emit('question', params);
                  return this.teamQuestionQueue.enqueue(
                    TeamQuestionQueue.MAIN_AGENT_ID,
                    { agentName: '主 Agent', role: 'main' },
                    params,
                  );
                },
              }),
              new Promise((_, reject) => {
                toolTimeoutId = setTimeout(() => reject(new Error(`工具执行超时(${TOOL_TIMEOUT / 1000}s)`)), TOOL_TIMEOUT);
              }),
            ]);
            clearTimeout(toolTimeoutId);
            if (!this._suppressUI) {this.emit('tool_result', { name, result, toolCall });}
            // 通知上下文管理器(相位检测 + 文件预取)
            if (this.contextManager && typeof this.contextManager.recordToolCall === 'function') {
              this.contextManager.recordToolCall(name, args);
              // 写/读文件操作后尝试预取关联文件
              if (['write_file', 'read_file', 'delete_file'].includes(name) && args.filePath) {
                this.contextManager.prefetchRelatedFiles(args.filePath).catch(() => {});
                // 将读取/写入的文件加入上下文缓存，侧边栏 Context 区才能显示注入文件列表
                if (['read_file', 'write_file'].includes(name) && !result.error) {
                  this.contextManager.loadFileOnDemand(args.filePath).catch(() => {});
                }
              }
            }
          } catch (err) {
            result = { error: `工具执行失败: ${err.message}` };
          }

          // 工具结果超长时截断字段值,避免消息历史爆炸
          let resultStr;
          const MAX_RESULT_LEN = 4000;
          if (result && typeof result === 'object') {
            const truncFields = ['content', 'output', 'diff'];
            const truncated = { ...result };
            for (const field of truncFields) {
              if (typeof truncated[field] === 'string' && truncated[field].length > MAX_RESULT_LEN) {
                truncated[field] = truncated[field].slice(0, MAX_RESULT_LEN) + '... (结果过长已截断)';
              }
            }
            resultStr = JSON.stringify(truncated);
            if (resultStr.length > MAX_RESULT_LEN) {
              resultStr = resultStr.slice(0, MAX_RESULT_LEN) + '... (结果过长已截断)';
            }
          } else {
            resultStr = JSON.stringify(result);
            if (resultStr.length > MAX_RESULT_LEN) {
              resultStr = resultStr.slice(0, MAX_RESULT_LEN) + '... (结果过长已截断)';
            }
          }
          this.messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: resultStr,
          });

          if (this.logger) {
            this.logger.info(`工具调用: ${name}`, { args, result });
          }

          // request_plan_approval 触发后标记后续工具为 skipped,避免规划前执行
          if (this._awaitingPlanApproval) {
            awaitingPlanBreak = true;
          }
        }

        // AI 调了 request_plan_approval 立即停止,等用户批准
        if (this._awaitingPlanApproval) {
          break;
        }

        continue;
      }

      // 检测截断：finishReason === 'length' 时自动继续
      if (response.finishReason === 'length' && continueCount < maxContinues) {
        continueCount++;

        // 将已有内容加入消息历史让 AI 继续
        this.messages.push({
          role: 'assistant',
          content: response.content || '',
          reasoning_content: response.thinking || '',
        });

        // 添加"继续"提示，让 AI 接着写
        this.messages.push({
          role: 'user',
          content: '继续',
        });

        this.emit('status', `[等待]响应被截断，自动继续... (${continueCount}/${maxContinues})`);

        if (this.logger) {
          this.logger.info('响应截断，自动继续', { continueCount });
        }

        // 继续循环，发送"继续"请求
        continue;
      }

      // 无工具调用且未截断，对话结束
      break;
    }

    return {
      thinking: fullThinking,
      content: fullContent,
      toolCalls: lastToolCalls || [],  // 返回实际 toolCalls（完成检测需要检查 task_complete）
      usage: lastUsage,
      hadToolCalls: lastHadToolCalls,  // 标记本批次是否执行了工具调用
    };
  }

  async compactContext(options, skipSemanticSummary = false) {
    if (!this.contextManager) {
      return { messages: this.messages, stats: { compressed: false, error: '上下文管理器未初始化' } };
    }

    // 触发动画：从当前进度 → 100%（覆盖普通压缩和语义压缩两条路径）
    const beforeStatus = this.contextManager?.getStatusReport(this.messages);
    const beforePercent = beforeStatus?.usagePercent || 0;
    this.emit('compression_animation', {
      phase: 'start',
      fromPercent: beforePercent,
      toPercent: 100,
    });

    // 语义预算压缩：硬性 1w-5w tokens 预算，无条件触发
    if (options.level === 'semantic') {
      const result = await this._semanticBudgetCompress(options);
      this._emitCompressionAnimationEnd(result, beforePercent);
      return result;
    }

    // 先执行实际压缩（基于当前消息）
    const result = this.contextManager.compactContext(this.messages, options);
    this.messages = result.messages;

    // 语义摘要：在压缩后生成（从压缩前的消息生成摘要，加入压缩后的消息）
    // 这样摘要本身不参与压缩计算，避免无效开销
    if (!skipSemanticSummary && result.stats.compressed) {
      const budget = this._calculateSummaryBudget();
      const semanticSummary = await this._generateSemanticSummary(budget);
      if (semanticSummary) {
        // 找到压缩后 system 消息的位置，在那之后插入语义摘要
        const lastSystemIdx = this.messages.findLastIndex((m) => m.role === 'system');
        const insertIdx = lastSystemIdx >= 0 ? lastSystemIdx + 1 : 0;
        this.messages.splice(insertIdx, 0, {
          role: 'system',
          content: `[AI 语义摘要]\n${semanticSummary}\n[/AI 语义摘要]`,
          _semanticSummary: true,
          _compressedAt: new Date().toISOString(),
        });
      }
    }

    this._emitCompressionAnimationEnd(result, beforePercent);
    return result;
  }

  // 压缩结束后触发动画收尾（100% → 实际压缩后进度）
  _emitCompressionAnimationEnd(result, beforePercent) {
    const afterStatus = this.contextManager?.getStatusReport(this.messages);
    const afterPercent = afterStatus?.usagePercent || 0;
    this.emit('compression_animation', {
      phase: 'end',
      fromPercent: 100,
      toPercent: afterPercent,
    });
    // status 文本也发一份，让 TUI 显示压缩完成信息
    const stats = result?.stats;
    if (stats && stats.compressed) {
      this.emit('status', `[完成]上下文已压缩: ${stats.beforeTokens.toLocaleString()} → ${stats.afterTokens.toLocaleString()} tokens (节省 ${stats.savedPercent}%)`);
    }
  }

  // 语义预算压缩（level='semantic'）：调 LLM 生成结构化摘要，硬性约束到 1w-5w tokens
  async _semanticBudgetCompress(options = {}) {
    const ctxCfg = this.config.context || {};
    const semanticCfg = ctxCfg.semanticBudget || {};
    const target = this.contextManager.validateSemanticBudget(options.budgetTokens || semanticCfg.default || 30_000);
    const shouldRebuild = options.rebuild !== false;
    const shouldForce = options.force !== false;

    // 低使用率 + 未 force → 跳过（节省 API 调用）
    if (!shouldForce) {
      const currentTokens = this.contextManager.estimateMessagesTokenCount(this.messages);
      const ratio = currentTokens / (this.contextManager.windowSize || 1_000_000);
      if (ratio < 0.3) {
        return {
          messages: this.messages,
          stats: {
            compressed: false,
            level: 'semantic',
            name: 'SEMANTIC_BUDGET_SKIPPED',
            reason: 'low_usage_not_forced',
            beforeTokens: currentTokens,
            afterTokens: currentTokens,
            savedPercent: 0,
            budget: target,
            rebuilt: false,
          },
        };
      }
    }

    // 1) 调 LLM 生成结构化摘要
    let summary = '';
    let fallback = null;
    try {
      summary = await this._generateSemanticSummary(target);
    } catch (err) {
      this.logger?.warn('语义压缩 LLM 摘要失败，尝试降级', err.message);
      // 降级：字符串截取
      if (semanticCfg.fallbackToStringSummary !== false) {
        try {
          summary = this.contextManager._fallbackStringSummary(this.messages, target);
          fallback = 'string-truncate';
        } catch (fbErr) {
          this.logger?.error('字符串降级也失败', fbErr.message);
        }
      }
    }

    if (!summary) {
      return {
        messages: this.messages,
        stats: {
          compressed: false,
          level: 'semantic',
          name: 'SEMANTIC_BUDGET_FAILED',
          error: '摘要生成失败',
          beforeTokens: this.contextManager.estimateMessagesTokenCount(this.messages),
          afterTokens: 0,
          savedPercent: 0,
          budget: target,
          rebuilt: false,
        },
      };
    }

    // 2) 应用摘要到 messages（contextManager 负责 truncate + 注入 + 统计）
    const applyResult = this.contextManager.applySemanticSummary(this.messages, summary, {
      budgetTokens: target,
      rebuild: shouldRebuild,
    });
    this.messages = applyResult.messages;

    // 3) 完整重注 L0+L1+L2+L3
    if (shouldRebuild) {
      await this._rebuildFullContext();
    }

    const finalStats = { ...applyResult.stats, fallback };
    return { messages: this.messages, stats: finalStats };
  }

  // 完整重注上下文：L0 (System Prompt) + L1 (Project Overview) + Tier 2/3/4 重新组装
  async _rebuildFullContext() {
    if (!this.contextManager) {return;}

    // 1) 清空文件 LRU 缓存（换新脑子，不带旧文件）
    if (this.contextManager._fileContexts) {
      this.contextManager._fileContexts.clear();
      this.contextManager._fileContextTotalTokens = 0;
    }

    // 2) 重建 L0 (System Prompt)
    this._updateSystemPrompt();

    // 3) 重新扫描项目概览
    if (typeof this.contextManager.buildProjectOverview === 'function') {
      try {
        await this.contextManager.buildProjectOverview();
      } catch (err) {
        this.logger?.warn('重建项目概览失败', err.message);
      }
    }

    // 4) 重新组装所有 tier（Tier 0/1/2/3/4）
    const sysPrompt = this.messages[0]?.content || this._buildSystemPrompt();
    const historyMsgs = this.messages.slice(1).filter(
      (m) => m.role !== 'system' || m._archiveTier !== undefined || m._semanticSummary,
    );
    this.messages = this.contextManager.assembleMessages(sysPrompt, historyMsgs);

    this.logger?.info('完整重注完成', {
      messageCount: this.messages.length,
      totalTokens: this.contextManager.estimateMessagesTokenCount(this.messages),
    });
  }

  clearTask(reason = '用户清空了任务列表') {
    this.messages.push({
      role: 'user',
      content: `[系统通知] ${reason}。之前的任务已全部取消，忘记之前的开发计划和工作状态，等待用户的新指令。`,
    });
    this._currentTask = null;
    this.emit('todo_change', []);
    if (this.logger) {this.logger.info('任务已清除', { reason });}
  }

  /**
   * 注入 Memory 检查点 reminder
   *
   * 每隔 _memoryCheckInterval 轮（默认 5）触发一次：
   * 1) 清理上一条 reminder（避免堆积）
   * 2) 注入新 reminder 到消息历史末尾，提示 AI 主动调用 memory_append 提取用户长期偏好/规则
   *
   * reminder 用 role='user' 注入（跟 clearTask 一致），AI 看到后会理解这是"系统通知"而非用户真实输入。
   * 同时发一个 status 事件让 TUI 提示用户"正在检查 Memory"。
   */
  _injectMemoryCheckReminder() {
    // 1) 清理旧 reminder（避免堆积多条）
    const before = this.messages.length;
    this.messages = this.messages.filter((m) => !m._memoryCheckReminder);
    const cleaned = before - this.messages.length;

    // 2) 注入新 reminder
    const reminder = {
      role: 'user',
      content: [
        '[Memory 总结检查点]',
        `你已经处理了 ${this._totalRoundsProcessed} 轮对话。请回顾本段对话（最近 ${this._memoryCheckInterval} 轮），`,
        '如果用户表达了【长期偏好、规则、约定】（例如"以后都用 X"、"不要 Y"、"我偏好 Z"、"请务必 W"），',
        '请使用 memory_append 工具写入 .anvil/Memory.md。',
        '',
        '【触发条件】用户消息含"记住/我要求/以后/不要/请务必/记得/偏好/习惯"等关键词，或重复表达同一偏好。',
        '【不要写入】临时任务、一次性需求、单次调试偏好。',
        '【不要回应该 reminder】无需在回复中提及本提醒，仅在确认有需要写入的内容时才调用 memory_append。',
      ].join(''),
      _memoryCheckReminder: true,
      _injectedAt: new Date().toISOString(),
    };
    this.messages.push(reminder);

    // 3) TUI 状态提示（让用户知道系统在做什么，但不打扰）
    this.emit('status', `[Memory] 检查点 (第 ${this._totalRoundsProcessed} 轮) — AI 正在审视是否需要更新 .anvil/Memory.md`);

    if (this.logger) {
      this.logger.info('Memory 检查点触发', {
        totalRounds: this._totalRoundsProcessed,
        cleaned,
        messagesAfter: this.messages.length,
      });
    }
  }

  /**
   * 获取 Memory 检查点状态（供 UI/命令显示）
   */
  getMemoryCheckStatus() {
    return {
      interval: this._memoryCheckInterval,
      roundsSinceLastCheck: this._roundSinceMemoryCheck,
      totalRounds: this._totalRoundsProcessed,
      nextCheckIn: this._memoryCheckInterval - this._roundSinceMemoryCheck,
    };
  }

  // 查找最后一条语义摘要的索引
  _findLastSemanticSummaryIndex() {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i]._semanticSummary) {
        return i;
      }
    }
    return -1;
  }

  _calculateSummaryBudget() {
    const windowSize = this.contextManager?.windowSize || 1_000_000;

    // 计算待摘要的非系统消息数量（上次语义摘要之后的新消息）
    const lastSemanticIdx = this._findLastSemanticSummaryIndex();
    const newMsgs = this.messages.slice(lastSemanticIdx + 1)
      .filter(m => m.role !== 'system');

    // 每 2 条消息估一轮
    const roundsToSummarize = Math.ceil(newMsgs.length / 2);

    // 预算公式：至少 200 tokens，最多窗口的 3%，每轮 80 tokens
    const maxBudget = Math.floor(windowSize * 0.03);
    const budget = Math.max(200, Math.min(maxBudget, roundsToSummarize * 80));

    return budget;
  }

  // AI 语义压缩：生成语义摘要
  async _generateSemanticSummary(budget = 200) {
    if (!this.aiClient) {return '';}

    try {
      // 获取上次摘要之后的新消息（增量摘要），最多取 60 条防止 Token 浪费
      const lastSemanticIdx = this._findLastSemanticSummaryIndex();
      const newMsgsStart = Math.max(lastSemanticIdx + 1, this.messages.length - 60);
      const newMsgs = this.messages.slice(newMsgsStart)
        .filter(m => m.role !== 'system' || m._semanticSummary);

      const dialogueContent = newMsgs
        .map(m => `${m.role}: ${(m.content || '').slice(0, 300)}`)
        .join('\n');

      if (!dialogueContent.trim()) {return '';}

      // 带预算的结构化摘要指令
      const summaryPrompt = `你最多可以使用 ${budget} tokens 来生成以下对话的语义摘要。
根据预算大小决定详细程度：
- 预算充裕（>1000 tokens）：逐轮详细记录，保留问题、工具调用、结果、决策
- 预算适中（300-1000 tokens）：每组轮次概要 + 关键操作列表
- 预算紧张（<300 tokens）：只保留核心需求、关键操作、重要决策

必须使用以下结构化格式输出，不要额外解释：

## 用户核心需求
{概括用户的目标和意图}

## 关键操作记录
{按时间顺序列出关键操作，包括工具调用、文件读写、命令执行等}

## 文件变更清单
{所有创建/修改/删除的文件及变更要点}

## 重要决策
{架构选择、方案取舍、关键判断等}

## 当前状态
{任务进度、待办事项、下一步方向}`;

      // 调用 AI 生成摘要
      const response = await this.aiClient.chat([
        { role: 'system', content: summaryPrompt },
        { role: 'user', content: dialogueContent },
      ], { model: this.model });

      return response.content || '';
    } catch (err) {
      this.logger?.warn('AI 语义摘要生成失败', err.message);
      return '';
    }
  }

  // 检测用户输入是否为清除 todolist 请求
  _isTodoClearRequest(input) {
    if (!input || typeof input !== 'string') {return false;}
    const patterns = [
      /^(清除|清空|删除|重置)(所有|全部)?(todo(列表|list)?|任务|待办)(列表)?\s*$/i,
      /^(清掉|删掉|干掉)(todo|任务|待办)/,
      /^clear\s+(all\s+)?(todos?|tasks?)\s*$/i,
    ];
    return patterns.some(p => p.test(input.trim()));
  }

  // 检查并获取待注入的用户上下文
  async _checkPendingContext() {
    return new Promise((resolve) => {
      // 设置一次性监听器，等待 index.js 返回上下文
      const handler = (context) => {
        resolve(context || null);
      };
      this.once('pending_context_response', handler);

      // 请求上下文
      this.emit('check_pending_context');

      // 超时保护（500ms）
      setTimeout(() => {
        this.removeListener('pending_context_response', handler);
        resolve(null);
      }, 500);
    });
  }

  interrupt() {
    this._aborted = true;
    if (this.aiClient) {
      this.aiClient.abort();
    }
    this.isProcessing = false;
    // 清理中断残留的孤立 tool 消息（避免下一轮触发 400）
    this._cleanupInterruptedToolCalls();
    // 团队模式中断：强制解散 teamManager，避免子 Agent 在后台继续消耗 token
    if (this.teamManager) {
      const teamManager = this.teamManager;
      this.teamManager = null;
      this.teamMode = false;
      this._updateSystemPrompt();
      this.emit('team_mode_end', { reason: 'interrupted' });
      // 异步强制解散，不阻塞 interrupt 返回
      teamManager.dissolve({ force: true }).catch(err => {
        this.logger?.error('中断时解散团队失败', err.message);
      });
    }
    this.emit('interrupted');
  }

  switchModel(modelName) {
    const { isValidModel, getModelProvider } = require('../ai/models');
    const { getModelContextWindow } = require('../ai/providers');
    if (isValidModel(modelName)) {
      this.model = modelName;

      // 根据新模型更新上下文窗口大小（如果能探测到）
      const provider = getModelProvider(modelName) || this.getProvider() || 'deepseek';
      const contextWindow = getModelContextWindow(provider, modelName);
      if (this.contextManager && contextWindow) {
        this.contextManager.setWindowSize(contextWindow);
        if (this.logger) {
          this.logger.debug(`切换模型到 ${modelName}，上下文窗口调整为 ${contextWindow.toLocaleString()} tokens`);
        }
      }

      // 触发模型切换事件
      this.emit('model_changed', { model: modelName, provider: this.getProvider() });

      return true;
    }
    return false;
  }

  /**
   * 获取当前提供商 ID
   * @returns {string} 提供商 ID
   */
  getProvider() {
    if (this.aiClient && this.aiClient.getCurrentProvider) {
      return this.aiClient.getCurrentProvider();
    }
    // 回退：从模型推断
    const { detectProvider } = require('../ai/providers');
    return detectProvider(this.model) || 'deepseek';
  }

  /**
   * 切换模型提供商
   * @param {string} providerId - 提供商 ID
   * @returns {boolean} 是否切换成功
   */
  switchProvider(providerId) {
    const { isValidProvider, getProvider, getModelContextWindow } = require('../ai/providers');
    if (!isValidProvider(providerId)) {
      return false;
    }

    const provider = getProvider(providerId);

    // 更新 AI 客户端的提供商配置
    if (this.aiClient) {
      // 重置客户端缓存，下次请求会使用新配置
      this.aiClient._providerConfig = null;
      this.aiClient._openai = null;
      this.aiClient.config.provider = providerId;
    }

    // 更新当前配置
    this.config.provider = providerId;

    // 如果当前模型不属于新提供商，切换到新提供商的默认模型
    const { detectProvider } = require('../ai/providers');
    const currentModelProvider = detectProvider(this.model);
    if (currentModelProvider !== providerId) {
      this.model = provider.defaultModel;
    }

    // 根据新提供商和模型更新上下文窗口大小（如果能探测到）
    const contextWindow = getModelContextWindow(providerId, this.model);
    if (this.contextManager && contextWindow) {
      this.contextManager.setWindowSize(contextWindow);
      if (this.logger) {
        this.logger.debug(`切换提供商到 ${providerId}，上下文窗口调整为 ${contextWindow.toLocaleString()} tokens`);
      }
    }

    return true;
  }

  togglePlanMode() {
    this._planMode = !this._planMode;
    if (!this._planMode) {
      this._awaitingPlanApproval = false;
      this._planApproved = false;
      this._pendingPlan = null;
    }
    // 更新 System Prompt 中的 Plan Mode 提示
    this._updateSystemPrompt();
    this.emit('plan_mode_changed', this._planMode);
    return this._planMode;
  }

  // 默认 L0,planMode 追加 L4,teamMode 追加 L5,其他按需
  _buildSystemPrompt() {
    const layers = [PromptLayer.L0];
    if (this._planMode) {layers.push(PromptLayer.L4);}
    if (this.teamMode) {layers.push(PromptLayer.L5);}
    return getSystemPrompt({ layers });
  }

  // 按需把指定层注入到 system 消息（供 get_system_layer 工具调用）
  // layerName: L0/L1/L2/L3/L4/L5；granularity: L3 内部粒度（required/detail），其他层忽略
  // 同层重复调用幂等；L3 的两种粒度可同时存在
  injectPromptLayer(layerName, granularity = L3Granularity.DETAIL) {
    const content = getLayerContent(layerName, granularity);
    if (!content) {return { success: false, error: `未知层级: ${layerName}` };}

    // L3 内部两种粒度用不同标记，避免 detail 覆盖 required
    const tag = layerName === PromptLayer.L3 ? `[Layer: ${layerName} (${granularity})]` : `[Layer: ${layerName}]`;

    const sysIdx = this.messages.findIndex(m => m.role === 'system');
    if (sysIdx >= 0) {
      const sysContent = this.messages[sysIdx].content;
      // 幂等检查：已注入过的层（含粒度）不重复添加
      if (sysContent.includes(tag)) {
        return { success: true, layer: layerName, granularity: layerName === PromptLayer.L3 ? granularity : null, action: 'already_loaded' };
      }
      this.messages[sysIdx].content = sysContent + `\n\n${tag}\n${content}`;
    } else {
      this.messages.unshift({
        role: 'system',
        content: `${tag}\n${content}`,
      });
    }
    return { success: true, layer: layerName, granularity: layerName === PromptLayer.L3 ? granularity : null, action: 'loaded' };
  }

  // 查看当前已注入的层级（含粒度，供 get_system_layer 工具的 list 操作）
  // 返回格式: ['L0', 'L3 (detail)', 'L4'] 等
  listLoadedLayers() {
    const sysIdx = this.messages.findIndex(m => m.role === 'system');
    if (sysIdx < 0) {return [];}
    const matches = this.messages[sysIdx].content.match(/\[Layer: ([A-Z0-9_]+(?:\s\([a-z]+\))?)\]/g) || [];
    return matches.map(m => m.match(/\[Layer: ([A-Z0-9_]+(?:\s\([a-z]+\))?)\]/)[1]);
  }

  // 更新 System Prompt(Plan/Team Mode 切换后重建)
  // 保留 AI 主动加载的 L1/L2/L3 detail 层,不因 planMode/teamMode 切换而丢失
  _updateSystemPrompt() {
    const sysPrompt = this._buildSystemPrompt();
    const sysIdx = this.messages.findIndex(m => m.role === 'system');

    if (sysIdx >= 0) {
      const sysContent = this.messages[sysIdx].content;
      // 提取所有 [Layer: L1/L2/L3 (xxx)] 标签的完整 block(AI 主动加载的层)
      const additionalLayers = [];
      const layerRegex = /\[Layer: (L[123](?:\s\([a-z]+\))?)\][\s\S]*?(?=\n\[Layer: |$)/g;
      let match;
      while ((match = layerRegex.exec(sysContent)) !== null) {
        additionalLayers.push(match[0].trim());
      }
      // 新内容 = base (L0 + L4 + L5) + 保留的 L1-L3 detail
      const newContent = additionalLayers.length > 0
        ? sysPrompt + '\n\n' + additionalLayers.join('\n\n')
        : sysPrompt;
      this.messages[sysIdx] = { role: 'system', content: newContent };
    } else {
      this.messages.unshift({ role: 'system', content: sysPrompt });
    }
  }

  async savePlanToFile(planContent) {
    if (!this.contextManager?.projectDir) {return;}
    const filePath = path.join(this.contextManager.projectDir, 'Anvil.md');
    const header = `# Anvil 计划\n\n_自动生成于 ${new Date().toLocaleString('zh-CN')}_\n\n---\n\n`;
    const fsp = require('fs/promises');
    try {
      await fsp.writeFile(filePath, header + planContent, 'utf8');
      this._planModeFilePath = filePath;
      this.logger?.info('计划已保存到 Anvil.md', { path: filePath });
    } catch (err) {
      this.logger?.warn('保存计划到 Anvil.md 失败', err.message);
    }
  }

  async updatePlanInFile(additionalContent) {
    if (!this._planModeFilePath) {return;}
    const fsp = require('fs/promises');
    try {
      const current = await fsp.readFile(this._planModeFilePath, 'utf8');
      const divider = `\n---\n\n_更新于 ${new Date().toLocaleString('zh-CN')}_\n\n`;
      await fsp.writeFile(this._planModeFilePath, current + divider + additionalContent, 'utf8');
    } catch (err) {
      this.logger?.warn('更新 Anvil.md 失败', err.message);
    }
  }

  resolveQuestion(answers) {
    // 优先解析 queue(主+子 Agent 共享),queue 无 current 时兜底旧单值 resolve
    if (this.teamQuestionQueue && this.teamQuestionQueue.current) {
      const resolved = this.teamQuestionQueue.resolve(answers);
      if (resolved) {
        this._pendingQuestionResolve = null;
        return;
      }
    }
    if (this._pendingQuestionResolve) {
      this._pendingQuestionResolve(answers);
      this._pendingQuestionResolve = null;
    }
  }

  async approvePlan() {
    if (!this._awaitingPlanApproval) {return { error: '当前没有待批准的 plan' };}
    this._awaitingPlanApproval = false;
    this._planApproved = true;
    this._pendingPlan = null;
    this._suppressUI = false;

    // 退出计划模式
    this._planMode = false;
    this._updateSystemPrompt();
    this.emit('plan_mode_changed', false);

    this.messages.push({ role: 'user', content: '计划已批准，请按计划执行。' });
    this.emit('status', '[完成]计划已批准，正在执行...');
    await this.updatePlanInFile('\n\n## [完成]计划已批准，正在执行...\n');

    const result = await this._agentLoop(this._currentTask);
    return this._finishPlanResponse(result);
  }

  async rejectPlan(feedback) {
    if (!this._awaitingPlanApproval) {return { error: '当前没有待批准的 plan' };}
    this._awaitingPlanApproval = false;
    this._pendingPlan = null;
    this._suppressUI = false;

    const msg = feedback
      ? `计划被拒绝。用户反馈：${feedback}。请根据反馈提供修改后的计划。`
      : '计划被拒绝，请提供替代方案。';
    this.messages.push({ role: 'user', content: msg });
    this.emit('status', '[重做]计划被拒绝，正在重新规划...');
    await this.updatePlanInFile(`\n\n## [失败]计划被拒绝\n\n**反馈**: ${feedback || '无'}\n\n正在重新规划...\n`);

    const result = await this._agentLoop(this._currentTask);
    return this._finishPlanResponse(result);
  }

  async editPlan(feedback) {
    if (!this._awaitingPlanApproval) {return { error: '当前没有待批准的 plan' };}
    this._awaitingPlanApproval = false;
    this._pendingPlan = null;
    this._suppressUI = false;

    this.messages.push({ role: 'user', content: `对计划的修改建议：${feedback}` });
    this.emit('status', '[状态] 收到计划反馈，正在调整...');
    await this.updatePlanInFile(`\n\n## 用户反馈\n\n${feedback}\n\n**正在调整计划...**\n`);

    const result = await this._agentLoop(this._currentTask);
    return this._finishPlanResponse(result);
  }

  async requestPlanMode(reason) {
    if (this._planMode) {
      return { alreadyEnabled: true, message: 'Plan Mode 已启用' };
    }

    // 开启 Plan Mode（但不设置 _awaitingPlanApproval，因为还没有产出计划）
    this._planMode = true;
    this._suppressUI = false;
    this._updateSystemPrompt();
    this.emit('plan_mode_changed', true);

    this.logger?.info('AI 请求进入 Plan Mode', { reason });

    return {
      requested: true,
      message: '已开启 Plan Mode，正在生成计划...',
    };
  }

  // 收尾 Plan → _agentLoop 结果
  async _finishPlanResponse(result) {
    // 如果结果仍然是一个 plan（再次产出 plan 而非执行），继续等待批准
    if (result.plan) {
      await this.savePlanToFile(result.plan);
      this.emit('plan_ready', result.plan);
      return { plan: result.plan };
    }

    // 正常收尾：同 processInput
    this.isProcessing = false;

    this.messages.push({
      role: 'assistant',
      content: result.content || '',
      reasoning_content: result.thinking || null,
      toolCalls: result.toolCalls || null,
    });

    if (this.contextManager && typeof this.contextManager.proactiveCompress === 'function') {
      try { this.messages = this.contextManager.proactiveCompress(this.messages); } catch {}
    }

    const contextHash = '';
    this.cache.set(this._currentTask, { model: this.model, contextHash }, {
      thinking: result.thinking,
      content: result.content,
      toolCalls: result.toolCalls,
    });

    this.emit('complete', {
      thinking: result.thinking,
      content: result.content,
      toolCalls: result.toolCalls,
      usage: result.usage,
    });

    return result;
  }

  getHistory() {
    return this.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role,
        content: m.content,
        reasoning_content: m.reasoning_content,
        tool_calls: m.tool_calls,
        timestamp: m.timestamp,
      }));
  }

  clearHistory() {
    const systemMsgs = this.messages.filter((m) => m.role === 'system');
    this.messages = systemMsgs;
    this.cache.clear();
  }

  getStatus() {
    const baseStatus = {
      model: this.model,
      processing: this.isProcessing,
      messageCount: this.messages.length,
    };

    if (this.contextManager) {
      const ctxStatus = this.contextManager.getStatusReport(this.messages);
      return { ...baseStatus, context: ctxStatus };
    }

    return baseStatus;
  }

  // 团队模式管理

  async _getTeamManager() {
    if (!this.teamManager) {
      const TeamManager = require('./team/manager');
      this.teamManager = await TeamManager.create({
        config: this.config,
        logger: this.logger,
        parentAgent: this,
        projectDir: this.config.projectDir || process.cwd(),
      });
      // 转发 manager 事件到 chatEngine,子 Agent 事件通过 _subAgent 标记路由
      const TEAM_EVENTS = [
        'team_created', 'team_dissolved', 'team_degraded',
        'agent_created', 'agent_started', 'agent_completed',
        'agent_terminated', 'agent_respawned',
        'state_changed',
        'thinking', 'content',  // 子 Agent 流式事件(带 _subAgent 标记)
        'tool_calls', 'tool_result',  // 子 Agent 工具调用事件(带 _subAgent 标记)
        'subagent_usage', 'subagent_heartbeat',
      ];
      for (const evt of TEAM_EVENTS) {
        this.teamManager.on(evt, (data) => {
          this.emit(evt, data);
        });
      }
    }
    return this.teamManager;
  }

  async _evaluateTeamNeed(taskDescription) {
    const teamManager = await this._getTeamManager();
    const context = {
      messageCount: this.messages.length,
      toolCallCount: this.messages.reduce((count, m) => {
        return count + (m.tool_calls?.length || 0);
      }, 0),
    };

    return await teamManager.evaluateTaskComplexity(taskDescription, context);
  }

  async _startTeamTask(taskDescription, options = {}) {
    const force = options.force === true;
    // suggestedRoles:AI 通过工具调用传的角色配置(可选)
    const suggestedRoles = Array.isArray(options.suggestedRoles) ? options.suggestedRoles : null;
    // 追踪 team_mode_start 是否已发出,确保 team_mode_end 成对出现
    let teamModeStarted = false;
    try {
      // force=true(用户明确要求)时跳过复杂度评估,直接进入 teamMode
      // 角色配置由 AI 决定(suggestedRoles),不再硬编码 1 executor
      let evaluation;
      if (force) {
        // chat 层算 suggestedAgents,UI 与 manager 共享同一份计数
        const finalRoles = (suggestedRoles && suggestedRoles.length > 0)
          ? suggestedRoles
          : [{ role: 'executor', count: 1 }];  // 兜底
        evaluation = {
          complexityScore: 100,
          needsTeam: true,
          reason: '用户明确要求启动团队(force=true)',
          suggestedAgents: finalRoles.map(r => ({
            role: r.role,
            count: Math.max(1, r.count || 1),
            description: r.description || `${r.role} - AI 指定的角色配置`,
          })),
          complexityFactors: { forceStart: true },
        };
      } else {
        // 评估是否需要团队
        evaluation = await this._evaluateTeamNeed(taskDescription);

        if (!evaluation.needsTeam) {
          // 任务足够简单，不需要团队
          return { needsTeam: false, reason: evaluation.reason };
        }
      }

      this.teamMode = true;
      // Team Mode 启动：注入 L5 规则到 system prompt
      this._updateSystemPrompt();
      this.emit('team_mode_start', {
        complexityScore: evaluation.complexityScore,
        suggestedAgents: evaluation.suggestedAgents,
        forced: force,
      });
      teamModeStarted = true;

      const teamManager = await this._getTeamManager();
      const result = await teamManager.startTeamTask(taskDescription, {
        messageCount: this.messages.length,
      }, { force, suggestedRoles });

      // 成功路径:任务完成,补发 team_mode_end 让 UI 状态栏恢复
      // (之前漏 emit,导致团队跑完后状态栏永远卡在"团队模式中")
      this._updateSystemPrompt();
      this.emit('team_mode_end', {
        reason: result?.result?.degraded ? 'degraded' : 'completed',
        teamId: result?.teamId,
        degraded: result?.result?.degraded,
        degradedReason: result?.result?.degradedReason,
      });

      // 关键:如果团队跑完但实际没产出(子 agent 全失败/没干活),
      // 把 degraded 标志 + 原因提到 result 顶层,避免 AI 漏看嵌套字段。
      // AI 必须明确知道"团队没真正干活",不能假装研究完成。
      if (result?.result?.degraded) {
        this.logger?.warn('团队模式 degraded: ' + result.result.degradedReason);
        return {
          ...result,
          degraded: true,
          degradedReason: result.result.degradedReason,
          warning: '⚠️ 团队任务完成度不足,子 Agent 可能未正常产出(degraded)。' +
            '请检查:1) 团队配置/角色 2) 子 Agent 是否能调通 AI API 3) 考虑用单 Agent 模式重做或拆任务。',
        };
      }

      return result;
    } catch (error) {
      this.logger?.error('团队模式执行失败', error.message);
      this.teamMode = false;
      // 关键:失败时清空 teamManager 引用,下次 _getTeamManager 会重建干净实例
      // 避免失败后 manager 内部 state 卡在 PLANNING/EXECUTING 等非终态,
      // 污染下次 start 触发状态机死锁(配合 manager.js 内部 state 重置形成双保险)
      this.teamManager = null;
      // 只有 start emit 过才补发 end,避免重复或误发
      if (teamModeStarted) {
        this._updateSystemPrompt();
        this.emit('team_mode_end', { reason: 'failed', error: error.message });
      }
      return { needsTeam: false, error: error.message };
    } finally {
      this.teamMode = false;
    }
  }

  // 解散团队
  async _dissolveTeam() {
    if (!this.teamManager) {
      return { success: false, message: '当前没有活跃的团队' };
    }

    try {
      await this.teamManager.dissolve();
      this.teamManager = null;
      this.teamMode = false;
      this._updateSystemPrompt();
      this.emit('team_mode_end', { reason: 'dissolved' });
      return { success: true, message: '团队已解散' };
    } catch (error) {
      this.logger?.error('解散团队失败', error.message);
      // 失败时也清空引用,避免半 cleanup 状态被复用
      this.teamManager = null;
      this.teamMode = false;
      this._updateSystemPrompt();
      this.emit('team_mode_end', { reason: 'dissolve_failed', error: error.message });
      return { success: false, error: error.message };
    }
  }

}

module.exports = ChatEngine;

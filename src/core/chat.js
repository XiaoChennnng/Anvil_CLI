'use strict';

const crypto = require('crypto');
const path = require('path');
const { EventEmitter } = require('events');
const SessionCache = require('../ai/cache');
const { getSystemPrompt, getAgentCheckPrompt, getAgentContinuePrompt } = require('../ai/prompts');

/**
 * 评估任务复杂度，动态调整迭代限制
 */
function estimateTaskComplexity(task) {
  if (!task) { return { level: 'unknown', maxIterations: 100 }; }
  const taskLength = task.length;
  let score = 0;

  if (taskLength > 500) { score += 2; }
  else if (taskLength > 200) { score += 1; }

  const multiTaskPatterns = [/\d+\s*个|多个|几个|一系列|各种|若干/];
  score += multiTaskPatterns.filter(p => p.test(task)).length;

  const complexPatterns = [/实现|开发|创建|构建|设计|重构|重写|迁移|改造|集成|对接|接入|测试/];
  score += complexPatterns.filter(p => p.test(task)).length;

  const fileOpPatterns = [/修改.*\d+|多个文件|整个项目|全局/];
  score += fileOpPatterns.filter(p => p.test(task)).length;

  const simplePatterns = [/是什么|怎么|如何|为什么|解释|说明|介绍|查看/];
  const isSimple = simplePatterns.some(p => p.test(task)) && score < 2;

  if (isSimple) { return { level: 'simple', maxIterations: 30 }; }
  if (score <= 2) { return { level: 'medium', maxIterations: 80 }; }
  if (score <= 4) { return { level: 'complex', maxIterations: 150 }; }
  return { level: 'very_complex', maxIterations: 250 };
}

/**
 * 解析 task_complete 结果，健壮处理各种格式
 */
function parseTaskCompleteResult(content) {
  if (!content) { return { complete: null, reason: 'no_result' }; }
  try {
    const result = JSON.parse(content);
    return { complete: result.complete === true, reason: 'json_parse' };
  } catch {
    if (/任务完成|已完成|all\s+done|completed/i.test(content)) {
      return { complete: true, reason: 'text_affirmative' };
    }
    if (/\d+\s*个?未完成|还有.*要做|pending/i.test(content)) {
      return { complete: false, reason: 'text_unfinished' };
    }
    return { complete: null, reason: 'parse_failed' };
  }
}

/**
 * 生成任务指纹，用于压缩后检测任务是否丢失
 */
function generateTaskFingerprint(task) {
  if (!task) { return { keyWords: [], full: '' }; }
  const words = task.split(/[\s,.，、。]+/).filter(w => w.length > 1);
  const stopWords = new Set(['的', '了', '和', '与', '或', '一个', '一些', '相关', '以及']);
  const keyWords = words.filter(w => !stopWords.has(w) && w.length > 2);
  return { keyWords: keyWords.slice(0, 5), full: task.slice(0, 80), length: task.length };
}

/**
 * 检测任务是否在压缩后丢失
 */
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

    // 用于文件冲突检测的时间戳记录
    this.fileTimestamps = {};

    // 当前任务描述（用于自主检查）
    this._currentTask = null;

    // 抑制 UI 事件标志：_agentLoop 内部 check/continue 消息不应渲染到 TUI
    this._suppressUI = false;

    // Plan Mode 状态
    this._planMode = false;
    this._planModeFilePath = null;
    this._awaitingPlanApproval = false;
    this._planApproved = false;
    this._pendingPlan = null;

    // AskUserQuestion 等待状态
    this._pendingQuestionResolve = null;

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
    const sysPrompt = getSystemPrompt({ planMode: this._planMode });
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
      this.messages = [...systemMsgs, ...historyMsgs];
    }
  }

  async processInput(input) {
    if (this.isProcessing) {
      return { error: '正在处理上一个请求，请等待...' };
    }

    this._aborted = false;
    this.isProcessing = true;

    try {
      if (this._isCompressionRequest(input)) {
        this.messages.push({ role: 'user', content: input });
        const result = this._handleCompressionRequest(input);
        this.isProcessing = false;
        return result;
      }

      if (this._isTodoClearRequest(input)) {
        this.clearTask('用户清空了任务列表');
        this.isProcessing = false;
        return { content: '✅ 任务列表已清空，等待新的指令。', cleaned: true };
      }

      this.messages.push({ role: 'user', content: input });

      if (this.contextManager && typeof this.contextManager.detectRegret === 'function') {
        const hadRegret = this.contextManager.detectRegret(input);
        if (hadRegret && this.logger) {
          this.logger.info('检测到压缩遗憾模式', { input: input.slice(0, 80) });
        }
      }

      // 构建对话上下文 hash，确保缓存感知对话状态
      const recentMsgs = this.messages.slice(-6);
      const contextHash = crypto.createHash('md5')
        .update(JSON.stringify(recentMsgs.map((m) => ({
          role: m.role,
          content: (m.content || '').slice(0, 100),
          hasTools: !!(m.tool_calls && m.tool_calls.length),
        }))))
        .digest('hex');

      // 检查缓存（带上上下文 hash，避免不同对话上下文命中同一缓存）
      const cached = this.cache.get(input, { model: this.model, contextHash });
      if (cached) {
        this.isProcessing = false;
        this.messages.push({ role: 'assistant', ...cached });
        return cached;
      }

      // 多级渐进式压缩
      if (this.contextManager) {
        const currentTokens = this.contextManager.estimateMessagesTokenCount(this.messages);
        const compLevel = this.contextManager.getCompressionLevel(this.messages, currentTokens);

        if (compLevel.needsCompression) {
	          this.emit('status', `⚡ ${compLevel.label} — 使用率 ${Math.round(compLevel.ratio * 100)}%`);

	          // 一次性调用 compressContext（修复之前调两次的 bug）
	          const compressResult = this.contextManager.compressContext(this.messages);
	          this.messages = compressResult.messages;
	          const stats = compressResult.stats;

          if (stats.compressed) {
            this.emit('status',
              `✅ 压缩完成 (L${stats.level}): ${stats.beforeTokens.toLocaleString()} → ${stats.afterTokens.toLocaleString()} tokens (节省 ${stats.savedPercent}%)`
            );

            if (this.logger) {
              this.logger.info('上下文压缩', stats);
            }
          }
        } else if (compLevel.level >= 1) {
          // 仅提示，不压缩
          this.emit('status', `💡 ${compLevel.label} (${Math.round(compLevel.ratio * 100)}%)`);
        }
      }

      // 保存当前任务描述
      this._currentTask = input;
      this._awaitingPlanApproval = false; // 确保无残留的待批准状态

      // 自主 Agent 模式：持续执行直到 AI 认为任务完成
      const result = await this._agentLoop(input);

      // Plan Mode：检测到计划，不进入正常收尾，等待用户批准
      if (result.plan) {
        this.emit('plan_ready', result.plan);
        if (this.logger) {this.logger.info('产出了计划，等待用户批准');}
        this.isProcessing = false;
        return { plan: result.plan };
      }

      this.isProcessing = false;

      // 添加最终助手消息到历史
      this.messages.push({
        role: 'assistant',
        content: result.content || '',
        reasoning_content: result.thinking || null,
        toolCalls: result.toolCalls || null,
      });

      // 主动后台压缩（非阻塞）
      if (this.contextManager && typeof this.contextManager.proactiveCompress === 'function') {
        try {
          this.messages = this.contextManager.proactiveCompress(this.messages);
        } catch { /* 压缩失败不影响主流程 */ }
      }

      // 更新缓存
      this.cache.set(input, { model: this.model, contextHash }, {
        thinking: result.thinking,
        content: result.content,
        toolCalls: result.toolCalls,
      });

      // 触发完成事件
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

  /**
   * 自主 Agent 循环
   * 像 Claude Code 一样：规划 -> 执行 -> 检查 -> 继续或结束
   * @param {string} originalTask - 原始任务
   * @returns {Promise<Object>} 最终结果
   */
  async _agentLoop(originalTask) {
    const complexity = estimateTaskComplexity(originalTask);
    const maxIterations = complexity.maxIterations;
    const startTime = Date.now();
    const HARD_TIMEOUT = 4 * 60 * 60 * 1000;
    const SOFT_TIMEOUT = 3.5 * 60 * 60 * 1000;
    let lastSoftWarning = 0;
    let iterationCount = 0;
    let fullContent = '';
    let fullThinking = '';
    let lastUsage = null;
    const taskFingerprint = generateTaskFingerprint(originalTask);

    // 第一次执行
    let result = await this._sendAndProcess();
    fullContent += result.content || '';
    fullThinking += result.thinking || '';
    lastUsage = result.usage;

    // Plan Mode：只要有内容就视为计划，等待批准
    if (this._planMode && result.content) {
      this._awaitingPlanApproval = true;
      this._pendingPlan = result.content;
      await this.savePlanToFile(result.content);
      return {
        thinking: fullThinking,
        content: fullContent,
        toolCalls: [],
        usage: lastUsage,
        plan: result.content,
      };
    }

    // Plan Mode：有工具调用但无内容，也等待批准
    if (this._planMode && result.hadToolCalls) {
      this._awaitingPlanApproval = true;
      this._pendingPlan = fullContent || '(工具调用，待批准)';
      await this.savePlanToFile(`[工具调用]\n\n${fullContent || '(无描述)'}`);
      return {
        thinking: fullThinking,
        content: fullContent,
        toolCalls: [],
        usage: lastUsage,
        plan: fullContent || '(工具调用，待批准)',
      };
    }

    // 非 Plan Mode：没有工具调用时直接返回
    if (!result.hadToolCalls) {
      return {
        thinking: fullThinking,
        content: fullContent,
        toolCalls: [],
        usage: lastUsage,
      };
    }

    // 自主循环：有工具调用时，检查任务是否需要继续
    while (iterationCount < maxIterations && !this._aborted) {
      iterationCount++;
      const elapsed = Date.now() - startTime;

      // 硬性超时：运行超过 4 小时强制停止
      if (elapsed >= HARD_TIMEOUT) {
        this.logger?.warn('Agent 达到硬性超时，强制停止', {
          iterationCount,
          elapsed: Math.round(elapsed / 60000) + 'min',
        });
        this.emit('timeout_hard', { iterationCount, elapsed });
        break;
      }

      // 软性超时警告：运行超过 3.5 小时发出警告
      if (elapsed >= SOFT_TIMEOUT && elapsed - lastSoftWarning >= 10 * 60 * 1000) {
        const remaining = HARD_TIMEOUT - elapsed;
        this.emit('timeout_soft', {
          iterationCount,
          elapsed,
          remaining,
          message: `已运行 ${Math.round(elapsed / 60000)} 分钟`,
        });
        lastSoftWarning = elapsed;
      }

      // 上下文使用率检查——撑爆了先压缩，别硬撑
      if (this.contextManager) {
        try {
          const compLevel = this.contextManager.getCompressionLevel(this.messages);
          if (compLevel.needsCompression || compLevel.ratio > 0.85) {
            const compressResult = this.compactContext({ level: 'auto', keep: ['recent', 'decisions'] });
            if (compressResult.stats?.compressed) {
              // 使用智能任务指纹检测任务是否丢失
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

      // 将当前结果加入历史（tool_calls 已在 _sendAndProcess 中加入，此处不重复）
      this.messages.push({
        role: 'assistant',
        content: result.content || '',
        reasoning_content: result.thinking || '',
      });

      // 检查是否有待注入的用户上下文
      const injectedContext = await this._checkPendingContext();

      // 使用强化后的检查提示词
      let checkMsg = getAgentCheckPrompt(originalTask);
      if (injectedContext) {
        checkMsg += `\n\n[用户补充说明]\n${injectedContext}`;
      }

      this.messages.push({
        role: 'user',
        content: checkMsg,
      });

      // 发送检查请求（内部消息，不渲染到 UI）
      this._suppressUI = true;
      const checkResult = await this._sendAndProcess();
      this._suppressUI = false;
      fullContent += checkResult.content || '';
      fullThinking += checkResult.thinking || '';
      lastUsage = checkResult.usage || lastUsage;

      // 将检查结果加入历史
      this.messages.push({
        role: 'assistant',
        content: checkResult.content || '',
        reasoning_content: checkResult.thinking || '',
      });

      // ─── 完成检测：只有明确调用 task_complete 且返回 complete=true 才停止 ───
      const calledTaskComplete = checkResult.toolCalls?.some(
        tc => tc.function?.name === 'task_complete'
      );

      if (calledTaskComplete) {
        const lastToolMsg = [...this.messages].reverse().find(m => m.role === 'tool');
        const parsed = parseTaskCompleteResult(lastToolMsg?.content || '');
        if (parsed.complete === true) {
          this.logger?.info('任务完成', { reason: parsed.reason, iterationCount });
          break;
        }
        // 有未完成或不确定，继续执行
      }

      // ─── 保护性限制：只有真正卡住才停 ───
      // AI 在干活（有工具调用）就不该停，maxIterations 只是最终保护
      // 移除 iterationCount >= maxIterations 的自动 break

      // ─── 任务未完成，继续执行 ───
      this.messages.push({
        role: 'user',
        content: getAgentContinuePrompt(),
      });

      this._suppressUI = true;
      result = await this._sendAndProcess();
      this._suppressUI = false;
      fullContent += result.content || '';
      fullThinking += result.thinking || '';
      lastUsage = result.usage || lastUsage;

      // ─── "继续"后无工具调用的处理 ───
      // 真正的动态：AI 在干活就不停，只有连续多次真正卡住才停
      if (!result.hadToolCalls) {
        // 检查当前回复中是否包含 task_complete 调用
        if (result.toolCalls?.some(tc => tc.function?.name === 'task_complete')) {
          break;
        }

        // 注入强制选择提示
        this.messages.push({
          role: 'user',
          content: '如果任务已完成，请调用 task_complete 工具。如果还有工作要做，请继续执行。' +
                   '不要只回复文字，用行动回答。',
        });

        this._suppressUI = true;
        const recheckResult = await this._sendAndProcess();
        this._suppressUI = false;

        if (recheckResult.toolCalls?.some(tc => tc.function?.name === 'task_complete')) {
          break;
        }

        // 连续两轮无工具调用，可能是真正卡住了
        // 但先检查 AI 是否有实际内容输出（可能在写大段代码/文档）
        const hasSubstantialContent = (recheckResult.content || '').length > 200;
        if (!hasSubstantialContent) {
          this.logger?.warn('AI 可能卡住', { iterationCount });
          break;
        }

        // 有实质内容但无工具调用，可能是输出阶段，继续
        result = recheckResult;
        fullContent += recheckResult.content || '';
        fullThinking += recheckResult.thinking || '';
        lastUsage = recheckResult.usage || lastUsage;
      }
    }

    return {
      thinking: fullThinking,
      content: fullContent,
      toolCalls: [],
      usage: lastUsage,
    };
  }

  /**
   * 发送消息并处理响应（含工具调用循环 + 自动继续）
   */
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

      // 准备 API 请求（必须正确传递 reasoning_content）
      // 规则：有 tool_calls 的 assistant 消息必须携带 reasoning_content 给后续所有请求
      // 无 tool_calls 的 assistant 消息的 reasoning_content 可选（API 会忽略）
      const apiMessages = this.messages.map((m) => {
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

      // 获取已注册的工具定义
      const tools = this.toolRegistry ? this.toolRegistry.getOpenAITools() : [];

      // 检查是否被中断
      if (this._aborted) {
        throw new Error('请求已被中断');
      }

      if (!this._suppressUI) {this.emit('thinking_start');}

      // 发送请求到 AI
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

        // 先添加 AI 回复（含工具调用 + reasoning_content）到消息历史
        // 重要：带 tool_calls 的 assistant 消息必须保留 reasoning_content
        // 后续所有请求都必须携带，否则 API 返回 400
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

        // 逐个执行工具调用：每个工具调用 → 立即显示结果，实现 1:1 对应
        for (const toolCall of response.toolCalls) {
          // 逐个发射工具调用事件（UI 逐个展示，与结果一一对应）
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

          // 执行工具
          let result;
          try {
            if (!this._suppressUI) {this.emit('tool_execute', { name, args });}
            result = await this.toolRegistry.execute(name, args, {
              projectDir: this.config.projectDir,
              logger: this.logger,
              fileTimestamps: this.fileTimestamps,
              maxOutputLines: this.config.maxOutputLines || 50,
              planModeRestricted: this._planMode && !this._planApproved,
              onOutput: (data, isError) => {
                if (!this._suppressUI) {this.emit('command_output', data, isError);}
              },
              todoManager: this.todoManager,
              onTodoChange: (todos) => this.emit('todo_change', todos),
              onQuestion: (params) => {
                // AskUserQuestion：暂停执行等待用户回答
                if (this._suppressUI) {return { answers: [] };}
                return new Promise((resolve) => {
                  this._pendingQuestionResolve = resolve;
                  this.emit('question', params);
                });
              },
            });
            if (!this._suppressUI) {this.emit('tool_result', { name, result, toolCall });}
            // 通知上下文管理器工具调用（用于相位检测 + 文件预取）
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

          // 将工具调用结果加入消息历史（限制大小防止撑爆上下文）
          let resultStr = JSON.stringify(result);
          const MAX_RESULT_LEN = 4000;
          if (resultStr.length > MAX_RESULT_LEN) {
            resultStr = resultStr.slice(0, MAX_RESULT_LEN) + '... (结果过长已截断)';
          }
          this.messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: resultStr,
          });

          if (this.logger) {
            this.logger.info(`工具调用: ${name}`, { args, result });
          }
        }

        // 继续循环，AI 将基于工具结果生成最终回复
        continue;
      }

      // 检测截断：finishReason === 'length' 表示输出被截断，需要自动继续
      if (response.finishReason === 'length' && continueCount < maxContinues) {
        continueCount++;

        // 将已有的内容加入消息历史，让 AI 知道从哪里继续
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

        this.emit('status', `⏳ 响应被截断，自动继续... (${continueCount}/${maxContinues})`);

        if (this.logger) {
          this.logger.info('响应截断，自动继续', { continueCount });
        }

        // 继续循环，发送"继续"请求
        continue;
      }

      // 无工具调用且未截断，对话结束
      // 注意：内容已通过 AI 客户端的流式发射发送到 UI，不需要再次发射
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

  /**
   * 压缩对话上下文（供 compact_context 工具和 /compact 命令调用）
   * @param {Object} options - 见 ContextManager.compactContext
   * @returns {{ messages: Array, stats: Object }}
   */
  compactContext(options) {
    if (!this.contextManager) {
      return { messages: this.messages, stats: { compressed: false, error: '上下文管理器未初始化' } };
    }
    const result = this.contextManager.compactContext(this.messages, options);
    this.messages = result.messages;
    return result;
  }

  /**
   * 清除当前任务，注入系统通知让 AI 重置工作状态
   * 由 /todo clear 或自然语言"清除todolist"触发
   * @param {string} reason - 清除原因
   */
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
   * 检测用户输入是否为上下文压缩请求
   */
  _isCompressionRequest(input) {
    if (!input || typeof input !== 'string') {return false;}
    const trimmed = input.trim().toLowerCase();

    // 精确匹配短命令
    const exactCommands = ['/compact', '/compress', '/compact keep', '/compress keep'];
    if (exactCommands.includes(trimmed.split(/\s+/)[0])) {return true;}

    // 中文自然语言压缩请求
    const patterns = [
      /^压缩(一下|上下文|清理|整理)?$/,
      /^清理(上下文|一下|下)?$/,
      /^整理(一下|上下文)?$/,
      /^释放(上下文|空间|token)/,
      /^compact/i,
      /^compress/i,
    ];

    // 只处理短消息（纯压缩请求，不带其他意图）
    if (trimmed.length > 30) {return false;}

    return patterns.some(p => p.test(trimmed));
  }

  /**
   * 处理上下文压缩请求
   */
  async _handleCompressionRequest(input) {
    const trimmed = input.trim().toLowerCase();

    // 解析 keep 参数: "压缩一下保留文件" 或 "压缩一下保留项目结构"
    let keep = ['recent', 'decisions'];
    let level = 'auto';

    if (/保留.*文件/.test(trimmed) || /保留.*注入/.test(trimmed)) {
      keep.push('files');
    }
    if (/保留.*项目/.test(trimmed) || /保留.*结构/.test(trimmed)) {
      keep.push('project');
    }
    if (/保留.*工具/.test(trimmed)) {
      keep.push('tools');
    }
    if (/保留.*全部/.test(trimmed) || /保留.*所有/.test(trimmed)) {
      keep = ['all'];
    }
    if (/轻度/.test(trimmed) || /light/.test(trimmed)) {
      level = 'light';
    }
    if (/深度/.test(trimmed) || /heavy/.test(trimmed)) {
      level = 'heavy';
    }

    try {
      const result = this.compactContext({ level, keep });
      if (result.stats && result.stats.compressed) {
        const stats = result.stats;
        if (this.logger) {
          this.logger.info(`上下文压缩完成: ${stats.beforeTokens}→${stats.afterTokens} tokens (${stats.savedPercent}%)`);
        }
        this.emit('status', `✅ 上下文已压缩: ${stats.beforeTokens.toLocaleString()} → ${stats.afterTokens.toLocaleString()} tokens (节省 ${stats.savedPercent}%)`);
        return {
          content: `✅ 上下文已压缩\n\n压缩级别: ${stats.name || level}\n压缩前: ${stats.beforeTokens.toLocaleString()} tokens\n压缩后: ${stats.afterTokens.toLocaleString()} tokens\n节省: ${stats.savedPercent}%\n保留策略: ${(stats.preserved || keep).join(', ')}\n${stats.message ? '\n' + stats.message : ''}`,
          compressed: stats,
        };
      }
      return { content: '上下文使用率不高，无需压缩', compressed: false };
    } catch (err) {
      if (this.logger) {this.logger.error('手动压缩失败', err.message);}
      return { error: `压缩失败: ${err.message}` };
    }
  }

  /**
   * 检测用户输入是否为"清除todolist"请求
   * 自然语言检测，不依赖 /todo clear 命令
   */
  _isTodoClearRequest(input) {
    if (!input || typeof input !== 'string') {return false;}
    const patterns = [
      /^(清除|清空|删除|重置)(所有|全部)?(todo(列表|list)?|任务|待办)(列表)?\s*$/i,
      /^(清掉|删掉|干掉)(todo|任务|待办)/,
      /^clear\s+(all\s+)?(todos?|tasks?)\s*$/i,
    ];
    return patterns.some(p => p.test(input.trim()));
  }

  /**
   * 检查并获取待注入的用户上下文
   * @returns {Promise<string|null>} 待注入的上下文内容
   */
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

  /**
   * 中断当前处理
   */
  interrupt() {
    this._aborted = true;
    if (this.aiClient) {
      this.aiClient.abort();
    }
    this.isProcessing = false;
    this.emit('interrupted');
  }

  /**
   * 切换模型
   * @param {string} modelName
   */
  switchModel(modelName) {
    const { isValidModel } = require('../ai/models');
    if (isValidModel(modelName)) {
      this.model = modelName;
      return true;
    }
    return false;
  }

  /**
   * 切换 Plan Mode
   * @returns {boolean} 切换后的状态
   */
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

  /**
   * 更新 System Prompt（切换 Plan Mode 后重建 system 消息）
   */
  _updateSystemPrompt() {
    const sysPrompt = getSystemPrompt({ planMode: this._planMode });
    // 替换第一条 system 消息
    const sysIdx = this.messages.findIndex(m => m.role === 'system');
    if (sysIdx >= 0) {
      this.messages[sysIdx] = { role: 'system', content: sysPrompt };
    } else {
      this.messages.unshift({ role: 'system', content: sysPrompt });
    }
  }

  /**
   * 保存计划到 Anvil.md
   */
  async savePlanToFile(planContent) {
    if (!this.contextManager?.projectDir) {return;}
    const filePath = path.join(this.contextManager.projectDir, 'Anvil.md');
    const header = `# Anvil 计划\n\n_自动生成于 ${new Date().toLocaleString('zh-CN')}_\n\n---\n\n`;
    const fs = require('fs');
    try {
      fs.writeFileSync(filePath, header + planContent, 'utf8');
      this._planModeFilePath = filePath;
      this.logger?.info('计划已保存到 Anvil.md', { path: filePath });
    } catch (err) {
      this.logger?.warn('保存计划到 Anvil.md 失败', err.message);
    }
  }

  /**
   * 更新 Anvil.md（追加新内容）
   */
  async updatePlanInFile(additionalContent) {
    if (!this._planModeFilePath) {return;}
    const fs = require('fs');
    try {
      const current = fs.readFileSync(this._planModeFilePath, 'utf8');
      const divider = `\n---\n\n_更新于 ${new Date().toLocaleString('zh-CN')}_\n\n`;
      fs.writeFileSync(this._planModeFilePath, current + divider + additionalContent, 'utf8');
    } catch (err) {
      this.logger?.warn('更新 Anvil.md 失败', err.message);
    }
  }

  /**
   * 处理用户问答结果
   * @param {Array} answers - 用户回答的结果数组
   */
  resolveQuestion(answers) {
    if (this._pendingQuestionResolve) {
      this._pendingQuestionResolve(answers);
      this._pendingQuestionResolve = null;
    }
  }

  /**
   * 处理计划批准 — 用户批准 → 按计划执行
   * @returns {Promise<Object>}
   */
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
    this.emit('status', '✅ 计划已批准，正在执行...');
    await this.updatePlanInFile('\n\n## ✅ 计划已批准，正在执行...\n');

    const result = await this._agentLoop(this._currentTask);
    return this._finishPlanResponse(result);
  }

  /**
   * 处理计划拒绝 — 用户拒绝 → 重新规划
   * @param {string} [feedback] - 拒绝时可附带反馈
   * @returns {Promise<Object>}
   */
  async rejectPlan(feedback) {
    if (!this._awaitingPlanApproval) {return { error: '当前没有待批准的 plan' };}
    this._awaitingPlanApproval = false;
    this._pendingPlan = null;
    this._suppressUI = false;

    const msg = feedback
      ? `计划被拒绝。用户反馈：${feedback}。请根据反馈提供修改后的计划。`
      : '计划被拒绝，请提供替代方案。';
    this.messages.push({ role: 'user', content: msg });
    this.emit('status', '🔁 计划被拒绝，正在重新规划...');
    await this.updatePlanInFile(`\n\n## ❌ 计划被拒绝\n\n**反馈**: ${feedback || '无'}\n\n正在重新规划...\n`);

    const result = await this._agentLoop(this._currentTask);
    return this._finishPlanResponse(result);
  }

  /**
   * 处理计划编辑反馈 — 用户给了修改意见
   * @param {string} feedback
   * @returns {Promise<Object>}
   */
  async editPlan(feedback) {
    if (!this._awaitingPlanApproval) {return { error: '当前没有待批准的 plan' };}
    this._awaitingPlanApproval = false;
    this._pendingPlan = null;
    this._suppressUI = false;

    this.messages.push({ role: 'user', content: `对计划的修改建议：${feedback}` });
    this.emit('status', '📝 收到计划反馈，正在调整...');
    await this.updatePlanInFile(`\n\n## 💬 用户反馈\n\n${feedback}\n\n**正在调整计划...**\n`);

    const result = await this._agentLoop(this._currentTask);
    return this._finishPlanResponse(result);
  }

  /**
   * 收尾 Plan → _agentLoop 结果（同 processInput 收尾逻辑）
   */
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

  /**
   * 获取对话历史
   * @returns {Array}
   */
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

  /**
   * 清空对话历史（保留 System Prompt）
   */
  clearHistory() {
    const systemMsgs = this.messages.filter((m) => m.role === 'system');
    this.messages = systemMsgs;
    this.cache.clear();
  }

  /**
   * 获取当前状态（包含上下文信息）
   * @returns {Object}
   */
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
}

module.exports = ChatEngine;

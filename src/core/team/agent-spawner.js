// 子 Agent 生成与执行器,复刻主 Agent 循环结构,独立 messages 不污染主 Agent

const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const AnvilAIClient = require('../../ai/client');
const DynamicPromptGenerator = require('./prompt-templates');
const { AgentRoles, MessageTypes } = require('./constants');
const {
  getAgentCheckPrompt,
  getAgentContinuePrompt,
} = require('../../ai/prompts');

// 工具执行超时：与主 Agent（chat.js:719）保持一致
const TOOL_TIMEOUT = 120 * 1000;

// 工具结果最大长度：与主 Agent（chat.js:770）保持一致
const MAX_RESULT_LEN = 4000;

// 单次 sendAndProcess 内的最大 tool-call 循环次数：与主 Agent 一致
const MAX_LOOPS_PER_TURN = 10;

// 单次 sendAndProcess 内的最大"继续"次数（防 finishReason=length 死循环）
const MAX_CONTINUES_PER_TURN = 5;

class AgentSpawner extends EventEmitter {
  constructor(options = {}) {
    super();

    this.config = options.config || {};
    this.logger = options.logger;
    this.parentEventBus = options.parentEventBus;  // 主 EventBus，用于事件转发
    this.communication = options.communication;  // TeamCommunication 引用，用于发送心跳

    // Agent 实例管理
    this.activeAgents = new Map();  // agentId -> AgentInstance

    // 读 config.model,兜底 deepseek-chat(旧硬编码 v4-flash 不存在)
    this.defaultModel = options.config?.model
      || options.config?.defaultModel
      || 'deepseek-chat';
    this.defaultTimeout = options.defaultTimeout || 30 * 60 * 1000;

    // 心跳发送间隔：子 Agent 在 _agentLoop 中按此间隔向 communication 上报心跳
    this.heartbeatInterval = options.heartbeatInterval || 30 * 1000;

    // 置 _aborted 让 while 快速退出,旧代码从未初始化此字段
    this._aborted = false;

    // 提示词生成器
    this.promptGenerator = new DynamicPromptGenerator({ config: options.config, logger: options.logger });
  }

  async spawn(options) {
    const {
      role,
      teamId,
      parentAgent,
      model,
    } = options;

    const roleConfig = AgentRoles[role.toUpperCase()] || AgentRoles.EXECUTOR;

    const agentId = uuidv4();
    const aiClient = new AnvilAIClient({
      ...this.config,
      defaultModel: model || this.defaultModel,
    });

    const resolvedModel = model || this.defaultModel;

    const agent = {
      agentId,
      teamId,
      role,
      roleName: roleConfig.name,
      description: roleConfig.description,
      createdAt: new Date().toISOString(),
      status: 'created',
      aiClient,
      model: resolvedModel,
      messages: [],          // 独立 messages 上下文（关键：与主 Agent 隔离）
      toolResults: [],
      parentAgent,           // 持有主 Agent 引用，用于工具执行代理
      _suppressEvents: false, // check 阶段置 true，屏蔽 subagent_thinking/content
    };

    this.activeAgents.set(agentId, agent);

    // 发标准 thinking/content + _agentId 字段,废弃 subagent_* 专用事件名
    if (this.parentEventBus) {
      aiClient.on('thinking', (chunk) => {
        if (agent._suppressEvents) {return;}
        this.parentEventBus.emit('thinking', { chunk, agentId: agent.agentId, _subAgent: true });
      });
      aiClient.on('content', (chunk) => {
        if (agent._suppressEvents) {return;}
        this.parentEventBus.emit('content', { chunk, agentId: agent.agentId, _subAgent: true });
      });
      aiClient.on('usage', (usage) => {
        this.parentEventBus.emit('subagent_usage', { agentId, usage });
      });
    }

    return agent;
  }

  async run(agent, options) {
    const {
      systemPrompt,
      tasks,
      timeout = this.defaultTimeout,
      priority,
    } = options;

    const startTime = Date.now();
    agent.status = 'running';
    agent._priority = priority;
    agent.originalTask = this._buildTaskPrompt(tasks, priority); // 供 check prompt 复用

    try {
      // 初始化独立 messages 上下文
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: agent.originalTask },
      ];
      agent.messages = messages;

      // 获取工具列表（从 parentAgent 的 toolRegistry）
      const tools = agent.parentAgent?.toolRegistry?.getOpenAITools() || [];

      // 执行主循环（持续驱动）
      const result = await this._agentLoop(agent, messages, tools, timeout);

      agent.status = 'completed';

      return {
        success: true,
        content: result.content,
        thinking: result.thinking,
        toolCalls: result.toolCalls,
        executionTime: Date.now() - startTime,
      };
    } catch (error) {
      agent.status = agent.status === 'terminated' ? 'terminated' : 'failed';
      return {
        success: false,
        error: error.message,
        executionTime: Date.now() - startTime,
      };
    }
  }

  /**
   * Agent 自主执行循环（持续驱动版）
   * 复刻主 Agent chat.js:323-579 的 _agentLoop 结构：
   *   1. 先跑一轮 _sendAndProcess
   *   2. task_complete → 结束
   *   3. 注入 check prompt（问"做完了吗"）→ 跑 check
   *   4. task_complete → 结束
   *   5. 注入 continue prompt（推"接着干"）→ 跑下一轮
   *   6. 回到 3，直到达到 maxIterations 或终止
   */
  async _agentLoop(agent, messages, tools, timeout) {
    const maxIterations = 50;
    const timeoutMs = timeout;
    const startTime = Date.now();
    let fullContent = '';
    let fullThinking = '';
    let lastToolCalls = null;
    let iterationCount = 0;
    let result;

    // 同步 messages 引用到 agent 实例(让 agent 状态可观察、可调试)
    // run() 路径已挂,直接 _agentLoop 路径(测试用)需要兜底
    agent.messages = messages;

    // 启动心跳发送定时器
    const heartbeatTimer = this.communication
      ? setInterval(() => {
          this._sendHeartbeat(agent);
        }, this.heartbeatInterval)
      : null;

    try {
      // 第一次执行：让 AI 看到任务后开始干活
      result = await this._sendAndProcess(agent, messages, tools);
      fullContent += result.content || '';
      fullThinking += result.thinking || '';
      lastToolCalls = result.toolCalls;

      // 第一次就 task_complete（简单任务一上来就结束）
      if (this._isTaskComplete(result, messages)) {
        return {
          content: fullContent,
          thinking: fullThinking,
          toolCalls: lastToolCalls,
        };
      }

      // 持续驱动循环：check → continue
      while (iterationCount < maxIterations && !this._aborted) {
        // 全局超时
        if (Date.now() - startTime > timeoutMs) {
          this.logger?.warn(`Agent ${agent.agentId} 达到 ${timeoutMs / 1000}s 超时`);
          break;
        }

        // terminate 信号
        if (agent.status === 'terminated') {
          break;
        }

        iterationCount++;

        // Step 1: 注入 check prompt，问 AI "做完了吗"
        messages.push({
          role: 'user',
          content: getAgentCheckPrompt(agent.originalTask),
        });

        // check 阶段抑制事件转发（避免"任务完成了吗？""是"这种内部对话上 TUI）
        agent._suppressEvents = true;
        const checkResult = await this._sendAndProcess(agent, messages, tools);
        agent._suppressEvents = false;

        fullContent += checkResult.content || '';
        fullThinking += checkResult.thinking || '';
        lastToolCalls = checkResult.toolCalls;

        // check 阶段 task_complete → 真正结束
        if (this._isTaskComplete(checkResult, messages)) {
          return {
            content: fullContent,
            thinking: fullThinking,
            toolCalls: lastToolCalls,
          };
        }

        // 全局超时 / terminate 检查
        if (Date.now() - startTime > timeoutMs) {break;}
        if (agent.status === 'terminated') {break;}

        // Step 2: 注入 continue prompt，推 AI "接着干"
        messages.push({
          role: 'user',
          content: getAgentContinuePrompt(),
        });

        // 继续干活
        result = await this._sendAndProcess(agent, messages, tools);
        fullContent += result.content || '';
        fullThinking += result.thinking || '';
        lastToolCalls = result.toolCalls;

        // 立即 task_complete 也算结束
        if (this._isTaskComplete(result, messages)) {
          return {
            content: fullContent,
            thinking: fullThinking,
            toolCalls: lastToolCalls,
          };
        }
      }
    } finally {
      // 清理心跳定时器
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      // 防御性重置：避免残留
      agent._suppressEvents = false;
    }

    return {
      content: fullContent,
      thinking: fullThinking,
      toolCalls: lastToolCalls,
    };
  }

  /**
   * 单次 API 调用 + 工具执行循环（内层）
   * 复刻主 Agent chat.js:582-852 的 _sendAndProcess：
   *   - 调 aiClient.chat 一次
   *   - 如果有 toolCalls → 逐个执行（带 120s 超时 + 4KB 截断）→ push 到 messages → 继续循环
   *   - 如果 finishReason=length → 注入"继续" → 继续循环
   *   - 都没了 → 返回累积结果
   */
  async _sendAndProcess(agent, messages, tools) {
    const maxLoops = MAX_LOOPS_PER_TURN;
    const maxContinues = MAX_CONTINUES_PER_TURN;
    let loopCount = 0;
    let continueCount = 0;
    let fullContent = '';
    let fullThinking = '';
    let lastToolCalls = null;
    let lastUsage = null;

    while (loopCount < maxLoops) {
      loopCount++;

      // 终止检查
      if (agent.status === 'terminated') {
        throw new Error('Agent 已被终止');
      }

      // 调 AI
      const response = await agent.aiClient.chat(messages, {
        model: agent.model || this.defaultModel,
        thinkingMode: this.config.thinkingMode !== false,  // 跟随 config，与主 Agent 一致
        tools,
        priority: agent._priority,
      });

      fullContent += response.content || '';
      fullThinking += response.thinking || '';
      lastUsage = response.usage;

      // 处理工具调用
      if (response.toolCalls && response.toolCalls.length > 0) {
        lastToolCalls = response.toolCalls;

        // assistant 消息（含 tool_calls + reasoning_content）入栈
        messages.push({
          role: 'assistant',
          content: response.content || null,
          reasoning_content: response.thinking || '',
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
        });

        // 逐个执行工具（发射事件让 TUI 能看到工具调用过程）
        let taskCompleteCalled = false;
        for (const toolCall of response.toolCalls) {
          const toolName = toolCall.function?.name || '';
          let args = {};
          try {
            args = typeof toolCall.function?.arguments === 'string'
              ? JSON.parse(toolCall.function.arguments)
              : (toolCall.function?.arguments || {});
          } catch {
            args = {};
          }

          // 发射 tool_calls 事件（与主 Agent chat.js:707 一致）
          this.parentEventBus?.emit('tool_calls', {
            toolCall,
            agentId: agent.agentId,
            _subAgent: true,
          });

          const toolResult = await this._executeTool(agent, toolName, args);
          const resultStr = this._truncateToolResult(toolResult);

          // 发射 tool_result 事件（与主 Agent chat.js:751 一致）
          this.parentEventBus?.emit('tool_result', {
            name: toolName,
            args,
            result: toolResult,
            toolCall,
            agentId: agent.agentId,
            _subAgent: true,
          });

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: resultStr,
          });

          if (this.logger) {
            this.logger.info(`子 Agent 工具调用: ${toolName}`, { args, result: toolResult });
          }

          // task_complete 工具调用后立即停止本轮
          // 原因:task_complete 语义就是"我完成了",AI 调了它就不该再被追问
          // 否则会陷入 _sendAndProcess 反复调 chat → chat 反复返回 task_complete 的死循环
          if (toolName === 'task_complete') {
            taskCompleteCalled = true;
            break;
          }
        }

        // task_complete 已调用 → 本轮结束,让 _agentLoop 走 _isTaskComplete 路径
        if (taskCompleteCalled) {
          break;
        }

        // 继续循环让 AI 看工具结果
        continue;
      }

      // 截断检测：自动"继续"
      if (response.finishReason === 'length' && continueCount < maxContinues) {
        continueCount++;

        messages.push({
          role: 'assistant',
          content: response.content || '',
          reasoning_content: response.thinking || '',
        });
        messages.push({
          role: 'user',
          content: '继续',
        });
        continue;
      }

      // 无 tool call 且未截断 → 本轮结束
      break;
    }

    return {
      thinking: fullThinking,
      content: fullContent,
      toolCalls: lastToolCalls,
      usage: lastUsage,
    };
  }

  /**
   * 工具结果截断：与主 Agent（chat.js:770-788）保持一致
   * 防止 read_file / execute_command 等返回大结果把 messages 撑爆
   */
  _truncateToolResult(result) {
    if (result && typeof result === 'object') {
      const truncFields = ['content', 'output', 'diff'];
      const truncated = { ...result };
      for (const field of truncFields) {
        if (typeof truncated[field] === 'string' && truncated[field].length > MAX_RESULT_LEN) {
          truncated[field] = truncated[field].slice(0, MAX_RESULT_LEN) + '... (结果过长已截断)';
        }
      }
      let resultStr = JSON.stringify(truncated);
      if (resultStr.length > MAX_RESULT_LEN) {
        resultStr = resultStr.slice(0, MAX_RESULT_LEN) + '... (结果过长已截断)';
      }
      return resultStr;
    }
    let resultStr = JSON.stringify(result);
    if (resultStr.length > MAX_RESULT_LEN) {
      resultStr = resultStr.slice(0, MAX_RESULT_LEN) + '... (结果过长已截断)';
    }
    return resultStr;
  }

  /**
   * 检测 AI 是否调用了 task_complete 且声明完成
   * 复刻主 Agent（chat.js:500-507）的检测方式：看 tool name + 解析 result.content
   */
  _isTaskComplete(result, messages) {
    const toolCalls = result?.toolCalls;
    if (!toolCalls || toolCalls.length === 0) {return false;}

    const calledTaskComplete = toolCalls.some(
      (tc) => tc.function?.name === 'task_complete',
    );
    if (!calledTaskComplete) {return false;}

    // 找到 task_complete 工具的 result content
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'tool' && m.tool_call_id) {
        try {
          const parsed = JSON.parse(m.content);
          if (parsed && parsed.complete === true) {return true;}
          if (parsed && parsed.error) {return false;}
        } catch {
          if (/完成|已完成|completed/i.test(m.content || '')) {return true;}
        }
        return false;
      }
    }
    return false;
  }

  /**
   * 子 Agent 主动发送心跳：写入 communication 通道 + emit subagent_heartbeat 事件
   */
  _sendHeartbeat(agent) {
    if (!agent) {return;}

    const payload = {
      agentId: agent.agentId,
      timestamp: Date.now(),
    };

    if (this.communication) {
      this.communication.receiveFromAgent(agent.agentId, {
        type: MessageTypes.HEARTBEAT,
        payload,
      }).catch((err) => {
        this.logger?.debug(`心跳发送失败: ${err.message}`);
      });
    }

    if (this.parentEventBus) {
      this.parentEventBus.emit('subagent_heartbeat', payload);
    }
  }

  /**
   * 执行工具（代理到主 Agent 的 toolRegistry）
   * 关键修复：透传完整 context（chatEngine / onOutput / todoManager / onQuestion / fileTimestamps）
   * + 120s 超时（与主 Agent chat.js:718-749 一致）
   */
  async _executeTool(agent, toolName, args) {
    const parent = agent.parentAgent;
    if (!parent?.toolRegistry) {
      return { error: '工具注册表不可用' };
    }

    let result;
    let timer;
    try {
      result = await Promise.race([
        parent.toolRegistry.execute(toolName, args, {
          projectDir: parent.config?.projectDir,
          logger: this.logger,
          fileTimestamps: parent.fileTimestamps,
          maxOutputLines: parent.config?.maxOutputLines || 50,
          planModeRestricted: false,  // 子 Agent 永远不在 plan mode
          chatEngine: parent,         // 关键：enter_plan_mode / memory_append 等工具依赖
          onOutput: (data, isError) => {
            this.parentEventBus?.emit('subagent_output', { agentId: agent.agentId, data, isError });
          },
          todoManager: parent.todoManager,
          onTodoChange: (todos) => {
            this.parentEventBus?.emit('subagent_todo_change', { agentId: agent.agentId, todos });
          },
          onQuestion: (params) => {
            // 子 Agent 收到 question 时转给主 Agent 决策
            if (parent._suppressUI) {return { answers: [] };}
            return new Promise((resolve) => {
              parent._pendingQuestionResolve = resolve;
              this.parentEventBus?.emit('subagent_question', { agentId: agent.agentId, params });
            });
          },
        }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`工具执行超时(${TOOL_TIMEOUT / 1000}s)`)),
            TOOL_TIMEOUT,
          );
        }),
      ]);
      return result;
    } catch (error) {
      return { error: `工具执行失败: ${error.message}` };
    } finally {
      if (timer) {clearTimeout(timer);}
    }
  }

  /**
   * 生成角色特定的提示词
   */
  generatePromptForRole(role, tasks, projectContext, sharedContext = null) {
    const taskDescription = this._buildTaskPrompt(tasks);

    return this.promptGenerator.generateSubAgentPrompt({
      role,
      taskDescription,
      projectContext,
      teamSharedContext: sharedContext,
    });
  }

  /**
   * 构建任务提示词
   */
  _buildTaskPrompt(tasks, overallPriority) {
    if (!tasks || tasks.length === 0) {
      return '请执行分配给你的任务。完成后调用 task_complete 工具声明完成，一句话说明即可。';
    }

    let prompt = '## 任务列表\n\n';
    if (overallPriority !== undefined) {
      prompt += `整体优先级: ${overallPriority}\n\n`;
    }
    prompt += '请按以下任务列表顺序执行：\n\n';

    for (const task of tasks) {
      const taskId = task.id || task.title || 'unknown';
      const description = task.description || task.text || String(task);
      // 内层变量改名 taskPriority，避免和外层形参 priority 重名
      const taskPriority = task.priority !== undefined ? ` [优先级: ${task.priority}]` : '';

      prompt += `- **${taskId}**${taskPriority}: ${description}\n`;
    }

    prompt += '\n关键进展时简要汇报。所有任务完成后调用 task_complete，一句话说明即可，不要重复总结。';

    return prompt;
  }

  /**
   * 终止 Agent
   */
  async terminate(agentId) {
    const agent = this.activeAgents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} 不存在`);
    }

    // 中断 AI 客户端
    agent.aiClient?.abort?.();

    // 旧 terminate 没设 _aborted,外层 loop 还在转
    this._aborted = true;

    // 更新状态
    agent.status = 'terminated';

    // 从活跃列表移除
    this.activeAgents.delete(agentId);

    // emit 到 parentEventBus(manager),由 chatEngine 转发到 cli 监听
    // 修复:之前 this.emit('agent_terminated') 是 emit 到 spawner 自己,没人订阅
    if (this.parentEventBus) {
      this.parentEventBus.emit('agent_terminated', { agentId });
    }

    return true;
  }

  /**
   * 获取 Agent 状态
   */
  getAgentStatus(agentId) {
    const agent = this.activeAgents.get(agentId);
    if (!agent) {return null;}

    return {
      agentId: agent.agentId,
      role: agent.role,
      status: agent.status,
      createdAt: agent.createdAt,
    };
  }

  /**
   * 获取所有活跃 Agent
   */
  getActiveAgents() {
    return [...this.activeAgents.values()].map((agent) => ({
      agentId: agent.agentId,
      role: agent.role,
      status: agent.status,
      teamId: agent.teamId,
    }));
  }
}

module.exports = AgentSpawner;
module.exports.AgentRoles = AgentRoles;

/**
 * 子Agent生成与执行器
 * 负责生成子Agent实例、分配角色、管理执行循环
 * @file agent-spawner.js
 */

const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const AnvilAIClient = require('../../ai/client');
const DynamicPromptGenerator = require('./prompt-templates');
const { AgentRoles } = require('./constants');

class AgentSpawner extends EventEmitter {
  constructor(options = {}) {
    super();

    this.config = options.config || {};
    this.logger = options.logger;
    this.parentEventBus = options.parentEventBus;  // 主EventBus，用于事件转发

    // Agent实例管理
    this.activeAgents = new Map();  // agentId -> AgentInstance

    // Agent配置
    this.defaultModel = options.config?.defaultModel || 'deepseek-v4-flash';
    this.defaultTimeout = options.defaultTimeout || 30 * 60 * 1000;

    // 提示词生成器
    this.promptGenerator = new DynamicPromptGenerator({ config: options.config, logger: options.logger });
  }

  /**
   * 生成Agent实例
   * @param {Object} options
   * @returns {Promise<Object>} Agent实例信息
   */
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

    const agent = {
      agentId,
      teamId,
      role,
      roleName: roleConfig.name,
      description: roleConfig.description,
      createdAt: new Date().toISOString(),
      status: 'created',
      aiClient,
      messageThread: [],
      toolResults: [],
      parentAgent,  // 持有主Agent引用，用于工具执行代理
    };

    this.activeAgents.set(agentId, agent);

    // 转发AI客户端事件到主EventBus
    if (this.parentEventBus) {
      aiClient.on('thinking', (chunk) => {
        this.parentEventBus.emit('subagent_thinking', { agentId, chunk });
      });
      aiClient.on('content', (chunk) => {
        this.parentEventBus.emit('subagent_content', { agentId, chunk });
      });
      aiClient.on('usage', (usage) => {
        this.parentEventBus.emit('subagent_usage', { agentId, usage });
      });
    }

    return agent;
  }

  /**
   * 运行Agent执行任务
   * @param {Object} agent - Agent实例
   * @param {Object} options
   * @returns {Promise<Object>}
   */
  async run(agent, options) {
    const {
      systemPrompt,
      tasks,
      timeout = this.defaultTimeout,
    } = options;

    const startTime = Date.now();
    agent.status = 'running';

    try {
      // 构建消息
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: this._buildTaskPrompt(tasks) },
      ];

      // 获取工具列表（从parentAgent的toolRegistry）
      const tools = agent.parentAgent?.toolRegistry?.getOpenAITools() || [];

      // 执行主循环
      const result = await this._agentLoop(agent, messages, tools, timeout);

      return {
        success: true,
        content: result.content,
        thinking: result.thinking,
        toolCalls: result.toolCalls,
        executionTime: Date.now() - startTime,
      };
    } catch (error) {
      agent.status = 'failed';
      return {
        success: false,
        error: error.message,
        executionTime: Date.now() - startTime,
      };
    }
  }

  /**
   * Agent自主执行循环
   */
  async _agentLoop(agent, messages, tools, timeout) {
    const maxIterations = 50;
    const timeoutMs = timeout;
    const startTime = Date.now();
    let fullContent = '';
    let fullThinking = '';
    let lastToolCalls = null;
    let iterationCount = 0;

    while (iterationCount < maxIterations) {
      // 超时检查
      if (Date.now() - startTime > timeoutMs) {
        throw new Error(`Agent执行超时 (${timeoutMs / 1000}s)`);
      }

      iterationCount++;

      // 发送请求
      const response = await agent.aiClient.chat(messages, {
        model: this.defaultModel,
        thinkingMode: true,
        tools,
      });

      fullContent += response.content || '';
      fullThinking += response.thinking || '';

      // 处理工具调用
      if (response.toolCalls && response.toolCalls.length > 0) {
        lastToolCalls = response.toolCalls;

        // 添加助手消息
        messages.push({
          role: 'assistant',
          content: response.content,
          reasoning_content: response.thinking,
          tool_calls: response.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.function.name,
              arguments: typeof tc.function.arguments === 'string'
                ? tc.function.arguments
                : JSON.stringify(tc.function.arguments),
            },
          })),
        });

        // 执行工具调用
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

          // 从parentAgent的工具注册表执行
          const toolResult = await this._executeTool(agent, toolName, args);

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolResult),
          });
        }

        // 检查是否完成
        if (response.toolCalls.some(tc => tc.function?.name === 'task_complete')) {
          break;
        }

        // 非 task_complete 工具：继续循环等待 AI 处理结果
        continue;
      }

      // 无工具调用，检查截断
      if (response.finishReason === 'length') {
        messages.push({
          role: 'assistant',
          content: response.content,
          reasoning_content: response.thinking,
        });
        messages.push({ role: 'user', content: '继续' });
        continue;
      }

      // 正常结束
      break;
    }

    return {
      content: fullContent,
      thinking: fullThinking,
      toolCalls: lastToolCalls,
    };
  }

  /**
   * 执行工具（代理到主Agent）
   */
  async _executeTool(agent, toolName, args) {
    const parentAgent = agent.parentAgent;
    if (!parentAgent?.toolRegistry) {
      return { error: '工具注册表不可用' };
    }

    try {
      const result = await parentAgent.toolRegistry.execute(toolName, args, {
        projectDir: parentAgent.config?.projectDir,
        logger: this.logger,
      });
      return result;
    } catch (error) {
      return { error: error.message };
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
  _buildTaskPrompt(tasks) {
    if (!tasks || tasks.length === 0) {
      return '请执行分配给你的任务。完成后调用 task_complete 工具声明完成。';
    }

    let prompt = '## 任务列表\n\n';
    prompt += '请按以下任务列表顺序执行：\n\n';

    for (const task of tasks) {
      const taskId = task.id || task.title || 'unknown';
      const description = task.description || task.text || String(task);
      const priority = task.priority !== undefined ? ` [优先级: ${task.priority}]` : '';

      prompt += `- **${taskId}**${priority}: ${description}\n`;
    }

    prompt += '\n每完成一个任务，标注进度。如果所有任务都完成，调用 task_complete 工具声明完成。';

    return prompt;
  }

  /**
   * 终止Agent
   */
  async terminate(agentId) {
    const agent = this.activeAgents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} 不存在`);
    }

    // 中断AI客户端
    agent.aiClient?.abort?.();

    // 更新状态
    agent.status = 'terminated';

    // 从活跃列表移除
    this.activeAgents.delete(agentId);

    this.emit('agent_terminated', { agentId });

    return true;
  }

  /**
   * 获取Agent状态
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
   * 获取所有活跃Agent
   */
  getActiveAgents() {
    return [...this.activeAgents.values()].map(agent => ({
      agentId: agent.agentId,
      role: agent.role,
      status: agent.status,
      teamId: agent.teamId,
    }));
  }
}

module.exports = AgentSpawner;
module.exports.AgentRoles = AgentRoles;

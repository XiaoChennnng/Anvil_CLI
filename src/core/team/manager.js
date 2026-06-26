/**
 * 团队管理器
 * 负责团队生命周期管理，整合所有团队组件
 * @file manager.js
 */

const { EventEmitter } = require('events');
const AgentSpawner = require('./agent-spawner');
const TaskDistributor = require('./task-distributor');
const ResultAggregator = require('./result-aggregator');
const TeamCommunication = require('./team-communication');
const TaskStateManager = require('./task-state');
const TeamErrorHandler = require('./error-handler');
const { ResearchContext } = require('../research-context');
const { L0_CORE_IDENTITY } = require('../../ai/prompts');
const {
  TeamState,
  TaskPriority,
} = require('./constants');

// 工具函数
function generateTeamId() {
  return `team_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateTaskFingerprint(task) {
  if (!task) {return { keyWords: [], full: '' };}
  const words = task.split(/[\s,.，、。]+/).filter(w => w.length > 1);
  const stopWords = new Set(['的', '了', '和', '与', '或', '一个', '一些', '相关', '以及']);
  const keyWords = words.filter(w => !stopWords.has(w) && w.length > 2);
  return { keyWords: keyWords.slice(0, 5), full: task.slice(0, 80), length: task.length };
}

/**
 * 团队管理器
 */
class TeamManager extends EventEmitter {
  constructor(options = {}) {
    super();

    this.config = options.config || {};
    this.logger = options.logger;

    // 团队元数据
    this.teamId = options.teamId || generateTeamId();
    this.createdAt = new Date().toISOString();
    this.parentAgent = options.parentAgent;

    // 团队状态
    this.state = TeamState.IDLE;

    // 子Agent管理
    this.agents = new Map();  // agentId -> AgentInfo

    // 通信通道（先于 AgentSpawner 创建,供 spawner 心跳使用）
    this.communication = new TeamCommunication({
      teamId: this.teamId,
      logger: options.logger,
    });

    this.agentSpawner = new AgentSpawner({
      config: options.config,
      logger: options.logger,
      parentEventBus: this,
      communication: this.communication,  // 注入 communication,使 _agentLoop 可发送心跳
    });

    // 任务管理
    this.taskDistributor = new TaskDistributor({
      logger: options.logger,
    });
    this.resultAggregator = new ResultAggregator({
      logger: options.logger,
    });
    this.taskStateManager = new TaskStateManager({
      logger: options.logger,
    });
    this.errorHandler = new TeamErrorHandler({
      logger: options.logger,
    });

    // 生命周期管理
    this._idleTimer = null;
    this._dissolveIdleTimeout = options.dissolveIdleTimeout || 5 * 60 * 1000;  // 5分钟空闲后解散

    // 任务指纹（用于去重检测）
    this._taskFingerprint = null;

    // 研究上下文隔离机制
    // 代码分析、架构研究等使用独立 context，不污染主 context
    this._researchContext = new ResearchContext({
      projectDir: options.projectDir || process.cwd(),
      logger: options.logger,
    });

    // 动态复杂度阈值（根据 context 使用情况调整）
    this._complexityThreshold = {
      low: 25,    // 无团队
      medium: 50, // 简单团队
      high: 75,   // 复杂团队
    };
  }

  static async create(options) {
    const team = new TeamManager(options);
    await team._initialize();
    return team;
  }

  /**
   * 初始化团队
   */
  async _initialize() {
    this.emit('team_created', {
      teamId: this.teamId,
      timestamp: this.createdAt,
    });

    // 启动空闲检测
    this._startIdleTimer();

    return this;
  }

  /**
   * 判断任务是否需要创建团队
   * @param {string} taskDescription - 任务描述
   * @param {Object} context - 上下文信息
   * @returns {Object} { needsTeam: boolean, reason: string, suggestedAgents: Array }
   */
  async evaluateTaskComplexity(taskDescription, context = {}) {
    // 复杂度评估维度
    const complexityFactors = {
      fileOperations: 0,
      domainCount: 0,
      independentTasks: 0,
      coordinationNeeds: 0,
      errorRecovery: false,
    };

    // 可独立执行的模式
    const parallelPatterns = [
      /同时.{0,10}(做|进行|实现|开发)/,
      /分别.{0,10}(做|进行|实现|开发)/,
      /并行/,
      /多个.{0,6}(模块|功能|组件|服务)/,
      /既.+又/,
      /这边.+那边/,
    ];

    // 多领域模式
    const multiDomainPatterns = [
      /前端.{0,10}(和|与|以及|.+)后端/,
      /后端.{0,10}(和|与|以及|.+)前端/,
      /数据库.{0,10}(和|与|以及|.+)服务/,
      /api.{0,10}(和|与|以及|.+)界面/,
    ];

    let complexityScore = 0;

    // 可并行执行的任务 (+20-40)
    if (parallelPatterns.some(p => p.test(taskDescription))) {
      complexityScore += 30;
      complexityFactors.independentTasks = 2;
    }

    // 多领域任务 (+25-35)
    if (multiDomainPatterns.some(p => p.test(taskDescription))) {
      complexityScore += 30;
      complexityFactors.domainCount = 2;
    }

    // 涉及文件操作 (+10-20 per operation)
    const fileOpMatches = taskDescription.match(/(?:修改|创建|删除|读写)/g);
    if (fileOpMatches) {
      complexityFactors.fileOperations = fileOpMatches.length;
      complexityScore += Math.min(fileOpMatches.length * 10, 30);
    }

    // 需要协调 (+10-20)
    if (/协调|同步|整合|合并/.test(taskDescription)) {
      complexityScore += 15;
      complexityFactors.coordinationNeeds = 1;
    }

    // 复杂错误恢复场景 (+15)
    if (/回滚|恢复|重试|容错/.test(taskDescription)) {
      complexityScore += 15;
      complexityFactors.errorRecovery = true;
    }

    // 基于上下文补充评估
    if (context.messageCount > 20) {complexityScore += 10;}
    if (context.toolCallCount > 10) {complexityScore += 10;}

    // 决策阈值（使用动态阈值，根据 context 使用情况调整）
    const THRESHOLD = {
      TEAM_NOT_NEEDED: this._complexityThreshold.low,
      SIMPLE_TEAM: this._complexityThreshold.medium,
      COMPLEX_TEAM: this._complexityThreshold.high,
    };

    let needsTeam = false;
    let reason = '';
    let suggestedAgents = [];

    if (complexityScore < THRESHOLD.TEAM_NOT_NEEDED) {
      needsTeam = false;
      reason = '任务足够简单，主Agent可直接完成';
    } else if (complexityScore < THRESHOLD.SIMPLE_TEAM) {
      needsTeam = true;
      reason = '任务有少量可独立执行的子任务';
      suggestedAgents = [
        { role: 'executor', count: 1, description: '执行者 - 负责具体实现' }
      ];
    } else if (complexityScore < THRESHOLD.COMPLEX_TEAM) {
      needsTeam = true;
      reason = '任务涉及多个可并行领域';
      suggestedAgents = [
        { role: 'architect', count: 1, description: '架构师 - 负责方案设计' },
        { role: 'executor', count: 2, description: '执行者 - 负责并行实现' },
      ];
    } else {
      needsTeam = true;
      reason = '任务高度复杂，需要多角色协调';
      suggestedAgents = [
        { role: 'architect', count: 1, description: '架构师 - 负责整体设计' },
        { role: 'executor', count: 2, description: '执行者 - 负责并行实现' },
        { role: 'reviewer', count: 1, description: '审查者 - 负责质量检查' },
        { role: 'coordinator', count: 1, description: '协调者 - 负责整合协调' },
      ];
    }

    return {
      complexityScore,
      needsTeam,
      reason,
      suggestedAgents,
      complexityFactors,
    };
  }

  async startTeamTask(task, context = {}, options = {}) {
    const force = options.force === true;

    // force=true 时强制解散旧团队再开新团,避免状态机死锁
    if (force && (this.state === TeamState.PLANNING
        || this.state === TeamState.EXECUTING
        || this.state === TeamState.AGGREGATING)) {
      this.logger?.warn(
        `force=true 但旧团队还在 ${this.state} 状态,强制解散后开新团`,
      );
      // dissolve({force:true}) 后 state=DISSOLVED,下面防御性重置回 IDLE
      await this.dissolve({ force: true });
    }

    if (this.state !== TeamState.IDLE && this.state !== TeamState.DISSOLVED) {
      throw new Error(`团队当前状态为 ${this.state}，无法启动新任务`);
    }

    // 残留 DISSOLVED 归位 IDLE,DISSOLVED→PLANNING 状态机不允许
    if (this.state === TeamState.DISSOLVED) {
      this.state = TeamState.IDLE;
    }

    // force=true:跳过复杂度评估直接启动,用于"用户明确开团但评估分低"场景
    let evaluation;
    if (force) {
      // 角色配置由 suggestedRoles(AI 给) 决定,兜底 1 executor
      const suggestedRoles = options.suggestedRoles;

      if (Array.isArray(suggestedRoles) && suggestedRoles.length > 0) {
        // AI 给的角色配置:直接采用
        evaluation = {
          complexityScore: 100,
          needsTeam: true,
          reason: '用户明确要求启动团队(force=true),AI 指定角色配置',
          suggestedAgents: suggestedRoles.map(r => ({
            role: r.role,
            count: Math.max(1, r.count || 1),
            description: `${r.role} - AI 指定的角色配置`,
          })),
          complexityFactors: { forceStart: true, aiSuggested: true },
        };
      } else {
        // 兜底:1 executor(无法识别或 AI 未给 suggestedRoles 时)
        // 这是"用户说开团 + AI 没说怎么开"的最小安全配置
        evaluation = {
          complexityScore: 100,
          needsTeam: true,
          reason: '用户明确要求启动团队(force=true),使用默认 1 executor 配置(建议 AI 调用时传 suggestedRoles 显式指定角色)',
          suggestedAgents: [
            { role: 'executor', count: 1, description: '执行者 - 默认配置' },
          ],
          complexityFactors: { forceStart: true, defaultConfig: true },
        };
      }
    } else {
      // 评估是否需要团队
      evaluation = await this.evaluateTaskComplexity(task, context);

      if (!evaluation.needsTeam) {
        return { needsTeam: false, reason: evaluation.reason };
      }
    }

    // 生成任务指纹
    this._taskFingerprint = generateTaskFingerprint(task);

    // 状态转换
    this._transitionTo(TeamState.PLANNING);

    const createdAgents = await this._createTeamAgents(evaluation.suggestedAgents);

    // 分配初始任务
    const taskPlan = await this.taskDistributor.createTaskPlan({
      task,
      agents: createdAgents,
      context,
    });

    // 分发任务
    this._transitionTo(TeamState.EXECUTING);
    const taskAssignments = this._distributeTasks(taskPlan);

    // 并行/串行执行
    const executionResults = await this._executeAllAgents(taskAssignments);

    // agentsSummary 列出每 agent 明细,让主 Agent 知道团队是否真干活
    // executionResults 兼容 Map / 数组(mock) / 普通对象
    const agentsSummary = [];
    const _entries = executionResults instanceof Map
      ? Array.from(executionResults.entries())
      : Array.isArray(executionResults)
        ? executionResults.map(item => [item.agentId || item.id, item])
        : Object.entries(executionResults || {});
    for (const [agentId, result] of _entries) {
      const agentInfo = this.agents.get(agentId);
      const content = result.content || '';
      const toolCalls = result.toolCalls || [];
      agentsSummary.push({
        agentId,
        role: agentInfo?.role || result.role || 'unknown',
        status: result.success ? 'completed' : 'failed',
        success: result.success !== false,
        executionTime: result.executionTime || 0,
        contentLength: content.length,
        toolCallCount: toolCalls.length,
        thinkingLength: (result.thinking || '').length,
        error: result.error || null,
        fallback: !!result.fallback,
      });
    }

    // 聚合结果
    this._transitionTo(TeamState.AGGREGATING);
    const aggregatedResult = await this.resultAggregator.aggregate({
      task,
      results: executionResults,
      fingerprint: this._taskFingerprint,
    });
    // 把 agentsSummary 附加到 aggregatedResult 上,让 chatEngine / AI 看到每个 agent 的明细
    aggregatedResult.agentsSummary = agentsSummary;

    // keyWords 命中率 < 60% 视为空跑,避免 AI 看到 completed 就以为研究完成
    if (aggregatedResult.completionStatus && !aggregatedResult.completionStatus.taskComplete) {
      this.logger?.warn('团队任务完成度不足(可能子 agent 全失败或没产出)', {
        retentionRate: aggregatedResult.completionStatus.retentionRate,
        keyWordsFound: aggregatedResult.completionStatus.keyWordsFound,
        keyWordsTotal: aggregatedResult.completionStatus.keyWordsTotal,
        contentLength: aggregatedResult.content?.length || 0,
      });
      this.emit('team_degraded', {
        teamId: this.teamId,
        completionStatus: aggregatedResult.completionStatus,
        agentCount: createdAgents.length,
        agentsSummary,
      });
      aggregatedResult.degraded = true;
      aggregatedResult.degradedReason =
        `任务完成度仅 ${(aggregatedResult.completionStatus.retentionRate * 100).toFixed(1)}% ` +
        `(${aggregatedResult.completionStatus.keyWordsFound}/${aggregatedResult.completionStatus.keyWordsTotal} 关键内容),` +
        `子 Agent 可能全部失败或没产出。`;
    } else {
      // 即便 keyWords 命中率高,也要检查是否所有 agent 都失败或产出为空
      const successCount = agentsSummary.filter(a => a.success && !a.fallback).length;
      const failedCount = agentsSummary.filter(a => !a.success).length;
      const emptyCount = agentsSummary.filter(a => a.success && a.contentLength === 0).length;
      const totalChars = agentsSummary.reduce((s, a) => s + a.contentLength, 0);

      if (successCount === 0 || (successCount > 0 && emptyCount === successCount && totalChars < 200)) {
        // 所有 agent 都失败 OR 全部成功但内容都为空(空跑)
        aggregatedResult.degraded = true;
        aggregatedResult.degradedReason = `所有 ${agentsSummary.length} 个 agent 全部失败或产出为空(${successCount} 成功,${failedCount} 失败,${emptyCount} 空内容,共 ${totalChars} 字符),团队实际未工作。`;
        this.emit('team_degraded', {
          teamId: this.teamId,
          reason: 'all_failed_or_empty',
          successCount,
          failedCount,
          emptyCount,
          totalChars,
          agentsSummary,
        });
      }
    }

    // 走到 COMPLETE 状态机节点（修复原流程跳过 COMPLETE 的 bug）
    this._transitionTo(TeamState.COMPLETE);

    // 清理团队
    await this.dissolve();

    return {
      needsTeam: true,
      teamId: this.teamId,
      result: aggregatedResult,
      stats: {
        agentCount: createdAgents.length,
        executionTime: aggregatedResult.executionTime,
        complexityScore: evaluation.complexityScore,
      },
    };
  }

  /**
   * 创建团队Agent
   */
  async _createTeamAgents(suggestedAgents) {
    const createdAgents = [];

    for (const suggestion of suggestedAgents) {
      for (let i = 0; i < suggestion.count; i++) {
        const agent = await this.agentSpawner.spawn({
          role: suggestion.role,
          teamId: this.teamId,
          parentAgent: this.parentAgent,
        });

        this.agents.set(agent.agentId, {
          ...agent,
          role: suggestion.role,
          createdAt: new Date().toISOString(),
          status: 'initialized',
        });

        createdAgents.push(agent);

        this.emit('agent_created', {
          teamId: this.teamId,
          agentId: agent.agentId,
          role: suggestion.role,
        });
      }
    }

    return createdAgents;
  }

  /**
   * 分发任务到各Agent
   */
  _distributeTasks(taskPlan) {
    const assignments = new Map();

    for (const [agentId, tasks] of Object.entries(taskPlan.assignments)) {
      const agentInfo = this.agents.get(agentId);
      if (!agentInfo) {continue;}

      assignments.set(agentId, {
        agent: agentInfo,
        tasks,
        priority: taskPlan.priorities[agentId] || TaskPriority.NORMAL,
      });
    }

    return assignments;
  }

  /**
   * 执行所有Agent任务(仅串行)
   * parallel 模式已移除——多个 agent 同时读写同一批文件会冲突,
   * 串行按 role 顺序逐个执行,前一个 agent 的结果可通过 result-aggregator 传给下一个。
   * @param {Map} assignments - agentId -> assignment
   */
  async _executeAllAgents(assignments) {
    const results = new Map();

    this.logger?.info(`串行执行 ${assignments.size} 个 Agent`);
    for (const [agentId, assignment] of assignments) {
      let agentResult;
      try {
        agentResult = await this._executeAgent(agentId, assignment);
      } catch (error) {
        agentResult = { success: false, error: error.message };
      }
      results.set(agentId, agentResult);
    }

    return results;
  }

  /**
   * 执行单个Agent任务
   */
  async _executeAgent(agentId, assignment) {
    const { agent, tasks, priority } = assignment;
    const agentInfo = this.agents.get(agentId);

    if (!agentInfo) {
      throw new Error(`Agent ${agentId} 不存在`);
    }

    // 接入 taskStateManager:追踪任务生命周期
    try {
      this.taskStateManager.createTask({
        id: agentId,
        description: `Agent ${agentId} (${agent.role}) 执行 ${tasks.length} 个子任务`,
        priority,
      });
      this.taskStateManager.startTask(agentId);
    } catch (err) {
      this.logger?.debug('taskStateManager 追踪失败', err.message);
    }

    // 更新状态
    agentInfo.status = 'executing';
    this.agents.set(agentId, agentInfo);

    this.emit('agent_started', {
      teamId: this.teamId,
      agentId,
      role: agent.role,
      taskCount: tasks.length,
    });

    // 前缀 L0 硬性规则,改 L0 子 Agent 自动同步
    const rolePrompt = this.agentSpawner.generatePromptForRole(
      agent.role,
      tasks,
      this.parentAgent?.contextManager?.getProjectOverviewText?.() || ''
    );
    const systemPrompt = `${L0_CORE_IDENTITY}\n\n---\n\n## 你的子 Agent 角色\n\n${rolePrompt}`;

    let result;
    try {
      // 启动Agent执行
      result = await this.agentSpawner.run(agent, {
        systemPrompt,
        tasks,
        timeout: 30 * 60 * 1000,  // 30分钟
        priority,
      });

      // result 失败与 run throw 统一走 errorHandler 路径
      if (!result.success) {
        throw new Error(result.error || 'Agent 执行失败 (无错误详情)');
      }
    } catch (error) {
      // 接入 errorHandler:决策错误回退策略
      const errorDecision = this.errorHandler.handleError(error, {
        taskId: agentId,
        type: 'agent_crash',
        role: agent.role,
        teamManager: this,
        originalTask: tasks,
      });
      this.logger?.error(`Agent ${agentId} 执行失败`, {
        error: error.message,
        strategy: errorDecision?.strategy,
      });

      // 真正执行 errorDecision.action,旧代码只 log 不执行
      let actionResult = null;
      if (typeof errorDecision?.action === 'function') {
        try {
          actionResult = await errorDecision.action();
        } catch (actionErr) {
          this.logger?.warn(`errorHandler action 执行失败: ${actionErr.message}`);
        }
      }

      // RETRY + respawn 成功:用新 agent 重试一次
      // agent_respawned 事件统一由 respawnAgent() 内部 emit,这里不重复发,否则 sidebar 计数 +2
      if (actionResult?.newAgent) {
        const newAgent = actionResult.newAgent;
        // 替换 agents Map 引用(respawnAgent 内部已 delete+set,这里再覆盖 status 为 executing)
        this.agents.set(newAgent.agentId, {
          ...newAgent,
          role: newAgent.role,
          createdAt: new Date().toISOString(),
          status: 'executing',
          respawnedFrom: agentId,
        });

        try {
          const retrySystemPrompt = this.agentSpawner.generatePromptForRole(
            newAgent.role,
            tasks,
            this.parentAgent?.contextManager?.getProjectOverviewText?.() || ''
          );
          this.logger?.info(`Agent 重试 (${agentId} → ${newAgent.agentId})`);

          const retryResult = await this.agentSpawner.run(newAgent, {
            systemPrompt: retrySystemPrompt,
            tasks,
            timeout: 30 * 60 * 1000,
            priority,
          });

          if (retryResult.success) {
            // 重试成功,走正常完成路径
            return this._markAgentCompleted(newAgent.agentId, retryResult, true);
          }
          // 重试也失败,记录后继续走失败清理
          this.logger?.warn(`Agent ${newAgent.agentId} 重试仍失败: ${retryResult.error}`);
        } catch (retryErr) {
          this.logger?.warn(`Agent 重试抛错: ${retryErr.message}`);
        }
      } else if (actionResult?.shouldFallback) {
        // FALLBACK_TO_MAIN:把任务交回主 agent 处理
        this.logger?.warn(`Agent ${agentId} fallback 到主 Agent`);
        this._markAgentCompleted(agentId, { success: false, error: 'fallback to main' }, false);
        return { success: false, error: 'fallback to main', fallback: true };
      }

      // 最终失败清理
      this._markAgentCompleted(agentId, {
        success: false,
        error: error.message,
        strategy: errorDecision?.strategy,
        executionTime: Date.now() - (agentInfo.createdAt ? new Date(agentInfo.createdAt).getTime() : Date.now()),
      }, false);
      return { success: false, error: error.message, strategy: errorDecision?.strategy };
    }

    // 成功路径
    return this._markAgentCompleted(agentId, result, true);
  }

  /**
   * 标记 Agent 完成（成功 / 失败通用）
   * 集中处理 taskStateManager / status / emit,避免成功失败路径重复代码
   */
  _markAgentCompleted(agentId, result, success) {
    const agentInfo = this.agents.get(agentId);
    if (agentInfo) {
      agentInfo.status = success ? 'completed' : 'failed';
      agentInfo.lastResult = result;
      this.agents.set(agentId, agentInfo);
    }

    // 通知 taskStateManager
    try {
      if (success) {
        this.taskStateManager.completeTask(agentId, { success: true });
      } else {
        this.taskStateManager.failTask(agentId, result.error);
      }
    } catch (err) {
      this.logger?.debug('taskStateManager 通知失败', err.message);
    }

    this.emit('agent_completed', {
      teamId: this.teamId,
      agentId,
      success,
      error: result.error,
      executionTime: result.executionTime,
    });

    return result;
  }

  /**
   * 终止团队
   * @param {Object} options
   * @param {boolean} options.force - 强制解散（跳过状态机校验，用于 interrupt/异常路径）
   */
  async dissolve(options = {}) {
    const { force = false } = options;

    if (force) {
      // 强制解散：直接置状态为 DISSOLVED，跳过状态机校验
      const oldState = this.state;
      this.state = TeamState.DISSOLVED;
      this.logger?.warn(`强制解散团队 (${oldState} -> DISSOLVED)`);
      this.emit('state_changed', {
        teamId: this.teamId,
        from: oldState,
        to: TeamState.DISSOLVED,
        forced: true,
      });
    } else {
      this._transitionTo(TeamState.DISSOLVED);
    }

    // 终止所有Agent
    for (const [agentId] of this.agents) {
      try {
        await this.agentSpawner.terminate(agentId);
      } catch (err) {
        this.logger?.warn(`终止Agent ${agentId} 失败`, err.message);
      }
    }

    // 清理通信通道
    this.communication.dispose();

    // 清理定时器
    this._stopIdleTimer();

    // 非 force 路径 cleanup 后归位 IDLE,避免 DISSOLVED→PLANNING 状态机死锁
    // force 路径保留 DISSOLVED,chat.js 会重建 manager 实例
    if (!force) {
      this.state = TeamState.IDLE;
    }

    this.emit('team_dissolved', {
      teamId: this.teamId,
      finalState: this.state,
      forced: force,
    });
  }

  /**
   * 终止单个Agent
   */
  async terminateAgent(agentId) {
    const agentInfo = this.agents.get(agentId);
    if (!agentInfo) {
      throw new Error(`Agent ${agentId} 不存在`);
    }

    await this.agentSpawner.terminate(agentId);

    agentInfo.status = 'terminated';
    this.agents.set(agentId, agentInfo);

    this.emit('agent_terminated', {
      teamId: this.teamId,
      agentId,
    });

    // 检查是否所有Agent都已终止
    const allTerminated = [...this.agents.values()].every(
      a => a.status === 'terminated' || a.status === 'completed' || a.status === 'failed'
    );

    if (allTerminated) {
      await this.dissolve();
    }
  }

  /**
   * 重新生成Agent（用于错误恢复）
   */
  async respawnAgent(agentId, options = {}) {
    // 先终止旧的Agent（如果存在）
    try {
      await this.agentSpawner.terminate(agentId);
    } catch {
      // 忽略终止失败（可能已不存在）
    }

    // 从agents Map中移除
    this.agents.delete(agentId);

    // 创建新Agent
    const newAgent = await this.agentSpawner.spawn({
      role: options.role || 'executor',
      teamId: this.teamId,
      parentAgent: this.parentAgent,
      model: options.model,
    });

    this.agents.set(newAgent.agentId, {
      ...newAgent,
      role: options.role || 'executor',
      createdAt: new Date().toISOString(),
      status: 'initialized',
      respawnedFrom: agentId, // 标记是从哪个Agent重新生成的
    });

    this.emit('agent_respawned', {
      teamId: this.teamId,
      oldAgentId: agentId,
      newAgentId: newAgent.agentId,
      role: options.role,
    });

    return newAgent;
  }

  /**
   * 获取团队状态
   */
  getStatus() {
    return {
      teamId: this.teamId,
      state: this.state,
      createdAt: this.createdAt,
      agentCount: this.agents.size,
      agents: [...this.agents.entries()].map(([id, info]) => ({
        agentId: id,
        role: info.role,
        status: info.status,
        createdAt: info.createdAt,
      })),
    };
  }

  // 状态机管理

  _createStateMachine() {
    const transitions = {
      // DISSOLVED 允许从任何状态强制转入(用于 interrupt/异常路径)
      [TeamState.IDLE]: [TeamState.PLANNING, TeamState.DISSOLVED],
      [TeamState.PLANNING]: [TeamState.EXECUTING, TeamState.FAILED, TeamState.IDLE, TeamState.DISSOLVED],
      [TeamState.EXECUTING]: [TeamState.AGGREGATING, TeamState.FAILED, TeamState.DISSOLVED],
      [TeamState.AGGREGATING]: [TeamState.COMPLETE, TeamState.FAILED, TeamState.DISSOLVED],
      [TeamState.COMPLETE]: [TeamState.DISSOLVED],
      [TeamState.FAILED]: [TeamState.DISSOLVED],
      [TeamState.DISSOLVED]: [],
    };

    return {
      canTransition: (from, to) => {
        const allowed = transitions[from] || [];
        return allowed.includes(to);
      },

      getValidTransitions: (from) => {
        return transitions[from] || [];
      },
    };
  }

  _transitionTo(newState) {
    const stateMachine = this._createStateMachine();
    if (!stateMachine.canTransition(this.state, newState)) {
      throw new Error(`无效的状态转换: ${this.state} -> ${newState}`);
    }

    const oldState = this.state;
    this.state = newState;

    this.emit('state_changed', {
      teamId: this.teamId,
      from: oldState,
      to: newState,
    });

    this.logger?.info(`团队状态转换: ${oldState} -> ${newState}`);
  }

  // 空闲管理

  _startIdleTimer() {
    this._idleTimer = setTimeout(() => {
      if (this.state === TeamState.IDLE) {
        this.dissolve();
      }
    }, this._dissolveIdleTimeout);
  }

  _stopIdleTimer() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

}

module.exports = TeamManager;
module.exports.TeamState = TeamState;
module.exports.TaskPriority = TaskPriority;

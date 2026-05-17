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
const {
  TeamState,
  TaskPriority,
  TeamErrorType,
} = require('./constants');

// 工具函数
function generateTeamId() {
  return `team_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateTaskFingerprint(task) {
  if (!task) return { keyWords: [], full: '' };
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
    this.agentSpawner = new AgentSpawner({
      config: options.config,
      logger: options.logger,
      parentEventBus: this,
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

    // 通信通道
    this.communication = new TeamCommunication({
      teamId: this.teamId,
      logger: options.logger,
    });

    // 生命周期管理
    this._idleTimer = null;
    this._dissolveIdleTimeout = options.dissolveIdleTimeout || 5 * 60 * 1000;  // 5分钟空闲后解散

    // 任务指纹（用于去重检测）
    this._taskFingerprint = null;
  }

  // ================================================================
  // 团队生命周期管理
  // ================================================================

  /**
   * 创建团队（静态工厂方法）
   * @param {Object} options
   * @returns {Promise<TeamManager>}
   */
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

    // 计算复杂度评分 (0-100)
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
    if (context.messageCount > 20) complexityScore += 10;
    if (context.toolCallCount > 10) complexityScore += 10;

    // 决策阈值
    const THRESHOLD = {
      TEAM_NOT_NEEDED: 25,
      SIMPLE_TEAM: 50,
      COMPLEX_TEAM: 75,
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

  /**
   * 启动团队执行任务
   * @param {string} task - 任务描述
   * @param {Object} context - 上下文
   * @returns {Promise<Object>} 执行结果
   */
  async startTeamTask(task, context = {}) {
    if (this.state !== TeamState.IDLE && this.state !== TeamState.DISSOLVED) {
      throw new Error(`团队当前状态为 ${this.state}，无法启动新任务`);
    }

    // 评估是否需要团队
    const evaluation = await this.evaluateTaskComplexity(task, context);

    if (!evaluation.needsTeam) {
      return { needsTeam: false, reason: evaluation.reason };
    }

    // 生成任务指纹
    this._taskFingerprint = generateTaskFingerprint(task);

    // 状态转换
    this._transitionTo(TeamState.PLANNING);

    // 创建子Agent
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

    // 并行执行
    const executionResults = await this._executeAllAgents(taskAssignments);

    // 聚合结果
    this._transitionTo(TeamState.AGGREGATING);
    const aggregatedResult = await this.resultAggregator.aggregate({
      task,
      results: executionResults,
      fingerprint: this._taskFingerprint,
    });

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
      if (!agentInfo) continue;

      assignments.set(agentId, {
        agent: agentInfo,
        tasks,
        priority: taskPlan.priorities[agentId] || TaskPriority.NORMAL,
      });
    }

    return assignments;
  }

  /**
   * 并行执行所有Agent任务
   */
  async _executeAllAgents(assignments) {
    const results = new Map();
    const executionPromises = [];

    for (const [agentId, assignment] of assignments) {
      const promise = this._executeAgent(agentId, assignment)
        .then(result => ({ agentId, result }))
        .catch(error => ({ agentId, error: error.message }));

      executionPromises.push(promise);
    }

    // 并行等待所有Agent完成
    const settled = await Promise.allSettled(executionPromises);

    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        results.set(outcome.value.agentId, outcome.value.result);
      } else {
        this.logger?.error('Agent执行异常', outcome.reason);
      }
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

    // 更新状态
    agentInfo.status = 'executing';
    this.agents.set(agentId, agentInfo);

    this.emit('agent_started', {
      teamId: this.teamId,
      agentId,
      taskCount: tasks.length,
    });

    // 生成Agent特定的提示词
    const systemPrompt = this.agentSpawner.generatePromptForRole(
      agent.role,
      tasks,
      this.parentAgent?.contextManager?.getProjectOverviewText?.() || ''
    );

    // 启动Agent执行
    const result = await this.agentSpawner.run(agent, {
      systemPrompt,
      tasks,
      timeout: 30 * 60 * 1000,  // 30分钟
      priority,
    });

    // 更新状态
    agentInfo.status = result.error ? 'failed' : 'completed';
    agentInfo.lastResult = result;
    this.agents.set(agentId, agentInfo);

    this.emit('agent_completed', {
      teamId: this.teamId,
      agentId,
      success: !result.error,
      executionTime: result.executionTime,
    });

    return result;
  }

  /**
   * 终止团队
   */
  async dissolve() {
    this._transitionTo(TeamState.DISSOLVED);

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

    this.emit('team_dissolved', {
      teamId: this.teamId,
      finalState: this.state,
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

  // ================================================================
  // 状态机管理
  // ================================================================

  _createStateMachine() {
    const transitions = {
      [TeamState.IDLE]: [TeamState.PLANNING],
      [TeamState.PLANNING]: [TeamState.EXECUTING, TeamState.FAILED, TeamState.IDLE],
      [TeamState.EXECUTING]: [TeamState.AGGREGATING, TeamState.FAILED],
      [TeamState.AGGREGATING]: [TeamState.COMPLETE, TeamState.FAILED],
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

  // ================================================================
  // 空闲管理
  // ================================================================

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

  _resetIdleTimer() {
    this._stopIdleTimer();
    this._startIdleTimer();
  }
}

module.exports = TeamManager;
module.exports.TeamState = TeamState;
module.exports.TaskPriority = TaskPriority;

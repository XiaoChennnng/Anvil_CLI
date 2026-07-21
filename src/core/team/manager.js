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

    // 用户约束(从 options.disabledTools 传入由 startTeamTask 注入)
    this._constraints = [];

    // 当前执行链路与结果(p2 修复:sharedContext 共享用)
    this._currentExecutionChain = [];
    this._currentResults = new Map();

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

    // P1 修复:监听 communication 的 agent_unresponsive,自动走 errorHandler
    // 真正打通"30s 无心跳 → 降级 → respawnAgent"的链路
    if (this.communication?.on) {
      this.communication.on('agent_unresponsive', (data) => {
        this.logger?.warn(`Agent ${data.agentId} 心跳超时 (${data.elapsed}ms),走降级`);
        this._handleUnresponsiveAgent(data.agentId, data).catch((err) => {
          this.logger?.error(`处理 unresponsive agent 失败: ${err.message}`);
        });
      });
    }

    return this;
  }

  /**
   * P1 修复:处理 unresponsive agent — 走 errorHandler.communication_failed 分支
   * 复用 _handleAgentCrash 同样的 RETRY → FALLBACK_TO_MAIN 兜底逻辑
   */
  async _handleUnresponsiveAgent(agentId, data) {
    const agentInfo = this.agents.get(agentId);
    if (!agentInfo || agentInfo.status === 'terminated' || agentInfo.status === 'failed') {
      return;
    }

    const error = new Error(`心跳超时 ${data.elapsed}ms`);
    const errorDecision = this.errorHandler.handleError(error, {
      agentId,
      type: 'communication_failed',
      role: agentInfo.role,
      teamManager: this,
      originalTask: null,
    });

    if (typeof errorDecision?.action === 'function') {
      try {
        const actionResult = await errorDecision.action();
        if (actionResult?.newAgent) {
          // respawn 成功,通知 TUI
          this.logger?.info(`Agent ${agentId} 已 respawn → ${actionResult.newAgent.agentId}`);
        } else if (actionResult?.shouldFallback) {
          this.logger?.warn(`Agent ${agentId} 心跳多次超时,标记 fallback`);
        }
      } catch (actionErr) {
        this.logger?.warn(`heartbeat 降级 action 失败: ${actionErr.message}`);
      }
    }
  }

  /**
   * 判断任务是否需要创建团队
   * @param {string} taskDescription - 任务描述
   * @param {Object} context - 上下文信息
   * @returns {Object} { needsTeam: boolean, reason: string, suggestedAgents: Array }
   */
  async evaluateTaskComplexity(taskDescription, context = {}) {
    // P0 修复:executionMode 控制规模上限
    // 'simple' 拉高阈值,只允许 ≤1 Agent / 'balanced' 默认 / 'thorough' 阈值×0.6 更激进
    const executionMode = context.executionMode
      || this.config.team?.executionMode
      || 'simple';
    const modeFactor = executionMode === 'thorough' ? 0.6
      : executionMode === 'balanced' ? 1.0
        : 1.0;  // simple 与 balanced 走相同阈值,但 suggestedAgents 选择不同
    const THRESHOLD = {
      TEAM_NOT_NEEDED: Math.round(this._complexityThreshold.low * modeFactor),
      SIMPLE_TEAM: Math.round(this._complexityThreshold.medium * modeFactor),
      COMPLEX_TEAM: Math.round(this._complexityThreshold.high * modeFactor),
    };

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

    let needsTeam = false;
    let reason = '';
    let suggestedAgents = [];

    if (complexityScore < THRESHOLD.TEAM_NOT_NEEDED) {
      needsTeam = false;
      reason = '任务足够简单，主Agent可直接完成';
    } else if (executionMode === 'simple') {
      // P0 修复:'simple' 模式下即使分数高也只起 1 executor
      // 防止用户未主动配置时跳到 3-5 Agent
      needsTeam = true;
      reason = `executionMode=simple:即使分数高(${complexityScore})也只起 1 executor,避免幽灵 Agent`;
      suggestedAgents = [
        { role: 'executor', count: 1, description: '执行者 - simple 模式兜底' }
      ];
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

    // P0 修复:executionMode 透传到 context 给 evaluateTaskComplexity
    // 优先级:options.executionMode > context.executionMode > config 默认 > 'simple'
    if (options.executionMode) {
      context = { ...context, executionMode: options.executionMode };
    }

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
    // 修复 P0:force=true 必须传 suggestedRoles,缺则拒绝(防止 AI 静默起 1 executor 让用户体感"幽灵 Agent")
    let evaluation;
    if (force) {
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
        // P0 修复:不再静默兜底 1 executor,直接抛错让 chat.js 把错误转给 AI 重新调
        // AI 看到错误后会用更明确的 suggestedRoles 重新发起
        throw new Error(
          '[start_team_task] force=true 必须显式传 suggestedRoles,'
          + '不允许静默兜底。'
          + '请重新调用时传入形如 '
          + 'suggestedRoles=[{role:"executor",count:1}] 的角色配置。',
        );
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

    // P1/P2 修复:把 disabledTools + constraints 注入到 agentSpawner
    // 角色白名单由 agentSpawner 内部 _filterToolsForAgent 生效
    if (Array.isArray(options.disabledTools)) {
      this.agentSpawner.setDisabledTools(options.disabledTools);
    }
    if (Array.isArray(options.constraints)) {
      this.agentSpawner.setConstraints(options.constraints);
      this._constraints = options.constraints;
    }

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

        // P1 修复:心跳真调度,communication 启动 _checkHeartbeat 定时器
        // 30s 检测一次,90s 无心跳 emit 'agent_unresponsive'
        if (this.communication?.startHeartbeat) {
          this.communication.startHeartbeat(agent.agentId);
        }

        // P2 修复:同步 agent 角色到 communication._roleMap,
        // _validateAgentCommunication 用此校验 agent 间通信权限
        if (this.communication?.setAgentRole) {
          this.communication.setAgentRole(agent.agentId, suggestion.role);
        }

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
   * P3 修复:Role 内并行(半并行)
   * 串行模式已升级为"按 role 分组,role 内并行"
   * - 不同 role 之间串行(architect → executor → reviewer → coordinator)
   *   理由:下游 role 依赖上游产出(架构师定方案,执行者去实现)
   * - 同一 role 内的多个 Agent 并行(Promise.all)
   *   理由:同 role 通常处理不同子模块,不冲突
   * - 文件软锁留给 P3 完整版,本次只做 role-group 并行(架构粒度已安全)
   * @param {Map} assignments - agentId -> assignment
   */
  async _executeAllAgents(assignments) {
    const ROLE_ORDER = ['architect', 'executor', 'reviewer', 'coordinator'];

    // 按 role 分组
    const roleGroups = new Map();
    for (const [agentId, assignment] of assignments) {
      const role = assignment.agent.role || 'executor';
      if (!roleGroups.has(role)) {roleGroups.set(role, []);}
      roleGroups.get(role).push([agentId, assignment]);
    }

    // 按 ROLE_ORDER 排序(其他 role 追加在末尾)
    const orderedGroups = [];
    for (const role of ROLE_ORDER) {
      if (roleGroups.has(role)) {
        orderedGroups.push([role, roleGroups.get(role)]);
        roleGroups.delete(role);
      }
    }
    for (const [role, group] of roleGroups) {
      orderedGroups.push([role, group]);
    }

    // role 间串行,role 内并行
    const results = new Map();
    for (const [role, group] of orderedGroups) {
      this.logger?.info(`[Role: ${role}] 并行执行 ${group.length} 个 Agent`);
      const groupResults = await Promise.all(
        group.map(async ([agentId, assignment]) => {
          try {
            return [agentId, await this._executeAgent(agentId, assignment)];
          } catch (error) {
            return [agentId, { success: false, error: error.message }];
          }
        })
      );
      for (const [agentId, result] of groupResults) {
        results.set(agentId, result);
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
    // P2 修复:constraints 透传到 generatePromptForRole,注入子 Agent system prompt 的 ## 约束条件 块
    // 新签名:(role, projectContext, sharedContext, constraints) — 第 2 位是 projectContext 不是 tasks
    const projectContext = this.parentAgent?.contextManager?.getProjectOverviewText?.() || '';
    const constraints = this.agentSpawner.constraints || [];
    // P2 修复(用户决策):sharedContext 内累计超阈值时由 AI 总结(不机械截断)
    const aiClient = this.parentAgent?.aiClient || null;
    const previousResultsMap = this._currentResults instanceof Map
      ? this._currentResults
      : new Map();
    const sharedContext = await this._buildSharedContext(agentId, previousResultsMap, aiClient);
    const rolePrompt = this.agentSpawner.generatePromptForRole(
      agent.role,
      projectContext,
      sharedContext,
      constraints
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

    // P1 修复:成功路径上重置 errorStats,避免同一 taskId 多次失败累积导致 respawn 死循环
    if (success && this.errorHandler?.resetErrorCount) {
      this.errorHandler.resetErrorCount(agentId);
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

  // ==================== sharedContext(团队上下文)====================
  // 团队共享上下文是 Phase A 协作机制的核心:让上游 Agent 的产出被下游 Agent 看到,
  // 而不是各自闭门造车后被 result-aggregator 拼凑。
  //
  // 修复(用户决策):窗口耗尽时不要机械截断,应调 AI 总结压缩上下文,
  // 让 AI 决定保留什么、舍什么。机械截断会把技术决策的关键段落切掉,
  // AI 总结至少能保留语义级的关键点。

  /**
   * 构建团队结构总览
   * @param {string} agentId - 当前 Agent 的 id
   * @returns {{totalAgents, myPosition:{idx,total}, prevRole, nextRole, executionOrder, roles, finalDeliverable}}
   */
  _buildTeamOverview(agentId) {
    const chain = this._currentExecutionChain || [];
    const idx = chain.indexOf(agentId);
    const total = chain.length;

    const rolesChain = chain.map((aid) => this.agents.get(aid)?.role).filter(Boolean);
    const prevRole = idx > 0 ? rolesChain[idx - 1] : null;
    const nextRole = idx >= 0 && idx < total - 1 ? rolesChain[idx + 1] : null;

    // roles 按 group by role count 聚合
    const roleCounts = new Map();
    for (const role of rolesChain) {
      roleCounts.set(role, (roleCounts.get(role) || 0) + 1);
    }
    const roles = [...roleCounts.entries()].map(([role, count]) => ({ role, count }));

    return {
      totalAgents: total,
      myPosition: { idx: idx >= 0 ? idx + 1 : 0, total },
      prevRole,
      nextRole,
      executionOrder: 'serial',
      roles,
      finalDeliverable: this._originalTaskDescription || '按团队目标产出最终交付',
    };
  }

  /**
   * AI 总结长内容(替代机械截断)
   * @param {string} text - 长原文
   * @param {Object} aiClient - 主 Agent 的 aiClient(可注入 mock)
   * @param {number} targetLen - 目标压缩后长度(字符)
   * @returns {Promise<string>} 总结文本
   */
  async _aiSummarizeLongContent(text, aiClient, targetLen = 1500) {
    if (!text || text.length <= targetLen) {return text || '';}

    if (!aiClient || typeof aiClient.chat !== 'function') {
      // 无 aiClient 时兜底:保留头 + 关键中段 + 尾,不做 AI 总结
      const headLen = Math.floor(targetLen * 0.5);
      const tailLen = Math.floor(targetLen * 0.3);
      return `${text.slice(0, headLen)}\n\n...（中段省略 ${text.length - headLen - tailLen} 字,请留意这是兜底截断,非 AI 总结）...\n\n${text.slice(-tailLen)}`;
    }

    try {
      const prompt = `请将以下内容压缩总结为不超过 ${targetLen} 字,保留关键决策、技术方案、产出物、共识点。删掉细节、过程、重复描述:

"""
${text}
"""

只返回压缩后的内容,不要加任何前言。`;
      const response = await aiClient.chat(
        [{ role: 'user', content: prompt }],
        { thinkingMode: false },
      );
      const summarized = response?.content || response?.text || '';
      if (!summarized) {
        this.logger?.warn('AI 总结返回空,降级到头尾截断');
        return text.slice(0, targetLen * 0.8);
      }
      return summarized;
    } catch (err) {
      this.logger?.warn(`AI 总结失败,降级到头尾截断: ${err.message}`);
      const headLen = Math.floor(targetLen * 0.5);
      const tailLen = Math.floor(targetLen * 0.3);
      return `${text.slice(0, headLen)}\n\n...（中段省略 ${text.length - headLen - tailLen} 字,请留意这是兜底截断）...\n\n${text.slice(-tailLen)}`;
    }
  }

  /**
   * 收集当前 Agent 的所有前序 Agent 产出
   * 用户决策:窗口耗尽时由 AI 总结压缩(不机械截断)
   * 简化设计:先估算总长,若超预算则一次性 AI 总结全部前序产出 → 单条 summary
   * 否则按原样展开所有项
   * @param {string} agentId - 当前 Agent id
   * @param {Map} results - agentId -> {success, content, error, ...}
   * @param {Object} aiClient - 可选 aiClient,用于调 AI 总结
   * @returns {Promise<Array<{role, content, label, summarizedFrom?}>>}
   */
  async _collectPreviousResults(agentId, results = new Map(), aiClient = null) {
    const chain = this._currentExecutionChain || [];
    const idx = chain.indexOf(agentId);
    if (idx <= 0) {return [];}

    const previousAgents = chain.slice(0, idx);
    const CONTENT_BUDGET_TOTAL = 8000;

    // 先把"成功"的前序产出收集成 rawItems(失败跳过)
    const rawItems = [];
    for (const aid of previousAgents) {
      const result = results.get(aid);
      if (!result || result.success === false) {continue;}

      const agentInfo = this.agents.get(aid);
      rawItems.push({
        aid,
        role: agentInfo?.role || 'agent',
        content: result.content || '',
      });
    }

    if (rawItems.length === 0) {return [];}

    // 单条前序产出自身已超 summary 目标长度 → 单独调 AI 总结这条
    const SUMMARY_TARGET = 1500;
    if (rawItems.length === 1 && rawItems[0].content.length > SUMMARY_TARGET) {
      const summarized = await this._aiSummarizeLongContent(rawItems[0].content, aiClient, SUMMARY_TARGET);
      return [{
        role: rawItems[0].role,
        content: summarized,
        label: `${rawItems[0].role} (#${rawItems[0].aid.slice(0, 4)}) — 已 AI 总结`,
        summarizedFrom: [rawItems[0].aid],
      }];
    }

    const totalLen = rawItems.reduce((s, x) => s + x.content.length, 0);

    // 没超预算 → 全展开
    if (totalLen <= CONTENT_BUDGET_TOTAL) {
      return rawItems.map((x) => ({
        role: x.role,
        content: x.content,
        label: `${x.role} (#${x.aid.slice(0, 4)})`,
      }));
    }

    // 超出预算 → 一次性 AI 总结全部前序产出
    const combined = rawItems.map((x) => `[${x.role}]\n${x.content}`).join('\n\n---\n\n');
    const summarized = await this._aiSummarizeLongContent(combined, aiClient, SUMMARY_TARGET);

    return [{
      role: 'summary',
      content: summarized,
      label: '前序产出 AI 总结',
      summarizedFrom: rawItems.map((x) => x.aid),
    }];
  }

  /**
   * 合并 teamOverview + previousResults 为子 Agent 注入的 sharedContext
   * @returns {Promise<{teamOverview, previousResults}>}
   */
  async _buildSharedContext(agentId, results = new Map(), aiClient = null) {
    return {
      teamOverview: this._buildTeamOverview(agentId),
      previousResults: await this._collectPreviousResults(agentId, results, aiClient),
    };
  }

}

module.exports = TeamManager;
module.exports.TeamState = TeamState;
module.exports.TaskPriority = TaskPriority;

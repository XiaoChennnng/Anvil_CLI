/**
 * 团队模块共享常量
 * @file constants.js
 */

/**
 * 团队状态枚举
 */
const TeamState = {
  IDLE: 'idle',           // 空闲，无任务
  PLANNING: 'planning',   // 规划中
  EXECUTING: 'executing', // 执行中
  AGGREGATING: 'aggregating', // 聚合结果中
  COMPLETE: 'complete',   // 完成
  FAILED: 'failed',       // 失败
  DISSOLVED: 'dissolved', // 已解散
};

/**
 * 任务优先级
 */
const TaskPriority = {
  CRITICAL: 0,  // 关键任务
  HIGH: 1,     // 高优先级
  NORMAL: 2,   // 普通
  LOW: 3,      // 低优先级
};

/**
 * 任务状态枚举
 */
const TaskState = {
  PENDING: 'pending',       // 等待执行
  RUNNING: 'running',       // 执行中
  WAITING_DEP: 'waiting_dep', // 等待依赖
  COMPLETED: 'completed',   // 已完成
  FAILED: 'failed',         // 失败
  CANCELLED: 'cancelled',   // 已取消
  TIMEOUT: 'timeout',       // 超时
};

/**
 * Agent角色定义
 */
const AgentRoles = {
  ARCHITECT: {
    name: 'architect',
    description: '架构师 - 负责方案设计和技术决策',
    defaultPrompt: `你是一位资深的系统架构师，擅长：
1. 分析需求并设计合理的系统架构
2. 将复杂任务拆解为可执行的子模块
3. 制定技术方案和实现优先级
4. 识别技术风险并准备应对方案

你的输出应该包含：
- 整体架构设计
- 模块划分及职责
- 数据流/接口设计
- 实现顺序建议
- 潜在风险点`,
    tools: ['read_file', 'search_in_files', 'list_directory', 'glob_files', 'analyze_dependencies'],
  },

  EXECUTOR: {
    name: 'executor',
    description: '执行者 - 负责具体代码实现',
    defaultPrompt: `你是一位高效的全栈开发者，擅长：
1. 根据既定方案快速实现功能
2. 编写清晰、健壮的代码
3. 进行基本的自测验证
4. 遵循项目代码规范

你的输出应该包含：
- 实现的代码
- 关键设计决策说明
- 自测验证结果`,
    tools: ['read_file', 'write_file', 'edit_file', 'execute_command', 'search_in_files'],
  },

  REVIEWER: {
    name: 'reviewer',
    description: '审查者 - 负责代码质量和安全审查',
    defaultPrompt: `你是一位严格的代码审查专家，擅长：
1. 发现潜在的bug和安全问题
2. 检查代码是否遵循规范
3. 提出改进建议
4. 验证功能的正确性

你的输出应该包含：
- 发现的问题列表
- 严重程度评估
- 修复建议`,
    tools: ['read_file', 'search_in_files', 'execute_command', 'analyze_dependencies'],
  },

  COORDINATOR: {
    name: 'coordinator',
    description: '协调者 - 负责多Agent协作和结果整合',
    defaultPrompt: `你是一位卓越的技术协调者，擅长：
1. 协调多个子任务的执行
2. 整合各方输出形成一致的整体
3. 识别和处理冲突
4. 确保整体进度和质量

你的输出应该包含：
- 整合后的完整方案
- 任务进度报告
- 冲突处理说明
- 后续建议`,
    tools: ['read_file', 'list_directory', 'glob_files'],
  },
};

/**
 * 任务类型枚举
 */
const TaskTypes = {
  DESIGN: 'design',         // 设计类任务
  IMPLEMENT: 'implement',    // 实现类任务
  REVIEW: 'review',          // 审查类任务
  COORDINATE: 'coordinate',  // 协调类任务
  EXPLORE: 'explore',        // 探索分析类任务
  TEST: 'test',             // 测试类任务
};

/**
 * 聚合策略类型
 */
const AggregationStrategy = {
  SEQUENTIAL: 'sequential',       // 顺序合并
  PARALLEL_OVERLAY: 'parallel_overlay',  // 并行覆盖
  HIERARCHICAL: 'hierarchical',   // 层级聚合
  CONSENSUS: 'consensus',          // 共识投票
};

/**
 * 冲突解决策略
 */
const ConflictResolution = {
  KEEP_ALL: 'keep_all',           // 保留所有冲突项
  LATEST_WINS: 'latest_wins',     // 最新结果优先
  QUALITY_WINS: 'quality_wins',    // 质量最优优先
  MAJORITY_WINS: 'majority_wins', // 多数投票
};

/**
 * 团队错误类型
 */
const TeamErrorType = {
  AGENT_CRASH: 'agent_crash',             // Agent崩溃
  TASK_TIMEOUT: 'task_timeout',          // 任务超时
  TOOL_EXECUTION_FAILED: 'tool_failed',   // 工具执行失败
  COMMUNICATION_FAILED: 'comm_failed',    // 通信失败
  DEADLOCK: 'deadlock',                  // 死锁
  VALIDATION_FAILED: 'validation_failed', // 验证失败
};

/**
 * 回退策略类型
 */
const FallbackStrategy = {
  RETRY: 'retry',                     // 重试
  SKIP: 'skip',                       // 跳过
  FALLBACK_TO_MAIN: 'fallback_main',  // 回退到主Agent
  PARTIAL_RESULT: 'partial_result',   // 使用部分结果
  CANCEL_REST: 'cancel_rest',         // 取消剩余任务
};

/**
 * 通信消息类型
 */
const MessageTypes = {
  TASK_ASSIGN: 'task_assign',         // 任务分配
  TASK_UPDATE: 'task_update',         // 任务进度更新
  RESULT_SUBMIT: 'result_submit',     // 结果提交
  STATUS_REPORT: 'status_report',    // 状态报告
  HEARTBEAT: 'heartbeat',             // 心跳
  INTERRUPT: 'interrupt',             // 中断指令
  RESUME: 'resume',                   // 恢复指令
  TERMINATE: 'terminate',             // 终止指令
};

module.exports = {
  TeamState,
  TaskPriority,
  TaskState,
  AgentRoles,
  TaskTypes,
  AggregationStrategy,
  ConflictResolution,
  TeamErrorType,
  FallbackStrategy,
  MessageTypes,
};

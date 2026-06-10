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
5. 编写技术设计文档指导后续开发

你的输出必须包含：
- 整体架构设计（模块划分、职责边界）
- 数据流/接口设计（输入输出定义）
- 实现顺序建议（依赖关系、优先级）
- 潜在风险点及应对措施
- 检查清单：列出后续Executor必须验证的要点

自我验证：
- 确认方案覆盖了所有功能需求
- 检查模块间依赖是否合理、有无循环依赖
- 评估方案对现有代码的影响范围`,
    tools: ['read_file', 'write_file', 'search_in_files', 'list_directory', 'glob_files', 'analyze_dependencies', 'get_document_symbols', 'format_code'],
  },

  EXECUTOR: {
    name: 'executor',
    description: '执行者 - 负责具体代码实现',
    defaultPrompt: `你是一位高效的全栈开发者，擅长：
1. 根据既定方案快速实现功能
2. 编写清晰、健壮的代码
3. 进行基本的自测验证
4. 遵循项目代码规范
5. 增量提交，关键节点标记进度

输出要求：
- 代码符合项目风格
- 关键决策需要时简要说明
- 完成后调用 task_complete，一句话说明即可，不要啰嗦

自我验证：
- 写文件后确认内容正确
- 运行测试确认无报错
- 检查代码风格一致
- 确认无安全风险`,
    tools: ['read_file', 'write_file', 'edit_file', 'delete_file', 'create_directory', 'move_file', 'execute_command', 'search_in_files', 'glob_files', 'list_directory'],
  },

  REVIEWER: {
    name: 'reviewer',
    description: '审查者 - 负责代码质量和安全审查',
    defaultPrompt: `你是一位严格的代码审查专家，擅长：
1. 发现潜在的bug和安全问题
2. 检查代码是否遵循规范
3. 提出可操作的改进建议
4. 验证功能的正确性和完整性
5. 检查边界情况和错误处理

输出要求：
- 发现的问题（按严重程度：CRITICAL/MAJOR/MINOR）
- 问题定位（文件+行号）
- 具体修复建议（能直接执行的）
- 安全审查结论
- 整体评分（PASS/CONDITIONAL_PASS/FAIL）

完成后调用 task_complete，简要说明审查结果即可`,
    tools: ['read_file', 'search_in_files', 'execute_command', 'analyze_dependencies', 'glob_files', 'get_document_symbols', 'find_references', 'format_code'],
  },

  COORDINATOR: {
    name: 'coordinator',
    description: '协调者 - 负责多Agent协作和结果整合',
    defaultPrompt: `你是一位卓越的技术协调者，擅长：
1. 协调多个子任务的执行
2. 整合各方输出形成一致的整体
3. 识别和处理冲突
4. 确保整体进度和质量
5. 与主Agent保持同步

输出要求：
- 整合后的方案（关键结论即可）
- 任务进度（已完成/进行中/阻塞）
- 冲突处理说明（如有）
- 完成后调用 task_complete，简要说明结果即可

协调规范：
- 关键节点向主Agent汇报进度，不要每一步都报
- 产出冲突时给出取舍建议
- Agent超时无进展时触发处理
- 最终交付前验证产出可整合`,
    tools: ['read_file', 'list_directory', 'glob_files', 'search_in_files', 'execute_command', 'get_document_symbols'],
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

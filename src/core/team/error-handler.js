/**
 * 团队错误处理策略管理器
 * 负责处理各种错误并决定回退策略
 * @file error-handler.js
 */

const {
  TeamErrorType,
  FallbackStrategy,
} = require('./constants');

class TeamErrorHandler {
  constructor(options = {}) {
    this.logger = options.logger;
    this.maxRetries = options.maxRetries || 3;
    this.retryDelays = options.retryDelays || [1000, 3000, 10000];  // 指数退避

    // 错误统计
    this.errorStats = new Map();  // taskId -> error count
  }

  /**
   * 处理错误并返回回退策略
   * @param {Object} error
   * @param {Object} context
   * @returns {Object}
   */
  handleError(error, context) {
    const { type, taskId, agentId, originalTask } = context;

    // 记录错误
    this._recordError(taskId);

    // 获取错误计数
    const errorCount = this.errorStats.get(taskId) || 0;

    // 根据错误类型决定策略
    switch (type) {
      case TeamErrorType.AGENT_CRASH:
        return this._handleAgentCrash(error, context, errorCount);

      case TeamErrorType.TASK_TIMEOUT:
        return this._handleTaskTimeout(error, context, errorCount);

      case TeamErrorType.TOOL_EXECUTION_FAILED:
        return this._handleToolFailure(error, context, errorCount);

      case TeamErrorType.COMMUNICATION_FAILED:
        return this._handleCommFailure(error, context, errorCount);

      case TeamErrorType.DEADLOCK:
        return this._handleDeadlock(error, context);

      default:
        return this._handleGenericError(error, context, errorCount);
    }
  }

  /**
   * Agent崩溃处理
   */
  _handleAgentCrash(error, context, errorCount) {
    const { teamManager, taskId, originalTask } = context;

    if (errorCount < this.maxRetries) {
      // 重试：创建新的Agent
      return {
        strategy: FallbackStrategy.RETRY,
        action: async () => {
          const newAgent = await teamManager.respawnAgent(context.agentId, {
            role: this._getAgentRole(context.agentId),
          });
          return { shouldRetry: true, newAgent };
        },
        delay: this._getRetryDelay(errorCount),
      };
    }

    // 终止回退：尝试使用主Agent完成
    return {
      strategy: FallbackStrategy.FALLBACK_TO_MAIN,
      action: async () => {
        this.logger?.warn(`Agent ${context.agentId} 崩溃次数过多，回退到主Agent`);
        return { shouldFallback: true, task: originalTask };
      },
    };
  }

  /**
   * 任务超时处理
   */
  _handleTaskTimeout(error, context, errorCount) {
    const { taskId, teamManager } = context;

    if (errorCount < this.maxRetries) {
      // 重试一次，给予更短的超时
      return {
        strategy: FallbackStrategy.RETRY,
        action: async () => {
          return {
            shouldRetry: true,
            newTimeout: Math.floor(context.taskTimeout * 0.5),
          };
        },
        delay: this._getRetryDelay(errorCount),
      };
    }

    // 跳过此任务，继续其他任务
    return {
      strategy: FallbackStrategy.SKIP,
      action: async () => {
        this.logger?.warn(`任务 ${taskId} 超时，跳过`);
        return { shouldSkip: true };
      },
    };
  }

  /**
   * 工具执行失败处理
   */
  _handleToolFailure(error, context, errorCount) {
    const { toolName, taskId } = context;

    // 区分可重试和不可重试的错误
    const nonRetryableErrors = [
      '文件不存在',
      '权限不足',
      '语法错误',
    ];

    const shouldRetry = !nonRetryableErrors.some(e =>
      error.message?.includes(e)
    );

    if (shouldRetry && errorCount < this.maxRetries) {
      return {
        strategy: FallbackStrategy.RETRY,
        action: async () => {
          this.logger?.info(`重试工具 ${toolName}`);
          return { shouldRetry: true };
        },
        delay: this._getRetryDelay(errorCount),
      };
    }

    // 不可重试的错误，使用部分结果或跳过
    return {
      strategy: FallbackStrategy.PARTIAL_RESULT,
      action: async () => {
        this.logger?.warn(`工具 ${toolName} 执行失败，使用部分结果`);
        return { partialResult: true, failedTool: toolName };
      },
    };
  }

  /**
   * 通信失败处理
   */
  _handleCommFailure(error, context, errorCount) {
    if (errorCount < this.maxRetries) {
      return {
        strategy: FallbackStrategy.RETRY,
        action: async () => {
          return { shouldRetry: true };
        },
        delay: this._getRetryDelay(errorCount),
      };
    }

    return {
      strategy: FallbackStrategy.FALLBACK_TO_MAIN,
      action: async () => {
        return { shouldFallback: true };
      },
    };
  }

  /**
   * 死锁处理
   */
  _handleDeadlock(error, context) {
    // 死锁时取消所有剩余任务，使用已有结果
    return {
      strategy: FallbackStrategy.CANCEL_REST,
      action: async () => {
        this.logger?.error('检测到任务死锁，取消剩余任务');
        return { cancelRemaining: true };
      },
    };
  }

  /**
   * 通用错误处理
   */
  _handleGenericError(error, context, errorCount) {
    if (errorCount < this.maxRetries) {
      return {
        strategy: FallbackStrategy.RETRY,
        action: async () => {
          return { shouldRetry: true };
        },
        delay: this._getRetryDelay(errorCount),
      };
    }

    return {
      strategy: FallbackStrategy.PARTIAL_RESULT,
      action: async () => {
        return { partialResult: true };
      },
    };
  }

  // ================================================================
  // 辅助方法
  // ================================================================

  _recordError(taskId) {
    const count = (this.errorStats.get(taskId) || 0) + 1;
    this.errorStats.set(taskId, count);
  }

  _getRetryDelay(attemptIndex) {
    return this.retryDelays[attemptIndex] || this.retryDelays[this.retryDelays.length - 1];
  }

  _getAgentRole(agentId) {
    // TODO: 从Agent元数据获取角色
    return 'executor';
  }

  /**
   * 重置错误统计
   */
  resetErrorCount(taskId) {
    this.errorStats.delete(taskId);
  }

  /**
   * 获取错误统计
   */
  getErrorStats() {
    return Object.fromEntries(this.errorStats);
  }
}

module.exports = TeamErrorHandler;
module.exports.TeamErrorType = TeamErrorType;
module.exports.FallbackStrategy = FallbackStrategy;

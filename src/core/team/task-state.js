/**
 * 任务状态管理器
 * 负责管理团队中每个任务的生命周期、超时监控和依赖管理
 * @file task-state.js
 */

const { TaskState: TASK_STATE, TaskPriority } = require('./constants');

/**
 * 任务状态管理器
 */
class TaskStateManager {
  constructor(options = {}) {
    this.logger = options.logger;

    // 任务状态存储
    this.tasks = new Map();  // taskId -> TaskState

    // 超时配置
    this.defaultTimeout = options.defaultTimeout || 30 * 60 * 1000;  // 30分钟
    this.warningThreshold = options.warningThreshold || 0.8;  // 80%时间时警告

    // 超时处理器
    this.timeoutHandlers = new Map();  // taskId -> { warning, timeout }
  }

  /**
   * 创建任务
   * @param {Object} taskInfo
   * @returns {Object} 创建的任务对象
   */
  createTask(taskInfo) {
    const task = {
      id: taskInfo.id || this._generateTaskId(),
      description: taskInfo.description,
      assignedAgent: taskInfo.assignedAgent,
      priority: taskInfo.priority || TaskPriority.NORMAL,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      state: TASK_STATE.PENDING,
      progress: 0,
      timeout: taskInfo.timeout || this.defaultTimeout,
      dependencies: taskInfo.dependencies || [],
      result: null,
      error: null,
    };

    this.tasks.set(task.id, task);

    // 设置超时监控
    this._startTimeoutMonitor(task.id);

    return task;
  }

  /**
   * 启动任务
   */
  startTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`任务 ${taskId} 不存在`);
    }

    if (task.state !== TASK_STATE.PENDING && task.state !== TASK_STATE.WAITING_DEP) {
      throw new Error(`任务 ${taskId} 当前状态为 ${task.state}，无法启动`);
    }

    task.state = TASK_STATE.RUNNING;
    task.startedAt = new Date().toISOString();

    this.tasks.set(taskId, task);

    return task;
  }

  /**
   * 更新任务进度
   */
  updateProgress(taskId, progress) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.progress = Math.min(Math.max(progress, 0), 100);
    this.tasks.set(taskId, task);
  }

  /**
   * 完成任务
   */
  completeTask(taskId, result) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.state = TASK_STATE.COMPLETED;
    task.completedAt = new Date().toISOString();
    task.progress = 100;
    task.result = result;

    this._clearTimeoutMonitor(taskId);
    this._notifyDependents(taskId);

    this.tasks.set(taskId, task);
  }

  /**
   * 标记任务失败
   */
  failTask(taskId, error) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.state = TASK_STATE.FAILED;
    task.completedAt = new Date().toISOString();
    task.error = error;

    this._clearTimeoutMonitor(taskId);

    this.tasks.set(taskId, task);
  }

  /**
   * 取消任务
   */
  cancelTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.state = TASK_STATE.CANCELLED;
    task.completedAt = new Date().toISOString();

    this._clearTimeoutMonitor(taskId);

    this.tasks.set(taskId, task);
  }

  /**
   * 获取任务状态
   */
  getTaskState(taskId) {
    return this.tasks.get(taskId);
  }

  /**
   * 获取所有任务状态摘要
   */
  getStatusSummary() {
    const summary = {
      total: this.tasks.size,
      byState: {},
      timeout: [],
    };

    for (const task of this.tasks.values()) {
      const state = task.state;
      summary.byState[state] = (summary.byState[state] || 0) + 1;

      if (this._isTaskTimedOut(task)) {
        summary.timeout.push(task.id);
      }
    }

    return summary;
  }

  // ================================================================
  // 超时管理
  // ================================================================

  _startTimeoutMonitor(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    // 设置超时警告（80%时间）
    const warningTimeout = task.timeout * this.warningThreshold;
    const warningTimerId = setTimeout(() => {
      this._handleTimeoutWarning(taskId);
    }, warningTimeout);

    // 设置超时终止（100%时间）
    const timeoutTimerId = setTimeout(() => {
      this._handleTimeout(taskId);
    }, task.timeout);

    this.timeoutHandlers.set(taskId, {
      warning: warningTimerId,
      timeout: timeoutTimerId,
    });
  }

  _clearTimeoutMonitor(taskId) {
    const timers = this.timeoutHandlers.get(taskId);
    if (timers) {
      clearTimeout(timers.warning);
      clearTimeout(timers.timeout);
      this.timeoutHandlers.delete(taskId);
    }
  }

  _handleTimeoutWarning(taskId) {
    const task = this.tasks.get(taskId);
    if (task && task.state === TASK_STATE.RUNNING) {
      this.logger?.warn(`任务 ${taskId} 即将超时`, {
        progress: task.progress,
        elapsed: task.startedAt ? Date.now() - new Date(task.startedAt).getTime() : 0,
      });
    }
  }

  _handleTimeout(taskId) {
    const task = this.tasks.get(taskId);
    if (task && task.state === TASK_STATE.RUNNING) {
      task.state = TASK_STATE.TIMEOUT;
      this.tasks.set(taskId, task);
      this.logger?.error(`任务 ${taskId} 执行超时`);
    }
  }

  _isTaskTimedOut(task) {
    return task.state === TASK_STATE.TIMEOUT ||
           (task.state === TASK_STATE.RUNNING && task.startedAt &&
            Date.now() - new Date(task.startedAt).getTime() > task.timeout);
  }

  // ================================================================
  // 依赖管理
  // ================================================================

  _notifyDependents(completedTaskId) {
    for (const task of this.tasks.values()) {
      if (task.dependencies.includes(completedTaskId)) {
        this._checkAndStartIfReady(task.id);
      }
    }
  }

  _checkAndStartIfReady(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || task.state !== TASK_STATE.WAITING_DEP) return;

    const allDepsCompleted = task.dependencies.every(depId => {
      const dep = this.tasks.get(depId);
      return dep && dep.state === TASK_STATE.COMPLETED;
    });

    if (allDepsCompleted) {
      task.state = TASK_STATE.PENDING;
      this.tasks.set(taskId, task);
    }
  }

  _generateTaskId() {
    return `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  }
}

module.exports = TaskStateManager;

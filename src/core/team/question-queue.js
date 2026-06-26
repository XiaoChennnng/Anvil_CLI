'use strict';

/**
 * Team Question Queue — 多 Agent 提问串行调度器。
 *
 * 解决 _pendingQuestionResolve 单值覆盖导致前一个 agent 永远等不到答案的问题。
 * 每个 entry 维护自己的 resolve,主 Agent 用 MAIN_AGENT_ID 占位串行入队。
 */

const { v4: uuidv4 } = require('uuid');
const { EventEmitter } = require('events');

const MAIN_AGENT_ID = '__main__';

class TeamQuestionQueue extends EventEmitter {
  constructor() {
    super();
    this.current = null;     // 当前展示的问题
    this.pending = [];       // 待处理队列
    this.history = [];       // 历史记录
  }

  /** 子 Agent / 主 Agent 提交问题,返回用户答案的 Promise(null = 取消)。 */
  enqueue(agentId, meta, params) {
    return new Promise((resolve) => {
      const entry = {
        id: uuidv4(),
        agentId,
        meta: meta || {},
        params,
        resolve,
        enqueuedAt: Date.now(),
      };
      this.pending.push(entry);
      this.emit('enqueued', entry);
      this._tryShow();
    });
  }

  /** 尝试展示下一个待处理问题(内部使用)。 */
  _tryShow() {
    if (this.current) {return;}
    const next = this.pending.shift();
    if (!next) {return;}
    this.current = next;
    this.history.push(next);
    this.emit('show', next);
  }

  /** 用户提交答案 → 解析当前问题(null = 取消)。 */
  resolve(answers) {
    if (!this.current) {return false;}  // stale resolve(多次 Enter)忽略
    const current = this.current;
    this.current = null;
    current.resolve(answers);
    this.emit('resolved', { id: current.id, agentId: current.agentId, answers });
    this._tryShow();
    return true;
  }

  /** 强制取消当前问题(interrupt 用)。 */
  cancelCurrent(reason) {
    if (!this.current) {return false;}
    return this.resolve(null);
  }

  /** 取消所有 pending + current(团队解散/中断)。 */
  cancelAll(reason) {
    const allPending = this.pending;
    if (this.current) {
      this.current.resolve(null);
      this.current = null;
    }
    for (const entry of allPending) {entry.resolve(null);}
    this.pending = [];
    this.emit('cancelledAll', { reason: reason || 'unknown' });
  }

  /** 当前展示的问题(供 UI 用)。 */
  getCurrent() {
    return this.current;
  }

  /** 队列长度(含正在展示的)。 */
  size() {
    return (this.current ? 1 : 0) + this.pending.length;
  }

  /** 清空历史并取消所有 pending。 */
  reset() {
    this.cancelAll('reset');
    this.history = [];
    this.emit('reset');
  }
}

module.exports = TeamQuestionQueue;
module.exports.MAIN_AGENT_ID = MAIN_AGENT_ID;

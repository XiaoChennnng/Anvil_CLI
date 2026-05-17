/**
 * 团队通信通道
 * 负责主Agent与子Agent之间、以及子Agent彼此间的消息传递
 * @file team-communication.js
 */

const { EventEmitter } = require('events');
const { MessageTypes } = require('./constants');

/**
 * 团队通信通道
 *
 * 负责主Agent与子Agent之间、以及子Agent彼此间的消息传递
 * 采用发布-订阅模式，支持异步通信
 */
class TeamCommunication extends EventEmitter {
  constructor(options = {}) {
    super();

    this.teamId = options.teamId;
    this.logger = options.logger;

    // 消息队列
    this.messageQueue = new Map();  // agentId -> Message[]
    this.pendingResponses = new Map();  // messageId -> Promise

    // 心跳配置
    this.heartbeatInterval = options.heartbeatInterval || 30 * 1000;
    this.heartbeatTimeout = options.heartbeatTimeout || 90 * 1000;
    this.heartbeatTimers = new Map();  // agentId -> timerId

    // 消息追踪
    this.messageStats = {
      sent: 0,
      received: 0,
      failed: 0,
    };

    // 心跳记录
    this._heartbeatMap = new Map();  // agentId -> last heartbeat timestamp
  }

  // ================================================================
  // 消息发送
  // ================================================================

  /**
   * 发送消息到指定Agent
   * @param {string} agentId - 目标Agent ID
   * @param {Object} message - 消息内容
   * @returns {Promise<Object>} 响应
   */
  async sendToAgent(agentId, message) {
    const messageId = this._generateMessageId();

    const envelope = {
      id: messageId,
      type: message.type,
      from: 'master',
      to: agentId,
      payload: message.payload,
      timestamp: new Date().toISOString(),
    };

    this.messageStats.sent++;

    // 加入队列
    this._enqueueMessage(agentId, envelope);

    // 发送事件（供Agent订阅）
    this.emit('message_to_agent', envelope);

    // 如果需要响应，返回Promise
    if (message.expectResponse) {
      return this._createResponsePromise(messageId);
    }

    return { messageId, sent: true };
  }

  /**
   * 广播消息到所有Agent
   */
  broadcast(message, agentIds = null) {
    const envelope = {
      id: this._generateMessageId(),
      type: message.type,
      from: 'master',
      to: '*',  // 广播标识
      payload: message.payload,
      timestamp: new Date().toISOString(),
    };

    this.emit('broadcast', envelope);

    return { broadcasted: true, agentCount: agentIds?.length || 0 };
  }

  /**
   * Agent发送消息到主Agent
   */
  async receiveFromAgent(agentId, message) {
    this.messageStats.received++;

    const envelope = {
      id: this._generateMessageId(),
      type: message.type,
      from: agentId,
      to: 'master',
      payload: message.payload,
      timestamp: new Date().toISOString(),
    };

    // 派发消息事件
    this.emit('message_from_agent', envelope);

    // 处理消息类型
    switch (message.type) {
      case MessageTypes.RESULT_SUBMIT:
        this._handleResultSubmit(agentId, message.payload);
        break;

      case MessageTypes.STATUS_REPORT:
        this._handleStatusReport(agentId, message.payload);
        break;

      case MessageTypes.HEARTBEAT:
        this._handleHeartbeat(agentId);
        break;
    }

    return { received: true };
  }

  // ================================================================
  // Agent间直接通信（通过主Agent转发）
  // ================================================================

  /**
   * Agent间点对点通信
   * 消息通过主Agent转发，不允许直接通信以保持主Agent控制权
   */
  async agentToAgent(fromAgentId, toAgentId, message) {
    const envelope = {
      id: this._generateMessageId(),
      type: MessageTypes.TASK_UPDATE,
      from: fromAgentId,
      to: toAgentId,
      payload: message.payload,
      timestamp: new Date().toISOString(),
    };

    // 验证通信权限
    if (!this._validateAgentCommunication(fromAgentId, toAgentId)) {
      throw new Error(`Agent ${fromAgentId} 无权向 ${toAgentId} 发送消息`);
    }

    this.emit('agent_message', envelope);

    return { relayed: true };
  }

  // ================================================================
  // 心跳管理
  // ================================================================

  /**
   * 启动Agent心跳
   */
  startHeartbeat(agentId) {
    const timerId = setInterval(() => {
      this._checkHeartbeat(agentId);
    }, this.heartbeatInterval);

    this.heartbeatTimers.set(agentId, timerId);
  }

  /**
   * 停止Agent心跳
   */
  stopHeartbeat(agentId) {
    const timerId = this.heartbeatTimers.get(agentId);
    if (timerId) {
      clearInterval(timerId);
      this.heartbeatTimers.delete(agentId);
    }
  }

  /**
   * 检查心跳状态
   */
  _checkHeartbeat(agentId) {
    const lastHeartbeat = this._getLastHeartbeat(agentId);

    if (!lastHeartbeat) {
      // 首次心跳，无需检查
      return;
    }

    const elapsed = Date.now() - new Date(lastHeartbeat).getTime();

    if (elapsed > this.heartbeatTimeout) {
      this.emit('agent_unresponsive', {
        agentId,
        lastHeartbeat,
        elapsed,
      });
    }
  }

  // ================================================================
  // 消息处理
  // ================================================================

  _handleResultSubmit(agentId, payload) {
    this.emit('result_submitted', {
      agentId,
      result: payload.result,
      timestamp: payload.timestamp,
    });
  }

  _handleStatusReport(agentId, payload) {
    this.emit('status_report', {
      agentId,
      status: payload.status,
      progress: payload.progress,
      message: payload.message,
    });
  }

  _handleHeartbeat(agentId) {
    this._setLastHeartbeat(agentId, new Date().toISOString());
  }

  // ================================================================
  // 辅助方法
  // ================================================================

  _enqueueMessage(agentId, envelope) {
    if (!this.messageQueue.has(agentId)) {
      this.messageQueue.set(agentId, []);
    }
    this.messageQueue.get(agentId).push(envelope);
  }

  _getNextMessage(agentId) {
    const queue = this.messageQueue.get(agentId);
    return queue ? queue.shift() : null;
  }

  _createResponsePromise(messageId) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(messageId);
        reject(new Error(`消息 ${messageId} 响应超时`));
      }, 60 * 1000);

      this.pendingResponses.set(messageId, { resolve, reject, timeout });
    });
  }

  _resolveResponse(messageId, response) {
    const pending = this.pendingResponses.get(messageId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(response);
      this.pendingResponses.delete(messageId);
    }
  }

  _generateMessageId() {
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  _getLastHeartbeat(agentId) {
    return this._heartbeatMap.get(agentId);
  }

  _setLastHeartbeat(agentId, timestamp) {
    this._heartbeatMap.set(agentId, timestamp);
  }

  _validateAgentCommunication(fromAgentId, toAgentId) {
    // 目前只允许协调者与执行者通信
    return true;  // TODO: 实现更细粒度的权限控制
  }

  /**
   * 清理资源
   */
  dispose() {
    // 停止所有心跳
    for (const agentId of this.heartbeatTimers.keys()) {
      this.stopHeartbeat(agentId);
    }

    // 清理响应Promise
    for (const [, pending] of this.pendingResponses) {
      clearTimeout(pending.timeout);
    }
    this.pendingResponses.clear();

    // 清理消息队列
    this.messageQueue.clear();
  }
}

module.exports = TeamCommunication;
module.exports.MessageTypes = MessageTypes;

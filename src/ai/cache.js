'use strict';

class SessionCache {
  constructor(maxSize = 100, ttl = 5 * 60 * 1000) {
    this._cache = new Map();
    this._maxSize = maxSize;
    this._ttl = ttl; // TTL 默认 5 分钟，过期条目自动失效
  }

  _makeKey(question, context) {
    // 轻量键：用 question + 上下文标识直接拼接，跳过 JSON.stringify + MD5
    // context 结构通常是 { model, contextHash }，由调用方传入
    const ctxId = (context && typeof context === 'object')
      ? (context.contextHash || context.model || '')
      : String(context || '');
    return question + '::' + ctxId;
  }

  get(question, context) {
    const key = this._makeKey(question, context);
    if (!this._cache.has(key)) {return null;}

    const entry = this._cache.get(key);

    // TTL 过期检查
    if (Date.now() - entry.ts > this._ttl) {
      this._cache.delete(key);
      return null;
    }

    // LRU 更新
    this._cache.delete(key);
    this._cache.set(key, entry);
    return entry.value;
  }

  set(question, context, result) {
    const key = this._makeKey(question, context);

    if (this._cache.size >= this._maxSize) {
      const firstKey = this._cache.keys().next().value;
      this._cache.delete(firstKey);
    }

    this._cache.set(key, { value: result, ts: Date.now() });
  }

  /**
   * 获取缓存统计信息
   */
  getStats() {
    return {
      size: this._cache.size,
      maxSize: this._maxSize,
      ttl: this._ttl,
    };
  }

  has(question, context) {
    return this._cache.has(this._makeKey(question, context));
  }

  clear() {
    this._cache.clear();
  }

  get size() {
    return this._cache.size;
  }
}

module.exports = SessionCache;

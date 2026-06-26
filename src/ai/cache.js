'use strict';

class SessionCache {
  constructor(maxSize = 500, ttl = 30 * 60 * 1000) {
    this._cache = new Map();
    this._maxSize = maxSize;
    this._ttl = ttl;
  }

  _makeKey(question, context) {
    // 轻量键: question + 上下文标识拼接，context 结构由调用方传入
    const ctxId = (context && typeof context === 'object')
      ? (context.contextHash || context.model || '')
      : String(context || '');
    return question + '::' + ctxId;
  }

  get(question, context) {
    const key = this._makeKey(question, context);
    if (!this._cache.has(key)) {return null;}

    const entry = this._cache.get(key);

    if (Date.now() - entry.ts > this._ttl) {
      this._cache.delete(key);
      return null;
    }

    // LRU:删除已存在的 key,重新插入到末尾成为最新访问
    this._cache.delete(key);
    this._cache.set(key, entry);
    return entry.value;
  }

  set(question, context, result) {
    const key = this._makeKey(question, context);

    if (this._cache.has(key)) {
      this._cache.delete(key);
    }

    if (this._cache.size >= this._maxSize) {
      const firstKey = this._cache.keys().next().value;
      this._cache.delete(firstKey);
    }

    this._cache.set(key, { value: result, ts: Date.now() });
  }

  clear() {
    this._cache.clear();
  }
}

module.exports = SessionCache;

'use strict';

const crypto = require('crypto');

class SessionCache {
  constructor(maxSize = 100) {
    this._cache = new Map();
    this._maxSize = maxSize;
  }

  _makeKey(question, context) {
    const data = JSON.stringify({ question, context });
    return crypto.createHash('md5').update(data).digest('hex');
  }

  get(question, context) {
    const key = this._makeKey(question, context);
    if (!this._cache.has(key)) {return null;}

    const value = this._cache.get(key);
    this._cache.delete(key);
    this._cache.set(key, value);
    return value;
  }

  set(question, context, result) {
    const key = this._makeKey(question, context);

    if (this._cache.size >= this._maxSize) {
      const firstKey = this._cache.keys().next().value;
      this._cache.delete(firstKey);
    }

    this._cache.set(key, result);
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

'use strict';

/**
 * 搜索结果 LRU 缓存模块，带 TTL 过期机制
 */

class SearchCache {
  /**
   * @param {object} options
   * @param {number} options.maxSize - 最大缓存条目数，默认 100
   * @param {number} options.defaultTTL - 默认 TTL（毫秒），默认 5 分钟
   */
  constructor(options = {}) {
    this.maxSize = options.maxSize || 100;
    this.defaultTTL = options.defaultTTL || 5 * 60 * 1000;
    this.cache = new Map(); // 使用 Map 保持插入顺序，便于 LRU 淘汰
    this.timers = new Map(); // 存储每个 key 的过期定时器
  }

  /**
   * 构建缓存 key
   * @param {string} query - 搜索词
   * @param {string} engine - 搜索引擎
   * @param {string} [timeRange] - 时间范围
   * @param {string} [siteFilter] - 站点过滤
   * @returns {string}
   */
  static buildKey(query, engine, timeRange, siteFilter) {
    const normalizedQuery = query.toLowerCase().trim();
    const normalizedEngine = engine.toLowerCase().trim();
    const tr = timeRange || 'any';
    const sf = siteFilter || 'any';
    return `websearch:${normalizedEngine}:${tr}:${sf}:${normalizedQuery}`;
  }

  /**
   * 获取缓存值
   * @param {string} key
   * @returns {object|null} - { data, timestamp } 或 null
   */
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }

    // 检查是否过期（虽然定时器会清理，但这里再检查一次保险）
    if (Date.now() > entry.expiresAt) {
      this.delete(key);
      return null;
    }

    // LRU: 移动到最新位置
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.data;
  }

  /**
   * 设置缓存值
   * @param {string} key
   * @param {object} data - 要缓存的数据
   * @param {number} [ttl] - 自定义 TTL（毫秒）
   */
  set(key, data, ttl) {
    // 如果已存在，先清理旧定时器
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
    }

    // LRU: 如果已满且是新的 key，删除最旧的
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const oldestKey = this.cache.keys().next().value;
      this.delete(oldestKey);
    }

    const expiresAt = Date.now() + (ttl || this.defaultTTL);
    const entry = {
      data,
      expiresAt,
      createdAt: Date.now(),
    };

    this.cache.set(key, entry);

    // 设置过期定时器
    const timer = setTimeout(() => {
      this.delete(key);
    }, ttl || this.defaultTTL);

    this.timers.set(key, timer);
  }

  /**
   * 删除缓存项
   * @param {string} key
   */
  delete(key) {
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
      this.timers.delete(key);
    }
    this.cache.delete(key);
  }

  /**
   * 清空所有缓存
   */
  clear() {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.cache.clear();
  }

  /**
   * 获取缓存统计信息
   * @returns {object}
   */
  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      defaultTTL: this.defaultTTL,
    };
  }

  /**
   * 检查 key 是否存在且未过期
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      return false;
    }
    if (Date.now() > entry.expiresAt) {
      this.delete(key);
      return false;
    }
    return true;
  }
}

module.exports = { SearchCache };

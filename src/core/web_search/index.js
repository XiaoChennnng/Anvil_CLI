'use strict';

/**
 * 联网搜索统一入口
 * 支持多搜索引擎（SearXNG、DuckDuckGo、Bing），带缓存和降级策略
 */

const { SearchCache } = require('./cache');
const { searchBing } = require('./bing');
const { searchDuckDuckGo } = require('./duckduckgo');
const { searchSearXNG } = require('./searxng');

// 搜索引擎优先级（auto 模式）
const ENGINE_PRIORITY = ['searxng', 'duckduckgo', 'bing'];

// 单例缓存实例
let globalCache = null;

/**
 * 获取缓存实例
 * @param {object} config
 * @returns {SearchCache}
 */
function getCache(config) {
  if (!globalCache) {
    const cacheConfig = config.cache || {};
    globalCache = new SearchCache({
      maxSize: cacheConfig.maxSize || 100,
      defaultTTL: cacheConfig.ttl || 5 * 60 * 1000, // 默认 5 分钟
    });
  }
  return globalCache;
}

/**
 * 构建缓存 key
 * @param {string} query
 * @param {string} engine
 * @param {object} options
 * @returns {string}
 */
function buildCacheKey(query, engine, options = {}) {
  return SearchCache.buildKey(query, engine, options.timeRange, options.siteFilter);
}

/**
 * 获取引擎优先级列表
 * @param {string} preferredEngine
 * @param {object} config
 * @returns {Array<string>}
 */
function getEnginePriority(preferredEngine, config) {
  if (preferredEngine && preferredEngine !== 'auto') {
    return [preferredEngine];
  }

  // 根据配置过滤可用的引擎
  const available = [];

  // SearXNG：如果配置了实例才优先
  if (config.searxng?.instance || config.searxng?.enabled !== false) {
    available.push('searxng');
  }

  // DuckDuckGo：默认启用
  if (config.duckduckgo?.enabled !== false) {
    available.push('duckduckgo');
  }

  // Bing：默认启用
  if (config.bing?.enabled !== false) {
    available.push('bing');
  }

  return available.length > 0 ? available : ['bing'];
}

/**
 * 执行单个引擎搜索
 * @param {string} engine
 * @param {string} query
 * @param {object} config
 * @param {object} logger
 * @returns {Promise<object>}
 */
async function searchWithEngine(engine, query, config, logger) {
  const engineConfig = {
    ...config[engine],
    proxy: config.proxy,
    timeout: config.timeout,
    maxResults: config.maxResults,
    locale: config.locale,
    userAgent: config.userAgent,
  };

  switch (engine) {
    case 'searxng':
      return searchSearXNG(query, engineConfig, logger);
    case 'duckduckgo':
      return searchDuckDuckGo(query, engineConfig, logger);
    case 'bing':
      return searchBing(query, engineConfig, logger);
    default:
      return { error: `未知搜索引擎: ${engine}` };
  }
}

/**
 * 统一搜索入口
 * @param {string} query - 搜索关键词
 * @param {object} options - 搜索选项
 * @param {object} context - 上下文（包含 config, logger 等）
 * @returns {Promise<object>}
 */
async function search(query, options = {}, context = {}) {
  const config = context.config?.webSearch || {};
  const logger = context.logger;

  if (config.enabled === false) {
    return { error: '联网搜索未启用' };
  }

  if (!query || typeof query !== 'string' || !query.trim()) {
    return { error: 'query 参数必填' };
  }

  const trimmed = query.trim();
  const maxResults = options.maxResults || config.maxResults || 8;
  const engine = options.engine || config.defaultEngine || 'auto';
  const timeRange = options.timeRange;
  const siteFilter = options.siteFilter;

  // 构建缓存 key
  const cacheKey = buildCacheKey(trimmed, engine, { timeRange, siteFilter });

  // 检查缓存
  const cache = config.cacheEnabled !== false ? getCache(config) : null;
  if (cache) {
    const cached = cache.get(cacheKey);
    if (cached) {
      logger?.debug?.('web_search 命中缓存', { query: trimmed, engine });
      return {
        ...cached,
        fromCache: true,
      };
    }
  }

  // 获取引擎优先级列表
  const engines = getEnginePriority(engine, config);
  logger?.debug?.('web_search 引擎优先级', { engines, query: trimmed });

  // 依次尝试每个引擎
  const errors = [];

  for (const engineName of engines) {
    logger?.debug?.('web_search 尝试引擎', { engine: engineName });

    const engineConfig = {
      ...config,
      maxResults,
      timeRange,
      siteFilter,
      [engineName]: {
        ...config[engineName],
        maxResults,
        timeRange,
        siteFilter,
      },
    };

    const result = await searchWithEngine(engineName, trimmed, engineConfig, logger);

    if (result.success) {
      // 缓存结果
      if (cache) {
        cache.set(cacheKey, result);
      }
      return result;
    }

    // 记录错误，继续下一个引擎
    errors.push({ engine: engineName, error: result.error });
    logger?.debug?.('web_search 引擎失败', { engine: engineName, error: result.error });
  }

  // 所有引擎都失败
  logger?.warn?.('web_search 所有引擎失败', { query: trimmed, errors });
  return {
    error: `所有搜索引擎均不可用。尝试的引擎: ${errors.map(e => `${e.engine}(${e.error})`).join(', ')}`,
  };
}

/**
 * 获取缓存统计信息
 * @returns {object|null}
 */
function getCacheStats() {
  if (!globalCache) {
    return null;
  }
  return globalCache.getStats();
}

/**
 * 清空缓存
 */
function clearCache() {
  if (globalCache) {
    globalCache.clear();
  }
}

module.exports = {
  search,
  getCacheStats,
  clearCache,
  // 导出底层实现供单独使用
  searchBing,
  searchDuckDuckGo,
  searchSearXNG,
  SearchCache,
};

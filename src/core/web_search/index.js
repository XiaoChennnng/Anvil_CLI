'use strict';

const { SearchCache } = require('./cache');
const { searchBing } = require('./bing');
const { searchDuckDuckGo } = require('./duckduckgo');
const { searchSearXNG } = require('./searxng');

let globalCache = null;

function getCache(config) {
  if (!globalCache) {
    const cacheConfig = config.cache || {};
    globalCache = new SearchCache({
      maxSize: cacheConfig.maxSize || 100,
      defaultTTL: cacheConfig.ttl || 5 * 60 * 1000,
    });
  }
  return globalCache;
}

function buildCacheKey(query, engine, options = {}) {
  return SearchCache.buildKey(query, engine, options.timeRange, options.siteFilter);
}

// 优先级: 用户指定引擎 > searxng(若配置实例) > duckduckgo > bing
function getEnginePriority(preferredEngine, config) {
  if (preferredEngine && preferredEngine !== 'auto') {
    return [preferredEngine];
  }

  const available = [];

  if (config.searxng?.instance || config.searxng?.enabled !== false) {
    available.push('searxng');
  }

  if (config.duckduckgo?.enabled !== false) {
    available.push('duckduckgo');
  }

  if (config.bing?.enabled !== false) {
    available.push('bing');
  }

  return available.length > 0 ? available : ['bing'];
}

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

// 统一搜索入口：缓存 → 引擎优先级 → 单引擎搜索；任一成功即返回，全部失败则聚合错误
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

  const cacheKey = buildCacheKey(trimmed, engine, { timeRange, siteFilter });
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

  const engines = getEnginePriority(engine, config);
  logger?.debug?.('web_search 引擎优先级', { engines, query: trimmed });

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
      if (cache) {
        cache.set(cacheKey, result);
      }
      return result;
    }

    errors.push({ engine: engineName, error: result.error });
    logger?.debug?.('web_search 引擎失败', { engine: engineName, error: result.error });
  }

  logger?.warn?.('web_search 所有引擎失败', { query: trimmed, errors });
  return {
    error: `所有搜索引擎均不可用。尝试的引擎: ${errors.map(e => `${e.engine}(${e.error})`).join(', ')}`,
  };
}

function getCacheStats() {
  if (!globalCache) {
    return null;
  }
  return globalCache.getStats();
}

function clearCache() {
  if (globalCache) {
    globalCache.clear();
  }
}

module.exports = {
  search,
  getCacheStats,
  clearCache,
  searchBing,
  searchDuckDuckGo,
  searchSearXNG,
  SearchCache,
};
'use strict';

/**
 * SearXNG 搜索客户端
 * 支持自定义 SearXNG 实例，返回 JSON 格式结果
 */

const HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;

// 默认公开 SearXNG 实例列表（作为备选）
const DEFAULT_INSTANCES = [
  'https://search.sapti.me',
  'https://search.bus-hit.me',
  'https://search.projectsegfault.com',
];

// 重试配置
const RETRY_DELAY_MS = 1500;
const RETRYABLE_HTTP_STATUS = new Set([502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set(['ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN']);

/**
 * 构造 fetch 选项
 * @param {object} config
 * @param {object} logger
 * @returns {object}
 */
function buildFetchOptions(config, logger) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeout || 15000);

  const fetchOptions = {
    method: 'GET',
    headers: {
      'User-Agent':
        config.userAgent ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    signal: controller.signal,
    redirect: 'follow',
  };

  // Proxy 支持
  if (config.proxy?.https) {
    try {
      fetchOptions.dispatcher = new HttpsProxyAgent(config.proxy.https);
    } catch (err) {
      logger?.debug?.('SearXNG 构造 proxy dispatcher 失败', { error: err.message });
    }
  }

  return { fetchOptions, controller, timer };
}

/**
 * 带重试的 fetch 封装
 * @param {string} url
 * @param {object} config
 * @param {object} logger
 * @returns {Promise<object>}
 */
async function fetchWithRetry(url, config, logger) {
  const maxAttempts = 2;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { fetchOptions, timer } = buildFetchOptions(config, logger);

    logger?.debug?.('SearXNG fetch', {
      url,
      attempt,
      hasDispatcher: !!fetchOptions.dispatcher,
      proxy: config.proxy?.https,
      timeout: config.timeout,
    });

    try {
      const response = await globalThis.fetch(url, fetchOptions);
      clearTimeout(timer);

      if (response.ok) {
        const body = await response.text();
        return { ok: true, status: response.status, body };
      }

      // 5xx 重试
      if (RETRYABLE_HTTP_STATUS.has(response.status) && attempt < maxAttempts) {
        logger?.debug?.('SearXNG 5xx，准备重试', { status: response.status, attempt });
        await sleep(RETRY_DELAY_MS);
        lastError = { kind: 'http_5xx', status: response.status };
        continue;
      }

      return { ok: false, status: response.status, body: null };
    } catch (err) {
      clearTimeout(timer);

      if (err.name === 'AbortError') {
        return { ok: false, kind: 'timeout', error: err };
      }

      // 网络错误重试
      if (err.code && RETRYABLE_NETWORK_CODES.has(err.code) && attempt < maxAttempts) {
        logger?.debug?.('SearXNG 网络错误，准备重试', { code: err.code, attempt });
        await sleep(RETRY_DELAY_MS);
        lastError = { kind: 'network', code: err.code };
        continue;
      }

      return { ok: false, kind: 'network', code: err.code, error: err };
    }
  }

  return { ok: false, ...(lastError || { kind: 'unknown' }) };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 解析 SearXNG JSON 响应
 * @param {string} jsonStr
 * @param {number} maxResults
 * @returns {{ results: Array, error: string|null }}
 */
function parseSearXNGResponse(jsonStr, maxResults) {
  try {
    const data = JSON.parse(jsonStr);

    if (!data.results || !Array.isArray(data.results)) {
      return { results: [], error: 'SearXNG 返回格式错误' };
    }

    const results = data.results
      .slice(0, maxResults)
      .map((item, index) => ({
        title: (item.title || '').trim(),
        url: (item.url || '').trim(),
        snippet: (item.content || item.abstract || '').trim(),
        source: item.engine || 'searxng',
        position: index + 1,
      }))
      .filter((item) => item.title && item.url);

    return { results, error: null };
  } catch (err) {
    return { results: [], error: `解析 SearXNG 响应失败: ${err.message}` };
  }
}

/**
 * 构建搜索 URL
 * @param {string} instance
 * @param {string} query
 * @param {object} options
 * @returns {string}
 */
function buildSearchUrl(instance, query, options = {}) {
  const url = new URL('/search', instance);
  url.searchParams.append('q', query);
  url.searchParams.append('format', 'json');
  url.searchParams.append('language', options.locale || 'zh-CN');

  // 时间范围过滤
  if (options.timeRange) {
    const timeMap = {
      day: 'day',
      week: 'week',
      month: 'month',
      year: 'year',
    };
    if (timeMap[options.timeRange]) {
      url.searchParams.append('time_range', timeMap[options.timeRange]);
    }
  }

  // 站点过滤
  if (options.siteFilter) {
    url.searchParams.append('q', `site:${options.siteFilter} ${query}`);
  }

  return url.toString();
}

/**
 * 搜索 SearXNG
 * @param {string} query
 * @param {object} config
 * @param {object} logger
 * @returns {Promise<object>}
 */
async function searchSearXNG(query, config = {}, logger) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return { error: 'query 参数必填' };
  }

  if (config.enabled === false) {
    return { error: 'SearXNG 搜索未启用' };
  }

  // 获取实例列表
  let instances = [];
  if (config.instance) {
    instances = [config.instance];
  } else {
    instances = DEFAULT_INSTANCES;
  }

  if (instances.length === 0) {
    return { error: '未配置 SearXNG 实例' };
  }

  const trimmed = query.trim();
  const maxResults = config.maxResults || 8;

  // 尝试每个实例
  for (const instance of instances) {
    const url = buildSearchUrl(instance, trimmed, {
      locale: config.locale,
      timeRange: config.timeRange,
      siteFilter: config.siteFilter,
    });

    const fetchResult = await fetchWithRetry(url, config, logger);

    if (!fetchResult.ok) {
      if (fetchResult.kind === 'timeout') {
        logger?.debug?.(`SearXNG 实例 ${instance} 超时，尝试下一个`);
        continue;
      }
      if (fetchResult.kind === 'network') {
        logger?.debug?.(`SearXNG 实例 ${instance} 网络错误 (${fetchResult.code})，尝试下一个`);
        continue;
      }
      logger?.debug?.(`SearXNG 实例 ${instance} 返回 ${fetchResult.status}，尝试下一个`);
      continue;
    }

    const { results, error } = parseSearXNGResponse(fetchResult.body, maxResults);

    if (error) {
      logger?.debug?.(`SearXNG 实例 ${instance} 解析失败: ${error}`);
      continue;
    }

    if (results.length === 0) {
      logger?.debug?.(`SearXNG 实例 ${instance} 返回 0 结果`);
      // 继续尝试下一个实例，因为可能是这个实例的问题
      continue;
    }

    return {
      success: true,
      query: trimmed,
      provider: 'searxng',
      instance,
      totalResults: results.length,
      results,
    };
  }

  // 所有实例都失败
  return { error: '所有 SearXNG 实例均不可用' };
}

module.exports = {
  searchSearXNG,
  parseSearXNGResponse,
  buildSearchUrl,
};

'use strict';

/**
 * web_search 核心模块
 *
 * 访问 Bing 公开搜索页（零 key），模拟浏览器 User-Agent 抓 HTML 并解析。
 * 失败/反爬/解析异常统一返回 { error: '...' }，不 throw。
 *
 * 导出：
 *   searchBing(query, config, logger) -> Promise<{ success, query, results, ... } | { error }>
 *   parseBingHTML(html, maxResults)   -> { results, captcha }（导出便于单测）
 */

const HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;

// Bing 结果页稳定的 DOM 标识（2024-2026 验证）。改版时优先改这里。
const BING_SELECTORS = {
  resultItem: '<li class="b_algo"',
  // 标题在 h2 内的 a 标签，href 是真实 URL
  // 注意：h2 可能带 class 属性（`<h2 class="">`），href 后面可能还有 h="ID=SERP,..." 等属性
  titleLink: /<h2\b[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i,
  // 摘要在 b_caption 内的 p 标签（p 可能带 class）
  captionBlock: /<div class="b_caption"[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i,
};

// 反爬触发关键词（CAPTCHA / 异常流量提示）
const CAPTCHA_MARKERS = [
  'captcha',
  'unusual traffic',
  'verify you are human',
  "verify you're human",
  'please complete the security check',
];

// 重试配置：仅对网络/5xx 重试 1 次，间隔 1.5s
const RETRY_DELAY_MS = 1500;
const RETRYABLE_HTTP_STATUS = new Set([502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set(['ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN']);

/**
 * 解析 Bing 搜索结果 HTML。
 * @param {string} html
 * @param {number} maxResults
 * @returns {{ results: Array, captcha: boolean }}
 */
function parseBingHTML(html, maxResults) {
  if (typeof html !== 'string' || html.length === 0) {
    return { results: [], captcha: false };
  }

  // 反爬检测：只要任一关键词命中就标记，让上层返回友好错误
  const lower = html.toLowerCase();
  const captcha = CAPTCHA_MARKERS.some(m => lower.includes(m));
  if (captcha) {
    return { results: [], captcha: true };
  }

  const results = [];
  // state-machine 扫描：定位每个 <li class="b_algo"> 区间
  let cursor = 0;
  let position = 1;
  while (cursor < html.length && results.length < maxResults) {
    const start = html.indexOf(BING_SELECTORS.resultItem, cursor);
    if (start === -1) {
      break;
    }
    // 找下一个 <li class="b_algo"> 作为区间终点
    const next = html.indexOf(BING_SELECTORS.resultItem, start + 1);
    const end = next === -1 ? html.length : next;
    const segment = html.slice(start, end);

    // 提取标题链接。过滤 Bing 重定向链接 (bing.com/ck/a?...)。
    const titleMatch = segment.match(BING_SELECTORS.titleLink);
    if (titleMatch) {
      const url = titleMatch[1];
      const rawTitle = titleMatch[2];
      if (!url.includes('bing.com/ck/a?') && !url.startsWith('javascript:')) {
        // 清理 title 里的 HTML 标签和实体（基础处理，足够用于展示）
        const title = stripHtml(rawTitle);
        if (title && url) {
          const captionMatch = segment.match(BING_SELECTORS.captionBlock);
          const snippet = captionMatch ? stripHtml(captionMatch[1]) : '';
          results.push({
            title: title.trim(),
            url: url.trim(),
            snippet: snippet.trim(),
            source: 'bing',
            position,
          });
          position += 1;
        }
      }
    }

    cursor = end;
  }

  return { results, captcha: false };
}

/**
 * 去掉简单 HTML 标签和实体，提取纯文本。
 * 不引入 cheerio，够用即可。
 */
function stripHtml(s) {
  if (!s) {
    return '';
  }
  return s
    .replace(/<[^>]+>/g, '')        // 去标签
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      // 处理 &#174; &#0183; 等数字实体
      const n = parseInt(code, 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : '';
    })
    .replace(/\s+/g, ' ');
}

/**
 * 构造带浏览器风格的 headers。
 */
function buildHeaders(config) {
  return {
    'User-Agent': config.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': 'https://www.bing.com/',
    'Upgrade-Insecure-Requests': '1',
  };
}

/**
 * 构造 fetch 选项（含 proxy dispatcher 和超时 signal）。
 */
function buildFetchOptions(config, logger) {
  const headers = buildHeaders(config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeout || 15000);

  const fetchOptions = {
    method: 'GET',
    headers,
    signal: controller.signal,
    redirect: 'follow',
  };

  // Node 18 fetch 是 undici 实现，proxy 通过 dispatcher 传。
  // HttpsProxyAgent v7 同时实现 Agent 和 Dispatcher 接口。
  if (config.proxy?.https) {
    try {
      fetchOptions.dispatcher = new HttpsProxyAgent(config.proxy.https);
    } catch (err) {
      logger?.debug?.('web_search 构造 proxy dispatcher 失败', { error: err.message });
    }
  }

  return { fetchOptions, controller, timer };
}

/**
 * 带超时 + 重试的 fetch 封装。返回 { ok, status, body, error } 之一。
 */
async function fetchWithRetry(url, config, logger) {
  const maxAttempts = 2; // 1 次重试
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { fetchOptions, timer } = buildFetchOptions(config, logger);
    logger?.debug?.('web_search fetch', {
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

      // 5xx 视情况重试
      if (RETRYABLE_HTTP_STATUS.has(response.status) && attempt < maxAttempts) {
        logger?.debug?.('web_search 5xx，准备重试', { status: response.status, attempt });
        await sleep(RETRY_DELAY_MS);
        lastError = { kind: 'http_5xx', status: response.status };
        continue;
      }

      // 4xx 或最后一次 5xx：直接返回错误状态
      return { ok: false, status: response.status, body: null };
    } catch (err) {
      clearTimeout(timer);

      // AbortError 区分用户中断 vs 超时
      if (err.name === 'AbortError') {
        return { ok: false, kind: 'timeout', error: err };
      }

      // 网络错误代码：可重试的（仅 attempt < max 时）
      if (err.code && RETRYABLE_NETWORK_CODES.has(err.code) && attempt < maxAttempts) {
        logger?.debug?.('web_search 网络错误，准备重试', { code: err.code, attempt });
        await sleep(RETRY_DELAY_MS);
        lastError = { kind: 'network', code: err.code };
        continue;
      }

      // 其他：直接返回错误
      return { ok: false, kind: 'network', code: err.code, error: err };
    }
  }

  // 走到这里说明重试用尽
  return { ok: false, ...(lastError || { kind: 'unknown' }) };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 主入口：搜索 Bing 并返回结构化结果。
 *
 * @param {string} query
 * @param {object} config  webSearch 配置块
 * @param {object} [logger]
 * @returns {Promise<{ success: true, query, provider, totalResults, results } | { error: string }>}
 */
async function searchBing(query, config = {}, logger) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return { error: 'query 参数必填' };
  }
  if (config.enabled === false) {
    return { error: 'web_search 工具未启用' };
  }

  const trimmed = query.trim();
  const maxResults = config.maxResults || 8;
  const locale = config.locale || 'zh-CN';
  const endpoint = config.endpoint || 'https://www.bing.com/search';

  let url;
  try {
    url = `${endpoint}?q=${encodeURIComponent(trimmed)}&count=${maxResults}&setlang=${encodeURIComponent(locale)}&mkt=${encodeURIComponent(locale)}&FORM=QBLH`;
  } catch (err) {
    return { error: `query 包含无法编码的字符: ${err.message}` };
  }

  const fetchResult = await fetchWithRetry(url, config, logger);

  if (!fetchResult.ok) {
    if (fetchResult.kind === 'timeout') {
      return { error: `搜索超时 (${config.timeout || 15000}ms)` };
    }
    if (fetchResult.kind === 'network') {
      return { error: `无法连接到 Bing (${fetchResult.code || 'UNKNOWN'})` };
    }
    if (fetchResult.kind === 'http_5xx') {
      return { error: `Bing 服务异常 ${fetchResult.status}` };
    }
    // 4xx
    return { error: `Bing 返回 ${fetchResult.status}` };
  }

  const { results, captcha } = parseBingHTML(fetchResult.body, maxResults);

  if (captcha) {
    logger?.warn?.('web_search 触发 Bing 反爬验证');
    return { error: 'Bing 触发反爬验证，请稍后重试' };
  }

  if (results.length === 0) {
    logger?.debug?.('web_search 解析 0 结果', {
      htmlLength: fetchResult.body?.length || 0,
      htmlHead: (fetchResult.body || '').slice(0, 200),
    });
    return { error: 'Bing 页面结构变化，解析失败' };
  }

  return {
    success: true,
    query: trimmed,
    provider: 'bing',
    totalResults: results.length,
    results,
  };
}

module.exports = {
  searchBing,
  parseBingHTML,
};

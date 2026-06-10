'use strict';

/**
 * DuckDuckGo HTML 搜索抓取（零 key）
 * 使用 html.duckduckgo.com/html/ 端点
 */

const HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;

// DuckDuckGo 结果页 DOM 标识
const DDG_SELECTORS = {
  resultItem: 'class="result"',
  // 标题链接在 h2.result__a 内的 a 标签
  titleLink: /<h2[^>]*class="result__title"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i,
  // 摘要在 .result__snippet 内
  snippetBlock: /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i,
};

// 反爬/验证标记
const CAPTCHA_MARKERS = [
  'captcha',
  'unusual traffic',
  'verify you are human',
  "verify you're human",
  'please complete',
  'security check',
];

// 重试配置
const RETRY_DELAY_MS = 1500;
const RETRYABLE_HTTP_STATUS = new Set([502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set(['ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN']);

/**
 * 去掉简单 HTML 标签和实体，提取纯文本
 * @param {string} s
 * @returns {string}
 */
function stripHtml(s) {
  if (!s) {
    return '';
  }
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      const n = parseInt(code, 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析 DuckDuckGo 搜索结果 HTML
 * @param {string} html
 * @param {number} maxResults
 * @returns {{ results: Array, captcha: boolean }}
 */
function parseDuckDuckGoHTML(html, maxResults) {
  if (typeof html !== 'string' || html.length === 0) {
    return { results: [], captcha: false };
  }

  // 反爬检测
  const lower = html.toLowerCase();
  const captcha = CAPTCHA_MARKERS.some((m) => lower.includes(m));
  if (captcha) {
    return { results: [], captcha: true };
  }

  const results = [];

  // 使用状态机扫描定位每个 class="result" 区块
  let cursor = 0;
  while (cursor < html.length && results.length < maxResults) {
    // 查找下一个 result 区块起点
    const startMatch = html.slice(cursor).match(/<div[^>]*class="result[^"]*"[^>]*>/i);
    if (!startMatch) break;

    const start = cursor + startMatch.index + startMatch[0].length;

    // 找匹配的结束标签（简单计数 div 开闭）
    let depth = 1;
    let pos = start;
    while (depth > 0 && pos < html.length) {
      const openIdx = html.indexOf('<div', pos);
      const closeIdx = html.indexOf('</div>', pos);

      if (closeIdx === -1) break; // 没有闭合标签

      if (openIdx !== -1 && openIdx < closeIdx) {
        // 遇到开标签
        depth++;
        pos = openIdx + 4;
      } else {
        // 遇到闭标签
        depth--;
        pos = closeIdx + 6;
      }
    }

    const end = pos;
    const segment = html.slice(start, end - 6); // 去掉最后的 </div>
    cursor = end;
    if (results.length >= maxResults) break;

    // 提取标题和链接
    const titleMatch = segment.match(DDG_SELECTORS.titleLink);
    if (!titleMatch) continue;

    let url = titleMatch[1];
    const rawTitle = titleMatch[2];

    // 跳过 DuckDuckGo 内部链接
    if (url.includes('duckduckgo.com') || url.startsWith('javascript:')) {
      continue;
    }

    // 处理重定向链接
    if (url.startsWith('/l/')) {
      // 解码 DuckDuckGo 重定向
      const redirectMatch = url.match(/[?&]uddg=([^&]+)/);
      if (redirectMatch) {
        try {
          url = decodeURIComponent(redirectMatch[1]);
        } catch {
          continue;
        }
      }
    }

    const title = stripHtml(rawTitle);
    if (!title || !url) continue;

    // 提取摘要
    const snippetMatch = segment.match(DDG_SELECTORS.snippetBlock);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : '';

    results.push({
      title: title.trim(),
      url: url.trim(),
      snippet: snippet.trim(),
      source: 'duckduckgo',
      position: results.length + 1,
    });
  }

  return { results, captcha: false };
}

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
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent':
        config.userAgent ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Origin: 'https://html.duckduckgo.com',
      Referer: 'https://html.duckduckgo.com/',
    },
    body: '', // 由调用方设置
    signal: controller.signal,
    redirect: 'follow',
  };

  // Proxy 支持
  if (config.proxy?.https) {
    try {
      fetchOptions.dispatcher = new HttpsProxyAgent(config.proxy.https);
    } catch (err) {
      logger?.debug?.('DuckDuckGo 构造 proxy dispatcher 失败', { error: err.message });
    }
  }

  return { fetchOptions, controller, timer };
}

/**
 * 带重试的 fetch 封装
 * @param {string} url
 * @param {string} body
 * @param {object} config
 * @param {object} logger
 * @returns {Promise<object>}
 */
async function fetchWithRetry(url, body, config, logger) {
  const maxAttempts = 2;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { fetchOptions, timer } = buildFetchOptions(config, logger);
    fetchOptions.body = body;

    logger?.debug?.('DuckDuckGo fetch', {
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
        const responseBody = await response.text();
        return { ok: true, status: response.status, body: responseBody };
      }

      // 5xx 重试
      if (RETRYABLE_HTTP_STATUS.has(response.status) && attempt < maxAttempts) {
        logger?.debug?.('DuckDuckGo 5xx，准备重试', { status: response.status, attempt });
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
        logger?.debug?.('DuckDuckGo 网络错误，准备重试', { code: err.code, attempt });
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
 * 搜索 DuckDuckGo
 * @param {string} query
 * @param {object} config
 * @param {object} logger
 * @returns {Promise<object>}
 */
async function searchDuckDuckGo(query, config = {}, logger) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return { error: 'query 参数必填' };
  }

  if (config.enabled === false) {
    return { error: 'DuckDuckGo 搜索未启用' };
  }

  const trimmed = query.trim();
  const maxResults = config.maxResults || 8;
  const endpoint = config.endpoint || 'https://html.duckduckgo.com/html/';

  // 构建 POST body
  let body;
  try {
    const params = new URLSearchParams();
    params.append('q', trimmed);
    params.append('kl', 'us-en'); // 语言区域
    body = params.toString();
  } catch (err) {
    return { error: `构建请求参数失败: ${err.message}` };
  }

  const fetchResult = await fetchWithRetry(endpoint, body, config, logger);

  if (!fetchResult.ok) {
    if (fetchResult.kind === 'timeout') {
      return { error: `搜索超时 (${config.timeout || 15000}ms)` };
    }
    if (fetchResult.kind === 'network') {
      return { error: `无法连接到 DuckDuckGo (${fetchResult.code || 'UNKNOWN'})` };
    }
    if (fetchResult.kind === 'http_5xx') {
      return { error: `DuckDuckGo 服务异常 ${fetchResult.status}` };
    }
    return { error: `DuckDuckGo 返回 ${fetchResult.status}` };
  }

  const { results, captcha } = parseDuckDuckGoHTML(fetchResult.body, maxResults);

  if (captcha) {
    logger?.warn?.('DuckDuckGo 触发反爬验证');
    return { error: 'DuckDuckGo 触发反爬验证，请稍后重试' };
  }

  if (results.length === 0) {
    logger?.debug?.('DuckDuckGo 解析 0 结果', {
      htmlLength: fetchResult.body?.length || 0,
      htmlHead: (fetchResult.body || '').slice(0, 200),
    });
    return { error: 'DuckDuckGo 页面结构变化，解析失败' };
  }

  return {
    success: true,
    query: trimmed,
    provider: 'duckduckgo',
    totalResults: results.length,
    results,
  };
}

module.exports = {
  searchDuckDuckGo,
  parseDuckDuckGoHTML,
  stripHtml,
};

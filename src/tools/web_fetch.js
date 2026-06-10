'use strict';

/**
 * web_fetch 工具注册 - 获取指定 URL 的网页内容
 */

const { extractContent } = require('../core/web_search/content_extractor');
const HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;

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
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
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
      logger?.debug?.('web_fetch 构造 proxy dispatcher 失败', { error: err.message });
    }
  }

  return { fetchOptions, controller, timer };
}

/**
 * 获取网页内容
 * @param {string} url
 * @param {object} config
 * @param {object} logger
 * @returns {Promise<object>}
 */
async function fetchWebPage(url, config = {}, logger) {
  if (!url || typeof url !== 'string' || !url.trim()) {
    return { error: 'url 参数必填' };
  }

  const trimmed = url.trim();

  // 验证 URL 格式
  let parsedUrl;
  try {
    parsedUrl = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return { error: '仅支持 HTTP 和 HTTPS 协议' };
    }
  } catch {
    return { error: '无效的 URL 格式' };
  }

  const { fetchOptions, timer } = buildFetchOptions(config, logger);

  logger?.debug?.('web_fetch 请求', { url: trimmed, timeout: config.timeout });

  try {
    const response = await globalThis.fetch(trimmed, fetchOptions);
    clearTimeout(timer);

    if (!response.ok) {
      return { error: `HTTP 错误: ${response.status} ${response.statusText}` };
    }

    // 检查 Content-Type
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      logger?.debug?.('web_fetch 非 HTML 内容', { contentType });
      // 仍然尝试获取，但标记一下
    }

    const html = await response.text();

    logger?.debug?.('web_fetch 成功', {
      url: trimmed,
      htmlLength: html.length,
      contentType,
    });

    // 提取内容
    const extractResult = extractContent(html, config.extractType || 'article', config.maxLength);

    if (extractResult.error) {
      return { error: extractResult.error };
    }

    return {
      success: true,
      url: trimmed,
      title: extractTitle(html),
      ...extractResult,
    };
  } catch (err) {
    clearTimeout(timer);

    if (err.name === 'AbortError') {
      return { error: `请求超时 (${config.timeout || 15000}ms)` };
    }

    logger?.error?.('web_fetch 异常', { url: trimmed, error: err.message });
    return { error: `获取页面失败: ${err.message}` };
  }
}

/**
 * 从 HTML 中提取标题
 * @param {string} html
 * @returns {string|null}
 */
function extractTitle(html) {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? match[1].trim() : null;
}

/**
 * 注册 web_fetch 工具
 * @param {object} registry - ToolRegistry 实例
 * @param {object} config - 配置对象
 */
function registerWebFetchTool(registry, config) {
  const baseConfig = (config && config.webSearch) || {};

  registry.register({
    name: 'web_fetch',
    description:
      '获取指定 URL 的网页内容并提取正文。用于深入阅读搜索结果中的网页，或分析用户提供的 URL。支持文章模式（智能提取正文）、纯文本模式（全部文本）、HTML模式（清理后的HTML）。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要获取的网页 URL，必须是以 http:// 或 https:// 开头的完整地址',
        },
        extractType: {
          type: 'string',
          description: '内容提取模式：article（智能提取文章正文，默认）、text（全部纯文本）、html（清理后的HTML）',
          enum: ['article', 'text', 'html'],
          default: 'article',
        },
        maxLength: {
          type: 'number',
          description: '最大返回字符数，默认 8000，最大 50000',
          minimum: 100,
          maximum: 50000,
          default: 8000,
        },
      },
      required: ['url'],
    },
    requiresConfirm: false,
    execute: async (params, context) => {
      const { url, extractType, maxLength } = params || {};
      const logger = context && context.logger;

      // 构建配置
      const cfg = {
        ...baseConfig,
        extractType: extractType || 'article',
        maxLength: maxLength || 8000,
        timeout: baseConfig.timeout || 15000,
      };

      try {
        return await fetchWebPage(url, cfg, logger);
      } catch (err) {
        logger?.error?.('web_fetch 异常', err.message);
        return { error: `web_fetch 内部错误: ${err.message}` };
      }
    },
  });
}

module.exports = { registerWebFetchTool };

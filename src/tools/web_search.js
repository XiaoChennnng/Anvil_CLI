'use strict';

// web_search 工具注册，业务逻辑在 core/web_search/index.js

const { search } = require('../core/web_search');

function registerWebSearchTool(registry, config) {
  // 闭包捕获 config
  const baseConfig = (config && config.webSearch) || {};

  registry.register({
    name: 'web_search',
    description: '联网搜索公开信息（新闻、文档、库版本、官方说明等）。当你不知道某个事实、不知道最新版本号、需要查官方文档、或用户问"最新/目前/2026"等时效性话题时调用；不要用于查项目本地代码（用 search_in_files）。支持多搜索引擎自动降级。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词，2-5 个关键词组合，英文技术词比中文精确。',
        },
        maxResults: {
          type: 'number',
          description: '返回结果数量，1-20，默认 8。',
          minimum: 1,
          maximum: 20,
        },
        timeRange: {
          type: 'string',
          description: '时间范围过滤，可选：day(一天内)/week(一周内)/month(一月内)/year(一年内)',
          enum: ['day', 'week', 'month', 'year'],
        },
        siteFilter: {
          type: 'string',
          description: '站点过滤，如 github.com、stackoverflow.com',
        },
        engine: {
          type: 'string',
          description: '搜索引擎，默认 auto 自动选择',
          enum: ['auto', 'bing', 'duckduckgo', 'searxng'],
          default: 'auto',
        },
      },
      required: ['query'],
    },
    requiresConfirm: false,
    execute: async (params, context) => {
      const { query, maxResults, timeRange, siteFilter, engine } = params || {};
      const logger = context && context.logger;

      try {
        return await search(query, {
          maxResults,
          timeRange,
          siteFilter,
          engine,
        }, {
          config: { webSearch: baseConfig },
          logger,
        });
      } catch (err) {
        logger?.error?.('web_search 异常', err.message);
        return { error: `web_search 内部错误: ${err.message}` };
      }
    },
  });
}

module.exports = { registerWebSearchTool };

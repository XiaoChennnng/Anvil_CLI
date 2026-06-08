'use strict';

// web_search 工具注册，业务逻辑在 core/web_search.js

const { searchBing } = require('../core/web_search');

function registerWebSearchTool(registry, config) {
  // 闭包捕获 config
  const baseConfig = (config && config.webSearch) || {};

  registry.register({
    name: 'web_search',
    description: '联网搜索公开信息（新闻、文档、库版本、官方说明等）。当你不知道某个事实、不知道最新版本号、需要查官方文档、或用户问"最新/目前/2026"等时效性话题时调用；不要用于查项目本地代码（用 search_in_files）。',
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
      },
      required: ['query'],
    },
    requiresConfirm: false,
    execute: async (params, context) => {
      const { query, maxResults } = params || {};
      const logger = context && context.logger;

      // 浅拷贝避免累积覆盖
      const cfg = { ...baseConfig };
      if (typeof maxResults === 'number' && maxResults > 0 && maxResults <= 20) {
        cfg.maxResults = maxResults;
      }

      try {
        return await searchBing(query, cfg, logger);
      } catch (err) {
        logger?.error?.('web_search 异常', err.message);
        return { error: `web_search 内部错误: ${err.message}` };
      }
    },
  });
}

module.exports = { registerWebSearchTool };

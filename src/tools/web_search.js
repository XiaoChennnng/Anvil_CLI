'use strict';

/**
 * web_search 工具注册
 *
 * 薄壳：只负责 schema 和 execute 入口，业务逻辑全在 core/web_search.js。
 * 错误处理统一 return { error }，不 throw。
 *
 * 注意：context 字段不包含 config（见 core/chat.js:702-723），
 * 所以 config 通过 registerXxxTool(registry, config) 闭包注入。
 */

const { searchBing } = require('../core/web_search');

function registerWebSearchTool(registry, config) {
  // 闭包捕获 config，避免每个工具调用重新读
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

      // 浅拷贝：避免 AI 多次调用时累积 maxResults 覆盖
      const cfg = { ...baseConfig };
      // 允许工具调用方临时覆盖 maxResults（AI 可以每次搜更多/更少）
      if (typeof maxResults === 'number' && maxResults > 0 && maxResults <= 20) {
        cfg.maxResults = maxResults;
      }

      try {
        return await searchBing(query, cfg, logger);
      } catch (err) {
        // 兜底：core 已经 return error，正常不该走到这里
        logger?.error?.('web_search 异常', err.message);
        return { error: `web_search 内部错误: ${err.message}` };
      }
    },
  });
}

module.exports = { registerWebSearchTool };

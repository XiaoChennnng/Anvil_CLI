'use strict';

function registerContextTools(toolRegistry, chatEngine, logger) {

  toolRegistry.register({
    name: 'compact_context',
    description: '压缩对话上下文以释放 token 空间。可指定保留特定信息（如文件、项目结构、最近对话、工具调用等），避免丢失重要内容。当上下文使用率较高或用户要求压缩时调用。',
    parameters: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          enum: ['auto', 'light', 'medium', 'heavy'],
          description: '压缩程度。auto=自动检测(默认)，light=轻度(清理低频文件)，medium=中度(压缩早期对话)，heavy=深度(只保留最近4轮)',
        },
        keep: {
          type: 'array',
          items: { type: 'string', enum: ['files', 'project', 'recent', 'tools', 'decisions', 'all'] },
          description: '要保留的方面：files(注入的文件缓存), project(项目目录结构), recent(最近对话轮次), tools(工具调用历史), decisions(文件写入/删除等关键操作)。默认保留 recent 和 decisions',
        },
      },
    },
    requiresConfirm: true,

    execute: async (params) => {
      const level = params.level || 'auto';
      const keep = params.keep || ['recent', 'decisions'];

      if (!chatEngine || !chatEngine.contextManager) {
        return { error: '对话引擎未初始化，无法压缩上下文' };
      }

      try {
        const result = chatEngine.compactContext({ level, keep });

        if (!result || !result.stats) {
          return { error: '压缩失败' };
        }

        const stats = result.stats;

        return {
          success: true,
          level: stats.name || level,
          beforeTokens: stats.beforeTokens,
          afterTokens: stats.afterTokens,
          savedTokens: stats.savedTokens,
          savedPercent: stats.savedPercent,
          preserved: stats.preserved,
          message: stats.message || '',
          summary: `上下文已压缩 (${stats.name || level}): ${stats.beforeTokens.toLocaleString()} → ${stats.afterTokens.toLocaleString()} tokens, 节省 ${stats.savedPercent}%`,
        };
      } catch (err) {
        if (logger) {logger.error('[compact] 压缩失败', err.message);}
        return { error: `上下文压缩失败: ${err.message}` };
      }
    },
  });
}

module.exports = { registerContextTools };

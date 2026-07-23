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
          enum: ['auto', 'light', 'medium', 'heavy', 'semantic'],
          description: '压缩程度。所有级别均走语义压缩，仅预算不同：light=50k(保留更多细节), medium=30k(默认), heavy=15k, critical=10k, auto=30k。压缩后自动停止，不会继续 AI 输出。',
        },
        budgetTokens: {
          type: 'number',
          minimum: 10000,
          maximum: 50000,
          default: null,
          description: '语义压缩预算 tokens（覆盖 level 映射的默认预算）。硬性约束 1w-5w tokens。',
        },
      },
    },
    requiresConfirm: true,

    execute: async (params) => {
      const level = params.level || 'auto';

      if (!chatEngine || !chatEngine.contextManager) {
        return { error: '对话引擎未初始化，无法压缩上下文' };
      }

      try {
        const result = await chatEngine.compactContext({
          level,
          budgetTokens: params.budgetTokens || undefined,
        });

        if (!result || !result.stats) {
          return { error: '压缩失败' };
        }

        const stats = result.stats;

        return {
          success: true,
          level: stats.name || 'SEMANTIC_BUDGET',
          beforeTokens: stats.beforeTokens,
          afterTokens: stats.afterTokens,
          budget: stats.budget,
          savedPercent: stats.savedPercent,
          fallback: stats.fallback || null,
          message: stats.message || '',
          summary: `✓ 语义压缩: ${stats.beforeTokens?.toLocaleString() || '?'} → ${stats.afterTokens?.toLocaleString() || '?'} tokens (预算 ${stats.budget?.toLocaleString() || '?'}, 节省 ${stats.savedPercent || 0}%)`,
        };
      } catch (err) {
        if (logger) {logger.error('[compact] 压缩失败', err.message);}
        return { error: `上下文压缩失败: ${err.message}` };
      }
    },
  });
}

module.exports = { registerContextTools };

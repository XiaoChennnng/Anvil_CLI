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
          description: '压缩程度。auto=自动检测(默认)，light=轻度(清理低频文件)，medium=中度(压缩早期对话)，heavy=深度(只保留最近4轮)，semantic=语义预算压缩(调 LLM 生成结构化摘要，硬性约束到 1w-5w tokens)',
        },
        keep: {
          type: 'array',
          items: { type: 'string', enum: ['files', 'project', 'recent', 'tools', 'decisions', 'all'] },
          description: '要保留的方面：files(注入的文件缓存), project(项目目录结构), recent(最近对话轮次), tools(工具调用历史), decisions(文件写入/删除等关键操作)。默认保留 recent 和 decisions',
        },
        budgetTokens: {
          type: 'number',
          minimum: 10000,
          maximum: 50000,
          default: 30000,
          description: '【仅 level=semantic】压缩后总 tokens 预算。硬性约束 1w-5w tokens，超出范围自动 clamp。语义压缩的核心参数。',
        },
        force: {
          type: 'boolean',
          default: true,
          description: '【仅 level=semantic】是否无视当前使用率强制压缩。true=立即压缩，false=低使用率时跳过',
        },
        rebuild: {
          type: 'boolean',
          default: true,
          description: '【仅 level=semantic】压缩后是否重新注入 L0+L1+L2+L3 完整 System Prompt。true=清空脑子重新开始，false=只压缩不重注',
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
        // 语义压缩模式：走新分支，调 LLM 生成摘要 + 完整重注
        if (level === 'semantic') {
          const result = await chatEngine.compactContext({
            level: 'semantic',
            keep,
            budgetTokens: params.budgetTokens,
            force: params.force !== false,
            rebuild: params.rebuild !== false,
          });

          if (!result || !result.stats) {
            return { error: '语义压缩失败' };
          }

          const stats = result.stats;
          return {
            success: true,
            level: 'semantic',
            mode: 'SEMANTIC_BUDGET',
            beforeTokens: stats.beforeTokens,
            afterTokens: stats.afterTokens,
            budget: stats.budget,
            savedPercent: stats.savedPercent,
            rebuilt: stats.rebuilt,
            fallback: stats.fallback || null,
            message: stats.message || '',
            summary: `[完成] 语义压缩完成: ${stats.beforeTokens.toLocaleString()} → ${stats.afterTokens.toLocaleString()} tokens (预算 ${stats.budget.toLocaleString()}, 节省 ${stats.savedPercent}%)${stats.rebuilt ? ' + System Prompt 已重建' : ''}`,
          };
        }

        // 普通压缩模式
        const result = await chatEngine.compactContext({ level, keep });

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

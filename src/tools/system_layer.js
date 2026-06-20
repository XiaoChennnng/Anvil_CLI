'use strict';

const { PromptLayer, L3Granularity, LAYER_CONTENT_MAP, getLayerContent } = require('../ai/prompts');

function registerSystemLayerTools(toolRegistry, chatEngine) {
  toolRegistry.register({
    name: 'get_system_layer',
    description: '按需加载 Prompt 分层到 system 消息。默认仅 L0 已加载；L1(行为准则)/L2(工作流)/L3(工具策略)/L4(Plan)/L5(Team) 都需要通过本工具按需加载。L3 内部两种粒度：required=精简必知约束(~700 tokens)，detail=详细全量策略(~4500 tokens)，默认 detail。action=load 注入到 system 消息；action=list 查看已加载的层；action=peek 预览层内容（不注入）。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['load', 'list', 'peek'],
          default: 'load',
          description: 'load=注入到 system 消息；list=查看已加载的层；peek=预览层内容（不注入）',
        },
        layer: {
          type: 'string',
          enum: Object.values(PromptLayer),
          description: '要加载/查看的层。load 和 peek 操作必填；list 操作不需要',
        },
        granularity: {
          type: 'string',
          enum: Object.values(L3Granularity),
          default: L3Granularity.DETAIL,
          description: '【仅 layer=L3 生效】required=精简必知约束（~700 tokens）；detail=详细全量策略（~4500 tokens）。默认 detail',
        },
      },
      required: ['action'],
    },

    execute: async (params) => {
      const { action = 'load', layer, granularity = L3Granularity.DETAIL } = params;

      // list：查看已加载的层
      if (action === 'list') {
        const loaded = chatEngine?.listLoadedLayers
          ? chatEngine.listLoadedLayers()
          : [PromptLayer.L0];
        return {
          success: true,
          action: 'list',
          loaded,
          available: Object.values(PromptLayer),
        };
      }

      // load/peek：必须有 layer
      if (!layer) {
        return { success: false, error: 'load/peek 操作必须指定 layer 参数' };
      }
      if (!LAYER_CONTENT_MAP[layer]) {
        return {
          success: false,
          error: `未知层级: ${layer}。可用层: ${Object.values(PromptLayer).join(', ')}`,
        };
      }

      // 解析实际内容（L3 嵌套结构）
      const content = getLayerContent(layer, granularity);
      if (!content) {
        return { success: false, error: `无法获取 ${layer} 内容` };
      }

      // peek：只返回内容不注入
      if (action === 'peek') {
        return {
          success: true,
          action: 'peek',
          layer,
          granularity: layer === PromptLayer.L3 ? granularity : null,
          tokens: Math.round(content.length / 1.5),
          content,
        };
      }

      // load：注入到 system 消息
      if (!chatEngine || typeof chatEngine.injectPromptLayer !== 'function') {
        return { success: false, error: '对话引擎未初始化，无法注入 prompt 层' };
      }
      const result = chatEngine.injectPromptLayer(layer, granularity);
      const layerTag = layer === PromptLayer.L3 ? `${layer} (${granularity})` : layer;
      return {
        ...result,
        action: 'load',
        layer,
        granularity: layer === PromptLayer.L3 ? granularity : null,
        tokens: Math.round(content.length / 1.5),
        message: result.action === 'already_loaded'
          ? `${layerTag} 已经加载到 system 消息，无需重复注入`
          : `${layerTag} 已注入到 system 消息（~${Math.round(content.length / 1.5)} tokens）`,
      };
    },
  });
}

module.exports = { registerSystemLayerTools };

'use strict';

const MODELS = {
  'deepseek-v4-flash': {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    description: '日常开发，快速生成',
    params: '284B / 13B (总/激活)',
    contextWindow: 1_000_000,
    maxOutput: 384_000,
    pricing: { input: 0.001, output: 0.002 },
    recommendedFor: ['日常开发', '快速生成', '简单任务'],
    thinkingMode: true,
  },
  'deepseek-v4-pro': {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    description: '复杂推理，深度分析',
    params: '1.6T / 49B (总/激活)',
    contextWindow: 1_000_000,
    maxOutput: 384_000,
    pricing: { input: 0.003, output: 0.006 },
    recommendedFor: ['复杂推理', '深度分析', '代码审查', '重构'],
    thinkingMode: true,
  },
};

function getModelList() {
  return Object.keys(MODELS);
}

function getModel(modelId) {
  return MODELS[modelId] || null;
}

function isValidModel(modelId) {
  return !!MODELS[modelId];
}

function getDefaultModel() {
  return 'deepseek-v4-flash';
}

module.exports = { MODELS, getModelList, getModel, isValidModel, getDefaultModel };

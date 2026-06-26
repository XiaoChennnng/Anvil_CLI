'use strict';

const { PROVIDERS, getProvider, isValidProvider, getCustomModel } = require('./providers');

// 聚合所有内置提供商的模型(模块内部使用,不对外暴露)
const MODELS = {};
for (const provider of Object.values(PROVIDERS)) {
  for (const [modelId, model] of Object.entries(provider.models)) {
    MODELS[modelId] = {
      ...model,
      provider: provider.id,
    };
  }
}

/**
 * 获取模型配置
 * @param {string} modelId - 模型 ID
 * @returns {Object|null} 模型配置（包含 provider 字段）
 */
function getModel(modelId) {
  // 先检查内置模型
  if (MODELS[modelId]) {
    return MODELS[modelId];
  }
  // 再检查自定义模型
  return getCustomModel(modelId);
}

/**
 * 检查模型是否有效
 * @param {string} modelId - 模型 ID
 * @returns {boolean}
 */
function isValidModel(modelId) {
  return !!MODELS[modelId] || !!getCustomModel(modelId);
}

/**
 * 获取模型的提供商 ID
 * @param {string} modelId - 模型 ID
 * @returns {string|null} 提供商 ID
 */
function getModelProvider(modelId) {
  const model = getModel(modelId);
  return model?.provider || null;
}

module.exports = {
  getModel,
  isValidModel,
  getModelProvider,
  getProvider,
  isValidProvider,
};

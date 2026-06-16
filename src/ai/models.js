'use strict';

const { PROVIDERS, getProvider, isValidProvider, getModel: _getProviderModel, isValidModel: _isValidProviderModel, getCustomModel, CUSTOM_MODELS } = require('./providers');

/**
 * 所有可用模型（向后兼容）n * 从 providers.js 聚合所有提供商的模型
 */
const MODELS = {};

// 聚合所有内置提供商的模型
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

/**
 * 获取所有模型列表（可选按提供商过滤）
 * @param {string} [providerId] - 可选的提供商 ID 过滤
 * @returns {Array} 模型列表
 */
function getAllModels(providerId) {
  const result = [];

  // 添加内置模型
  for (const [modelId, model] of Object.entries(MODELS)) {
    if (!providerId || model.provider === providerId) {
      result.push(model);
    }
  }

  // 添加自定义模型
  for (const [modelId, model] of CUSTOM_MODELS.entries()) {
    if (!providerId || model.provider === providerId) {
      result.push(model);
    }
  }

  return result;
}

module.exports = {
  MODELS,
  getModel,
  isValidModel,
  getModelProvider,
  getAllModels,
  // 从 providers 导出以便统一访问
  getProvider,
  isValidProvider,
};

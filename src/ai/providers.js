'use strict';

/**
 * AI 提供商配置
 * 支持多提供商切换：DeepSeek、Kimi 等
 */

/**
 * 自定义模型配置存储
 * 允许用户动态添加模型配置
 */
const CUSTOM_MODELS = new Map();
const CUSTOM_PROVIDERS = new Map();

/**
 * 注册自定义提供商配置
 * @param {Object} config - 自定义配置
 * @param {string} config.id - 提供商唯一标识
 * @param {string} config.name - 提供商名称
 * @param {string} config.baseURL - API 基础 URL
 * @param {string} config.apiKey - API Key（直接传入，非环境变量）
 * @param {string} config.format - API 格式: 'openai' | 'anthropic'
 * @param {boolean} [config.thinkingMode] - 是否支持思考模式
 * @param {string} [config.defaultModel] - 默认模型 ID
 */
function registerCustomProvider(config) {
  if (!config.id || !config.baseURL) {
    throw new Error('自定义提供商必须包含 id 和 baseURL');
  }

  const providerConfig = {
    id: config.id,
    name: config.name || config.id,
    description: config.description || '自定义提供商',
    baseURL: config.baseURL,
    apiKey: config.apiKey, // 直接存储 API Key
    apiKeyEnv: null, // 不使用环境变量
    thinkingMode: config.thinkingMode !== undefined ? config.thinkingMode : false,
    format: config.format || 'openai', // 'openai' 或 'anthropic'
    requestFormat: {
      thinkingType: config.thinkingMode ? 'reasoning_effort' : 'none',
    },
    defaultModel: config.defaultModel || 'custom-model',
    models: {},
    isCustom: true,
  };

  CUSTOM_PROVIDERS.set(config.id, providerConfig);
  return providerConfig;
}

/**
 * 注册自定义模型
 * @param {Object} config - 模型配置
 * @param {string} config.id - 模型唯一标识
 * @param {string} config.provider - 所属提供商 ID（可以是自定义提供商）
 * @param {string} [config.name] - 模型显示名称
 * @param {string} [config.description] - 模型描述
 * @param {number} [config.contextWindow] - 上下文窗口大小
 * @param {number} [config.maxOutput] - 最大输出 tokens
 * @param {boolean} [config.vision] - 是否支持多模态（图片）
 * @param {boolean} [config.thinkingMode] - 是否支持思考模式
 * @param {Object} [config.pricing] - 定价配置
 */
function registerCustomModel(config) {
  if (!config.id || !config.provider) {
    throw new Error('自定义模型必须包含 id 和 provider');
  }

  const modelConfig = {
    id: config.id,
    name: config.name || config.id,
    description: config.description || '自定义模型',
    contextWindow: config.contextWindow || 128_000,
    maxOutput: config.maxOutput || 4_096,
    vision: config.vision || false,
    thinkingMode: config.thinkingMode || false,
    pricing: config.pricing || { input: 0, output: 0 },
    recommendedFor: config.recommendedFor || ['自定义'],
    isCustom: true,
  };

  // 如果是自定义提供商，添加到其 models 中
  const customProvider = CUSTOM_PROVIDERS.get(config.provider);
  if (customProvider) {
    customProvider.models[config.id] = modelConfig;
  }

  CUSTOM_MODELS.set(config.id, {
    ...modelConfig,
    provider: config.provider,
  });

  return modelConfig;
}

/**
 * 获取自定义提供商
 * @param {string} providerId - 提供商 ID
 * @returns {Object|null}
 */
function getCustomProvider(providerId) {
  return CUSTOM_PROVIDERS.get(providerId) || null;
}

/**
 * 获取自定义模型
 * @param {string} modelId - 模型 ID
 * @returns {Object|null}
 */
function getCustomModel(modelId) {
  return CUSTOM_MODELS.get(modelId) || null;
}

/**
 * 列出所有自定义提供商
 * @returns {Array}
 */
function listCustomProviders() {
  return Array.from(CUSTOM_PROVIDERS.values()).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    baseURL: p.baseURL,
    format: p.format,
    thinkingMode: p.thinkingMode,
    defaultModel: p.defaultModel,
  }));
}

/**
 * 列出所有自定义模型
 * @returns {Array}
 */
function listCustomModels() {
  return Array.from(CUSTOM_MODELS.values()).map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    description: m.description,
    vision: m.vision,
    thinkingMode: m.thinkingMode,
  }));
}

/**
 * 移除自定义提供商
 * @param {string} providerId - 提供商 ID
 */
function removeCustomProvider(providerId) {
  // 先移除该提供商下的所有模型
  const modelsToRemove = [];
  for (const [modelId, model] of CUSTOM_MODELS.entries()) {
    if (model.provider === providerId) {
      modelsToRemove.push(modelId);
    }
  }
  for (const modelId of modelsToRemove) {
    CUSTOM_MODELS.delete(modelId);
  }
  CUSTOM_PROVIDERS.delete(providerId);
}

/**
 * 移除自定义模型
 * @param {string} modelId - 模型 ID
 */
function removeCustomModel(modelId) {
  const model = CUSTOM_MODELS.get(modelId);
  if (model) {
    // 从自定义提供商的 models 中也移除
    const provider = CUSTOM_PROVIDERS.get(model.provider);
    if (provider && provider.models[modelId]) {
      delete provider.models[modelId];
    }
    CUSTOM_MODELS.delete(modelId);
  }
}

const PROVIDERS = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    // DeepSeek 支持思考模式
    thinkingMode: true,
    // 请求格式配置
    requestFormat: {
      // 使用 reasoning_effort + extra_body.thinking
      thinkingType: 'reasoning_effort',
    },
    // 默认模型
    defaultModel: 'deepseek-v4-flash',
    // 模型列表
    models: {
      'deepseek-v4-flash': {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
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
        params: '1.6T / 49B (总/激活)',
        contextWindow: 1_000_000,
        maxOutput: 384_000,
        pricing: { input: 0.003, output: 0.006 },
        recommendedFor: ['复杂推理', '深度分析', '代码审查', '重构'],
        thinkingMode: true,
      },
    },
  },

  openai: {
    id: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    // OpenAI o1/o3 系列支持思考模式
    thinkingMode: true,
    // 请求格式配置
    requestFormat: {
      // OpenAI 原生 Chat Completions 格式
      thinkingType: 'reasoning_effort',
    },
    // 默认模型 - 用户需要自行添加
    defaultModel: null,
    // 模型列表 - 空，由用户自己添加
    models: {},
  },

  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    // Claude 3.7 Sonnet 支持扩展思考模式
    thinkingMode: true,
    // 请求格式配置
    requestFormat: {
      // Anthropic Messages API 格式，思考模式用 thinking 块
      thinkingType: 'thinking_block',
    },
    // 默认模型 - 用户需要自行添加
    defaultModel: null,
    // 模型列表 - 空，由用户自己添加
    models: {},
  },

  kimi: {
    id: 'kimi',
    name: 'Kimi',
    baseURL: 'https://api.moonshot.cn/v1',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    // Kimi K2.x 系列支持思考模式
    thinkingMode: true,
    // 请求格式配置
    requestFormat: {
      // Kimi 使用原生思考模式参数
      thinkingType: 'enabled',
    },
    // 默认模型
    defaultModel: 'kimi-k2.5',
    // 模型列表
    models: {
      // Kimi K2.5 系列 (推荐)
      'kimi-k2.5': {
        id: 'kimi-k2.5',
        name: 'Kimi K2.5',
        contextWindow: 262_144,
        maxOutput: 131_072,
        // 定价：缓存未命中 ¥4/1M tokens = ¥0.004/千tokens，输出 ¥21/1M = ¥0.021/千tokens
        pricing: { input: 0.004, cachedInput: 0.0007, output: 0.021 },
        recommendedFor: ['日常开发', '代码生成', '多模态任务', '长上下文'],
        thinkingMode: true,
        vision: true,
      },
      // Kimi K2.6 系列
      'kimi-k2.6': {
        id: 'kimi-k2.6',
        name: 'Kimi K2.6',
        contextWindow: 262_144,
        maxOutput: 131_072,
        // 定价：缓存未命中 ¥6.5/1M = ¥0.0065/千tokens，输出 ¥27/1M = ¥0.027/千tokens
        pricing: { input: 0.0065, cachedInput: 0.0011, output: 0.027 },
        recommendedFor: ['复杂推理', '深度分析', '代码审查', '长程任务'],
        thinkingMode: true,
        vision: true,
      },
      // Kimi K2.7 Code 系列
      'kimi-k2.7-code': {
        id: 'kimi-k2.7-code',
        name: 'Kimi K2.7 Code',
        contextWindow: 262_144,
        maxOutput: 131_072,
        // 定价：缓存未命中 ¥6.5/1M = ¥0.0065/千tokens，输出 ¥27/1M = ¥0.027/千tokens
        pricing: { input: 0.0065, cachedInput: 0.0013, output: 0.027 },
        recommendedFor: ['复杂编程', '代码重构', '架构设计', '深度代码分析'],
        thinkingMode: true,
        vision: true,
      },
      'kimi-k2.7-code-highspeed': {
        id: 'kimi-k2.7-code-highspeed',
        name: 'Kimi K2.7 Code HighSpeed',
        contextWindow: 262_144,
        maxOutput: 131_072,
        // 定价：缓存未命中 ¥13/1M = ¥0.013/千tokens，输出 ¥54/1M = ¥0.054/千tokens
        pricing: { input: 0.013, cachedInput: 0.0026, output: 0.054 },
        recommendedFor: ['快速编程', '实时编码', '快速原型'],
        thinkingMode: true,
        vision: true,
      },
      // Moonshot V1 系列 (经典)
      'moonshot-v1-8k': {
        id: 'moonshot-v1-8k',
        name: 'Kimi V1 8K',
        contextWindow: 8_192,
        maxOutput: 8_192,
        // 定价：输入 ¥2/1M = ¥0.002/千tokens，输出 ¥10/1M = ¥0.01/千tokens
        pricing: { input: 0.002, output: 0.01 },
        recommendedFor: ['简单问答', '短文本生成', '快速任务'],
        thinkingMode: false,
      },
      'moonshot-v1-32k': {
        id: 'moonshot-v1-32k',
        name: 'Kimi V1 32K',
        contextWindow: 32_768,
        maxOutput: 32_768,
        // 定价：输入 ¥5/1M = ¥0.005/千tokens，输出 ¥20/1M = ¥0.02/千tokens
        pricing: { input: 0.005, output: 0.02 },
        recommendedFor: ['日常开发', '代码生成', '中等长度文本'],
        thinkingMode: false,
      },
      'moonshot-v1-128k': {
        id: 'moonshot-v1-128k',
        name: 'Kimi V1 128K',
        contextWindow: 131_072,
        maxOutput: 131_072,
        // 定价：输入 ¥10/1M = ¥0.01/千tokens，输出 ¥30/1M = ¥0.03/千tokens
        pricing: { input: 0.01, output: 0.03 },
        recommendedFor: ['长文档分析', '大规模代码审查', '长上下文任务'],
        thinkingMode: false,
      },
      // Moonshot V1 Vision 系列
      'moonshot-v1-8k-vision-preview': {
        id: 'moonshot-v1-8k-vision-preview',
        name: 'Kimi V1 8K Vision',
        contextWindow: 8_192,
        maxOutput: 8_192,
        pricing: { input: 0.002, output: 0.01 },
        recommendedFor: ['图像理解', '简单多模态任务'],
        thinkingMode: false,
        vision: true,
      },
      'moonshot-v1-32k-vision-preview': {
        id: 'moonshot-v1-32k-vision-preview',
        name: 'Kimi V1 32K Vision',
        contextWindow: 32_768,
        maxOutput: 32_768,
        pricing: { input: 0.005, output: 0.02 },
        recommendedFor: ['图像分析', '多模态开发任务'],
        thinkingMode: false,
        vision: true,
      },
      'moonshot-v1-128k-vision-preview': {
        id: 'moonshot-v1-128k-vision-preview',
        name: 'Kimi V1 128K Vision',
        contextWindow: 131_072,
        maxOutput: 131_072,
        pricing: { input: 0.01, output: 0.03 },
        recommendedFor: ['长文档+图像分析', '复杂多模态任务'],
        thinkingMode: false,
        vision: true,
      },
    },
  },
};

/**
 * 获取提供商配置
 * @param {string} providerId - 提供商 ID
 * @returns {Object|null} 提供商配置
 */
function getProvider(providerId) {
  // 先检查自定义提供商
  const customProvider = CUSTOM_PROVIDERS.get(providerId);
  if (customProvider) {
    return customProvider;
  }
  return PROVIDERS[providerId] || null;
}

/**
 * 检查提供商是否有效
 * @param {string} providerId - 提供商 ID
 * @returns {boolean}
 */
function isValidProvider(providerId) {
  return !!PROVIDERS[providerId] || CUSTOM_PROVIDERS.has(providerId);
}

/**
 * 获取模型配置
 * @param {string} providerId - 提供商 ID
 * @param {string} modelId - 模型 ID
 * @returns {Object|null} 模型配置
 */
function getModel(providerId, modelId) {
  // 先检查自定义模型
  const customModel = CUSTOM_MODELS.get(modelId);
  if (customModel && customModel.provider === providerId) {
    return customModel;
  }

  const provider = getProvider(providerId);
  if (!provider) return null;
  return provider.models[modelId] || null;
}

/**
 * 检查模型是否有效
 * @param {string} providerId - 提供商 ID
 * @param {string} modelId - 模型 ID
 * @returns {boolean}
 */
function isValidModel(providerId, modelId) {
  // 检查自定义模型
  const customModel = CUSTOM_MODELS.get(modelId);
  if (customModel && customModel.provider === providerId) {
    return true;
  }

  const provider = getProvider(providerId);
  if (!provider) return false;
  return !!provider.models[modelId];
}

/**
 * 获取模型的上下文窗口大小
 * @param {string} providerId - 提供商 ID
 * @param {string} modelId - 模型 ID
 * @returns {number|null} 上下文窗口大小（tokens），如果无法探测则返回 null
 */
function getModelContextWindow(providerId, modelId) {
  const model = getModel(providerId, modelId);
  if (model && model.contextWindow) {
    return model.contextWindow;
  }

  // 对于无预设模型的提供商，不返回硬编码默认值
  // 由调用方处理（如使用配置中的默认值或提示用户）
  return null;
}

/**
 * 获取所有可用提供商列表
 * @param {boolean} includeCustom - 是否包含自定义提供商
 * @returns {Array} 提供商列表
 */
function getProviderList(includeCustom = true) {
  const providers = Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    defaultModel: p.defaultModel,
    thinkingMode: p.thinkingMode,
    isCustom: false,
  }));

  if (includeCustom) {
    for (const cp of CUSTOM_PROVIDERS.values()) {
      providers.push({
        id: cp.id,
        name: cp.name,
        description: cp.description,
        defaultModel: cp.defaultModel,
        thinkingMode: cp.thinkingMode,
        isCustom: true,
      });
    }
  }

  return providers;
}

/**
 * 获取提供商的所有模型列表
 * @param {string} providerId - 提供商 ID
 * @param {boolean} includeCustom - 是否包含自定义模型
 * @returns {Array} 模型列表
 */
function getModelList(providerId, includeCustom = true) {
  const provider = getProvider(providerId);
  if (!provider) return [];

  const models = Object.values(provider.models).map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    contextWindow: m.contextWindow,
    pricing: m.pricing,
    recommendedFor: m.recommendedFor,
    thinkingMode: m.thinkingMode,
    vision: m.vision || false,
    isCustom: m.isCustom || false,
  }));

  // 添加属于此提供商的自定义模型
  if (includeCustom) {
    for (const cm of CUSTOM_MODELS.values()) {
      if (cm.provider === providerId) {
        models.push({
          id: cm.id,
          name: cm.name,
          description: cm.description,
          contextWindow: cm.contextWindow,
          pricing: cm.pricing,
          recommendedFor: cm.recommendedFor,
          thinkingMode: cm.thinkingMode,
          vision: cm.vision,
          isCustom: true,
        });
      }
    }
  }

  return models;
}

/**
 * 根据模型 ID 自动识别提供商
 * @param {string} modelId - 模型 ID
 * @returns {string|null} 提供商 ID
 */
function detectProvider(modelId) {
  // OpenAI 模型以 gpt- 或 o1/o3 开头
  if (modelId.startsWith('gpt-') || modelId.startsWith('o1') || modelId.startsWith('o3')) {
    return 'openai';
  }
  // Anthropic 模型以 claude- 开头
  if (modelId.startsWith('claude-')) {
    return 'anthropic';
  }
  // Kimi 模型以 moonshot- 或 kimi-k 开头
  if (modelId.startsWith('moonshot-') || modelId.startsWith('kimi-k')) {
    return 'kimi';
  }
  // DeepSeek 模型以 deepseek- 开头
  if (modelId.startsWith('deepseek-')) {
    return 'deepseek';
  }
  return null;
}

/**
 * 获取提供商的 API Key（从环境变量或自定义配置）
 * @param {string} providerId - 提供商 ID
 * @returns {string|undefined} API Key
 */
function getProviderApiKey(providerId) {
  const provider = getProvider(providerId);
  if (!provider) return undefined;

  // 自定义提供商直接返回存储的 apiKey
  if (provider.isCustom) {
    return provider.apiKey;
  }

  const envName = provider.apiKeyEnv;
  return process.env[envName];
}

/**
 * 获取提供商配置（用于 client.js）
 * @param {string} providerId - 提供商 ID
 * @param {Object} config - 用户配置
 * @returns {Object} 合并后的配置
 */
function getClientConfig(providerId, config = {}) {
  const provider = getProvider(providerId);
  if (!provider) {
    throw new Error(`未知提供商: ${providerId}`);
  }

  return {
    provider: providerId,
    baseURL: provider.baseURL,
    apiKey: config.apiKey || getProviderApiKey(providerId),
    defaultModel: provider.defaultModel,
    thinkingMode: provider.thinkingMode && (config.thinkingMode !== false),
    requestFormat: provider.requestFormat,
    timeout: config.timeout || 60000,
    retryCount: config.retryCount || 2,
    proxy: config.proxy,
  };
}

/**
 * 检查模型是否支持多模态（图片）
 * @param {string} providerId - 提供商 ID
 * @param {string} modelId - 模型 ID
 * @returns {boolean}
 */
function isVisionModel(providerId, modelId) {
  const model = getModel(providerId, modelId);
  if (!model) return false;
  return model.vision === true;
}

/**
 * 转换图片为 OpenAI 格式 (base64 或 URL)
 * @param {Object} image - 图片信息
 * @param {string} image.type - 'base64' | 'url' | 'file'
 * @param {string} image.data - base64 数据 或 URL 或文件路径
 * @param {string} [image.mediaType] - MIME 类型 (如 'image/png')
 * @returns {Object} OpenAI 格式的图片对象
 */
function formatImageForOpenAI(image) {
  if (!image || !image.type || !image.data) {
    throw new Error('图片必须包含 type 和 data');
  }

  if (image.type === 'base64') {
    const mediaType = image.mediaType || 'image/png';
    return {
      type: 'image_url',
      image_url: {
        url: `data:${mediaType};base64,${image.data}`,
      },
    };
  }

  if (image.type === 'url') {
    return {
      type: 'image_url',
      image_url: {
        url: image.data,
      },
    };
  }

  throw new Error(`不支持的图片类型: ${image.type}`);
}

/**
 * 转换图片为 Anthropic 格式
 * @param {Object} image - 图片信息
 * @param {string} image.type - 'base64' | 'url' | 'file'
 * @param {string} image.data - base64 数据 或 URL 或文件路径
 * @param {string} [image.mediaType] - MIME 类型 (如 'image/png')
 * @returns {Object} Anthropic 格式的图片对象
 */
function formatImageForAnthropic(image) {
  if (!image || !image.type || !image.data) {
    throw new Error('图片必须包含 type 和 data');
  }

  if (image.type === 'base64') {
    const mediaType = image.mediaType || 'image/png';
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType,
        data: image.data,
      },
    };
  }

  if (image.type === 'url') {
    return {
      type: 'image',
      source: {
        type: 'url',
        url: image.data,
      },
    };
  }

  throw new Error(`不支持的图片类型: ${image.type}`);
}

/**
 * 将消息中的图片转换为指定格式
 * @param {Array} messages - 消息数组
 * @param {string} format - 目标格式: 'openai' | 'anthropic'
 * @returns {Array} 转换后的消息数组
 */
function convertImagesInMessages(messages, format) {
  if (!Array.isArray(messages)) return messages;

  const formatFn = format === 'anthropic' ? formatImageForAnthropic : formatImageForOpenAI;

  return messages.map((msg) => {
    // 如果消息没有图片，直接返回
    if (!msg.images || msg.images.length === 0) {
      return msg;
    }

    // 转换图片
    const imageContents = msg.images.map((img) => {
      try {
        return formatFn(img);
      } catch (err) {
        console.error('图片格式转换失败:', err.message);
        return null;
      }
    }).filter(Boolean);

    // OpenAI 格式：content 是数组，包含 text 和 image_url
    if (format === 'openai' || format === 'kimi') {
      const content = [];
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      content.push(...imageContents);
      return {
        ...msg,
        content,
      };
    }

    // Anthropic 格式：content 是数组，包含 text 和 image
    if (format === 'anthropic') {
      const content = [];
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      content.push(...imageContents);
      return {
        ...msg,
        content,
      };
    }

    return msg;
  });
}

module.exports = {
  PROVIDERS,
  CUSTOM_MODELS,
  getProvider,
  isValidProvider,
  getModel,
  isValidModel,
  getModelContextWindow,
  getProviderList,
  getModelList,
  detectProvider,
  getProviderApiKey,
  getClientConfig,
  // 自定义配置导出
  registerCustomProvider,
  registerCustomModel,
  getCustomProvider,
  getCustomModel,
  listCustomProviders,
  listCustomModels,
  removeCustomProvider,
  removeCustomModel,
  // 多模态支持导出
  isVisionModel,
  formatImageForOpenAI,
  formatImageForAnthropic,
  convertImagesInMessages,
};

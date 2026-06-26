'use strict';

const CUSTOM_MODELS = new Map();
const CUSTOM_PROVIDERS = new Map();

function registerCustomProvider(config) {
  if (!config.id || !config.baseURL) {
    throw new Error('自定义提供商必须包含 id 和 baseURL');
  }

  const providerConfig = {
    id: config.id,
    name: config.name || config.id,
    description: config.description || '自定义提供商',
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    apiKeyEnv: null,
    thinkingMode: config.thinkingMode !== undefined ? config.thinkingMode : false,
    format: config.format || 'openai',
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

function getCustomModel(modelId) {
  return CUSTOM_MODELS.get(modelId) || null;
}

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

function removeCustomProvider(providerId) {
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

const PROVIDERS = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    thinkingMode: true,
    requestFormat: {
      thinkingType: 'reasoning_effort',
    },
    defaultModel: 'deepseek-v4-flash',
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
    thinkingMode: true,
    requestFormat: {
      thinkingType: 'reasoning_effort',
    },
    defaultModel: null,
    models: {},
  },

  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    thinkingMode: true,
    requestFormat: {
      thinkingType: 'thinking_block',
    },
    defaultModel: null,
    models: {},
  },

  kimi: {
    id: 'kimi',
    name: 'Kimi',
    baseURL: 'https://api.moonshot.cn/v1',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    thinkingMode: true,
    requestFormat: {
      thinkingType: 'enabled',
    },
    defaultModel: 'kimi-k2.5',
    models: {
      'kimi-k2.5': {
        id: 'kimi-k2.5',
        name: 'Kimi K2.5',
        contextWindow: 262_144,
        maxOutput: 131_072,
        pricing: { input: 0.004, cachedInput: 0.0007, output: 0.021 },
        recommendedFor: ['日常开发', '代码生成', '多模态任务', '长上下文'],
        thinkingMode: true,
        vision: true,
      },
      'kimi-k2.6': {
        id: 'kimi-k2.6',
        name: 'Kimi K2.6',
        contextWindow: 262_144,
        maxOutput: 131_072,
        pricing: { input: 0.0065, cachedInput: 0.0011, output: 0.027 },
        recommendedFor: ['复杂推理', '深度分析', '代码审查', '长程任务'],
        thinkingMode: true,
        vision: true,
      },
      'kimi-k2.7-code': {
        id: 'kimi-k2.7-code',
        name: 'Kimi K2.7 Code',
        contextWindow: 262_144,
        maxOutput: 131_072,
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
        pricing: { input: 0.013, cachedInput: 0.0026, output: 0.054 },
        recommendedFor: ['快速编程', '实时编码', '快速原型'],
        thinkingMode: true,
        vision: true,
      },
      'moonshot-v1-8k': {
        id: 'moonshot-v1-8k',
        name: 'Kimi V1 8K',
        contextWindow: 8_192,
        maxOutput: 8_192,
        pricing: { input: 0.002, output: 0.01 },
        recommendedFor: ['简单问答', '短文本生成', '快速任务'],
        thinkingMode: false,
      },
      'moonshot-v1-32k': {
        id: 'moonshot-v1-32k',
        name: 'Kimi V1 32K',
        contextWindow: 32_768,
        maxOutput: 32_768,
        pricing: { input: 0.005, output: 0.02 },
        recommendedFor: ['日常开发', '代码生成', '中等长度文本'],
        thinkingMode: false,
      },
      'moonshot-v1-128k': {
        id: 'moonshot-v1-128k',
        name: 'Kimi V1 128K',
        contextWindow: 131_072,
        maxOutput: 131_072,
        pricing: { input: 0.01, output: 0.03 },
        recommendedFor: ['长文档分析', '大规模代码审查', '长上下文任务'],
        thinkingMode: false,
      },
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

function getProvider(providerId) {
  const customProvider = CUSTOM_PROVIDERS.get(providerId);
  if (customProvider) {
    return customProvider;
  }
  return PROVIDERS[providerId] || null;
}

function isValidProvider(providerId) {
  return !!PROVIDERS[providerId] || CUSTOM_PROVIDERS.has(providerId);
}

function getModel(providerId, modelId) {
  // 自定义模型优先:按 modelId 全局查找,再校验 provider 归属
  const customModel = CUSTOM_MODELS.get(modelId);
  if (customModel && customModel.provider === providerId) {
    return customModel;
  }

  const provider = getProvider(providerId);
  if (!provider) {return null;}
  return provider.models[modelId] || null;
}

function isValidModel(providerId, modelId) {
  const customModel = CUSTOM_MODELS.get(modelId);
  if (customModel && customModel.provider === providerId) {
    return true;
  }

  const provider = getProvider(providerId);
  if (!provider) {return false;}
  return !!provider.models[modelId];
}

function getModelContextWindow(providerId, modelId) {
  const model = getModel(providerId, modelId);
  if (model && model.contextWindow) {
    return model.contextWindow;
  }

  // 无预设模型的提供商返回 null,由调用方决定兜底策略
  return null;
}

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

function getModelList(providerId, includeCustom = true) {
  const provider = getProvider(providerId);
  if (!provider) {return [];}

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

  // 追加属于此提供商的自定义模型(去重)
  if (includeCustom) {
    const seen = new Set(models.map((m) => m.id));
    for (const cm of CUSTOM_MODELS.values()) {
      if (cm.provider === providerId && !seen.has(cm.id)) {
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

function detectProvider(modelId) {
  if (modelId.startsWith('gpt-') || modelId.startsWith('o1') || modelId.startsWith('o3')) {
    return 'openai';
  }
  if (modelId.startsWith('claude-')) {
    return 'anthropic';
  }
  if (modelId.startsWith('moonshot-') || modelId.startsWith('kimi-k')) {
    return 'kimi';
  }
  if (modelId.startsWith('deepseek-')) {
    return 'deepseek';
  }
  return null;
}

function getProviderApiKey(providerId) {
  const provider = getProvider(providerId);
  if (!provider) {return undefined;}

  // 自定义提供商直接读取存储值;内置提供商从环境变量取
  if (provider.isCustom) {
    return provider.apiKey;
  }

  const envName = provider.apiKeyEnv;
  return process.env[envName];
}

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

function isVisionModel(providerId, modelId) {
  const model = getModel(providerId, modelId);
  if (!model) {return false;}
  return model.vision === true;
}

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

function convertImagesInMessages(messages, format) {
  if (!Array.isArray(messages)) {return messages;}

  const formatFn = format === 'anthropic' ? formatImageForAnthropic : formatImageForOpenAI;

  return messages.map((msg) => {
    if (!msg.images || msg.images.length === 0) {
      return msg;
    }

    const imageContents = msg.images.map((img) => {
      try {
        return formatFn(img);
      } catch (err) {
        console.error('图片格式转换失败:', err.message);
        return null;
      }
    }).filter(Boolean);

    // OpenAI/Kimi:content 是数组,包含 text + image_url
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

    // Anthropic:content 是数组,包含 text + image
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
  getProvider,
  isValidProvider,
  getModel,
  isValidModel,
  getModelContextWindow,
  getProviderList,
  getModelList,
  detectProvider,
  getClientConfig,
  registerCustomProvider,
  registerCustomModel,
  getCustomModel,
  listCustomProviders,
  listCustomModels,
  removeCustomProvider,
  isVisionModel,
  formatImageForAnthropic,
  convertImagesInMessages,
};
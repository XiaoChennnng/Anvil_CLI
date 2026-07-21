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
      reasoningSplit: config.reasoningSplit || false,
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
        pricing: { input: 0.14, output: 0.28 },
        recommendedFor: ['日常开发', '快速生成', '简单任务'],
        thinkingMode: true,
      },
      'deepseek-v4-pro': {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        params: '1.6T / 49B (总/激活)',
        contextWindow: 1_000_000,
        maxOutput: 384_000,
        pricing: { input: 0.435, output: 0.87 },
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
    format: 'openai',
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
    baseURL: 'https://api.anthropic.com',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    format: 'anthropic',
    thinkingMode: true,
    requestFormat: {
      thinkingType: 'thinking_block',
    },
    defaultModel: null,
    models: {},
  },

  'openai-api': {
    id: 'openai-api',
    name: 'OpenAI API',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    format: 'openai',
    thinkingMode: true,
    requestFormat: {
      thinkingType: 'reasoning_effort',
    },
    defaultModel: 'gpt-5.5',
    models: {
      'gpt-5.6-sol': {
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        contextWindow: 1_050_000,
        maxOutput: 128_000,
        vision: true,
        pricing: { input: 15, output: 75 },
        thinkingMode: true,
      },
      'gpt-5.6-terra': {
        id: 'gpt-5.6-terra',
        name: 'GPT-5.6 Terra',
        contextWindow: 1_050_000,
        maxOutput: 128_000,
        vision: true,
        pricing: { input: 10, output: 50 },
        thinkingMode: true,
      },
      'gpt-5.5': {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        contextWindow: 1_050_000,
        maxOutput: 128_000,
        vision: true,
        pricing: { input: 5, output: 25 },
        thinkingMode: true,
      },
      'gpt-5.5-pro': {
        id: 'gpt-5.5-pro',
        name: 'GPT-5.5 Pro',
        contextWindow: 1_050_000,
        maxOutput: 128_000,
        vision: true,
        pricing: { input: 10, output: 50 },
        thinkingMode: true,
      },
      'gpt-5.4': {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        contextWindow: 1_050_000,
        maxOutput: 128_000,
        vision: true,
        pricing: { input: 2.5, output: 15 },
        thinkingMode: true,
      },
      'gpt-5.4-pro': {
        id: 'gpt-5.4-pro',
        name: 'GPT-5.4 Pro',
        contextWindow: 1_050_000,
        maxOutput: 128_000,
        vision: true,
        pricing: { input: 5, output: 25 },
        thinkingMode: true,
      },
      'gpt-5.4-mini': {
        id: 'gpt-5.4-mini',
        name: 'GPT-5.4 Mini',
        contextWindow: 400_000,
        maxOutput: 128_000,
        pricing: { input: 0.35, output: 2 },
        thinkingMode: true,
      },
      'gpt-5.4-nano': {
        id: 'gpt-5.4-nano',
        name: 'GPT-5.4 Nano',
        contextWindow: 400_000,
        maxOutput: 128_000,
        pricing: { input: 0.15, output: 1 },
        thinkingMode: true,
      },
      'gpt-5.3-codex': {
        id: 'gpt-5.3-codex',
        name: 'GPT-5.3 Codex',
        contextWindow: 400_000,
        maxOutput: 128_000,
        pricing: { input: 0.5, output: 2.5 },
        thinkingMode: true,
      },
      'gpt-4.1': {
        id: 'gpt-4.1',
        name: 'GPT-4.1',
        contextWindow: 1_050_000,
        maxOutput: 128_000,
        vision: true,
        pricing: { input: 2, output: 10 },
        thinkingMode: false,
      },
      'o3': {
        id: 'o3',
        name: 'o3',
        contextWindow: 200_000,
        maxOutput: 100_000,
        pricing: { input: 10, output: 40 },
        thinkingMode: true,
      },
    },
  },

  'anthropic-api': {
    id: 'anthropic-api',
    name: 'Anthropic API',
    baseURL: 'https://api.anthropic.com',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    format: 'anthropic',
    thinkingMode: true,
    requestFormat: {
      thinkingType: 'thinking_block',
    },
    defaultModel: 'claude-sonnet-5',
    models: {
      'claude-fable-5': {
        id: 'claude-fable-5',
        name: 'Claude Fable 5',
        contextWindow: 1_000_000,
        maxOutput: 128_000,
        vision: true,
        pricing: { input: 10, output: 50 },
        thinkingMode: true,
      },
      'claude-opus-4-8': {
        id: 'claude-opus-4-8',
        name: 'Claude Opus 4.8',
        contextWindow: 1_000_000,
        maxOutput: 128_000,
        vision: true,
        pricing: { input: 5, output: 25 },
        thinkingMode: true,
      },
      'claude-sonnet-5': {
        id: 'claude-sonnet-5',
        name: 'Claude Sonnet 5',
        contextWindow: 1_000_000,
        maxOutput: 128_000,
        vision: true,
        pricing: { input: 3, output: 15 },
        thinkingMode: true,
      },
      'claude-haiku-4-5': {
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        contextWindow: 200_000,
        maxOutput: 64_000,
        vision: true,
        pricing: { input: 1, output: 5 },
        thinkingMode: false,
      },
    },
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
    defaultModel: 'kimi-k2.7-code',
    models: {
      'kimi-k2.5': {
        id: 'kimi-k2.5',
        name: 'Kimi K2.5',
        contextWindow: 262_144,
        maxOutput: 131_072,
        pricing: { input: 0.60, cachedInput: 0.15, output: 2.60 },
        recommendedFor: ['日常开发', '代码生成', '多模态任务', '长上下文'],
        thinkingMode: true,
        vision: true,
      },
      'kimi-k2.6': {
        id: 'kimi-k2.6',
        name: 'Kimi K2.6',
        contextWindow: 262_144,
        maxOutput: 131_072,
        pricing: { input: 6.5, output: 20.0 },
        recommendedFor: ['复杂推理', '深度分析', '代码审查', '长程任务'],
        thinkingMode: true,
        vision: true,
      },
      'kimi-k2.7-code': {
        id: 'kimi-k2.7-code',
        name: 'Kimi K2.7 Code',
        contextWindow: 262_144,
        maxOutput: 131_072,
        pricing: { input: 6.5, output: 20.0 },
        recommendedFor: ['复杂编程', '代码重构', '架构设计', '深度代码分析'],
        thinkingMode: true,
        vision: true,
      },
      'kimi-k2.7-code-highspeed': {
        id: 'kimi-k2.7-code-highspeed',
        name: 'Kimi K2.7 Code HighSpeed',
        contextWindow: 262_144,
        maxOutput: 131_072,
        pricing: { input: 13.0, output: 40.0 },
        recommendedFor: ['快速编程', '实时编码', '快速原型'],
        thinkingMode: true,
        vision: true,
      },
      'moonshot-v1-8k': {
        id: 'moonshot-v1-8k',
        name: 'Kimi V1 8K',
        contextWindow: 8_192,
        maxOutput: 8_192,
        pricing: { input: 0.5, output: 2.0 },
        recommendedFor: ['简单问答', '短文本生成', '快速任务'],
        thinkingMode: false,
      },
      'moonshot-v1-32k': {
        id: 'moonshot-v1-32k',
        name: 'Kimi V1 32K',
        contextWindow: 32_768,
        maxOutput: 32_768,
        pricing: { input: 1.0, output: 4.0 },
        recommendedFor: ['日常开发', '代码生成', '中等长度文本'],
        thinkingMode: false,
      },
      'moonshot-v1-128k': {
        id: 'moonshot-v1-128k',
        name: 'Kimi V1 128K',
        contextWindow: 131_072,
        maxOutput: 131_072,
        pricing: { input: 2.0, output: 6.0 },
        recommendedFor: ['长文档分析', '大规模代码审查', '长上下文任务'],
        thinkingMode: false,
      },
      'moonshot-v1-8k-vision-preview': {
        id: 'moonshot-v1-8k-vision-preview',
        name: 'Kimi V1 8K Vision',
        contextWindow: 8_192,
        maxOutput: 8_192,
        pricing: { input: 0.5, output: 2.0 },
        recommendedFor: ['图像理解', '简单多模态任务'],
        thinkingMode: false,
        vision: true,
      },
      'moonshot-v1-32k-vision-preview': {
        id: 'moonshot-v1-32k-vision-preview',
        name: 'Kimi V1 32K Vision',
        contextWindow: 32_768,
        maxOutput: 32_768,
        pricing: { input: 1.0, output: 4.0 },
        recommendedFor: ['图像分析', '多模态开发任务'],
        thinkingMode: false,
        vision: true,
      },
      'moonshot-v1-128k-vision-preview': {
        id: 'moonshot-v1-128k-vision-preview',
        name: 'Kimi V1 128K Vision',
        contextWindow: 131_072,
        maxOutput: 131_072,
        pricing: { input: 2.0, output: 6.0 },
        recommendedFor: ['长文档+图像分析', '复杂多模态任务'],
        thinkingMode: false,
        vision: true,
      },
    },
  },

  google: {
    id: 'google',
    name: 'Google',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GOOGLE_API_KEY',
    thinkingMode: true,
    requestFormat: {
      thinkingType: 'reasoning_effort',
    },
    defaultModel: 'gemini-3.5-flash',
    models: {
      'gemini-3.6-flash': {
        id: 'gemini-3.6-flash',
        name: 'Gemini 3.6 Flash',
        contextWindow: 1_000_000,
        maxOutput: 65_536,
        vision: true,
        pricing: { input: 1.50, output: 7.50 },
        thinkingMode: true,
      },
      'gemini-3.5-flash': {
        id: 'gemini-3.5-flash',
        name: 'Gemini 3.5 Flash',
        contextWindow: 1_000_000,
        maxOutput: 65_536,
        vision: true,
        pricing: { input: 1.50, output: 9.00 },
        thinkingMode: true,
      },
      'gemini-3.1-pro': {
        id: 'gemini-3.1-pro',
        name: 'Gemini 3.1 Pro',
        contextWindow: 1_000_000,
        maxOutput: 65_536,
        vision: true,
        pricing: { input: 2.00, output: 12.00 },
        thinkingMode: true,
      },
      'gemini-3.1-flash-lite': {
        id: 'gemini-3.1-flash-lite',
        name: 'Gemini 3.1 Flash Lite',
        contextWindow: 1_000_000,
        maxOutput: 65_536,
        pricing: { input: 0.25, output: 1.50 },
        thinkingMode: true,
      },
      'gemini-3-flash': {
        id: 'gemini-3-flash',
        name: 'Gemini 3 Flash',
        contextWindow: 1_000_000,
        maxOutput: 65_536,
        vision: true,
        pricing: { input: 0.50, output: 3.00 },
        thinkingMode: true,
      },
      'gemini-2.5-pro': {
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        contextWindow: 1_000_000,
        maxOutput: 65_536,
        vision: true,
        pricing: { input: 1.25, output: 10.00 },
        thinkingMode: true,
      },
      'gemini-2.5-flash': {
        id: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        contextWindow: 1_000_000,
        maxOutput: 65_536,
        vision: true,
        pricing: { input: 0.30, output: 2.50 },
        thinkingMode: true,
      },
    },
  },

  qwen: {
    id: 'qwen',
    name: 'Qwen',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'QWEN_API_KEY',
    thinkingMode: true,
    requestFormat: {
      thinkingType: 'reasoning_effort',
    },
    defaultModel: 'qwen3.5-plus',
    models: {
      'qwen3.7-plus': {
        id: 'qwen3.7-plus',
        name: 'Qwen 3.7 Plus',
        contextWindow: 1_000_000,
        maxOutput: 65_536,
        pricing: { input: 2.32, output: 9.28 },
        thinkingMode: true,
      },
      'qwen3.7-max': {
        id: 'qwen3.7-max',
        name: 'Qwen 3.7 Max',
        contextWindow: 1_000_000,
        maxOutput: 65_536,
        pricing: { input: 9.06, output: 27.19 },
        thinkingMode: true,
      },
      'qwen3.6-plus': {
        id: 'qwen3.6-plus',
        name: 'Qwen 3.6 Plus',
        contextWindow: 1_000_000,
        maxOutput: 65_536,
        pricing: { input: 2.36, output: 14.14 },
        thinkingMode: true,
      },
      'qwen3.5-plus': {
        id: 'qwen3.5-plus',
        name: 'Qwen 3.5 Plus',
        contextWindow: 1_000_000,
        maxOutput: 65_536,
        pricing: { input: 2.90, output: 17.40 },
        thinkingMode: true,
      },
      'qwen3.5-flash': {
        id: 'qwen3.5-flash',
        name: 'Qwen 3.5 Flash',
        contextWindow: 1_000_000,
        maxOutput: 65_536,
        pricing: { input: 0.73, output: 2.90 },
        thinkingMode: true,
      },
      'qwen3-max-thinking': {
        id: 'qwen3-max-thinking',
        name: 'Qwen 3 Max Thinking',
        contextWindow: 262_144,
        maxOutput: 32_000,
        pricing: { input: 5.66, output: 28.28 },
        thinkingMode: true,
      },
      'qwen3-max': {
        id: 'qwen3-max',
        name: 'Qwen 3 Max',
        contextWindow: 262_144,
        maxOutput: 32_000,
        pricing: { input: 8.70, output: 43.50 },
        thinkingMode: true,
      },
      'qwen3-plus': {
        id: 'qwen3-plus',
        name: 'Qwen 3 Plus',
        contextWindow: 1_000_000,
        maxOutput: 65_536,
        pricing: { input: 2.90, output: 8.70 },
        thinkingMode: true,
      },
      'qwen3-flash': {
        id: 'qwen3-flash',
        name: 'Qwen 3 Flash',
        contextWindow: 1_000_000,
        maxOutput: 65_536,
        pricing: { input: 0.36, output: 2.90 },
        thinkingMode: true,
      },
      'qwen3-coder-plus': {
        id: 'qwen3-coder-plus',
        name: 'Qwen 3 Coder Plus',
        contextWindow: 1_000_000,
        maxOutput: 65_536,
        pricing: { input: 4.71, output: 23.56 },
        thinkingMode: true,
      },
      'qwen3-235b-a22b': {
        id: 'qwen3-235b-a22b',
        name: 'Qwen 3 235B (MoE)',
        contextWindow: 262_144,
        maxOutput: 262_144,
        pricing: { input: 0.65, output: 4.35 },
        thinkingMode: true,
      },
      'qwen3-32b': {
        id: 'qwen3-32b',
        name: 'Qwen 3 32B',
        contextWindow: 128_000,
        maxOutput: 128_000,
        pricing: { input: 0.58, output: 1.45 },
        thinkingMode: true,
      },
      'qwen2.5-72b': {
        id: 'qwen2.5-72b',
        name: 'Qwen 2.5 72B',
        contextWindow: 128_000,
        maxOutput: 128_000,
        pricing: { input: 1.67, output: 4.28 },
        thinkingMode: false,
      },
      'qwen2.5-coder-32b': {
        id: 'qwen2.5-coder-32b',
        name: 'Qwen 2.5 Coder 32B',
        contextWindow: 128_000,
        maxOutput: 128_000,
        pricing: { input: 0.65, output: 0.65 },
        thinkingMode: false,
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
  // 自定义模型优先：按 modelId 全局查找再校验 provider 归属
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

/**
 * 模型上下文窗口模式匹配表——作为预设数据库的补充回退，
 * 覆盖已知型号命名规则。只有不在预设数据库中时才触发。
 */
const MODEL_CONTEXT_PATTERNS = [
  // MiniMax（官方文档: minimaxi.com）
  { pattern: /^MiniMax-M3/i, window: 1_000_000 },
  { pattern: /^MiniMax-M2\.\d/i, window: 204_800 },
  { pattern: /^MiniMax-M2(?!\.)/i, window: 204_800 },
  // DeepSeek（预设库已收 v4，这里覆盖 legacy 型号）
  { pattern: /^deepseek-(chat|reasoner)/i, window: 1_000_000 },
  { pattern: /^deepseek-v3/i, window: 128_000 },
  { pattern: /^kimi-k\d/i, window: 262_144 },
  { pattern: /^moonshot-v1-/i, window: 131_072 },
  // OpenAI
  { pattern: /^gpt-5\.6/i, window: 1_050_000 },
  { pattern: /^gpt-5\.5/i, window: 1_050_000 },
  { pattern: /^gpt-5\.4/i, window: 1_050_000 },
  { pattern: /^gpt-5\.3/i, window: 400_000 },
  { pattern: /^gpt-5/i, window: 400_000 },
  { pattern: /^gpt-4\.1/i, window: 1_050_000 },
  { pattern: /^gpt-4o/i, window: 128_000 },
  { pattern: /^gpt-4(?!\.)/i, window: 128_000 },
  { pattern: /^gpt-3\.5/i, window: 16_000 },
  { pattern: /^o4/i, window: 200_000 },
  { pattern: /^o3/i, window: 200_000 },
  { pattern: /^o1/i, window: 200_000 },
  // Qwen（预设库已收主要型号，这里补未收录的）
  { pattern: /^qwen3\.\d/i, window: 262_144 },
  { pattern: /^qwen2\.5/i, window: 128_000 },
  { pattern: /^qwen2/i, window: 32_768 },
  { pattern: /^gemini-3\.6/i, window: 1_000_000 },
  { pattern: /^gemini-3\.5/i, window: 1_000_000 },
  { pattern: /^gemini-3\.1/i, window: 1_000_000 },
  { pattern: /^gemini-3/i, window: 1_000_000 },
  { pattern: /^gemini-2\.5/i, window: 1_000_000 },
  { pattern: /^gemini-2/i, window: 32_768 },
  { pattern: /^claude-(fable|mythos)/i, window: 1_000_000 },
  { pattern: /^claude-opus-\d/i, window: 1_000_000 },
  { pattern: /^claude-sonnet-\d/i, window: 1_000_000 },
  { pattern: /^claude-haiku-\d/i, window: 200_000 },
  { pattern: /^claude-\d/i, window: 200_000 },
  { pattern: /^llama-4-scout/i, window: 131_072 },
  { pattern: /^llama-4-maverick/i, window: 1_000_000 },
  { pattern: /^llama-4/i, window: 131_072 },
  { pattern: /^llama-3\.\d/i, window: 128_000 },
  { pattern: /^llama-3/i, window: 8_192 },
  { pattern: /^gemma-3/i, window: 32_768 },
  { pattern: /^gemma-2/i, window: 8_192 },
  { pattern: /^mistral-large/i, window: 128_000 },
  { pattern: /^mistral-small/i, window: 32_000 },
  { pattern: /^mistral/i, window: 32_000 },
  { pattern: /^codestral/i, window: 256_000 },
  { pattern: /^grok-\d/i, window: 131_072 },
  { pattern: /^grok/i, window: 8_192 },
];

function getModelContextWindow(providerId, modelId) {
  const model = getModel(providerId, modelId);
  if (model && model.contextWindow) {
    return model.contextWindow;
  }

  // 不在预设库时尝试模式匹配自动探测
  if (modelId) {
    for (const entry of MODEL_CONTEXT_PATTERNS) {
      if (entry.pattern.test(modelId)) {
        return entry.window;
      }
    }
  }

  // 无预设模型的提供商返回 null，兜底策略由调用方决定
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

  // 追加此提供商的自定义模型（按 id 去重）
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

  // 自定义提供商直接读取存储值，内置提供商从环境变量取
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
    baseURL: config.customBaseURL || config.baseURL || provider.baseURL,
    apiKey: config.apiKey || getProviderApiKey(providerId),
    defaultModel: config.defaultModel || provider.defaultModel,
    format: provider.format || 'openai',
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

    // OpenAI/Kimi: content 是数组（text + image_url）
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
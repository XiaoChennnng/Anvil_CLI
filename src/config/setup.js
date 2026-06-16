'use strict';

const fs = require('fs');
const path = require('path');
const { getGlobalConfigDir } = require('./loader');
const { getProviderList, getModelList } = require('../ai/providers');

async function setupWizard(options = {}) {
  const projectDir = options.projectDir || process.cwd();

  // 尝试动态加载 inquirer
  let inquirer;
  try {
    inquirer = (await import('inquirer')).default;
  } catch {
    console.error('无法加载 inquirer 模块，请确认 npm install 已完成');
    process.exit(1);
  }

  console.log('\n⚒  欢迎使用 Anvil！首次启动需要进行一些配置...\n');

  // Step 1: 选择项目目录（带重试）
  let resolvedDir;
  while (true) {
    const { projectDir: dir } = await inquirer.prompt([
      {
        type: 'input',
        name: 'projectDir',
        message: '请输入项目工作目录:',
        default: projectDir,
      },
    ]);

    const trimmed = dir?.trim();
    if (!trimmed || trimmed.length === 0) {
      console.log('⚠️  项目目录不能为空，请重新输入\n');
      continue;
    }
    resolvedDir = path.resolve(trimmed);
    break;
  }

  // Step 2: 选择模型提供商
  const providers = getProviderList();
  const providerChoices = providers.map((p) => {
    let displayName = p.name;
    if (p.id === 'openai') {
      displayName = 'OpenAI Chat Completions 格式模型';
    } else if (p.id === 'anthropic') {
      displayName = 'Anthropic Messages 格式模型';
    }
    return {
      name: displayName,
      value: p.id,
    };
  });

  const { provider } = await inquirer.prompt([
    {
      type: 'list',
      name: 'provider',
      message: '请选择模型提供商:',
      choices: providerChoices,
      default: 'deepseek',
    },
  ]);

  // Step 3: 根据提供商请求相应的 API Key（带重试）
  const providerConfig = providers.find((p) => p.id === provider);
  let apiKey;

  while (true) {
    const { input } = await inquirer.prompt([
      {
        type: 'password',
        name: 'input',
        message: `请输入你的 ${providerConfig.name} API Key:`,
      },
    ]);

    const trimmed = input?.trim();

    // 检查是否为空
    if (!trimmed || trimmed.length === 0) {
      console.log('⚠️  API Key 不能为空，请重新输入\n');
      continue;
    }

    // 注意：不再强制检查 API Key 格式，不同提供商格式可能不同
    // 用户自行确认输入正确即可

    apiKey = trimmed;
    break;
  }

  // Step 3.5: 对于 OpenAI/Anthropic，询问自定义 baseURL（无默认值，必须用户输入）
  let customBaseURL = null;
  if (provider === 'openai' || provider === 'anthropic') {
    while (true) {
      const { baseURLInput } = await inquirer.prompt([
        {
          type: 'input',
          name: 'baseURLInput',
          message: `请输入 ${providerConfig.name} API 基础 URL:`,
        },
      ]);

      const trimmed = baseURLInput?.trim();
      if (!trimmed || trimmed.length === 0) {
        console.log('⚠️  API URL 不能为空，请重新输入\n');
        continue;
      }

      // 简单验证 URL 格式
      try {
        new URL(trimmed);
        customBaseURL = trimmed;
        break;
      } catch {
        console.log('⚠️  URL 格式无效，请输入有效的 URL（如 https://api.example.com/v1）\n');
        continue;
      }
    }
  }

  // Step 4: 选择或输入模型（带重试）
  let model;
  const availableModels = getModelList(provider);

  if (availableModels.length > 0) {
    // 有预设模型，显示列表选择
    const { selectedModel } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedModel',
        message: '请选择默认模型:',
        choices: availableModels.map((m) => ({
          name: m.name,
          value: m.id,
        })),
        default: availableModels[0]?.id,
      },
    ]);
    model = selectedModel;
  } else {
    // 无预设模型（如 OpenAI/Anthropic），让用户手动输入
    while (true) {
      const { customModel } = await inquirer.prompt([
        {
          type: 'input',
          name: 'customModel',
          message: '请输入模型 ID（如 gpt-4o, claude-3-5-sonnet-20241022）:',
        },
      ]);

      const trimmed = customModel?.trim();
      if (!trimmed || trimmed.length === 0) {
        console.log('⚠️  模型 ID 不能为空，请重新输入\n');
        continue;
      }

      model = trimmed;
      break;
    }
  }

  // Step 5: 对于 OpenAI/Anthropic 格式，询问 URL 路径后缀
  let apiPath = null;
  if (provider === 'openai') {
    const { addPath } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'addPath',
        message: '是否在请求地址后添加 /chat/completions 路径？',
        default: true,
      },
    ]);
    apiPath = addPath ? '/chat/completions' : null;
  } else if (provider === 'anthropic') {
    const { addPath } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'addPath',
        message: '是否在请求地址后添加 /v1/messages 路径？',
        default: true,
      },
    ]);
    apiPath = addPath ? '/v1/messages' : null;
  }

  const savedConfig = await saveConfig(resolvedDir, {
    apiKey: apiKey,
    defaultModel: model,
    provider: provider,
    apiPath: apiPath,
    customBaseURL: customBaseURL,
  });

  console.log('\n✅ 配置完成！Anvil 已就绪。\n');
  console.log(`  提供商: ${providerConfig.name}`);
  console.log(`  模型: ${model}`);
  if (customBaseURL) {
    console.log(`  API 地址: ${customBaseURL}`);
  }
  if (apiPath) {
    console.log(`  API 路径: ${apiPath}`);
  }
  console.log(`  工作目录: ${resolvedDir}\n`);

  return {
    projectDir: resolvedDir,
    apiKey: apiKey,
    defaultModel: model,
    provider: provider,
    baseURL: savedConfig?.baseURL,
  };
}

/**
 * 获取 API Key 环境变量名
 * @param {string} providerId - 提供商 ID
 * @returns {string} 环境变量名
 */
function getApiKeyEnvName(providerId) {
  const envNames = {
    deepseek: 'DEEPSEEK_API_KEY',
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    kimi: 'MOONSHOT_API_KEY',
  };
  return envNames[providerId] || `${providerId.toUpperCase()}_API_KEY`;
}

/**
 * 获取提供商基础 URL
 * @param {string} providerId - 提供商 ID
 * @returns {string} API 基础 URL
 */
function getProviderBaseURL(providerId) {
  const baseURLs = {
    deepseek: 'https://api.deepseek.com',
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
    kimi: 'https://api.moonshot.cn/v1',
  };
  return baseURLs[providerId] || '';
}

async function saveConfig(projectDir, settings) {
  // 创建项目 .anvil 目录
  const anvilDir = path.join(projectDir, '.anvil');
  fs.mkdirSync(anvilDir, { recursive: true });
  fs.mkdirSync(path.join(anvilDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(anvilDir, 'logs'), { recursive: true });

  // 保存全局配置
  const globalDir = getGlobalConfigDir();
  fs.mkdirSync(globalDir, { recursive: true });

  const provider = settings.provider || 'deepseek';

  // 构建 baseURL
  // 优先使用用户提供的 customBaseURL，否则使用默认值
  let baseURL = settings.customBaseURL || getProviderBaseURL(provider);
  if (settings.apiPath && baseURL) {
    // 确保 baseURL 不以 / 结尾，apiPath 以 / 开头
    baseURL = baseURL.replace(/\/$/, '') + settings.apiPath;
  }

  const globalConfig = {
    provider: provider,
    apiKey: settings.apiKey,
    defaultModel: settings.defaultModel,
    baseURL: baseURL,
    thinkingMode: true,
    theme: 'auto',
    timeout: 60000,
    retryCount: 2,
  };

  fs.writeFileSync(
    path.join(globalDir, 'config.json'),
    JSON.stringify(globalConfig, null, 2) + '\n',
    'utf8',
  );

  console.log(`  配置已保存到: ${path.join(globalDir, 'config.json')}`);

  return globalConfig;
}

module.exports = { setupWizard, saveConfig };

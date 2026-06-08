'use strict';

const fs = require('fs');
const path = require('path');
const { getGlobalConfigDir } = require('./loader');

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

  // Step 1: 选择项目目录
  const { projectDir: dir } = await inquirer.prompt([
    {
      type: 'input',
      name: 'projectDir',
      message: '请输入项目工作目录:',
      default: projectDir,
      validate: (input) => {
        if (!input || input.trim().length === 0) {
          return '项目目录不能为空';
        }
        return true;
      },
    },
  ]);

  const resolvedDir = path.resolve(dir.trim());

  const { apiKey } = await inquirer.prompt([
    {
      type: 'password',
      name: 'apiKey',
      message: '请输入你的 DeepSeek API Key:',
      validate: (input) => {
        if (!input || input.trim().length === 0) {
          return 'API Key 不能为空';
        }
        if (!input.trim().startsWith('sk-')) {
          return 'API Key 通常以 sk- 开头，请确认输入正确';
        }
        return true;
      },
    },
  ]);

  const { model } = await inquirer.prompt([
    {
      type: 'list',
      name: 'model',
      message: '请选择默认模型:',
      choices: [
        { name: 'deepseek-v4-flash (日常开发，快速生成)', value: 'deepseek-v4-flash' },
        { name: 'deepseek-v4-pro (复杂推理，深度分析)', value: 'deepseek-v4-pro' },
      ],
      default: 'deepseek-v4-flash',
    },
  ]);

  await saveConfig(resolvedDir, { apiKey: apiKey.trim(), defaultModel: model });

  console.log('\n✅ 配置完成！Anvil 已就绪。\n');

  return {
    projectDir: resolvedDir,
    apiKey: apiKey.trim(),
    defaultModel: model,
  };
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

  const globalConfig = {
    apiKey: settings.apiKey,
    defaultModel: settings.defaultModel || 'deepseek-v4-flash',
    baseURL: 'https://api.deepseek.com',
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
}

module.exports = { setupWizard, saveConfig };

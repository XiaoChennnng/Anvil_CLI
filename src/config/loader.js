'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const DEFAULTS = require('./defaults');
const { loadProxy } = require('./proxy');

function getGlobalConfigDir() {
  return path.join(os.homedir(), '.anvil');
}

function getGlobalConfigPath() {
  return path.join(getGlobalConfigDir(), 'config.json');
}

function getProjectConfigPath(projectDir) {
  return path.join(projectDir, '.anvil', 'config.json');
}

function loadJSONFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content);
    }
  } catch (err) {
    console.error(`[config] 读取配置失败: ${filePath}`, err.message);
  }
  return null;
}

function mergeConfig(base, override) {
  if (!override) {return base;}
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (override[key] !== null && override[key] !== undefined) {
      if (key === 'proxy' && result.proxy && typeof override.proxy === 'object') {
        result.proxy = { ...result.proxy, ...override.proxy };
      } else if (key === 'context' && result.context && typeof override.context === 'object') {
        result.context = { ...result.context, ...override.context };
      } else if (key === 'mcpServers' && result.mcpServers && typeof override.mcpServers === 'object') {
        result.mcpServers = { ...result.mcpServers, ...override.mcpServers };
      } else if (key === 'webSearch' && result.webSearch && typeof override.webSearch === 'object') {
        result.webSearch = { ...result.webSearch, ...override.webSearch };
      } else {
        result[key] = override[key];
      }
    }
  }
  return result;
}

function loadConfig(cliOptions = {}) {
  const globalConfig = loadJSONFile(getGlobalConfigPath());

  const projectDir = cliOptions.dir
    ? path.resolve(cliOptions.dir)
    : process.env.ANVIL_PROJECT_DIR
      ? path.resolve(process.env.ANVIL_PROJECT_DIR)
      : globalConfig?.defaultDir
        ? path.resolve(globalConfig.defaultDir)
        : process.cwd();

  const projectConfig = loadJSONFile(getProjectConfigPath(projectDir));

  let config = mergeConfig(DEFAULTS, globalConfig);
  config = mergeConfig(config, projectConfig);

  config.proxy = loadProxy(config.proxy);

  if (process.env.DEEPSEEK_API_KEY) {
    config.apiKey = process.env.DEEPSEEK_API_KEY;
  }

  // 联网搜索环境变量覆盖（参考 DEEPSEEK_API_KEY 模式）
  if (process.env.WEB_SEARCH_TIMEOUT) {
    const t = parseInt(process.env.WEB_SEARCH_TIMEOUT, 10);
    if (!Number.isNaN(t) && t > 0) {
      config.webSearch.timeout = t;
    }
  }
  if (process.env.WEB_SEARCH_DISABLED === '1') {
    config.webSearch.enabled = false;
  }

  if (cliOptions.model) {
    config.defaultModel = cliOptions.model;
  }
  if (cliOptions.thinkingMode !== undefined) {
    config.thinkingMode = cliOptions.thinkingMode;
  }

  const isFirstRun = !config.apiKey;

  config.projectDir = projectDir;
  config.globalConfigDir = getGlobalConfigDir();

  return { config, projectDir, isFirstRun };
}

function saveMCPConfig(projectDir, mcpServers) {
  const configPath = getProjectConfigPath(projectDir);
  try {
    // 确保 .anvil 目录存在
    const configDir = path.dirname(configPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    let config = {};
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      config = JSON.parse(content);
    }
    config.mcpServers = mcpServers;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`[config] 保存 MCP 配置失败: ${configPath}`, err.message);
    return false;
  }
}

module.exports = { loadConfig, getGlobalConfigDir, getGlobalConfigPath, getProjectConfigPath, saveMCPConfig };

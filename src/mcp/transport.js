'use strict';

function resolveHeaderEnvVars(headers, logger) {
  if (!headers) {return {};}
  const resolved = {};
  for (const [key, value] of Object.entries(headers)) {
    resolved[key] = String(value).replace(/\$\{(\w+)\}/g, (match, varName) => {
      if (process.env[varName]) {
        return process.env[varName];
      }
      if (logger) {
        logger.warn(`[mcp] Header "${key}" 中的环境变量 ${match} 未设置，使用空字符串`);
      }
      return '';
    });
  }
  return resolved;
}

function createTransport(serverName, config, logger) {
  if (!config || !config.transport) {
    throw new Error(`MCP 服务器 "${serverName}" 的 transport 字段缺失`);
  }

  switch (config.transport) {
    case 'stdio': {
      if (!config.command) {
        throw new Error(`MCP 服务器 "${serverName}" (stdio) 缺少 command 字段`);
      }
      const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
      const options = {
        command: config.command,
        args: config.args || [],
        stderr: 'pipe',  // 防止子进程输出污染 CLI 界面
      };
      // 可选的环境变量
      if (config.env && typeof config.env === 'object') {
        options.env = { ...process.env, ...config.env };
      }
      // 可选的工作目录
      if (config.cwd) {
        options.cwd = config.cwd;
      }
      return new StdioClientTransport(options);
    }

    case 'sse': {
      if (!config.url) {
        throw new Error(`MCP 服务器 "${serverName}" (sse) 缺少 url 字段`);
      }
      const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
      const resolvedHeaders = resolveHeaderEnvVars(config.headers, logger);
      return new SSEClientTransport(new URL(config.url), {
        headers: resolvedHeaders,
      });
    }

    case 'streamable-http':
    case 'http': {
      if (!config.url) {
        throw new Error(`MCP 服务器 "${serverName}" (${config.transport}) 缺少 url 字段`);
      }
      const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
      const resolvedHeaders = resolveHeaderEnvVars(config.headers, logger);
      return new StreamableHTTPClientTransport(new URL(config.url), {
        headers: resolvedHeaders,
      });
    }

    default:
      throw new Error(
        `MCP 服务器 "${serverName}" 不支持的传输类型 "${config.transport}"，支持: stdio、sse、http`
      );
  }
}

module.exports = { createTransport };

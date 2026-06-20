'use strict';

// MCP 管理工具：动态添加/移除/罗列 MCP 服务器

// 注册 MCP 管理工具
function registerMCPTools(toolRegistry, mcpManager, config, logger) {
  const { saveMCPConfig } = require('../config/loader');

  toolRegistry.register({
    name: 'mcp_add_server',
    description: '添加并连接一个新的 MCP 服务器。AI 可以通过此工具动态连接外部的 MCP 服务器，连接后该服务器的工具将自动注册为 mcp__<服务器名>__<工具名> 格式供后续调用。',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'MCP 服务器名称，将作为工具名前缀（mcp__<name>__<tool>），请使用简短有意义的英文名',
        },
        transport: {
          type: 'string',
          description: '传输协议类型',
          enum: ['stdio', 'sse', 'http'],
        },
        command: {
          type: 'string',
          description: '（stdio 模式必填）可执行命令，如 npx、node、uvx、python 等',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '（stdio 模式可选）命令行参数数组，如 ["-y", "@modelcontextprotocol/server-filesystem", "/path"]',
        },
        url: {
          type: 'string',
          description: '（sse/http 模式必填）MCP 服务器端点 URL',
        },
        headers: {
          type: 'object',
          description: '（sse/http 模式可选）HTTP 请求头，值中可使用 ${ENV_VAR} 引用环境变量',
          additionalProperties: { type: 'string' },
        },
        env: {
          type: 'object',
          description: '（stdio 模式可选）额外环境变量，如 { "NODE_ENV": "production" }',
          additionalProperties: { type: 'string' },
        },
        cwd: {
          type: 'string',
          description: '（stdio 模式可选）工作目录',
        },
      },
      required: ['name', 'transport'],
    },
    requiresConfirm: true,

    execute: async (params, context) => {
      const { name, transport, command, args, url, headers, env, cwd } = params;

      if (!name || !transport) {
        return { error: 'name 和 transport 是必填参数' };
      }

      const serverConfig = { transport };
      if (command) {serverConfig.command = command;}
      if (args) {serverConfig.args = args;}
      if (url) {serverConfig.url = url;}
      if (headers) {serverConfig.headers = headers;}
      if (env) {serverConfig.env = env;}
      if (cwd) {serverConfig.cwd = cwd;}

      if (transport === 'stdio' && !command) {
        return { error: 'stdio 模式必须提供 command 参数' };
      }
      if ((transport === 'sse' || transport === 'http') && !url) {
        return { error: `${transport} 模式必须提供 url 参数` };
      }

      try {
        const result = await mcpManager.addServer(name, serverConfig);

        if (result.status === 'connected') {
          // 持久化配置
          const allConfigs = mcpManager.getConfig();
          const saved = saveMCPConfig(context.projectDir, allConfigs);

          const toolNames = result.tools.map((t) => `mcp__${name}__${t.name}`).join(', ');

          return {
            success: true,
            server: name,
            status: 'connected',
            toolCount: result.tools.length,
            tools: toolNames || '无工具注册',
            configPersisted: saved,
            message: `MCP 服务器 "${name}" 已连接，注册了 ${result.tools.length} 个工具: ${toolNames || '无'}`,
          };
        }

        // 连接失败（重试耗尽）
        return {
          success: false,
          server: name,
          status: 'error',
          error: result.error || '连接失败',
          message: `MCP 服务器 "${name}" 连接失败: ${result.error || '未知错误'}`,
        };
      } catch (err) {
        return { error: `添加 MCP 服务器失败: ${err.message}` };
      }
    },
  });

  toolRegistry.register({
    name: 'mcp_remove_server',
    description: '断开并移除一个已连接的 MCP 服务器。移除后该服务器的所有工具将不再可用。',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '要移除的 MCP 服务器名称',
        },
      },
      required: ['name'],
    },
    requiresConfirm: true,

    execute: async (params, context) => {
      const { name } = params;

      if (!name) {
        return { error: 'name 是必填参数' };
      }

      if (!mcpManager.getStatus().find((s) => s.name === name)) {
        return { error: `MCP 服务器 "${name}" 不存在` };
      }

      try {
        await mcpManager.removeServer(name);

        // 持久化配置
        const allConfigs = mcpManager.getConfig();
        const saved = saveMCPConfig(context.projectDir, allConfigs);

        return {
          success: true,
          server: name,
          status: 'removed',
          configPersisted: saved,
          message: `MCP 服务器 "${name}" 已移除`,
        };
      } catch (err) {
        return { error: `移除 MCP 服务器失败: ${err.message}` };
      }
    },
  });

  toolRegistry.register({
    name: 'mcp_list_servers',
    description: '列出所有已配置的 MCP 服务器及其状态、注册的工具列表。用于查看 MCP 服务器运行状况。',
    parameters: {
      type: 'object',
      properties: {},
    },
    requiresConfirm: false,

    execute: async () => {
      const statusList = mcpManager.getStatus();

      if (statusList.length === 0) {
        return {
          servers: [],
          total: 0,
          summary: '当前没有配置任何 MCP 服务器',
          content: '当前没有配置任何 MCP 服务器',
        };
      }

      const serverInfo = statusList.map((s) => ({
        name: s.name,
        status: s.status,
        toolCount: s.tools.length,
        tools: s.tools.map((t) => `mcp__${s.name}__${t.name}`),
        error: s.error || undefined,
      }));

      const connected = serverInfo.filter((s) => s.status === 'connected').length;
      const totalTools = serverInfo.reduce((sum, s) => sum + s.toolCount, 0);

      return {
        servers: serverInfo,
        total: statusList.length,
        connected,
        totalTools,
        summary: `共 ${statusList.length} 个 MCP 服务器，${connected} 个已连接，${totalTools} 个工具`,
        content: `共 ${statusList.length} 个 MCP 服务器，${connected} 个已连接，${totalTools} 个工具`,
      };
    },
  });
}

module.exports = { registerMCPTools };

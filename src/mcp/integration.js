'use strict';

const _serverToolNames = new Map();

function makeToolName(serverName, toolName) {
  return `mcp__${serverName}__${toolName}`;
}

function hasConflict(toolRegistry, fullName) {
  const existing = toolRegistry.get(fullName);
  return !!existing;
}

function registerMCPServerTools(toolRegistry, mcpManager, serverName, tools) {
  if (!tools || tools.length === 0) {return;}

  const registeredNames = [];

  for (const tool of tools) {
    const fullName = makeToolName(serverName, tool.name);

    if (hasConflict(toolRegistry, fullName)) {
      console.warn(`[mcp] 工具名冲突，跳过: ${fullName}`);
      continue;
    }

    const toolDef = {
      name: fullName,
      description: `[MCP:${serverName}] ${tool.description || tool.name}`,
      parameters: tool.inputSchema || {
        type: 'object',
        properties: {},
      },
      requiresConfirm: false,

      execute: async (params, context) => {
        const result = await mcpManager.executeTool(serverName, tool.name, params);

        if (result.isError) {
          return { error: result.content || '工具执行失败' };
        }
        return {
          content: result.content || '',
          _meta: result._meta || undefined,
        };
      },
    };

    toolDef._mcp = {
      serverName,
      toolName: tool.name,
    };

    toolRegistry.register(toolDef);
    registeredNames.push(fullName);
  }

  _serverToolNames.set(serverName, registeredNames);
}

function unregisterMCPServerTools(toolRegistry, serverName) {
  const names = _serverToolNames.get(serverName);
  if (!names || names.length === 0) {return;}

  for (const name of names) {
    toolRegistry.unregister(name);
  }

  _serverToolNames.delete(serverName);
}

let _wired = false;

function wireMCPEvents(toolRegistry, mcpManager, logger) {
  // 幂等保护：防止重复绑定事件处理器
  if (_wired) {return;}
  _wired = true;

  mcpManager.on('server_connected', ({ name, tools }) => {
    registerMCPServerTools(toolRegistry, mcpManager, name, tools);
    if (logger) {
      logger.info(`[mcp] 工具已注册: ${name} (${tools.length} 个)`);
    }
  });

  mcpManager.on('server_disconnected', ({ name }) => {
    unregisterMCPServerTools(toolRegistry, name);
    if (logger) {
      logger.warn(`[mcp] 工具已卸载: ${name}`);
    }
  });

  mcpManager.on('server_error', ({ name }) => {
    unregisterMCPServerTools(toolRegistry, name);
  });
}

module.exports = {
  registerMCPServerTools,
  unregisterMCPServerTools,
  wireMCPEvents,
};

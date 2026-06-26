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

/**
 * 幂等保护：用嵌套 WeakMap 按对象身份追踪 (toolRegistry, mcpManager) 对。
 * key 必须是对象引用本身（Symbol.toString() 每次都不同，会导致 wire/unwire key 不一致）。
 */
const _wireHandlers = new WeakMap(); // toolRegistry -> WeakMap<mcpManager, handlers>

function _getHandlers(toolRegistry, mcpManager) {
  return _wireHandlers.get(toolRegistry)?.get(mcpManager);
}

function _setHandlers(toolRegistry, mcpManager, handlers) {
  let inner = _wireHandlers.get(toolRegistry);
  if (!inner) {
    inner = new WeakMap();
    _wireHandlers.set(toolRegistry, inner);
  }
  inner.set(mcpManager, handlers);
}

function wireMCPEvents(toolRegistry, mcpManager, logger) {
  // 幂等保护：同一对 (registry, manager) 只绑定一次
  if (_getHandlers(toolRegistry, mcpManager)) {return;}

  const handlers = {
    connected: ({ name, tools }) => {
      registerMCPServerTools(toolRegistry, mcpManager, name, tools);
      if (logger) {
        logger.info(`[mcp] 工具已注册: ${name} (${tools.length} 个)`);
      }
    },
    disconnected: ({ name }) => {
      unregisterMCPServerTools(toolRegistry, name);
      if (logger) {
        logger.warn(`[mcp] 工具已卸载: ${name}`);
      }
    },
    error: ({ name }) => {
      unregisterMCPServerTools(toolRegistry, name);
    },
  };

  mcpManager.on('server_connected', handlers.connected);
  mcpManager.on('server_disconnected', handlers.disconnected);
  mcpManager.on('server_error', handlers.error);

  _setHandlers(toolRegistry, mcpManager, handlers);
}

/** 解除事件绑定（测试用）— 只移除我们自己注册的 handler */
// 注: unwireMCPEvents 和 _resetWiredState 原本用于测试,但 WeakMap 难以干净清理,
// 实际测试场景直接重建 toolRegistry/mcpManager 即可,这两个函数无人调用,已删除。

module.exports = {
  wireMCPEvents,
};

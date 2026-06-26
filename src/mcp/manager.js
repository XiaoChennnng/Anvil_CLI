'use strict';

const { EventEmitter } = require('events');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { createTransport } = require('./transport');

const MAX_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;

class MCPManager extends EventEmitter {
  constructor(config, logger) {
    super();
    this._config = config || {};
    this._logger = logger;
    this._servers = new Map();
  }

  async start() {
    const servers = this._config.mcpServers || {};
    const names = Object.keys(servers);
    if (names.length === 0) {return;}

    if (this._logger) {
      this._logger.info(`[mcp] 启动 ${names.length} 个 MCP 服务器`);
    }

    // 并发出所有服务器的连接请求
    const promises = names.map((name) =>
      this.connectServer(name, servers[name], 0)
    );
    await Promise.allSettled(promises);
  }

  async addServer(name, serverConfig) {
    if (this._servers.has(name)) {
      // 已连接则报错
      const existing = this._servers.get(name);
      if (existing.status === 'connected' || existing.status === 'connecting') {
        throw new Error(`MCP 服务器 "${name}" 已存在且状态为 ${existing.status}`);
      }
      // 移除旧的重新添加
      await this.disconnectServer(name);
    }
    return this.connectServer(name, serverConfig, 0);
  }

  // 移除并断开 MCP 服务器
  async removeServer(name) {
    await this.disconnectServer(name);
  }

  // 连接 MCP 服务器（指数退避重试）
  async connectServer(name, serverConfig, retryCount) {
    // 创建或更新服务器状态记录
    const entry = {
      client: null,
      transport: null,
      tools: [],
      config: serverConfig,
      status: 'connecting',
      error: null,
      retryCount: retryCount || 0,
      _closingDeliberately: false,
    };
    this._servers.set(name, entry);
    this.emit('server_status_change', this.getStatus());

    try {
      if (this._logger) {
        this._logger.info(`[mcp] 连接服务器 "${name}" (${serverConfig.transport})`);
      }

      // 创建传输层
      const transport = createTransport(name, serverConfig, this._logger);
      entry.transport = transport;

      // 创建 MCP Client
      const client = new Client(
        { name: 'anvil', version: '0.1.0' },
        { capabilities: {} }
      );
      entry.client = client;

        transport.onclose = () => {
        this._onTransportClose(name);
      };

      // 处理传输错误事件
      transport.onerror = (err) => {
        this._onTransportError(name, err);
      };

      // 连接到服务器
      await client.connect(transport);

      // 发现工具
      let toolList = [];
      try {
        const toolResult = await client.listTools();
        toolList = toolResult?.tools || [];
      } catch (toolErr) {
        if (this._logger) {
          this._logger.warn(`[mcp] 服务器 "${name}" 工具发现失败: ${toolErr.message}`);
        }
      }

      // 更新状态
      entry.status = 'connected';
      entry.tools = toolList;
      entry.error = null;
      entry.retryCount = 0;

      if (this._logger) {
        this._logger.info(`[mcp] 服务器 "${name}" 已连接, ${toolList.length} 个工具`);
      }

      this.emit('server_connected', { name, tools: toolList });
      this.emit('server_status_change', this.getStatus());

      return { name, status: 'connected', tools: toolList, error: null };
    } catch (err) {
      entry.error = err.message;

      if (retryCount < MAX_RETRIES) {
        const delay = Math.min(
          BASE_RETRY_DELAY_MS * Math.pow(2, retryCount) + Math.random() * 1000,
          MAX_RETRY_DELAY_MS
        );

        if (this._logger) {
          this._logger.warn(
            `[mcp] 服务器 "${name}" 连接失败 (第 ${retryCount + 1}/${MAX_RETRIES} 次重试): ${err.message}`
          );
        }

        this.emit('server_status_change', this.getStatus());

        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.connectServer(name, serverConfig, retryCount + 1);
      }

      // 重试耗尽
      entry.status = 'error';

      if (this._logger) {
        this._logger.error(`[mcp] 服务器 "${name}" 连接失败，已耗尽重试: ${err.message}`);
      }

      this.emit('server_error', { name, error: err.message });
      this.emit('server_status_change', this.getStatus());

      return { name, status: 'error', tools: [], error: err.message };
    }
  }

  // 断开 MCP 服务器
  async disconnectServer(name) {
    const entry = this._servers.get(name);
    if (!entry) {return;}

    entry._closingDeliberately = true;

    // 清除重连定时器
    if (entry._reconnectTimer) {
      clearTimeout(entry._reconnectTimer);
      entry._reconnectTimer = null;
    }

    try {
      if (entry.client) {
        await entry.client.close();
      }
    } catch (err) {
      if (this._logger) {
        this._logger.warn(`[mcp] 断开服务器 "${name}" 时出错: ${err.message}`);
      }
    }

    this._servers.delete(name);
    this.emit('server_disconnected', { name });
    this.emit('server_status_change', this.getStatus());

    if (this._logger) {
      this._logger.info(`[mcp] 服务器 "${name}" 已断开`);
    }
  }

  // 断线重连
  async reconnectServer(name) {
    const entry = this._servers.get(name);
    if (!entry) {return;}

    // 清除旧重连定时器
    if (entry._reconnectTimer) {
      clearTimeout(entry._reconnectTimer);
      entry._reconnectTimer = null;
    }

    // 关闭旧 transport 和 client（防止泄漏）
    try {
      if (entry.client) {await entry.client.close();}
      if (entry.transport) {entry.transport.close();}
    } catch {} // 旧连接关闭失败不影响重连

    this.emit('server_disconnected', { name });

    if (this._logger) {
      this._logger.info(`[mcp] 服务器 "${name}" 断线重连...`);
    }

    entry.status = 'connecting';
    entry.client = null;
    entry.transport = null;
    this.emit('server_status_change', this.getStatus());

    // 重新连接（重置重试计数）
    await this.connectServer(name, entry.config, 0);
  }

  // 执行 MCP 工具
  async executeTool(serverName, toolName, params) {
    const entry = this._servers.get(serverName);
    if (!entry || entry.status !== 'connected') {
      return {
        content: [{ type: 'text', text: `MCP 服务器 "${serverName}" 未连接` }],
        isError: true,
      };
    }

    try {
      const result = await entry.client.callTool({
        name: toolName,
        arguments: params,
      });
      return this._formatToolResult(result);
    } catch (err) {
      return {
        content: [{ type: 'text', text: `工具 "${toolName}" 执行失败: ${err.message}` }],
        isError: true,
      };
    }
  }

  // 关闭所有服务器
  async stop() {
    if (this._servers.size === 0) {return;}

    if (this._logger) {
      this._logger.info(`[mcp] 关闭 ${this._servers.size} 个 MCP 服务器`);
    }

    // 清除重连定时器并标记主动关闭
    for (const [, entry] of this._servers) {
      entry._closingDeliberately = true;
      if (entry._reconnectTimer) {
        clearTimeout(entry._reconnectTimer);
        entry._reconnectTimer = null;
      }
    }

    const promises = [];
    for (const [name, entry] of this._servers) {
      if (entry.client) {
        promises.push(
          entry.client.close().catch((err) => {
            if (this._logger) {
              this._logger.warn(`[mcp] 关闭服务器 "${name}" 时出错: ${err.message}`);
            }
          })
        );
      }
      // 关闭 transport
      if (entry.transport) {
        try {entry.transport.close();} catch {}
      }
    }

    await Promise.allSettled(promises);
    this._servers.clear();

    if (this._logger) {
      this._logger.info('[mcp] 所有 MCP 服务器已关闭');
    }
  }

  // 获取服务器状态摘要
  getStatus() {
    const result = [];
    for (const [name, entry] of this._servers) {
      result.push({
        name,
        status: entry.status,
        tools: entry.tools.map((t) => ({
          name: t.name,
          description: t.description,
        })),
        error: entry.error,
      });
    }
    return result;
  }

  // 获取服务器配置
  getConfig() {
    const config = {};
    for (const [name, entry] of this._servers) {
      config[name] = entry.config;
    }
    return config;
  }

  /**
   * 处理传输意外关闭
   */
  _onTransportClose(name) {
    const entry = this._servers.get(name);
    if (!entry) {return;}

    // 主动关闭不重连
    if (entry._closingDeliberately) {return;}

    if (this._logger) {
      this._logger.warn(`[mcp] 服务器 "${name}" 连接意外关闭`);
    }

    entry.status = 'disconnected';

    // 2 秒后重连
    entry._reconnectTimer = setTimeout(() => {
      if (!this._servers.has(name)) {return;}
      this.reconnectServer(name).catch((err) => {
        if (this._logger) {
          this._logger.error(`[mcp] 服务器 "${name}" 重连失败: ${err.message}`);
        }
      });
    }, 2000);
  }

  /**
   * 处理传输错误事件
   */
  _onTransportError(name, err) {
    const entry = this._servers.get(name);
    if (!entry) {return;}

    entry.error = err.message;

    if (this._logger) {
      this._logger.error(`[mcp] 服务器 "${name}" 传输错误: ${err.message}`);
    }

    this.emit('server_error', { name, error: err.message });
  }

  // 格式化 MCP 工具执行结果
  _formatToolResult(result) {
    if (!result || !result.content) {
      return { content: [], isError: result?.isError || false };
    }

    // 提取 text 内容拼接为字符串
    const textParts = [];
    let nonTextCount = 0;

    for (const item of result.content) {
      if (item.type === 'text' && item.text) {
        textParts.push(item.text);
      } else {
        nonTextCount++;
      }
    }

    const rawContent = textParts.join('\n');

    // 检测并格式化搜索结果 JSON
    const formattedContent = this._formatSearchResults(rawContent);

    const formatted = {
      content: formattedContent,
      isError: result.isError || false,
    };

    if (nonTextCount > 0) {
      formatted._meta = { nonTextItems: nonTextCount };
    }

    return formatted;
  }

  // 格式化搜索结果 JSON
  _formatSearchResults(text) {
    try {
      const trimmed = text.trim();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return text;
      }

      const data = JSON.parse(trimmed);

      // 识别搜索结果结构
      let items = null;
      if (data.organic && Array.isArray(data.organic)) {
        items = data.organic;
      } else if (data.results && Array.isArray(data.results)) {
        items = data.results;
      } else if (data.items && Array.isArray(data.items)) {
        items = data.items;
      } else if (Array.isArray(data)) {
        items = data;
      }

      if (!items || items.length === 0) {
        return text;
      }

      // 多行可读格式
      const lines = [];
      lines.push(`[SEARCH_RESULTS:${items.length}]`);

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const title = item.title || '';
        const snippet = item.snippet || '';
        const date = item.date || '';
        const link = item.link || '';

        // 提取域名
        let domain = '';
        if (link) {
          try {
            domain = new URL(link).hostname.replace(/^www\./, '');
          } catch {}
        }

        // 清理摘要中的多余空白
        const cleanSnippet = snippet.replace(/\s+/g, ' ').trim();

        // 组装单个结果
        lines.push(`  标题: ${title}`);
        if (cleanSnippet) {lines.push(`  摘要: ${cleanSnippet}`);}
        if (date) {lines.push(`  日期: ${date}`);}
        if (domain) {lines.push(`  链接: ${domain}`);}
      }

      return lines.join('\n');
    } catch {
      return text;
    }
  }
}

module.exports = MCPManager;

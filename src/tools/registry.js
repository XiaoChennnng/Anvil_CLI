'use strict';

class ToolRegistry {
  constructor() {
    this._tools = new Map();
  }

  register(tool) {
    if (!tool.name || !tool.execute) {
      throw new Error(`工具注册失败: name 和 execute 是必填字段`);
    }
    this._tools.set(tool.name, tool);
  }

  get(name) {
    return this._tools.get(name);
  }

  requiresConfirm(name) {
    const tool = this._tools.get(name);
    return tool ? !!tool.requiresConfirm : false;
  }

  getOpenAITools() {
    const tools = [];
    for (const [, tool] of this._tools) {
      tools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      });
    }
    return tools;
  }

  async execute(name, params, context) {
    const tool = this._tools.get(name);
    if (!tool) {
      throw new Error(`未知工具: ${name}`);
    }
    return await tool.execute(params, context);
  }

  unregister(name) {
    return this._tools.delete(name);
  }

  list() {
    return Array.from(this._tools.keys());
  }
}

module.exports = ToolRegistry;

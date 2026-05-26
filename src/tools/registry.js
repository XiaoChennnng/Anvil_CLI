'use strict';

const path = require('path');
const { loadSkillsFromDir } = require('./skill');

class ToolRegistry {
  constructor() {
    this._tools = new Map();
    this._skills = new Map();
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

  // ==========================================================================
  // Skill 管理
  // ==========================================================================

  /**
   * 加载用户 Skills（从 .anvil/skills/ 目录）
   * @param {string} projectDir - 项目目录
   */
  loadSkills(projectDir) {
    const skillsDir = path.join(projectDir, '.anvil', 'skills');
    const loaded = loadSkillsFromDir(skillsDir);

    for (const [name, skill] of loaded) {
      this._skills.set(name, skill);
    }

    return this._skills.size;
  }

  /**
   * 获取 Skill
   */
  getSkill(name) {
    return this._skills.get(name);
  }

  /**
   * 检查输入是否匹配某个 Skill
   */
  matchSkill(input) {
    for (const [, skill] of this._skills) {
      if (skill.matches(input)) {
        return skill;
      }
    }
    return null;
  }

  /**
   * 列出所有已加载的 Skills
   */
  listSkills() {
    const result = [];
    for (const [, skill] of this._skills) {
      result.push(skill.getInfo());
    }
    return result;
  }
}

module.exports = ToolRegistry;

'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================================
// 常量定义
// ============================================================================

// 技能分类
const SKILL_CATEGORIES = {
  ANALYZE: 'analyze',   // 代码分析、架构研究
  IMPLEMENT: 'implement', // 代码生成、重构
  DEBUG: 'debug',       // 问题诊断、修复
  REVIEW: 'review',     // 代码审查、质量检查
  ORCHESTRATE: 'orchestrate',  // 编排协调
};

// ============================================================================
// Skill 类
// ============================================================================

class Skill {
  constructor(filePath) {
    this.path = filePath;
    this.name = '';
    this.description = '';
    this.triggers = [];
    this.content = '';
    this.tools = [];
    this.category = SKILL_CATEGORIES.IMPLEMENT;  // 默认分类
    this.disableModelInvocation = false;  // 是否禁用自动加载
    this._loaded = false;
  }

  /**
   * 加载并解析 Skill 文件
   */
  load() {
    if (this._loaded) {return;}
    try {
      const content = fs.readFileSync(this.path, 'utf8');
      this._parse(content);
      this._loaded = true;
    } catch (err) {
      throw new Error(`加载 Skill 失败: ${this.path} - ${err.message}`);
    }
  }

  /**
   * 解析 YAML frontmatter 和 Markdown 内容
   */
  _parse(content) {
    // 解析 frontmatter (--- ... ---)
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const fmContent = fmMatch[1];
      this._parseFrontmatter(fmContent);

      // 剩余部分为 markdown 内容
      this.content = content.slice(fmMatch[0].length).trim();
    } else {
      // 没有 frontmatter，整个文件就是内容
      this.content = content;
      // 从文件名推导 name
      this.name = path.basename(this.path, '.md');
    }
  }

  /**
   * 解析 frontmatter 内容
   */
  _parseFrontmatter(content) {
    const lines = content.split('\n');
    let currentKey = '';
    let inList = false;
    const metadata = {};

    for (const line of lines) {
      const trimmed = line.trim();

      // Key-Value 行
      if (/^[a-zA-Z_][a-zA-Z0-9_]*:/.test(trimmed)) {
        inList = false;
        const colonIdx = trimmed.indexOf(':');
        currentKey = trimmed.slice(0, colonIdx).trim();
        const value = trimmed.slice(colonIdx + 1).trim();

        if (value === '') {
          metadata[currentKey] = {};
          inList = currentKey.endsWith('s') || false; // 简单启发式
        } else {
          metadata[currentKey] = this._parseValue(value);
        }
      } else if (trimmed.startsWith('-') && (inList || currentKey === 'triggers' || currentKey === 'tools')) {
        // 列表项
        const value = trimmed.slice(1).trim();
        if (!Array.isArray(metadata[currentKey])) {
          metadata[currentKey] = [];
        }
        if (value) {
          metadata[currentKey].push(this._parseValue(value));
        }
      } else if (trimmed === '' && metadata[currentKey] && Array.isArray(metadata[currentKey])) {
        // 空行，可能开始列表
      } else if (trimmed.startsWith('#')) {
        // 注释行
      }
    }

    // 应用 metadata
    this.name = metadata.name || path.basename(this.path, '.md');
    this.description = metadata.description || '';
    this.triggers = Array.isArray(metadata.triggers) ? metadata.triggers : [];
    this.tools = Array.isArray(metadata.tools) ? metadata.tools : [];

    // 支持 disable-model-invocation 字段
    if (metadata.disable_model_invocation === true || metadata.disable_model_invocation === 'true') {
      this.disableModelInvocation = true;
    }

    // 支持 category 分类
    if (metadata.category) {
      const cat = metadata.category.toLowerCase();
      if (Object.values(SKILL_CATEGORIES).includes(cat)) {
        this.category = cat;
      }
    }
  }

  /**
   * 解析单个值（处理引号）
   */
  _parseValue(value) {
    // 去除引号
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
    return value;
  }

  /**
   * 获取 Skill 的完整内容（加载后）
   */
  getContent() {
    this.load();
    return this.content;
  }

  /**
   * 检查是否匹配给定输入
   */
  matches(input) {
    this.load();
    const lower = input.toLowerCase().trim();

    // 检查触发词
    for (const trigger of this.triggers) {
      const triggerLower = trigger.toLowerCase();
      if (lower === triggerLower || lower.startsWith(triggerLower + ' ') || lower.includes(triggerLower)) {
        return true;
      }
    }

    // 检查 name 匹配
    if (lower.startsWith('/' + this.name.toLowerCase())) {
      return true;
    }

    return false;
  }

  /**
   * 获取 Skill 信息摘要
   */
  getInfo() {
    this.load();
    return {
      name: this.name,
      description: this.description,
      triggers: this.triggers,
      tools: this.tools,
      category: this.category,
      disableModelInvocation: this.disableModelInvocation,
      path: this.path,
    };
  }

  /**
   * 检查 Skill 是否应该自动加载
   * disable_model_invocation 为 true 时不自动加载
   */
  shouldAutoLoad() {
    return !this.disableModelInvocation;
  }
}

/**
 * 从目录加载所有 Skills
 * @param {string} skillsDir - Skills 目录
 * @param {Object} [options] - 加载选项
 * @param {boolean} [options.skipDisabled=false] - 是否跳过 disable_model_invocation 的 skill
 * @param {string} [options.category] - 按分类过滤
 * @returns {Map<string, Skill>}
 */
function loadSkillsFromDir(skillsDir, options = {}) {
  const skills = new Map();

  if (!fs.existsSync(skillsDir)) {
    return skills;
  }

  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(skillsDir, entry.name);

      if (entry.isDirectory()) {
        // Skill 目录: skill-name/SKILL.md
        const skillFile = path.join(fullPath, 'SKILL.md');
        if (fs.existsSync(skillFile)) {
          try {
            const skill = new Skill(skillFile);
            skill.load();

            // 如果启用 skipDisabled 且 skill 禁用自动加载，跳过
            if (options.skipDisabled && skill.disableModelInvocation) {
              continue;
            }

            // 如果指定了 category，按分类过滤
            if (options.category && skill.category !== options.category) {
              continue;
            }

            skills.set(skill.name, skill);
          } catch (err) {
            console.warn(`加载 Skill 失败: ${skillFile} - ${err.message}`);
          }
        }
      } else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name === 'SKILL.md')) {
        // 直接的 .md 文件
        try {
          const skill = new Skill(fullPath);
          skill.load();

          if (options.skipDisabled && skill.disableModelInvocation) {
            continue;
          }

          if (options.category && skill.category !== options.category) {
            continue;
          }

          skills.set(skill.name, skill);
        } catch (err) {
          console.warn(`加载 Skill 失败: ${fullPath} - ${err.message}`);
        }
      }
    }
  } catch (err) {
    console.warn(`读取 Skills 目录失败: ${skillsDir} - ${err.message}`);
  }

  return skills;
}

module.exports = {
  Skill,
  loadSkillsFromDir,
  SKILL_CATEGORIES,
};
'use strict';

const fs = require('fs');
const path = require('path');

class Skill {
  constructor(filePath) {
    this.path = filePath;
    this.name = '';
    this.description = '';
    this.triggers = [];
    this.content = '';
    this.tools = [];
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
      path: this.path,
    };
  }
}

/**
 * 从目录加载所有 Skills
 */
function loadSkillsFromDir(skillsDir) {
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

module.exports = { Skill, loadSkillsFromDir };
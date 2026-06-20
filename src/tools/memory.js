'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Memory 工具：管理 .anvil/Memory.md（用户长期记忆）
 *
 * 设计目标：
 * - 软上限 5000 tokens（不强制阻断，但超限时警告 AI）
 * - AI 自由判断何时写入（不是每轮必写，而是当用户偏好/规则出现时写入）
 * - 自动按 section 追加，不破坏现有结构
 * - 原子写入（先写 tmp 再 rename）
 */
function registerMemoryTools(toolRegistry, contextManager, config = {}) {
  const memoryCfg = config.memory || {};
  const maxTokens = memoryCfg.maxTokens || 5000;
  const memoryFilePath = path.join(
    contextManager.projectDir,
    '.anvil',
    memoryCfg.fileName || 'Memory.md',
  );

  /**
   * 估算文本 tokens（CJK 感知，简单按字符）
   */
  function estimateTokens(text) {
    if (!text) {return 0;}
    // CJK 字符按 1.5 算；ASCII 按 0.4 算；混合约等于 chars * 0.6
    let total = 0;
    for (const ch of text) {
      if (/[一-龥＀-￯]/.test(ch)) {
        total += 1.5;
      } else if (/\s/.test(ch)) {
        total += 0.3;
      } else {
        total += 0.4;
      }
    }
    return Math.ceil(total);
  }

  /**
   * 读取 Memory.md
   */
  function readMemory() {
    try {
      return fs.readFileSync(memoryFilePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {return '';}
      throw err;
    }
  }

  /**
   * 写入 Memory.md（原子）
   */
  function writeMemory(content) {
    fs.mkdirSync(path.dirname(memoryFilePath), { recursive: true });
    const tmpPath = memoryFilePath + '.tmp';
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, memoryFilePath);
    // 通知 ContextManager 清缓存，下次 assembleMessages 时重新加载
    if (contextManager && typeof contextManager.invalidateMemoryCache === 'function') {
      contextManager.invalidateMemoryCache();
    }
  }

  /**
   * 解析所有 section
   * 返回 [{ title, body, lineStart }]
   */
  function parseSections(content) {
    const lines = content.split('\n');
    const sections = [];
    let current = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 匹配 ## 或 ### 开头的标题
      const m = line.match(/^(#{1,3})\s+(.+)$/);
      if (m) {
        if (current) {sections.push(current);}
        current = {
          level: m[1].length,
          title: m[2].trim(),
          body: [],
          lineStart: i,
        };
      } else if (current) {
        current.body.push(line);
      } else {
        // 头部（## 之前的所有内容）
        if (!sections.preamble) {sections.preamble = [];}
        sections.preamble.push(line);
      }
    }
    if (current) {sections.push(current);}
    return sections;
  }

  /**
   * 找到或创建 section
   */
  function findOrCreateSection(sections, title) {
    let section = sections.find(s => s.title === title);
    if (!section) {
      section = { level: 2, title, body: [], lineStart: -1 };
      sections.push(section);
    }
    return section;
  }

  // ────────────────── memory_read ──────────────────
  toolRegistry.register({
    name: 'memory_read',
    description: '读取 .anvil/Memory.md 全部内容（用户长期记忆）。当需要回顾用户偏好/规则/约定时调用。返回当前完整文本和 token 估算。',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      try {
        const content = readMemory();
        const tokens = estimateTokens(content);
        return {
          success: true,
          path: memoryFilePath,
          exists: content.length > 0,
          content: content || '(空 — Memory.md 不存在)',
          tokens,
          maxTokens,
          overLimit: tokens > maxTokens,
        };
      } catch (err) {
        return { error: `读取 Memory.md 失败: ${err.message}` };
      }
    },
  });

  // ────────────────── memory_write ──────────────────
  toolRegistry.register({
    name: 'memory_write',
    description: `完整重写 .anvil/Memory.md。慎用！会覆盖现有内容。推荐使用 memory_append 增量写入。仅在需要整体重构 Memory.md 时调用。软上限 ${maxTokens} tokens。`,
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '完整的 Memory.md 内容（Markdown 格式）',
        },
      },
      required: ['content'],
    },
    requiresConfirm: true,
    execute: async (params) => {
      const content = params.content || '';
      if (!content.trim()) {
        return { error: 'content 不能为空' };
      }
      const tokens = estimateTokens(content);
      if (tokens > maxTokens * 1.5) {
        return {
          error: `内容 ${tokens} tokens 严重超限（上限 ${maxTokens}），拒绝写入。请精简或分段写入。`,
          tokens,
          maxTokens,
        };
      }
      try {
        writeMemory(content);
        return {
          success: true,
          path: memoryFilePath,
          tokens,
          maxTokens,
          warning: tokens > maxTokens
            ? `已写入但超软上限（${tokens} > ${maxTokens}），下次加载会被截断`
            : null,
        };
      } catch (err) {
        return { error: `写入失败: ${err.message}` };
      }
    },
  });

  // ────────────────── memory_append ──────────────────
  toolRegistry.register({
    name: 'memory_append',
    description: `追加新条目到 Memory.md 的指定 section。AI 应在检测到用户表达偏好、规则、约定、长期待办时调用，自动加时间戳。`,
    parameters: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          description: '目标 section 标题（自动创建如果不存在）。如 "用户偏好"、"项目规则"、"常用约定"、"待办事项"',
        },
        entry: {
          type: 'string',
          description: '要追加的条目内容（单行或简短 Markdown）。建议一句话概括',
        },
        asSubsection: {
          type: 'boolean',
          default: false,
          description: '是否作为子条目（### 标题 + 内容块）。适合多行/详细描述',
        },
        subsectionTitle: {
          type: 'string',
          description: '子条目标题（asSubsection=true 时使用）',
        },
      },
      required: ['section', 'entry'],
    },
    execute: async (params) => {
      const sectionName = (params.section || '').trim();
      const entry = (params.entry || '').trim();
      if (!sectionName || !entry) {
        return { error: 'section 和 entry 都不能为空' };
      }

      try {
        const current = readMemory();
        const sections = parseSections(current);
        const section = findOrCreateSection(sections, sectionName);
        const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');

        let newEntry;
        if (params.asSubsection && params.subsectionTitle) {
          newEntry = `\n### ${params.subsectionTitle} (${timestamp})\n\n${entry}\n`;
        } else {
          newEntry = `- ${entry} _(记录于 ${timestamp})_\n`;
        }

        // 插入到 section body 的开头（最新内容优先可见）
        section.body.unshift(newEntry);

        // 重建全文
        const rebuilt = rebuildContent(sections);
        const tokens = estimateTokens(rebuilt);

        if (tokens > maxTokens * 1.3) {
          return {
            error: `追加后 ${tokens} tokens 超上限（${maxTokens}），已阻止写入。请先精简历史条目。`,
            tokens,
            maxTokens,
          };
        }

        writeMemory(rebuilt);
        return {
          success: true,
          path: memoryFilePath,
          section: sectionName,
          tokens,
          maxTokens,
          warning: tokens > maxTokens
            ? `已追加但总 ${tokens} tokens 超过软上限 ${maxTokens}`
            : null,
        };
      } catch (err) {
        return { error: `追加失败: ${err.message}` };
      }
    },
  });

  // ────────────────── memory_search ──────────────────
  toolRegistry.register({
    name: 'memory_search',
    description: '在 Memory.md 中搜索关键词，返回匹配的 section 和行。用于快速定位历史记忆条目。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词（大小写不敏感）',
        },
        contextLines: {
          type: 'number',
          default: 1,
          description: '匹配行前后保留几行作为上下文',
        },
      },
      required: ['query'],
    },
    execute: async (params) => {
      const query = (params.query || '').trim();
      if (!query) {return { error: 'query 不能为空' };}

      try {
        const content = readMemory();
        if (!content) {return { success: true, matches: [], totalMatches: 0 };}

        const lines = content.split('\n');
        const lowerQuery = query.toLowerCase();
        const ctx = Math.max(0, params.contextLines || 1);
        const matches = [];

        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(lowerQuery)) {
            const start = Math.max(0, i - ctx);
            const end = Math.min(lines.length - 1, i + ctx);
            matches.push({
              line: i + 1,
              text: lines[i],
              context: lines.slice(start, end + 1).join('\n'),
            });
          }
        }

        return {
          success: true,
          query,
          totalMatches: matches.length,
          matches: matches.slice(0, 20),
        };
      } catch (err) {
        return { error: `搜索失败: ${err.message}` };
      }
    },
  });

  /**
   * 重建全文（用于追加后写回）
   */
  function rebuildContent(sections) {
    const parts = [];
    if (sections.preamble && sections.preamble.length > 0) {
      parts.push(sections.preamble.join('\n').trim());
    }
    for (const s of sections) {
      const prefix = '#'.repeat(s.level);
      parts.push(`${prefix} ${s.title}`);
      parts.push(s.body.join('\n').trimEnd());
    }
    return parts.join('\n\n') + '\n';
  }
}

module.exports = { registerMemoryTools };
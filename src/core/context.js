'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

/**
 * ============================================================================
 * 精密上下文管理系统 — 默认 1M 上下文窗口
 * ============================================================================
 *
 * 架构设计:
 * ┌─────────────────────────────────────────────────────────────┐
 * │  Tier 0: 不可驱逐层 (Immutable)                               │
 * │  System Prompt + Tool Definitions (~3-5K)                    │
 * ├─────────────────────────────────────────────────────────────┤
 * │  Tier 1: 静态缓存友好层 (Cache-Friendly)                      │
 * │  Project Overview: 目录树 + 关键文件摘要 (~10-20K)            │
 * │  放在消息最前端 → 最大化 DeepSeek 硬盘缓存命中 → 1/10 费用    │
 * ├─────────────────────────────────────────────────────────────┤
 * │  Tier 2: 工作记忆层 (Working Memory)                          │
 * │  最近 N 轮对话 (动态分配, ~100K-150K)                         │
 * │  包含 reasoning_content + tool_calls 完整保留               │
 * ├─────────────────────────────────────────────────────────────┤
 * │  Tier 3: 文件上下文层 (File Context)                          │
 * │  按需加载的文件内容 (~30K-50K)                                │
 * │  LRU 淘汰 + 使用频率追踪                                      │
 * ├─────────────────────────────────────────────────────────────┤
 * │  Tier 4: 压缩存档层 (Compressed Archive)                      │
 * │  历史对话的多级压缩版本 (~10K-20K)                            │
 * │  L1: 详细摘要 | L2: 概要摘要 | L3: 仅关键决策                 │
 * ├─────────────────────────────────────────────────────────────┤
 * │  Tier 5: 瞬时层 (Transient)                                   │
 * │  工具调用结果 (执行完立即清理，不占持久空间)                   │
 * └─────────────────────────────────────────────────────────────┘
 *
 * 窗口配置:
 * - STANDARD (1M):   默认上下文窗口（模型支持 1M）
 * - EXTENDED (1M):   复杂项目分析
 * - MAXIMUM (1M):    极限场景（大量文件审查、超长对话）
 *
 * 压缩触发线 (占窗口 %):
 * - 级别 0  SOFT_WARN:  70% — 控制台提示
 * - 级别 1  LIGHT_COMP: 80% — 轻度裁剪文件上下文
 * - 级别 2  MED_COMP:   90% — 压缩早期对话为 L1 详细摘要
 * - 级别 3  HEAVY_COMP: 95% — 压缩为 L2 概要摘要
 * - 级别 4  CRITICAL:   98% — L3 仅保留关键决策 + 最近 2 轮
 *
 * 缓存命中优化:
 * - Tier 0 + Tier 1 始终在消息列表最前端（前缀固定 → 最大化缓存命中）
 * - 消息顺序严格保持: [System] [ProjectOverview] [Archive] [History...] [User]
 * - 相同前缀在不同请求间可复用硬盘缓存 → 输入费用降至 1/10
 */

// ============================================================================
// 常量定义
// ============================================================================

// 忽略的目录
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.anvil', 'dist', 'build',
  '.next', '.nuxt', 'cache', '__pycache__', '.venv',
  'venv', 'env', '.svn', 'coverage',
]);

// 窗口大小配置（真正分层：EXTENDED 开大点给复杂项目，MAXIMUM 极限全量）
const WINDOW_SIZES = {
  STANDARD: 1_000_000,  // 1M — 默认（模型支持 1M 上下文）
  EXTENDED: 1_200_000,  // 1.2M — 复杂项目分析
  MAXIMUM:  1_500_000,  // 1.5M — 极限场景（大量文件审查、超长对话）
};

// 压缩级别及触发阈值（占当前窗口 %）
const COMPRESSION_LEVELS = {
  NONE:       { level: 0, threshold: 0.00, label: '正常' },
  SOFT_WARN:  { level: 1, threshold: 0.70, label: '⚠ 上下文偏高' },
  LIGHT_COMP: { level: 2, threshold: 0.80, label: '🔧 轻度压缩' },
  MED_COMP:   { level: 3, threshold: 0.90, label: '📦 中度压缩' },
  HEAVY_COMP: { level: 4, threshold: 0.95, label: '📚 深度压缩' },
  CRITICAL:   { level: 5, threshold: 0.98, label: '🚨 极限压缩' },
};

// Token 估算缓存（LRU，避免重复 O(n) 字符遍历）
const _tokenCache = new Map();
const TOKEN_CACHE_MAX = 500;
let _tokenCacheSize = 0;

// Token 估算缓存键（用字符串前 200 字 + 长度做键，兼顾准确和性能）
function _makeTokenCacheKey(text) {
  if (!text || typeof text !== 'string') {return '';}
  if (text.length <= 200) {return text;}
  // 长文本用前缀+后缀+长度做摘要，避免存大key
  return text.slice(0, 100) + '|' + text.slice(-100) + '|' + text.length;
}

function _getCachedTokenCount(text) {
  if (!text || typeof text !== 'string') {return undefined;}
  const key = _makeTokenCacheKey(text);
  if (!key) {return undefined;}
  if (_tokenCache.has(key)) {
    const val = _tokenCache.get(key);
    // LRU 提升：删除再设置以更新顺序
    _tokenCache.delete(key);
    _tokenCache.set(key, val);
    return val;
  }
  return undefined;
}

function _setCachedTokenCount(text, count) {
  if (!text || typeof text !== 'string') {return;}
  const key = _makeTokenCacheKey(text);
  if (!key) {return;}
  if (_tokenCache.has(key)) {
    _tokenCache.delete(key);
  } else {
    _tokenCacheSize++;
  }
  _tokenCache.set(key, count);
  // 超限淘汰
  if (_tokenCacheSize > TOKEN_CACHE_MAX) {
    const firstKey = _tokenCache.keys().next().value;
    if (firstKey !== undefined) {
      _tokenCache.delete(firstKey);
      _tokenCacheSize--;
    }
  }
}

// Token 预算分配（占窗口 %）
const BUDGET = {
  IMMUTABLE:    0.02,   // Tier 0: System Prompt + Tool Defs
  CACHE_FRIENDLY: 0.08, // Tier 1: Project Overview (静态，最大化缓存命中)
  WORKING_MEM:  0.50,   // Tier 2: Recent Rounds
  FILE_CONTEXT: 0.25,   // Tier 3: File Contexts
  ARCHIVE:      0.10,   // Tier 4: Compressed Archive
  RESERVE:      0.05,   // 安全余量
};

// 文件上下文 LRU 配置
const FILE_CONTEXT_MAX_ENTRIES = 30;
const FILE_CONTEXT_MAX_TOKENS = 15000; // ~50KB at 0.3 tokens/char, 统一用 token 单位

// 工具调用重要性权重（按工具类型差异化评分）
const TOOL_IMPORTANCE = {
  write_file:        { score: 1.0,  category: 'mutation' },
  delete_file:       { score: 0.95, category: 'mutation' },
  create_directory:  { score: 0.9,  category: 'mutation' },
  execute_command:   { score: 0.85, category: 'execution' },
  read_file:         { score: 0.5,  category: 'read' },
  search:            { score: 0.4,  category: 'read' },
  list_directory:    { score: 0.3,  category: 'read' },
  _default:          { score: 0.6,  category: 'other' },
};

// 内容类型 token 比率（用于 content-aware estimation）
const CONTENT_TOKEN_RATIOS = {
  code_block:  0.40,    // ~2.5 chars/token — 代码紧凑
  markdown:    0.35,    // ~2.85 chars/token — Markdown 混合
  json:        0.45,    // ~2.2 chars/token — JSON 高密度
  plain_text:  0.285,   // ~3.5 chars/token — 自然语言
  cjk:         1.5,     // ~0.67 char/token — 中文等
};

// 压缩遗憾检测模式（用户消息中的关键词）
const REGRET_PATTERNS = [
  /(?:^|[^a-zA-Z])(?:刚才|之前|刚刚).*(?:写|说|改|删)(?:的|了)/,
  /\b(?:undo|restore)\b|恢复|还原|撤销|回退/,
  /之前的版本|旧版本|上一个|上一版/,
  /(?:^|[^a-zA-Z])(?:你怎么|为什么你).*(?:删|改|丢|忘)/,
  /回来(?:\b|吧)|找不到了|不见了/,
  /不是这个|不对|错了|搞错了/,
  /回到(?:\b|之前|回退到)/,
];

// 消息权重 (用于重要性评分)
const MSG_WEIGHTS = {
  user:          1.0,   // 用户消息最重要
  assistant_tool: 0.9,  // 带工具调用的 assistant
  assistant:     0.6,   // 普通 assistant
  tool:          0.3,   // 工具结果
};

// 对话相位（影响压缩阈值和保留轮数）
const CONVERSATION_PHASES = {
  EXPLORE:   { thresholdShift: +0.05, keepRounds: 8,  description: '探索代码库' },
  IMPLEMENT: { thresholdShift: 0,     keepRounds: 6,  description: '开发实现' },
  DEBUG:     { thresholdShift: -0.03, keepRounds: 4,  description: '调试修复' },
  REVIEW:    { thresholdShift: 0,     keepRounds: 5,  description: '代码审查' },
};

// ============================================================================
// Token 估算
// ============================================================================

/**
 * 内容感知 Token 估算
 * - 检测代码块 (```)、JSON、普通文本
 * - 不同内容类型使用不同比率，同一签名向后兼容
 * - 中文 ~1.5 tokens/char, 代码 ~2.5 char/token, 英文 ~3.5 char/token
 */
function estimateTokenCount(text) {
  if (!text) {return 0;}
  if (typeof text !== 'string') {return 0;}

  // 缓存查询
  const cached = _getCachedTokenCount(text);
  if (cached !== undefined) {return cached;}

  const segments = _segmentContentType(text);
  let total = 0;
  for (const seg of segments) {
    total += _countCharsByRatio(seg.text, seg.ratio);
  }
  const result = Math.ceil(total);
  _setCachedTokenCount(text, result);
  return result;
}

/**
 * 将文本分割为不同类型的内容块
 * @param {string} text
 * @returns {Array<{text: string, ratio: number}>}
 */
function _segmentContentType(text) {
  const segments = [];

  let lastEnd = 0;
  const fencePattern = /```[\s\S]*?```/g;
  let match;

  while ((match = fencePattern.exec(text)) !== null) {
    if (match.index > lastEnd) {
      segments.push({ text: text.slice(lastEnd, match.index), ratio: CONTENT_TOKEN_RATIOS.markdown });
    }
    segments.push({ text: match[0], ratio: CONTENT_TOKEN_RATIOS.code_block });
    lastEnd = match.index + match[0].length;
  }
  if (lastEnd < text.length) {
    segments.push({ text: text.slice(lastEnd), ratio: CONTENT_TOKEN_RATIOS.markdown });
  }

  // 无代码块 → 全段检测
  if (segments.length === 0) {
    segments.push(..._detectSingleContentType(text));
  }

  return segments;
}

/**
 * 检测单一段落的内容类型
 */
function _detectSingleContentType(text) {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) {return [{ text, ratio: CONTENT_TOKEN_RATIOS.plain_text }];}

  // JSON 检测: 大多数行以 JSON 结构开始
  const jsonLike = lines.every((l) => {
    const t = l.trim();
    return t.startsWith('{') || t.startsWith('[') || t.startsWith('"') ||
           t === '}' || t === ']' || t.endsWith(',') || t.endsWith('},') || t.endsWith('],');
  });
  if (jsonLike && lines.length > 1) {
    return [{ text, ratio: CONTENT_TOKEN_RATIOS.json }];
  }

  // 内联代码检测
  const inlineCodeRatio = _estimateInlineCodeRatio(text);
  if (inlineCodeRatio > 0.3) {
    return [{ text, ratio: CONTENT_TOKEN_RATIOS.code_block }];
  }

  return [{ text, ratio: CONTENT_TOKEN_RATIOS.plain_text }];
}

/**
 * 估算文本中内联代码比例
 */
function _estimateInlineCodeRatio(text) {
  if (text.length < 20) {return 0;}
  const codeLike = text.match(/[{}[\]();=<>+*/&|!~^%#@]/g);
  if (!codeLike) {return 0;}
  return codeLike.length / text.length;
}

/**
 * 按比率统计字符 tokens（处理 CJK / 空白 / 其他）
 */
function _countCharsByRatio(text, baseRatio) {
  let count = 0;
  for (const char of text) {
    const cp = char.codePointAt(0);
    if ((cp >= 0x4e00 && cp <= 0x9fff) ||
        (cp >= 0x3400 && cp <= 0x4dbf) ||
        (cp >= 0xf900 && cp <= 0xfaff)) {
      count += CONTENT_TOKEN_RATIOS.cjk; // CJK
    } else if (char === ' ' || char === '\n' || char === '\t' || char === '\r') {
      count += 0; // 空白不计
    } else {
      count += baseRatio; // 按内容类型比率
    }
  }
  return count;
}

/**
 * 估算消息列表的 token 总数
 */
// 消息 token 缓存
const _msgTokenCache = new Map();
const MSG_TOKEN_CACHE_MAX = 20;

function estimateMessageTokens(messages) {
  if (!messages || !Array.isArray(messages)) {return 0;}

  // 用消息列表的指纹做缓存键
  const cacheKey = _messagesFingerprint(messages);
  if (cacheKey) {
    const cached = _msgTokenCache.get(cacheKey);
    if (cached !== undefined) {return cached;}
  }

  let total = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    total += estimateTokenCount(msg.content || '');
    total += estimateTokenCount(msg.reasoning_content || '');
    total += 6; // 消息结构开销
  }

  if (cacheKey) {
    // LRU
    if (_msgTokenCache.has(cacheKey)) {
      _msgTokenCache.delete(cacheKey);
    }
    _msgTokenCache.set(cacheKey, total);
    if (_msgTokenCache.size > MSG_TOKEN_CACHE_MAX) {
      const first = _msgTokenCache.keys().next().value;
      if (first !== undefined) {_msgTokenCache.delete(first);}
    }
  }

  return total;
}

/**
 * 生成消息列表的快速指纹（用于 token 缓存键）
 * 取最后几条消息的关键属性做哈希，避免全量遍历
 */
function _messagesFingerprint(messages) {
  if (!messages || messages.length === 0) {return null;}
  // 取长度、最后 3 条消息的内容长度、角色
  const len = messages.length;
  const last3 = messages.slice(-3).map(m => {
    const c = (m.content || '').length;
    const r = (m.reasoning_content || '').length;
    const role = m.role || '';
    return `${role}:${c}:${r}`;
  }).join('|');
  return `${len}|${last3}`;
}

// ============================================================================
// 上下文管理器
// ============================================================================

class ContextManager {
  constructor(config) {
    this.config = config || {};
    this.projectDir = config.projectDir || process.cwd();

    // 从配置读取上下文参数（支持 defaults.js 中的 context 块）
    this._contextCfg = this.config.context || {};
    this.windowSize = this._contextCfg.windowSize || config.windowSize || WINDOW_SIZES.STANDARD;
    this.maxTokens = this.windowSize;
    this._compressThresholds = this._contextCfg.compressThresholds || null;
    this._keepRoundsCfg = this._contextCfg.keepRounds || null;

    // 项目概览缓存
    this.projectOverview = null;

    // 文件上下文 (LRU Map)
    this._fileContexts = new Map();
    this._fileContextTotalTokens = 0;

    // 压缩统计
    this.compressionStats = {
      totalCompressions: 0,
      totalTokensSaved: 0,
      lastCompression: null,
    };

    // 实际运行时 token 追踪（按 tier，由 _computeTierTokens 填充）
    this._tierTokens = {};

    // 对话相位追踪
    this._phaseTracker = {
      phase: 'EXPLORE',
      toolSequence: [],
      messageCountSincePhaseCheck: 0,
    };

    // Token 估算校准
    this._calibration = {
      samples: [],
      correctionFactor: 1.0,
      alpha: 0.2,
      lastCalibrated: null,
    };

    // 预测性文件预取 — import/require 关联图
    this._prefetchHints = {
      relatedFiles: new Map(),  // filePath → Set(relatedPaths)
    };

    // 压缩遗憾检测
    this._regretTracker = {
      count: 0,
      patterns: [],
      lastReported: null,
    };

    // 功能开关（可通过 config 禁用）
    this._enablePhaseDetection = config.adaptiveCompression !== false;
    this._enableCalibration = config.autoCalibrate !== false;
  }

  // ==========================================================================
  // 窗口管理
  // ==========================================================================

  /**
   * 设置窗口大小
   * @param {'STANDARD'|'EXTENDED'|'MAXIMUM'|number} size
   */
  setWindowSize(size) {
    if (typeof size === 'number') {
      this.windowSize = Math.min(size, WINDOW_SIZES.MAXIMUM);
    } else {
      this.windowSize = WINDOW_SIZES[size] || WINDOW_SIZES.STANDARD;
    }
    this.maxTokens = this.windowSize;
    return this.windowSize;
  }

  /**
   * 获取当前窗口配置
   */
  getWindowConfig() {
    return {
      size: this.windowSize,
      sizeLabel: this.windowSize >= WINDOW_SIZES.MAXIMUM ? 'MAXIMUM' :
                 this.windowSize >= WINDOW_SIZES.EXTENDED ? 'EXTENDED' : 'STANDARD',
      budget: {
        immutable: Math.floor(this.windowSize * BUDGET.IMMUTABLE),
        cacheFriendly: Math.floor(this.windowSize * BUDGET.CACHE_FRIENDLY),
        workingMemory: Math.floor(this.windowSize * BUDGET.WORKING_MEM),
        fileContext: Math.floor(this.windowSize * BUDGET.FILE_CONTEXT),
        archive: Math.floor(this.windowSize * BUDGET.ARCHIVE),
        reserve: Math.floor(this.windowSize * BUDGET.RESERVE),
      },
    };
  }

  // ==========================================================================
  // Tier 1: 项目概览（Cache-Friendly Zone）
  // ==========================================================================

  /**
   * 构建项目概览（优化版 — 自适应深度，按重要性分层）
   */
  async buildProjectOverview(depth = 3) {
    const maxBudget = Math.floor(this.windowSize * BUDGET.CACHE_FRIENDLY);

    // 先尝试 depth=3，超预算则降为 depth=2
    let tree = this._buildDirectoryTree(this.projectDir, 3);
    let treeTokens = estimateTokenCount(tree);
    if (treeTokens > maxBudget * 0.6) {
      tree = this._buildDirectoryTree(this.projectDir, 2);
      treeTokens = estimateTokenCount(tree);
    }

    // 关键文件摘要（根据预算控制数量）
    const keyFiles = this._findKeyFiles();
    let totalTokens = treeTokens;

    // 智能选择关键文件阅读行数
    const fileBudget = maxBudget * 0.3;
    const avgTokensPerLine = 50; // 估算每行约 50 tokens
    const maxLinesPerFile = Math.max(10, Math.floor(fileBudget / (keyFiles.length * avgTokensPerLine)));

    const keyFilesWithSummary = [];
    for (const file of keyFiles) {
      const fullPath = path.join(this.projectDir, file);
      try {
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, 'utf8');
          const lines = content.split(/\r?\n/);
          const summary = lines.slice(0, Math.min(maxLinesPerFile, 30)).join('\n');
          keyFilesWithSummary.push({ file, summary });
          totalTokens += estimateTokenCount(summary) + 20;
        }
      } catch {
        keyFilesWithSummary.push({ file, summary: '(读取失败)' });
      }

      if (totalTokens > maxBudget) {break;}
    }

    // 依赖信息（极简）
    const deps = this._readDependencies();
    const depTokens = estimateTokenCount(deps);
    if (totalTokens + depTokens > maxBudget) {
      // 截断依赖列表
      const truncated = deps.split(', ').slice(0, 20).join(', ');
      this.projectOverview = {
        tree,
        keyFiles: keyFilesWithSummary,
        dependencies: truncated + (deps.split(', ').length > 20 ? '...' : ''),
      };
    } else {
      this.projectOverview = {
        tree,
        keyFiles: keyFilesWithSummary,
        dependencies: deps,
      };
    }

    return this.projectOverview;
  }

  _buildDirectoryTree(dirPath, maxDepth, currentDepth = 0) {
    if (currentDepth > maxDepth) {return '';}
    let result = '';
    const indent = '  '.repeat(currentDepth);

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) {return -1;}
        if (!a.isDirectory() && b.isDirectory()) {return 1;}
        return a.name.localeCompare(b.name);
      });

      for (const entry of entries) {
        if (IGNORED_DIRS.has(entry.name)) {continue;}
        if (entry.name.startsWith('.')) {continue;}

        if (entry.isDirectory()) {
          result += `${indent}${entry.name}/\n`;
          result += this._buildDirectoryTree(
            path.join(dirPath, entry.name),
            maxDepth,
            currentDepth + 1,
          );
        } else {
          result += `${indent}${entry.name}\n`;
        }
      }
    } catch {
      // 权限不足等忽略
    }
    return result;
  }

  _findKeyFiles() {
    const candidates = [
      'package.json', 'tsconfig.json', 'pyproject.toml',
      'requirements.txt', 'Cargo.toml', 'go.mod',
      'pom.xml', 'build.gradle', 'Makefile',
      'Dockerfile', 'docker-compose.yml',
      '.env.example', 'README.md',
    ];
    return candidates.filter((f) => fs.existsSync(path.join(this.projectDir, f)));
  }

  _readDependencies() {
    const pkgPath = path.join(this.projectDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        return Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }).join(', ');
      } catch { /* ignore */ }
    }
    return '';
  }

  getProjectOverviewText() {
    if (!this.projectOverview) {return '';}
    let text = '## 项目概览\n\n';
    text += `### 目录结构\n\`\`\`\n${this.projectOverview.tree}\`\`\`\n\n`;

    if (this.projectOverview.keyFiles.length > 0) {
      text += '### 关键文件\n\n';
      for (const { file, summary } of this.projectOverview.keyFiles) {
        text += `**${file}**\n\`\`\`\n${summary}\n\`\`\`\n\n`;
      }
    }

    if (this.projectOverview.dependencies) {
      text += `### 依赖\n${this.projectOverview.dependencies}\n\n`;
    }
    return text;
  }

  // ==========================================================================
  // Tier 3: 文件上下文管理 (LRU + 使用频率追踪)
  // ==========================================================================

  /**
   * 按需加载文件到上下文（增强版 — LRU 淘汰 + 预算控制）
   */
  async loadFileOnDemand(filePath, options = {}) {
    const resolvedPath = path.resolve(this.projectDir, filePath);
    const relative = path.relative(this.projectDir, resolvedPath);
    if (relative.startsWith('..')) {return null;}

    const cacheKey = options.limit ? `${relative}:${options.offset}:${options.limit}` : relative;

    // 检查缓存
    if (this._fileContexts.has(cacheKey)) {
      const entry = this._fileContexts.get(cacheKey);
      entry.accessCount = (entry.accessCount || 0) + 1;
      entry.lastAccess = Date.now();
      return entry.content;
    }

    try {
      // 二进制检测 + 读取内容（用 fsp 异步，不阻塞 event loop）
      let fileHandle;
      try {
        fileHandle = await fsp.open(resolvedPath, 'r');
      } catch {
        return null; // ENOENT → 文件不存在
      }

      const buffer = Buffer.alloc(1024);
      const { bytesRead } = await fileHandle.read(buffer, 0, 1024, 0);
      await fileHandle.close();

      if (buffer.slice(0, bytesRead).includes(0)) {
        const result = `[二进制文件: ${path.basename(filePath)}]`;
        this._addFileContext(cacheKey, result);
        return result;
      }

      // 读取全部内容
      const raw = await fsp.readFile(resolvedPath, 'utf8');
      const lines = raw.split(/\r?\n/);
      let content;

      // 智能行数决策
      if (options.limit) {
        const selected = lines.slice(options.offset || 0, (options.offset || 0) + options.limit);
        content = selected.join('\n');
      } else if (lines.length > 500) {
        // 大文件：只取头部 200 行 + 尾部 30 行
        const head = lines.slice(0, 200);
        const tail = lines.slice(-30);
        content = head.join('\n') + `\n\n... (${lines.length - 230} lines omitted) ...\n\n` + tail.join('\n');
      } else {
        content = raw;
      }

      const result = `### ${relative}\n\`\`\`\n${content}\n\`\`\``;
      this._addFileContext(cacheKey, result);

      // 扫描 import/require 构建关联图（仅扫描关键文件）
      if (relative.endsWith('.js') || relative.endsWith('.ts') ||
          relative.endsWith('.jsx') || relative.endsWith('.tsx') ||
          relative.endsWith('.py') || relative.endsWith('.go') ||
          relative.endsWith('.rs') || relative.endsWith('.java')) {
        this._scanImports(content, relative);
      }

      return result;
    } catch {
      return null;
    }
  }

  /**
   * 添加文件上下文到 LRU 缓存
   */
  _addFileContext(key, content) {
    const newTokens = estimateTokenCount(content);

    // 超出容量，淘汰最少使用的
    while (
      this._fileContexts.size >= FILE_CONTEXT_MAX_ENTRIES ||
      this._fileContextTotalTokens + newTokens > FILE_CONTEXT_MAX_TOKENS
    ) {
      this._evictLRU();
    }

    this._fileContexts.set(key, {
      content,
      tokens: newTokens,
      accessCount: 1,
      lastAccess: Date.now(),
      added: Date.now(),
    });
    this._fileContextTotalTokens += newTokens;
  }

  /**
   * LRU 淘汰
   */
  _evictLRU() {
    let oldest = null;
    let oldestKey = null;

    for (const [key, entry] of this._fileContexts) {
      if (!oldest || entry.lastAccess < oldest.lastAccess) {
        oldest = entry;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this._fileContextTotalTokens -= oldest ? (oldest.tokens || 0) : 0;
      this._fileContexts.delete(oldestKey);
    }
  }

  /**
   * 获取当前文件上下文层 token 总数
   * @returns {number}
   */
  _getFileContextTokens() {
    return this._fileContextTotalTokens;
  }

  // ==========================================================================
  // 压缩引擎 — 多级渐进式压缩
  // ==========================================================================

  /**
   * 检查当前需要的压缩级别
   * @param {Array} messages - 消息列表
   * @param {number} currentTokens - 当前估算 token 数
   * @returns {{ level: number, label: string, needsCompression: boolean }}
   */
  getCompressionLevel(messages, currentTokens) {
    // 更新相位后获取相位偏移
    const phaseCfg = this._updatePhase(messages);
    const phaseShift = phaseCfg.thresholdShift || 0;
    const ratio = currentTokens / this.windowSize;
    const adjustedRatio = ratio - phaseShift; // 负偏移 = 更易触发压缩

    for (const [name, cfg] of Object.entries(COMPRESSION_LEVELS).reverse()) {
      if (adjustedRatio >= cfg.threshold) {
        return {
          level: cfg.level,
          label: cfg.label,
          name,
          needsCompression: cfg.level >= COMPRESSION_LEVELS.LIGHT_COMP.level,
          ratio,
          adjustedRatio,
          phase: this._phaseTracker.phase,
          currentTokens,
          windowSize: this.windowSize,
        };
      }
    }

    return {
      level: 0, label: '正常', name: 'NONE', needsCompression: false,
      ratio, adjustedRatio, phase: this._phaseTracker.phase, currentTokens,
    };
  }

  /**
   * 检查是否需要压缩（便捷方法）
   */
  needsCompression(messages) {
    const tokens = estimateMessageTokens(messages);
    const { needsCompression } = this.getCompressionLevel(messages, tokens);
    return needsCompression;
  }

  /**
   * 手动触发上下文压缩（支持聚焦保留）
   * 由 /compact 命令或 compact_context 工具调用
   *
   * @param {Array} messages - 消息列表
   * @param {Object} [options]
   * @param {string} [options.level='auto'] - 压缩级别: 'auto' | 'light' | 'medium' | 'heavy' | 'critical'
   * @param {string|string[]} [options.keep=['recent', 'decisions']] - 要保留的方面:
   *   'files' 保留注入文件, 'project' 保留项目概览,
   *   'recent' 保留最近对话, 'tools' 保留工具调用历史,
   *   'decisions' 保留关键决策, 'all' 全部保留（普通模式）
   * @param {number} [options.keepRounds] - 保留最近几轮（默认根据相位自适应）
   * @returns {{ messages: Array, stats: Object }}
   */
  compactContext(messages, options = {}) {
    const { level = 'auto', keep = ['recent', 'decisions'], keepRounds } = options;
    const totalTokens = estimateMessageTokens(messages);

    // 1. 确定压缩级别
    let compLevel;
    const autoLevel = this.getCompressionLevel(messages, totalTokens);
    if (level === 'auto') {
      compLevel = Math.max(autoLevel.level, COMPRESSION_LEVELS.LIGHT_COMP.level);
    } else {
      const levelMap = { light: 2, medium: 3, heavy: 4, critical: 5 };
      compLevel = levelMap[level] || COMPRESSION_LEVELS.LIGHT_COMP.level;
    }
    compLevel = Math.min(compLevel, COMPRESSION_LEVELS.CRITICAL.level);

    // 2. 确定保留方面
    const preserveList = Array.isArray(keep) ? keep : [keep];
    const preserve = new Set(preserveList.map(k => k.toLowerCase().trim()));

    // 3. 执行压缩
    let result;
    if (preserve.has('all')) {
      result = this._compressByLevel(messages, compLevel);
    } else {
      result = this._selectiveCompress(messages, compLevel, preserve, keepRounds);
    }

    // 4. 统计
    const afterTokens = estimateMessageTokens(result.messages);
    this.compressionStats.totalCompressions++;
    this.compressionStats.totalTokensSaved += totalTokens - afterTokens;
    this.compressionStats.lastCompression = new Date().toISOString();

    return {
      messages: result.messages,
      stats: {
        compressed: true,
        level: compLevel,
        name: Object.entries(COMPRESSION_LEVELS).find(([,c]) => c.level === compLevel)?.[0] || 'UNKNOWN',
        beforeTokens: totalTokens,
        afterTokens,
        savedTokens: totalTokens - afterTokens,
        savedPercent: Math.round((1 - afterTokens / Math.max(totalTokens, 1)) * 100),
        preserved: preserveList,
        message: result.message || '',
      },
    };
  }

  /**
   * 按级别选择压缩策略（内部辅助）
   */
  _compressByLevel(messages, level) {
    const name = Object.entries(COMPRESSION_LEVELS).find(([,c]) => c.level === level)?.[0] || 'MED_COMP';
    switch (name) {
      case 'LIGHT_COMP':  return this._lightCompress(messages);
      case 'MED_COMP':    return this._mediumCompress(messages);
      case 'HEAVY_COMP':  return this._heavyCompress(messages);
      case 'CRITICAL':    return this._criticalCompress(messages);
      default:            return this._mediumCompress(messages);
    }
  }

  /**
   * 选择性压缩 — 保留指定方面，压缩其余部分
   * @param {Array} messages
   * @param {number} level
   * @param {Set<string>} preserve - 要保留的方面集合
   * @param {number} [keepRounds]
   * @returns {{ messages: Array, message?: string }}
   */
  _selectiveCompress(messages, level, preserve, keepRounds) {
    const { systemMsgs, nonSystem } = this._splitMessages(messages);
    const phaseCfg = this._updatePhase(messages);
    const defaultKeepRounds = keepRounds || phaseCfg.keepRounds || 6;

    // 如果保留了 all，退回到普通压缩
    if (preserve.has('all')) {
      return this._compressByLevel(messages, level);
    }

    // 保留最近 N 轮
    let keptRounds = [];
    let olderRounds = [];

    if (preserve.has('recent')) {
      const rounds = this._groupIntoRounds(nonSystem);
      const keepCount = Math.min(defaultKeepRounds * 2, rounds.length);
      keptRounds = rounds.slice(-keepCount);
      olderRounds = rounds.slice(0, rounds.length - keepCount);
    } else if (preserve.has('decisions') || preserve.has('tools')) {
      // 如果没保留 recent，但仍然要保留 decisions/tools → 按重要性保留
      const scored = nonSystem.map((msg, i) => ({
        msg,
        score: this._scoreMessage(msg, i, nonSystem.length),
        tokens: estimateTokenCount(msg.content || '') + estimateTokenCount(msg.reasoning_content || '') + 6,
      }));
      scored.sort((a, b) => b.score - a.score);

      // 保留高分数消息
      const targetTokens = Math.floor(this.windowSize * 0.60);
      let current = 0;
      const keptMsgs = [];
      const olderMsgs = [];
      for (const item of scored) {
        if (current + item.tokens <= targetTokens) {
          keptMsgs.push(item.msg);
          current += item.tokens;
        } else {
          olderMsgs.push(item.msg);
        }
      }
      // 恢复顺序
      keptMsgs.sort((a, b) => nonSystem.indexOf(a) - nonSystem.indexOf(b));
      const olderNonSystem = nonSystem.filter(m => !keptMsgs.includes(m));
      keptRounds = this._groupIntoRounds(keptMsgs);
      olderRounds = this._groupIntoRounds(olderNonSystem);
    } else {
      // 没保留 recent → 全部分组，按重要性裁
      const rounds = this._groupIntoRounds(nonSystem);
      const keepCount = Math.min(defaultKeepRounds, rounds.length);
      keptRounds = rounds.slice(-keepCount);
      olderRounds = rounds.slice(0, rounds.length - keepCount);
    }

    // 对 older 轮次生成摘要
    const archivedRounds = [];

    for (const round of olderRounds) {
      const hasDecisions = round.some(m =>
        m.role === 'assistant' && m.tool_calls?.some(tc => {
          const n = tc.function?.name || '';
          return ['write_file', 'delete_file', 'execute_command'].includes(n);
        })
      );
      const hasFileOps = round.some(m =>
        m.role === 'assistant' && m.tool_calls?.some(tc => {
          const n = tc.function?.name || '';
          return ['read_file', 'write_file', 'glob_files', 'search_in_files'].includes(n);
        })
      );

      // 调试相位 + 保留 decisions：保留有关键决策的轮次
      if (preserve.has('decisions') && hasDecisions) {
        keptRounds.push(round);
        continue;
      }
      // 保留 tools：保留有文件操作的轮次
      if (preserve.has('tools') && hasFileOps) {
        keptRounds.push(round);
        continue;
      }

      archivedRounds.push(round);
    }

    // 重新排序 keptRounds 保持原始对话顺序
    if (keptRounds.length > 0) {
      const allKeptMsgs = keptRounds.flat();
      allKeptMsgs.sort((a, b) => nonSystem.indexOf(a) - nonSystem.indexOf(b));
      keptRounds = this._groupIntoRounds(allKeptMsgs);
    }

    // 需要保留 files — 不清空文件缓存
    if (preserve.has('files')) {
      // 不动 this._fileContexts
    } else if (level >= COMPRESSION_LEVELS.LIGHT_COMP.level) {
      // 轻度清理一半低频文件
      const entries = [...this._fileContexts.entries()]
        .sort((a, b) => (b[1].accessCount || 0) - (a[1].accessCount || 0));
      const keepCount = Math.floor(entries.length / 2);
      for (const [key] of entries.slice(keepCount)) {
        this._fileContexts.delete(key);
      }
    }

    // 需要保留 project — 不动 project overview
    if (preserve.has('project')) {
      // keep project overview as-is
    }

    // 对存档轮次生成摘要
    const messagesOut = [...systemMsgs];

    if (archivedRounds.length > 0) {
      // 按级别生成摘要
      const summaries = archivedRounds.map((round, i) => {
        if (level >= COMPRESSION_LEVELS.HEAVY_COMP.level) {
          return this._summarizeRoundL2(round, i + 1);
        }
        return this._summarizeRoundL1(round, i + 1);
      });

      const tier = level >= COMPRESSION_LEVELS.HEAVY_COMP.level ? 2 : 1;
      messagesOut.push({
        role: 'system',
        content: [
          `[压缩摘要 — 聚焦模式, 保留: ${[...preserve].join(', ')}]`,
          ...summaries,
          '[摘要结束]',
        ].join('\n'),
        _archiveTier: tier,
        _originalRounds: archivedRounds.length,
        _compressedAt: new Date().toISOString(),
      });
    }

    // 添加保留的完整轮次
    for (const round of keptRounds) {
      messagesOut.push(...round);
    }

    const detail = [];
    if (preserve.has('recent')) {detail.push(`保留最近 ${keptRounds.length} 轮`);}
    if (preserve.has('decisions')) {detail.push('保留关键决策');}
    if (preserve.has('tools')) {detail.push('保留工具调用');}
    if (preserve.has('files')) {detail.push('保留文件缓存');}
    if (preserve.has('project')) {detail.push('保留项目概览');}
    if (archivedRounds.length > 0) {detail.push(`${archivedRounds.length} 轮已压缩为摘要`);}

    return { messages: messagesOut, message: detail.join('，') };
  }

  /**
   * 主压缩入口 — 根据当前使用率选择压缩策略
   * @param {Array} messages - 完整消息列表
   * @returns {{ messages: Array, stats: Object }} 压缩后的消息和统计信息
   */
  compressContext(messages) {
    const totalTokens = estimateMessageTokens(messages);
    const { level, name } = this.getCompressionLevel(messages, totalTokens);

    if (level < COMPRESSION_LEVELS.LIGHT_COMP.level) {
      return { messages, stats: { compressed: false, level: 0 } };
    }

    let result;
    switch (name) {
      case 'LIGHT_COMP':  result = this._lightCompress(messages); break;
      case 'MED_COMP':    result = this._mediumCompress(messages); break;
      case 'HEAVY_COMP':  result = this._heavyCompress(messages); break;
      case 'CRITICAL':    result = this._criticalCompress(messages); break;
      default:            result = { messages }; break;
    }

    const afterTokens = estimateMessageTokens(result.messages);
    this.compressionStats.totalCompressions++;
    this.compressionStats.totalTokensSaved += totalTokens - afterTokens;
    this.compressionStats.lastCompression = new Date().toISOString();

    return {
      messages: result.messages,
      stats: {
        compressed: true,
        level,
        name,
        beforeTokens: totalTokens,
        afterTokens,
        savedTokens: totalTokens - afterTokens,
        savedPercent: Math.round((1 - afterTokens / totalTokens) * 100),
      },
    };
  }

  /**
   * 轻度压缩 (LIGHT_COMP — 80%触发)
   * 策略: 按重要性评分裁剪消息 + 淘汰低频文件缓存
   */
  _lightCompress(messages) {
    const systemMsgs = messages.filter((m) => m.role === 'system');
    const nonSystem = messages.filter((m) => m.role !== 'system');

    // 按重要性评分保留消息，目标 75% 窗口
    const targetTokens = Math.floor(this.windowSize * 0.75);
    const kept = this._trimByImportance(nonSystem, targetTokens);

    // 淘汰 50% 低频文件上下文缓存
    const entries = [...this._fileContexts.entries()]
      .sort((a, b) => (b[1].accessCount || 0) - (a[1].accessCount || 0));
    const keepCount = Math.floor(entries.length / 2);
    for (const [key] of entries.slice(keepCount)) {
      this._fileContexts.delete(key);
    }

    return { messages: [...systemMsgs, ...kept], detail: '按重要性裁剪 + 文件缓存清理' };
  }

  /**
   * 中度压缩 (MED_COMP — 90%触发)
   * 策略: 早期对话 → L1 详细摘要（保留每轮关键信息）
   * 保留最近 N 轮（自适应相位）
   */
  _mediumCompress(messages) {
    const { systemMsgs, nonSystem } = this._splitMessages(messages);

    const keepRounds = Math.floor(this._getKeepCountForPhase() / 2);
    const keepCount = keepRounds * 2;
    const recent = nonSystem.slice(-keepCount);
    const older = nonSystem.slice(0, -keepCount);

    if (older.length === 0) {return { messages };}

    const rounds = this._groupIntoRounds(older);
    const summaries = rounds.map((round, i) => this._summarizeRoundL1(round, i + 1));

    const archiveMsg = {
      role: 'system',
      content: [
        '[早期对话摘要 L1 — 详细级]',
        ...summaries,
        '[摘要结束 — 如需完整内容，可继续对话]',
      ].join('\n'),
      _archiveTier: 1,
      _originalRounds: rounds.length,
      _compressedAt: new Date().toISOString(),
    };

    return { messages: [...systemMsgs, archiveMsg, ...recent] };
  }

  /**
   * 深度压缩 (HEAVY_COMP — 95%触发)
   * 策略: 早期对话 → L2 概要摘要，保留最近 4 轮
   */
  _heavyCompress(messages) {
    const { systemMsgs, nonSystem } = this._splitMessages(messages);

    const keepCount = 8;
    const recent = nonSystem.slice(-keepCount);
    const older = nonSystem.slice(0, -keepCount);

    if (older.length === 0) {
      return this._mediumCompress(messages);
    }

    const rounds = this._groupIntoRounds(older);
    const l2Summaries = rounds.map((round, i) => this._summarizeRoundL2(round, i + 1));

    const archiveMsg = {
      role: 'system',
      content: [
        '[早期对话摘要 L2 — 概要级]',
        ...l2Summaries,
        '[摘要结束]',
      ].join('\n'),
      _archiveTier: 2,
      _originalRounds: rounds.length,
      _compressedAt: new Date().toISOString(),
    };

    return { messages: [...systemMsgs, archiveMsg, ...recent] };
  }

  /**
   * 极限压缩 (CRITICAL — 98%触发)
   * 策略: 全部历史 → L3 仅关键决策点 + 保留最近 2 轮
   */
  _criticalCompress(messages) {
    const { systemMsgs, nonSystem } = this._splitMessages(messages);

    const keepCount = 4;
    const recent = nonSystem.slice(-keepCount);
    const older = nonSystem.slice(0, -keepCount);

    const rounds = this._groupIntoRounds(older);
    const keyDecisions = [];

    for (const round of rounds) {
      const decisions = this._extractKeyDecisions(round);
      if (decisions.length > 0) {
        keyDecisions.push(...decisions);
      }
    }

    const archiveMsg = {
      role: 'system',
      content: keyDecisions.length > 0
        ? `[关键决策记录]\n${keyDecisions.join('\n')}\n[仅保留最近 2 轮完整对话]`
        : '[对话历史过长，已压缩]',
      _archiveTier: 3,
      _originalRounds: rounds.length,
      _compressedAt: new Date().toISOString(),
    };

    return { messages: [...systemMsgs, archiveMsg, ...recent] };
  }

  /**
   * 主动后台压缩 — 每轮结束后预压缩最旧部分
   * 在 70%+ 使用率时，将最旧 20% 对话轮次压缩为 L1 摘要
   * 同步非阻塞（轻量操作）
   * @param {Array} messages - 当前消息列表
   * @returns {Array} 可能压缩后的消息列表
   */
  proactiveCompress(messages) {
    const usage = estimateMessageTokens(messages) / this.windowSize;
    if (usage < 0.70) {return messages;}

    const { systemMsgs, nonSystem } = this._splitMessages(messages);
    if (nonSystem.length < 8) {return messages;} // 太少不压

    const rounds = this._groupIntoRounds(nonSystem);
    if (rounds.length < 4) {return messages;}

    // 压缩最旧 20% 轮次（至少 1 轮）
    const compressCount = Math.max(1, Math.floor(rounds.length * 0.2));
    const toCompress = rounds.slice(0, compressCount);
    const remaining = rounds.slice(compressCount);

    // 只压那些还没有 _archiveTier 标记的
    const existingArchives = messages.filter((m) => m._archiveTier);
    const toSummarize = toCompress.filter((r) =>
      !r.some((m) => m._archiveTier || m._deduplicated),
    );
    if (toSummarize.length === 0) {return messages;}

    const summaries = toSummarize.map((round, i) => this._summarizeRoundL1(round, i + 1));

    const archiveMsg = {
      role: 'system',
      content: [
        '[后台预压缩 — L1 摘要]',
        ...summaries,
        '[预压缩结束]',
      ].join('\n'),
      _archiveTier: 1,
      _originalRounds: toSummarize.length,
      _compressedAt: new Date().toISOString(),
      _proactive: true,
    };

    const remainingFlat = remaining.flat();
    const newMessages = [...systemMsgs, ...existingArchives, archiveMsg, ...remainingFlat];

    // 更新统计
    const beforeTokens = estimateMessageTokens(messages);
    const afterTokens = estimateMessageTokens(newMessages);
    this.compressionStats.totalCompressions++;
    this.compressionStats.totalTokensSaved += beforeTokens - afterTokens;

    return newMessages;
  }

  /**
   * 分割消息为系统消息和非系统消息（辅助方法）
   */
  _splitMessages(messages) {
    const systemMsgs = messages.filter((m) => m.role === 'system' && !m._archiveTier);
    const archiveMsgs = messages.filter((m) => m._archiveTier);
    const regularNonSystem = messages.filter((m) => m.role !== 'system' && !m._archiveTier);
    return {
      systemMsgs: [...systemMsgs, ...archiveMsgs],
      nonSystem: regularNonSystem,
    };
  }

  // ==========================================================================
  // 对话相位检测（无 LLM 依赖，基于工具调用统计 + 关键词）
  // ==========================================================================

  /**
   * 记录工具调用（用于相位检测）
   * @param {string} toolName - 工具名称
   * @param {Object} args - 调用参数
   */
  recordToolCall(toolName, args) {
    const seq = this._phaseTracker.toolSequence;
    seq.push(toolName);
    // 保留最近 20 条
    if (seq.length > 20) {seq.shift();}
  }

  /**
   * 检测当前对话相位
   */
  _detectPhase(messages) {
    const recentTools = this._phaseTracker.toolSequence.slice(-10);
    const counts = { mutation: 0, execution: 0, read: 0, other: 0 };
    for (const name of recentTools) {
      const info = TOOL_IMPORTANCE[name] || TOOL_IMPORTANCE._default;
      counts[info.category] = (counts[info.category] || 0) + 1;
    }

    const total = Math.max(recentTools.length, 1);
    if (counts.mutation / total > 0.4) {return 'IMPLEMENT';}
    if (counts.execution / total > 0.4) {return 'DEBUG';}
    if (counts.read / total > 0.5) {return 'EXPLORE';}

    // 关键词回退：检查最后一条用户消息（注意 CJK 不支持 \b 边界）
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUser) {
      const c = (lastUser.content || '').toLowerCase();
      if (/\b(?:debug|fix|error|bug|crash|broken)\b|失败|错误|报错/.test(c)) {return 'DEBUG';}
      if (/\b(?:review|analy[sz]e|audit|check)\b|审查|分析|检查/.test(c)) {return 'REVIEW';}
      if (/\b(?:implement|write|create|build|add|make|generate)\b|写|创建|实现|添加/.test(c)) {return 'IMPLEMENT';}
      if (/\b(?:how|what|where|explain|find|show|list|read)\b|怎么|什么|哪里|解释|查找/.test(c)) {return 'EXPLORE';}
    }

    return this._phaseTracker.phase;
  }

  /**
   * 更新相位并返回当前配置
   */
  _updatePhase(messages) {
    if (!this._enablePhaseDetection) {return CONVERSATION_PHASES.EXPLORE;}
    const newPhase = this._detectPhase(messages);
    if (newPhase !== this._phaseTracker.phase) {
      this._phaseTracker.phase = newPhase;
    }
    return CONVERSATION_PHASES[newPhase] || CONVERSATION_PHASES.EXPLORE;
  }

  /**
   * 获取当前相位的保留轮数
   */
  _getKeepCountForPhase() {
    const phase = this._phaseTracker.phase;
    const cfg = CONVERSATION_PHASES[phase] || CONVERSATION_PHASES.EXPLORE;
    // 支持配置覆盖：context.keepRounds.{phase}，默认 fallback 到内置值
    const configPhaseRounds = this._keepRoundsCfg?.[phase.toLowerCase()];
    const rounds = configPhaseRounds || cfg.keepRounds;
    return rounds * 2;
  }

  // ==========================================================================
  // 摘要生成辅助方法
  // ==========================================================================

  /**
   * 将扁平消息列表分组为对话轮次
   */
  _groupIntoRounds(messages) {
    const rounds = [];
    let currentRound = [];

    for (const msg of messages) {
      if (msg.role === 'user' && currentRound.length > 0) {
        rounds.push(currentRound);
        currentRound = [];
      }
      currentRound.push(msg);
    }

    if (currentRound.length > 0) {
      rounds.push(currentRound);
    }

    return rounds;
  }

  /**
   * L1 详细摘要 — 保留每轮核心信息 (~150 tokens/轮)
   */
  _summarizeRoundL1(round, roundNum) {
    const userMsg = round.find((m) => m.role === 'user');
    const assistantMsgs = round.filter((m) => m.role === 'assistant');

    const question = (userMsg?.content || '').slice(0, 200);
    const hadTools = assistantMsgs.some((m) => m.tool_calls && m.tool_calls.length > 0);
    const toolsUsed = assistantMsgs
      .filter((m) => m.tool_calls)
      .flatMap((m) => m.tool_calls || [])
      .map((tc) => tc.function?.name || 'unknown')
      .join(', ');

    const finalAnswer = assistantMsgs.length > 0
      ? (assistantMsgs[assistantMsgs.length - 1].content || '').slice(0, 300)
      : '';

    let summary = `[轮次 ${roundNum}] 问: ${question}`;
    if (hadTools) {summary += ` | 工具: ${toolsUsed}`;}
    if (finalAnswer) {summary += `\n  答: ${finalAnswer}`;}
    return summary;
  }

  /**
   * L2 概要摘要 — 仅保留问题和结果 (~50 tokens/轮)
   */
  _summarizeRoundL2(round, roundNum) {
    const userMsg = round.find((m) => m.role === 'user');
    const assistantMsgs = round.filter((m) => m.role === 'assistant');
    const lastAnswer = assistantMsgs.length > 0
      ? (assistantMsgs[assistantMsgs.length - 1].content || '').slice(0, 100)
      : '';

    return `[${roundNum}] ${(userMsg?.content || '').slice(0, 100)} → ${lastAnswer}`;
  }

  /**
   * L3 关键决策提取 — 仅保留文件写入/删除等操作记录
   */
  _extractKeyDecisions(round) {
    const decisions = [];
    for (const msg of round) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const name = tc.function?.name || '';
          if (['write_file', 'delete_file', 'execute_command'].includes(name)) {
            let args = {};
            try {
              args = typeof tc.function?.arguments === 'string'
                ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {});
            } catch { /* ignore */ }
            decisions.push(` • ${name}: ${args.filePath || args.command || args.path || JSON.stringify(args).slice(0, 100)}`);
          }
        }
      }
    }
    return decisions;
  }

  // ==========================================================================
  // 消息重要性评分
  // ==========================================================================

  /**
   * 计算单条消息的重要性分数（增强版 — 工具类型差异化）
   */
  _scoreMessage(msg, index, totalCount) {
    let score = MSG_WEIGHTS[msg.role] || 0.2;

    // 最近的消息权重更高
    const recency = (index + 1) / totalCount;
    score *= (0.5 + 0.5 * recency);

    // 差异化工具调用评分
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      let maxToolScore = 0;
      let hasMutation = false;
      for (const tc of msg.tool_calls) {
        const name = tc.function?.name || '';
        const info = TOOL_IMPORTANCE[name] || TOOL_IMPORTANCE._default;
        maxToolScore = Math.max(maxToolScore, info.score);
        if (info.category === 'mutation') {hasMutation = true;}
      }
      score *= (1.0 + maxToolScore); // 最高 2x (write_file)
      if (hasMutation) {score *= 1.3;}  // 变异操作额外 30%
    }

    // 包含文件路径的用户消息加分
    if (msg.role === 'user') {
      const content = msg.content || '';
      if (/\.(tsx?|jsx?|py|go|rs|java)$/m.test(content)) {
        score *= 1.2;
      }
    }

    return score;
  }

  /**
   * 按重要性排序的裁剪
   * @param {Array} messages - 非系统消息
   * @param {number} targetTokens - 目标 token 数
   */
  _trimByImportance(messages, targetTokens) {
    const len = messages.length;

    // 预计算：消息索引、token 数、分数（一次性 O(n)，避免重复估算）
    const msgTokenMap = new Map();
    const msgScoreMap = new Map();
    const msgIndexMap = new Map();
    for (let i = 0; i < len; i++) {
      const msg = messages[i];
      msgIndexMap.set(msg, i);
      msgTokenMap.set(msg, estimateTokenCount(msg.content || '') + estimateTokenCount(msg.reasoning_content || '') + 6);
      msgScoreMap.set(msg, this._scoreMessage(msg, i, len));
    }

    // 第一步：建立 tool_call_id 映射，保护 tool_call + tool_result 对不被拆散
    const toolCallMap = new Map(); // tool_call_id → { assistant, tool }

    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          toolCallMap.set(tc.id || tc.function?.name, { assistant: msg, tool: null });
        }
      } else if (msg.role === 'tool' && msg.tool_call_id) {
        if (toolCallMap.has(msg.tool_call_id)) {
          toolCallMap.get(msg.tool_call_id).tool = msg;
        }
      }
    }

    // 第二步：将消息按组打包（每组要么是一个 pair，要么是单条消息）
    const groups = [];
    const pairedAssistants = new Set();
    const pairedTools = new Set();

    for (const [, pair] of toolCallMap) {
      if (pair.assistant && pair.tool) {
        pairedAssistants.add(pair.assistant);
        pairedTools.add(pair.tool);
        const totalTokens = (msgTokenMap.get(pair.assistant) - 6)  // remove double-counted overhead
          + msgTokenMap.get(pair.tool) + 6;
        const avgScore = (msgScoreMap.get(pair.assistant) + msgScoreMap.get(pair.tool)) / 2;
        groups.push({ messages: [pair.assistant, pair.tool], tokens: totalTokens, score: avgScore });
      } else if (pair.assistant && !pair.tool) {
        pairedAssistants.add(pair.assistant);
        groups.push({ messages: [pair.assistant], tokens: msgTokenMap.get(pair.assistant), score: msgScoreMap.get(pair.assistant) });
      } else if (!pair.assistant && pair.tool) {
        pairedTools.add(pair.tool);
        groups.push({ messages: [pair.tool], tokens: msgTokenMap.get(pair.tool), score: 0.1 });
      }
    }

    // 剩余未配对的单条消息
    for (const msg of messages) {
      if (!pairedAssistants.has(msg) && !pairedTools.has(msg)) {
        groups.push({
          messages: [msg],
          tokens: msgTokenMap.get(msg),
          score: msgScoreMap.get(msg),
        });
      }
    }

    // 按总分降序排列
    groups.sort((a, b) => b.score - a.score);

    let currentTokens = 0;
    const keptMsgs = [];

    for (const group of groups) {
      if (currentTokens + group.tokens <= targetTokens) {
        keptMsgs.push(...group.messages);
        currentTokens += group.tokens;
      }
    }

    // 恢复原始顺序（用预计算的 index map）
    keptMsgs.sort((a, b) => (msgIndexMap.get(a) || 0) - (msgIndexMap.get(b) || 0));

    return keptMsgs;
  }

  // ==========================================================================
  // 每层预算追踪与强制执行
  // ==========================================================================

  /**
   * 计算当前消息列表中各层的 token 消耗
   */
  _computeTierTokens(messages) {
    const budget = this.getWindowConfig().budget;

    this._tierTokens = {
      tier0: { label: 'Immutable',    budget: budget.immutable,    current: 0 },
      tier1: { label: 'CacheFriendly', budget: budget.cacheFriendly, current: 0 },
      tier2: { label: 'WorkingMemory', budget: budget.workingMemory, current: 0 },
      tier3: { label: 'FileContext',   budget: budget.fileContext,   current: 0 },
      tier4: { label: 'Archive',      budget: budget.archive,       current: 0 },
    };

    const systemMsgs = messages.filter((m) => m.role === 'system' && !m._archiveTier);
    this._tierTokens.tier1.current = estimateMessageTokens(systemMsgs);

    const archives = messages.filter((m) => m._archiveTier);
    this._tierTokens.tier4.current = estimateMessageTokens(archives);

    const regular = messages.filter((m) => m.role !== 'system' && !m._archiveTier);
    this._tierTokens.tier2.current = estimateMessageTokens(regular);

    this._tierTokens.tier3.current = [...this._fileContexts.values()]
      .reduce((sum, e) => sum + estimateTokenCount(e.content || ''), 0);
  }

  /**
   * 检查并强制执行每层预算
   * 如果某层超出预算 10%，触发对应压缩操作
   */
  _enforceBudget(messages) {
    this._computeTierTokens(messages);

    if (this._tierTokens.tier2.current > this._tierTokens.tier2.budget * 1.1) {
      return this._mediumCompress(messages);
    }

    if (this._tierTokens.tier4.current > this._tierTokens.tier4.budget * 1.1) {
      return this._heavyCompress(messages);
    }

    return messages;
  }

  // ==========================================================================
  // 内容感知去重
  // ==========================================================================

  /**
   * 检测并折叠重复消息（相同内容转引用）
   */
  _deduplicateMessages(messages) {
    const seen = new Map();
    const deduped = [];

    for (const msg of messages) {
      const key = this._messageFingerprint(msg);
      if (key && seen.has(key)) {
        const origIdx = seen.get(key);
        deduped.push({
          role: msg.role,
          content: `[内容与第 ${origIdx + 1} 条消息相同，已省略]`,
          tool_call_id: msg.tool_call_id,
          _deduplicated: true,
          _originalIndex: origIdx,
        });
      } else {
        if (key) {seen.set(key, deduped.length);}
        deduped.push(msg);
      }
    }

    return deduped;
  }

  /**
   * 生成消息指纹（用于去重）
   */
  _messageFingerprint(msg) {
    if (msg._deduplicated) {return null;}
    const content = (msg.content || '').slice(0, 200);
    const tools = (msg.tool_calls || []).map((t) => t.function?.name).join(',');
    return crypto.createHash('md5').update(`${msg.role}|${content}|${tools}`).digest('hex');
  }

  // ==========================================================================
  // 语义分块截断（替代逐行截断）
  // ==========================================================================

  /**
   * 将文本裁剪到指定 token 预算内
   * 代码: 在函数/类边界截断 | 散文: 在段落边界截断
   */
  _trimToTokens(text, maxTokens) {
    if (!text) {return '';}
    if (estimateTokenCount(text) <= maxTokens) {return text;}

    const lines = text.split('\n');
    const isCode = lines.some((l) =>
      /^\s*(function|class|export|import|const|let|var|if|for|while|def|impl|fn)\s/.test(l.trim()),
    );

    if (isCode) {
      return this._trimCodeSemantic(text, maxTokens);
    }
    return this._trimProseSemantic(text, maxTokens);
  }

  /**
   * 代码语义截断（在函数/类边界截断）
   */
  _trimCodeSemantic(text, maxTokens) {
    const blocks = text.split(/(?=^\s*(?:export\s+)?(?:async\s+)?(?:function|class|const\s+\w+\s*=\s*(?:async\s+)?\())/m);
    let result = '';
    for (const block of blocks) {
      if (estimateTokenCount(result + block) > maxTokens) {
        result += '\n// ... (剩余代码已截断)';
        break;
      }
      result += block;
    }
    return result;
  }

  /**
   * 散文语义截断（在段落边界截断）
   */
  _trimProseSemantic(text, maxTokens) {
    const paragraphs = text.split(/\n\n+/);
    let result = '';
    for (const para of paragraphs) {
      if (estimateTokenCount(result ? result + '\n\n' + para : para) > maxTokens) {
        result += '\n\n... (剩余文本已截断)';
        break;
      }
      result += (result ? '\n\n' : '') + para;
    }
    return result;
  }

  // ==========================================================================
  // 组装消息（优化缓存命中）
  // ==========================================================================

  /**
   * 组装最终消息列表（保证前缀稳定性以优化缓存命中）
   *
   * 消息顺序:
   * [SystemPrompt] → [ProjectOverview] → [Archive] → [History] → [User]
   *  └─ 静态前缀 ─┘  └── 半静态 ──┘  └─ 动态 ──────────┘  └─ 最新 ─┘
   *  └── 最大化缓存命中（需相同前缀） ──┘
   *
   * @param {string} systemPrompt - Tier 0
   * @param {Array} historyMessages - Tier 2+4
   * @returns {Array} 组装好的消息数组
   */
  assembleMessages(systemPrompt, historyMessages) {
    const assembled = [];

    // Tier 0: System Prompt (总是第一，形成稳定的缓存前缀)
    assembled.push({ role: 'system', content: systemPrompt });

    // Tier 1: Project Overview (紧随 system prompt，增加缓存命中范围)
    const overview = this.getProjectOverviewText();
    if (overview) {
      const budget = Math.floor(this.windowSize * BUDGET.CACHE_FRIENDLY);
      const trimmed = this._trimToTokens(overview, budget);
      assembled.push({ role: 'system', content: trimmed });
    }

    // Tier 2+4: 历史消息 + 压缩摘要 (去重前先检查预算)
    // _enforceBudget 会在 tier2/tier4 超预算时自动压缩（之前没调用点，死代码！）
    const budgetChecked = this._enforceBudget(historyMessages);
    const deduped = this._deduplicateMessages(budgetChecked);
    // 保留非 system 消息 + 带 _archiveTier 的归档摘要（别把压缩摘要过滤掉了，SB bug）
    const historyNonSystem = deduped.filter((m) => m.role !== 'system' || m._archiveTier !== undefined);
    if (historyNonSystem.length > 0) {
      assembled.push(...historyNonSystem);
    }

    return assembled;
  }

  // ==========================================================================
  // Phase 3: 压缩遗憾检测
  // ==========================================================================

  /**
   * 检测用户消息是否包含压缩遗憾
   * @param {string} userMessage - 用户输入
   * @returns {boolean}
   */
  detectRegret(userMessage) {
    if (!userMessage) {return false;}
    const matched = REGRET_PATTERNS.some((p) => p.test(userMessage));
    if (matched) {
      this._regretTracker.count++;
      this._regretTracker.patterns.push({
        message: userMessage.slice(0, 100),
        timestamp: new Date().toISOString(),
        compressionCount: this.compressionStats.totalCompressions,
      });
      // 保留最近 20 条记录
      if (this._regretTracker.patterns.length > 20) {
        this._regretTracker.patterns.shift();
      }
    }
    return matched;
  }

  /**
   * 获取压缩质量报告
   * @returns {Object}
   */
  getCompressionQualityReport() {
    const total = this.compressionStats.totalCompressions || 1;
    const regretCount = this._regretTracker.count;
    const regretRate = regretCount / total;

    return {
      totalCompressions: this.compressionStats.totalCompressions,
      totalTokensSaved: this.compressionStats.totalTokensSaved,
      regretCount,
      regretRate: Math.round(regretRate * 100) / 100,
      suggestion: regretRate > 0.3
        ? '⚠️ 遗憾率较高 (>30%)，建议降低压缩激进程度或增大窗口'
        : regretRate > 0.1
          ? '💡 轻度遗憾，可考虑调整压缩策略'
          : '✅ 压缩质量良好',
      lastRegret: this._regretTracker.patterns[this._regretTracker.patterns.length - 1] || null,
    };
  }

  // ==========================================================================
  // 工具方法
  // ==========================================================================

  /**
   * 估算消息列表 token 数（应用校准因子）
   */
  estimateMessagesTokenCount(messages) {
    const raw = estimateMessageTokens(messages);
    return Math.ceil(raw * (this._calibration?.correctionFactor || 1.0));
  }

  /**
   * 估算单段文本 token 数
   */
  estimateTokenCount(text) {
    return estimateTokenCount(text);
  }

  /**
   * 从 API 实际 token 使用反馈校准估算
   * @param {number} estimatedTokens - 估算值
   * @param {number} actualPromptTokens - API 返回实际值
   */
  calibrateFromUsage(estimatedTokens, actualPromptTokens) {
    if (!this._enableCalibration || !estimatedTokens || !actualPromptTokens) {return;}

    const ratio = actualPromptTokens / Math.max(estimatedTokens, 1);
    this._calibration.samples.push({
      estimated: estimatedTokens,
      actual: actualPromptTokens,
      ratio,
      timestamp: new Date().toISOString(),
    });
    if (this._calibration.samples.length > 20) {
      this._calibration.samples.shift();
    }

    // 中位数（抗离群）
    const ratios = [...this._calibration.samples].map((s) => s.ratio).sort((a, b) => a - b);
    const median = ratios[Math.floor(ratios.length / 2)];
    // EMA 平滑
    this._calibration.correctionFactor =
      this._calibration.alpha * median + (1 - this._calibration.alpha) * this._calibration.correctionFactor;
    this._calibration.lastCalibrated = new Date().toISOString();
  }

  clearFileCache() {
    this._fileContexts.clear();
    this._fileContextTotalTokens = 0;
  }

  // ==========================================================================
  // Phase 3: 预测性文件预取
  // ==========================================================================

  /**
   * 扫描文件内容中的 import/require 依赖
   * @param {string} content - 文件内容
   * @param {string} filePath - 文件路径（相对）
   * @returns {Array<string>} 依赖的文件路径列表
   */
  _scanImports(content, filePath) {
    if (!content) {return [];}
    const imports = new Set();
    const dir = path.dirname(filePath);

    // require('...')
    const requirePattern = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = requirePattern.exec(content)) !== null) {
      imports.add(m[1]);
    }

    // import ... from '...'
    const importFromPattern = /import\s+(?:\{[^}]*\}|[^;{]+)\s+from\s*['"]([^'"]+)['"]/g;
    while ((m = importFromPattern.exec(content)) !== null) {
      imports.add(m[1]);
    }

    // import '...'
    const importSidePattern = /import\s+['"]([^'"]+)['"]/g;
    while ((m = importSidePattern.exec(content)) !== null) {
      imports.add(m[1]);
    }

    // 将 bare specifiers 解析为可能的相对路径
    const relatedPaths = [];
    for (const imp of imports) {
      if (imp.startsWith('.')) {
        // 相对路径
        const resolved = path.normalize(path.join(dir, imp));
        // 尝试常见扩展名
        for (const ext of ['', '.js', '.ts', '.jsx', '.tsx', '.json', '.mjs', '.cjs']) {
          const fullPath = path.join(this.projectDir, resolved + ext);
          if (fs.existsSync(fullPath)) {
            relatedPaths.push(path.relative(this.projectDir, fullPath));
            break;
          }
        }
        // 尝试 index 文件
        if (!relatedPaths.length) {
          for (const ext of ['/index.js', '/index.ts', '/index.jsx', '/index.tsx']) {
            const fullPath = path.join(this.projectDir, resolved + ext);
            if (fs.existsSync(fullPath)) {
              relatedPaths.push(path.relative(this.projectDir, fullPath));
              break;
            }
          }
        }
      }
      // npm 包名不解析为本地路径
    }

    // 存入关联图
    if (relatedPaths.length > 0) {
      this._prefetchHints.relatedFiles.set(filePath, new Set(relatedPaths));
    }

    return relatedPaths;
  }

  /**
   * 预取关联文件
   * 在工具执行后调用，异步加载相关文件到缓存
   * @param {string} filePath - 刚操作的文件路径
   * @param {number} [maxFiles=5] - 最多预取数量
   * @returns {Promise<Array<{path: string, content: string|null}>>}
   */
  async prefetchRelatedFiles(filePath, maxFiles = 5) {
    const relative = path.relative(this.projectDir, path.resolve(this.projectDir, filePath));
    const related = this._prefetchHints.relatedFiles.get(relative);
    if (!related || related.size === 0) {return [];}

    const loaded = [];
    let count = 0;
    for (const relPath of related) {
      if (count >= maxFiles) {break;}
      // 只在未缓存时预取
      if (!this._fileContexts.has(relPath) && !relPath.includes('node_modules')) {
        const content = await this.loadFileOnDemand(relPath);
        loaded.push({ path: relPath, content });
        count++;
      }
    }
    return loaded;
  }

  /**
   * 获取上下文各层 Token 明细
   * @param {Array} messages - 消息列表
   * @returns {{ systemPrompt: number, projectOverview: number, fileContexts: Array<{path:string, tokens:number}>,
   *            totalFileTokens: number, messagesTokens: number, messagesPercent: number,
   *            freeTokens: number, freePercent: number, total: number, totalPercent: number,
   *            breakdown: Array<{label:string, tokens:number, percent:number}> }}
   */
  getContextBreakdown(messages) {
    const systemMsgs = messages.filter(m => m.role === 'system' && !m._archiveTier);

    // System Prompt (第一条 system 消息)
    const sysPromptTokens = estimateTokenCount(systemMsgs[0]?.content || '');

    // Project Overview (第二条 system 消息，如果有)
    const overviewTokens = estimateTokenCount(systemMsgs[1]?.content || '');

    // 注入文件列表及各自 Token
    const fileContexts = [];
    for (const [key, entry] of this._fileContexts) {
      fileContexts.push({
        path: key.split(':')[0],
        tokens: entry.tokens || estimateTokenCount(entry.content || ''),
      });
    }
    // 按 token 降序排列
    fileContexts.sort((a, b) => b.tokens - a.tokens);

    const totalFileTokens = fileContexts.reduce((sum, f) => sum + f.tokens, 0);

    // 总 tokens
    const total = estimateMessageTokens(messages);

    // 对话消息 tokens（排除 system 消息和工具结果）
    const nonSystemMsgs = messages.filter(m => m.role !== 'system' || m._archiveTier);
    const toolResultTokens = nonSystemMsgs
      .filter(m => m.role === 'tool')
      .reduce((sum, m) => sum + estimateTokenCount(m.content || ''), 0);
    const messagesTokens = nonSystemMsgs
      .filter(m => m.role !== 'tool')
      .reduce((sum, m) => {
        const ct = estimateTokenCount(m.content || '');
        const rt = estimateTokenCount(m.reasoning_content || '');
        return sum + ct + rt + 6;
      }, 0);

    // 空闲空间
    const freeTokens = Math.max(0, this.windowSize - total);

    // 计算各类别百分比
    const pctOf = (val) => this.windowSize > 0 ? Math.round((val / this.windowSize) * 1000) / 10 : 0;

    // 构建分解列表（按 token 数降序，>0 才显示）
    const breakdown = [
      { label: 'System', tokens: sysPromptTokens, percent: pctOf(sysPromptTokens) },
      { label: 'Project', tokens: overviewTokens, percent: pctOf(overviewTokens) },
      { label: 'Messages', tokens: messagesTokens, percent: pctOf(messagesTokens) },
      { label: 'Tools', tokens: toolResultTokens, percent: pctOf(toolResultTokens) },
      { label: 'Injected', tokens: totalFileTokens, percent: pctOf(totalFileTokens) },
      { label: 'Free', tokens: freeTokens, percent: pctOf(freeTokens) },
    ].filter(item => item.tokens > 0);

    return {
      systemPrompt: sysPromptTokens,
      projectOverview: overviewTokens,
      fileContexts,
      totalFileTokens,
      messagesTokens,
      messagesPercent: pctOf(messagesTokens),
      freeTokens,
      freePercent: pctOf(freeTokens),
      total,
      totalPercent: pctOf(total),
      breakdown,
    };
  }

  /**
   * 获取上下文状态报告
   */
  getStatusReport(messages) {
    const tokens = estimateMessageTokens(messages);
    const { level, label, ratio } = this.getCompressionLevel(messages, tokens);
    const budget = this.windowSize;

    return {
      windowSize: budget,
      windowLabel: budget >= WINDOW_SIZES.MAXIMUM ? '1M' :
                   budget >= WINDOW_SIZES.EXTENDED ? '400K' : '200K',
      currentTokens: tokens,
      usagePercent: Math.round(ratio * 100),
      compressionLevel: level,
      compressionLabel: label,
      fileContextCount: this._fileContexts.size,
      compressionHistory: this.compressionStats,
    };
  }
}

module.exports = {
  ContextManager,
  estimateTokenCount,
  estimateMessageTokens,
  WINDOW_SIZES,
  COMPRESSION_LEVELS,
  TOOL_IMPORTANCE,
  CONVERSATION_PHASES,
  // 内部方法（用于测试）
  _countCharsByRatio,
  _messageFingerprint: (msg) => crypto.createHash('md5').update(`${msg.role}|${(msg.content || '').slice(0, 200)}|${(msg.tool_calls || []).map((t) => t.function?.name).join(',')}`).digest('hex'),
};

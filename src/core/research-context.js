/**
 * 研究上下文隔离机制
 *
 * 在独立 context 中运行研究任务，仅返回摘要结果，不污染主 context。
 * 适用于：代码库架构研究、大文件分析、多文件关联分析。
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// 常量定义
// ============================================================================

const DEFAULT_MAX_TOKENS = 15000;  // 研究 context 最大 token 数
const SUMMARY_TRUNCATE_THRESHOLD = 5000;  // 超过此长度生成摘要

// ============================================================================
// Token 估算
// ============================================================================

function estimateTokenCount(text) {
  if (!text || typeof text !== 'string') {return 0;}
  let count = 0;
  for (const char of text) {
    const cp = char.codePointAt(0);
    if ((cp >= 0x4e00 && cp <= 0x9fff) ||
        (cp >= 0x3400 && cp <= 0x4dbf) ||
        (cp >= 0xf900 && cp <= 0xfaff)) {
      count += 1.5;  // CJK
    } else if (char === ' ' || char === '\n' || char === '\t' || char === '\r') {
      count += 0;
    } else {
      count += 0.4;  // 其他字符
    }
  }
  return Math.ceil(count);
}

/**
 * 研究结果封装
 */
class ResearchResult {
  constructor(options = {}) {
    this.summary = options.summary || '';
    this.keyFindings = options.keyFindings || [];
    this.filesAnalyzed = options.filesAnalyzed || [];
    this.totalTokens = options.totalTokens || 0;
    this.sourcePaths = options.sourcePaths || [];
    this.metadata = options.metadata || {};
  }

  /**
   * 生成简短摘要（用于返回主 context）
   */
  toSummary() {
    return {
      summary: this.summary.slice(0, 500),
      keyFindings: this.keyFindings.slice(0, 5),
      filesCount: this.filesAnalyzed.length,
      totalTokens: this.totalTokens,
    };
  }

  /**
   * 检查结果是否为空
   */
  isEmpty() {
    return !this.summary && this.keyFindings.length === 0;
  }
}

/**
 * 研究上下文隔离器
 */
class ResearchContext {
  constructor(options = {}) {
    this.projectDir = options.projectDir || process.cwd();
    this.maxTokens = options.maxTokens || DEFAULT_MAX_TOKENS;
    this.logger = options.logger;

    // 文件缓存（研究过程中避免重复读取）
    this._fileCache = new Map();
    this._cacheSize = 0;
    this._MAX_CACHE_SIZE = 10 * 1024 * 1024;  // 10MB 缓存
  }

  // ==========================================================================
  // 文件分析
  // ==========================================================================

  /**
   * 分析单个文件
   * @param {string} filePath - 文件路径
   * @param {Object} [options] - 分析选项
   * @param {number} [options.maxLines] - 最大读取行数
   * @param {boolean} [options.includeImports] - 是否分析 import
   * @returns {ResearchResult}
   */
  async analyzeFile(filePath, options = {}) {
    const resolvedPath = path.resolve(this.projectDir, filePath);
    const relativePath = path.relative(this.projectDir, resolvedPath);

    try {
      const content = await this._readFile(resolvedPath, options.maxLines);
      if (!content) {
        return new ResearchResult({
          summary: `File not found: ${relativePath}`,
          filesAnalyzed: [relativePath],
        });
      }

      const tokens = estimateTokenCount(content);
      let summary = content;

      // 大文件生成摘要
      if (tokens > SUMMARY_TRUNCATE_THRESHOLD) {
        summary = this._generateFileSummary(content, relativePath);
      }

      // 分析 imports
      let keyFindings = [];
      if (options.includeImports !== false) {
        keyFindings = this._extractImports(content, relativePath);
      }

      return new ResearchResult({
        summary,
        keyFindings,
        filesAnalyzed: [relativePath],
        totalTokens: tokens,
        sourcePaths: [resolvedPath],
        metadata: {
          type: 'file_analysis',
          lines: content.split('\n').length,
        },
      });
    } catch (err) {
      return new ResearchResult({
        summary: `Error analyzing ${relativePath}: ${err.message}`,
        filesAnalyzed: [relativePath],
      });
    }
  }

  /**
   * 分析多个文件
   * @param {Array<string>} filePaths - 文件路径数组
   * @param {Object} [options] - 分析选项
   * @returns {ResearchResult}
   */
  async analyzeFiles(filePaths, options = {}) {
    const results = [];
    for (const fp of filePaths) {
      const result = await this.analyzeFile(fp, options);
      results.push(result);
    }

    // 合并结果
    const allFindings = results.flatMap(r => r.keyFindings);
    const totalTokens = results.reduce((sum, r) => sum + r.totalTokens, 0);

    return new ResearchResult({
      summary: `Analyzed ${filePaths.length} files`,
      keyFindings: allFindings.slice(0, 20),
      filesAnalyzed: filePaths.map(fp => path.relative(this.projectDir, fp)),
      totalTokens,
      metadata: { type: 'multi_file_analysis', count: filePaths.length },
    });
  }

  // ==========================================================================
  // 模式搜索
  // ==========================================================================

  /**
   * 搜索代码模式
   * @param {string} pattern - 搜索模式
   * @param {Array<string>} [extensions] - 文件扩展名过滤
   * @param {number} [maxResults] - 最大结果数
   * @returns {ResearchResult}
   */
  async searchPattern(pattern, extensions = ['.js', '.ts', '.jsx', '.tsx'], maxResults = 10) {
    const findings = [];
    const analyzedFiles = [];

    try {
      const searchDir = this.projectDir;
      const files = this._findFiles(searchDir, extensions);

      for (const file of files) {
        if (findings.length >= maxResults) {break;}

        const content = await this._readFile(file);
        if (!content) {continue;}

        analyzedFiles.push(path.relative(this.projectDir, file));

        // 简单字符串搜索（实际应该用正则）
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(pattern)) {
            findings.push({
              file: path.relative(this.projectDir, file),
              line: i + 1,
              content: lines[i].trim().slice(0, 100),
            });
            if (findings.length >= maxResults) {break;}
          }
        }
      }
    } catch (err) {
      return new ResearchResult({
        summary: `Search error: ${err.message}`,
        filesAnalyzed: analyzedFiles,
      });
    }

    return new ResearchResult({
      summary: `Found ${findings.length} matches for "${pattern}"`,
      keyFindings: findings,
      filesAnalyzed: analyzedFiles,
      metadata: { type: 'pattern_search', pattern },
    });
  }

  // ==========================================================================
  // 架构分析
  // ==========================================================================

  /**
   * 分析项目架构
   * @returns {ResearchResult}
   */
  async analyzeArchitecture() {
    const structure = this._buildStructureReport();
    const keyFiles = await this._findKeyFiles();

    return new ResearchResult({
      summary: structure,
      keyFindings: keyFiles.map(f => ({ file: f, type: 'key_file' })),
      filesAnalyzed: keyFiles,
      metadata: { type: 'architecture_analysis' },
    });
  }

  // ==========================================================================
  // 内部辅助方法
  // ==========================================================================

  /**
   * 读取文件（带缓存）
   */
  async _readFile(filePath, maxLines = null) {
    const cacheKey = filePath;

    if (this._fileCache.has(cacheKey)) {
      return this._fileCache.get(cacheKey);
    }

    try {
      let content = fs.readFileSync(filePath, 'utf8');

      // 行数限制
      if (maxLines) {
        const lines = content.split('\n');
        content = lines.slice(0, maxLines).join('\n');
      }

      // 更新缓存
      this._cacheSize += content.length;
      this._fileCache.set(cacheKey, content);

      // 缓存过大，清除最老的
      if (this._cacheSize > this._MAX_CACHE_SIZE) {
        const firstKey = this._fileCache.keys().next().value;
        if (firstKey) {
          this._cacheSize -= this._fileCache.get(firstKey).length;
          this._fileCache.delete(firstKey);
        }
      }

      return content;
    } catch {
      return null;
    }
  }

  /**
   * 生成文件摘要
   */
  _generateFileSummary(content, filePath) {
    const lines = content.split('\n');
    const totalLines = lines.length;

    // 取前 30 行作为头部摘要
    const head = lines.slice(0, 30).join('\n');

    // 取后 20 行作为尾部摘要
    const tail = lines.slice(-20).join('\n');

    // 提取函数和类定义
    const definitions = lines.filter(l =>
      /^\s*(export\s+)?(async\s+)?(function|class|const\s+\w+\s*=\s*(?:async\s+)?\(|interface|type\s+\w+\s*=)/.test(l.trim())
    ).slice(0, 20);

    let summary = `## ${filePath} (${totalLines} lines)\n\n`;
    summary += `### Key Definitions\n${definitions.join('\n')}\n\n`;
    summary += `### Head\n${head}\n\n`;
    summary += `### Tail\n${tail}`;

    return summary;
  }

  /**
   * 提取 imports
   */
  _extractImports(content, filePath) {
    const imports = [];
    const requirePattern = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    const importPattern = /import\s+(?:\{[^}]*\}|[^;{]+)\s+from\s*['"]([^'"]+)['"]/g;

    let match;
    while ((match = requirePattern.exec(content)) !== null) {
      imports.push({ type: 'require', path: match[1], file: filePath });
    }
    while ((match = importPattern.exec(content)) !== null) {
      imports.push({ type: 'import', path: match[1], file: filePath });
    }

    return imports.slice(0, 30);
  }

  /**
   * 查找文件
   */
  _findFiles(dir, extensions, maxDepth = 3, currentDepth = 0) {
    const result = [];
    const ignoredDirs = new Set(['node_modules', '.git', '.anvil', 'dist', 'build', '.next', '.nuxt']);

    if (currentDepth > maxDepth) {return result;}

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (ignoredDirs.has(entry.name)) {continue;}
        if (entry.name.startsWith('.')) {continue;}

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          result.push(...this._findFiles(fullPath, extensions, maxDepth, currentDepth + 1));
        } else if (entry.isFile()) {
          if (extensions.some(ext => entry.name.endsWith(ext))) {
            result.push(fullPath);
          }
        }
      }
    } catch {
      // 忽略权限错误
    }

    return result;
  }

  /**
   * 构建目录结构报告
   */
  _buildStructureReport(maxDepth = 3) {
    const IGNORED_DIRS = new Set([
      'node_modules', '.git', '.anvil', 'dist', 'build',
      '.next', '.nuxt', 'cache', '__pycache__', '.venv',
    ]);

    const buildTree = (dirPath, depth = 0, maxDepth = 3) => {
      if (depth > maxDepth) {return '';}

      let result = '';
      const indent = '  '.repeat(depth);

      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true })
          .sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) {return -1;}
            if (!a.isDirectory() && b.isDirectory()) {return 1;}
            return a.name.localeCompare(b.name);
          });

        for (const entry of entries) {
          if (IGNORED_DIRS.has(entry.name)) {continue;}
          if (entry.name.startsWith('.')) {continue;}

          if (entry.isDirectory()) {
            result += `${indent}${entry.name}/\n`;
            result += buildTree(path.join(dirPath, entry.name), depth + 1, maxDepth);
          } else {
            result += `${indent}${entry.name}\n`;
          }
        }
      } catch {
        // 忽略
      }

      return result;
    };

    return buildTree(this.projectDir);
  }

  /**
   * 查找关键文件
   */
  async _findKeyFiles() {
    const candidates = [
      'package.json', 'tsconfig.json', 'pyproject.toml',
      'requirements.txt', 'Cargo.toml', 'go.mod',
      'pom.xml', 'build.gradle', 'Makefile',
      'Dockerfile', 'docker-compose.yml',
      '.env.example', 'README.md',
    ];

    return candidates.filter(f =>
      fs.existsSync(path.join(this.projectDir, f))
    );
  }

  // ==========================================================================
  // 工具方法
  // ==========================================================================

  /**
   * 清空缓存
   */
  clearCache() {
    this._fileCache.clear();
    this._cacheSize = 0;
  }

  /**
   * 获取缓存状态
   */
  getCacheStatus() {
    return {
      entries: this._fileCache.size,
      sizeBytes: this._cacheSize,
    };
  }
}

// ============================================================================
// 导出
// ============================================================================

module.exports = {
  ResearchContext,
  ResearchResult,
  estimateTokenCount,
};
/**
 * 结果聚合器
 * 负责收集、分类、合并多个Agent的产出，检测冲突并验证完成度
 * @file result-aggregator.js
 */

const {
  AggregationStrategy,
  ConflictResolution,
} = require('./constants');

class ResultAggregator {
  constructor(options = {}) {
    this.logger = options.logger;

    this.defaultStrategy = AggregationStrategy.HIERARCHICAL;
    this.conflictResolution = ConflictResolution.QUALITY_WINS;
  }

  /**
   * 聚合多个Agent的结果
   * @param {Object} options
   * @returns {Promise<Object>}
   */
  async aggregate(options) {
    const { task, results, fingerprint } = options;

    const startTime = Date.now();

    // 1. 分类结果
    const categorizedResults = this._categorizeResults(results);

    // 2. 检测冲突
    const conflicts = this._detectConflicts(categorizedResults);

    // 3. 解决冲突
    const resolvedResults = this._resolveConflicts(conflicts);

    // 4. 合并结果
    const mergedOutput = this._mergeResults(resolvedResults, this.defaultStrategy);

    // 5. 验证任务完成度
    const completionStatus = this._verifyCompletion(task, mergedOutput, fingerprint);

    return {
      content: mergedOutput.content,
      artifacts: mergedOutput.artifacts,
      completionStatus,
      conflictsResolved: conflicts.length,
      executionTime: Date.now() - startTime,
    };
  }

  /**
   * 分类结果
   */
  _categorizeResults(results) {
    const categorized = {
      code: [],
      design: [],
      review: [],
      coordination: [],
      other: [],
    };

    for (const [agentId, result] of results) {
      if (result.error) {
        categorized.other.push({
          agentId,
          type: 'error',
          content: result.error,
        });
        continue;
      }

      const content = result.content || '';

      // 基于内容特征分类
      if (this._isCodeOutput(content)) {
        categorized.code.push({ agentId, content, result });
      } else if (this._isDesignOutput(content)) {
        categorized.design.push({ agentId, content, result });
      } else if (this._isReviewOutput(content)) {
        categorized.review.push({ agentId, content, result });
      } else if (this._isCoordinationOutput(content)) {
        categorized.coordination.push({ agentId, content, result });
      } else {
        categorized.other.push({ agentId, content, result });
      }
    }

    return categorized;
  }

  /**
   * 检测冲突
   */
  _detectConflicts(categorizedResults) {
    const conflicts = [];

    // 检测代码冲突
    if (categorizedResults.code.length > 1) {
      const codeSignatures = this._extractCodeSignatures(
        categorizedResults.code.map(r => r.content)
      );

      const duplicates = this._findDuplicates(codeSignatures);
      if (duplicates.length > 0) {
        conflicts.push({
          type: 'code_conflict',
          category: 'code',
          items: duplicates,
          severity: 'high',
        });
      }
    }

    // 检测设计冲突
    if (categorizedResults.design.length > 1) {
      const designKeys = categorizedResults.design.map(r =>
        this._extractDesignKey(r.content)
      );

      const duplicates = this._findDuplicates(designKeys);
      if (duplicates.length > 0) {
        conflicts.push({
          type: 'design_conflict',
          category: 'design',
          items: duplicates,
          severity: 'medium',
        });
      }
    }

    return conflicts;
  }

  /**
   * 解决冲突
   */
  _resolveConflicts(conflicts) {
    if (conflicts.length === 0) {
      return { resolved: true };
    }

    const resolved = [];

    for (const conflict of conflicts) {
      switch (this.conflictResolution) {
        case ConflictResolution.KEEP_ALL:
          resolved.push(...conflict.items);
          break;

        case ConflictResolution.LATEST_WINS:
          // 按时间戳排序，保留最新
          const sorted = conflict.items.sort((a, b) =>
            new Date(b.timestamp) - new Date(a.timestamp)
          );
          resolved.push(sorted[0]);
          break;

        case ConflictResolution.QUALITY_WINS:
          // 选择内容最详细的
          const byLength = conflict.items.sort((a, b) =>
            (b.content?.length || 0) - (a.content?.length || 0)
          );
          resolved.push(byLength[0]);
          break;

        default:
          resolved.push(conflict.items[0]);
      }
    }

    return { resolved: true, resolvedItems: resolved };
  }

  /**
   * 合并结果
   */
  _mergeResults(categorizedResults, strategy) {
    let content = '';
    const artifacts = {};

    // 处理无冲突情况：_resolveConflicts 返回 { resolved: true } 时直接返回空结果
    if (categorizedResults.resolved === true && !categorizedResults.resolvedItems) {
      return { content: '', artifacts };
    }

    switch (strategy) {
      case AggregationStrategy.SEQUENTIAL:
        content = this._mergeSequential(categorizedResults);
        break;

      case AggregationStrategy.PARALLEL_OVERLAY:
        content = this._mergeParallelOverlay(categorizedResults);
        break;

      case AggregationStrategy.HIERARCHICAL:
        const hierarchical = this._mergeHierarchical(categorizedResults);
        content = hierarchical.content;
        artifacts = hierarchical.artifacts;
        break;

      default:
        content = this._mergeSequential(categorizedResults);
    }

    return { content, artifacts };
  }

  /**
   * 顺序合并
   */
  _mergeSequential(categorizedResults) {
    const sections = [];

    for (const [category, items] of Object.entries(categorizedResults)) {
      if (items.length === 0) continue;

      sections.push(`## ${this._formatCategoryName(category)}`);

      for (const item of items) {
        sections.push(`### ${item.agentId}`);
        sections.push(item.content);
        sections.push('');
      }
    }

    return sections.join('\n');
  }

  /**
   * 并行覆盖合并
   */
  _mergeParallelOverlay(categorizedResults) {
    const allContent = [];

    // 合并所有非冲突内容
    for (const items of Object.values(categorizedResults)) {
      for (const item of items) {
        if (!item._conflicted) {
          allContent.push(item.content);
        }
      }
    }

    return allContent.join('\n\n');
  }

  /**
   * 层级聚合（优先设计 -> 实现 -> 审查）
   */
  _mergeHierarchical(categorizedResults) {
    const contentParts = [];
    const artifacts = {};

    // 设计优先
    if (categorizedResults.design.length > 0) {
      contentParts.push('## 架构设计\n');
      for (const item of categorizedResults.design) {
        contentParts.push(item.content);
      }
    }

    // 实现次之
    if (categorizedResults.code.length > 0) {
      contentParts.push('\n## 实现\n');
      for (const item of categorizedResults.code) {
        contentParts.push(item.content);
        // 提取代码片段作为artifact
        const codeBlocks = this._extractCodeBlocks(item.content);
        Object.assign(artifacts, codeBlocks);
      }
    }

    // 审查最后
    if (categorizedResults.review.length > 0) {
      contentParts.push('\n## 审查意见\n');
      for (const item of categorizedResults.review) {
        contentParts.push(item.content);
      }
    }

    // 协调内容（通常作为补充）
    if (categorizedResults.coordination.length > 0) {
      contentParts.push('\n## 协调说明\n');
      for (const item of categorizedResults.coordination) {
        contentParts.push(item.content);
      }
    }

    return {
      content: contentParts.join('\n'),
      artifacts,
    };
  }

  /**
   * 验证任务完成度
   */
  _verifyCompletion(task, mergedOutput, fingerprint) {
    const content = mergedOutput.content || '';

    // 检查关键词是否保留
    const keyWords = fingerprint?.keyWords || [];
    const foundCount = keyWords.filter(w => content.includes(w)).length;
    const retentionRate = keyWords.length > 0
      ? foundCount / keyWords.length
      : 1;

    return {
      taskComplete: retentionRate >= 0.6,
      retentionRate,
      keyWordsFound: foundCount,
      keyWordsTotal: keyWords.length,
    };
  }

  // ================================================================
  // 辅助方法
  // ================================================================

  _isCodeOutput(content) {
    const codeIndicators = [
      /```[\s\S]*?```/,
      /function\s+\w+/,
      /class\s+\w+/,
      /const\s+\w+\s*=/,
      /def\s+\w+/,
      /import\s+/,
    ];
    return codeIndicators.some(p => p.test(content));
  }

  _isDesignOutput(content) {
    return /架构|设计|模块|接口|数据流/.test(content);
  }

  _isReviewOutput(content) {
    return /审查|问题|建议|bug|安全|风险/.test(content);
  }

  _isCoordinationOutput(content) {
    return /整合|协调|进度|状态/.test(content);
  }

  _extractCodeSignatures(contents) {
    return contents.map(c => {
      // 提取函数/类名作为签名
      const matches = c.match(/(?:function|class|const|def)\s+(\w+)/g);
      return matches ? matches.join('|') : c.slice(0, 100);
    });
  }

  _extractDesignKey(content) {
    // 提取设计关键词
    const keyTerms = ['架构', '模块', '接口', '数据流', '服务'];
    return keyTerms.filter(t => content.includes(t)).join('|');
  }

  _extractCodeBlocks(content) {
    const blocks = {};
    const regex = /```(\w+)\n([\s\S]*?)```/g;
    let match;

    while ((match = regex.exec(content)) !== null) {
      const lang = match[1] || 'unknown';
      const code = match[2];
      const key = `code_${Object.keys(blocks).length}`;
      blocks[key] = { language: lang, code };
    }

    return blocks;
  }

  _findDuplicates(items) {
    const seen = new Map();
    const duplicates = [];

    for (const item of items) {
      if (!item) continue;
      const key = typeof item === 'string' ? item : JSON.stringify(item);
      if (seen.has(key)) {
        duplicates.push(item);
      } else {
        seen.set(key, true);
      }
    }

    return duplicates;
  }

  _formatCategoryName(category) {
    return category.charAt(0).toUpperCase() + category.slice(1);
  }
}

module.exports = ResultAggregator;
module.exports.AggregationStrategy = AggregationStrategy;
module.exports.ConflictResolution = ConflictResolution;

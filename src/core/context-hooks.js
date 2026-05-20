/**
 * Context Hooks 机制
 *
 * 在关键事件（文件读取、Phase切换、阈值警告）触发自动化操作。
 * 支持：预加载、上下文监控、验证等。
 */

/**
 * Hook 基类
 */
class ContextHook {
  constructor(name) {
    this.name = name;
    this.enabled = true;
  }

  /**
   * 钩子执行（子类实现）
   * @param {Object} context - 上下文信息
   * @returns {Object|undefined} - 可选的返回结果
   */
  async execute(context) {
    return undefined;
  }

  /**
   * 启用/禁用钩子
   */
  setEnabled(enabled) {
    this.enabled = !!enabled;
  }
}

/**
 * 文件读取后预加载相关文件
 */
class PrefetchHook extends ContextHook {
  constructor(options = {}) {
    super('prefetch-hook');
    this.maxPrefetch = options.maxPrefetch || 5;
    this.contextManager = options.contextManager;
  }

  async execute(context) {
    if (!this.contextManager || !context.filePath) {
      return undefined;
    }

    try {
      const loaded = await this.contextManager.prefetchRelatedFiles(
        context.filePath,
        this.maxPrefetch
      );

      return {
        hook: this.name,
        action: 'prefetch',
        filesLoaded: loaded.length,
        files: loaded.map(f => f.path),
      };
    } catch {
      return undefined;
    }
  }
}

/**
 * Phase 切换时触发回调
 */
class PhaseTransitionHook extends ContextHook {
  constructor(options = {}) {
    super('phase-transition-hook');
    this.phaseManager = options.phaseManager;
    this.onPhaseChange = options.onPhaseChange;
  }

  async execute(context) {
    if (!context.phase) {
      return undefined;
    }

    const { oldPhase, newPhase } = context;

    // 触发回调
    if (this.onPhaseChange && oldPhase !== newPhase) {
      this.onPhaseChange(newPhase, oldPhase);
    }

    return {
      hook: this.name,
      action: 'phase_changed',
      from: oldPhase,
      to: newPhase,
    };
  }
}

/**
 * 上下文阈值警告时触发
 */
class ContextWarningHook extends ContextHook {
  constructor(options = {}) {
    super('context-monitor-hook');
    this.onWarning = options.onWarning;
  }

  async execute(context) {
    const { level, ratio, threshold } = context;

    if (level >= 2) {  // LIGHT_COMP 及以上
      if (this.onWarning) {
        this.onWarning({
          level,
          ratio: Math.round(ratio * 100),
          threshold: Math.round(threshold * 100),
        });
      }

      return {
        hook: this.name,
        action: 'warning',
        level,
        message: `Context at ${Math.round(ratio * 100)}% (threshold: ${Math.round(threshold * 100)}%)`,
      };
    }

    return undefined;
  }
}

/**
 * 文件修改后自动运行验证
 */
class ValidationHook extends ContextHook {
  constructor(options = {}) {
    super('validation-hook');
    this.validators = new Map();
    this.onValidation = options.onValidation;
  }

  /**
   * 注册验证器
   * @param {string} filePattern - 文件模式（如 *.js）
   * @param {Function} validator - 验证函数 (content) => Promise<boolean>
   */
  registerValidator(filePattern, validator) {
    this.validators.set(filePattern, validator);
  }

  async execute(context) {
    if (!context.filePath || !context.content) {
      return undefined;
    }

    // 查找匹配的验证器
    for (const [pattern, validator] of this.validators) {
      if (this._matchesPattern(context.filePath, pattern)) {
        try {
          const result = await validator(context.content);

          if (this.onValidation) {
            this.onValidation({
              file: context.filePath,
              valid: result,
              pattern,
            });
          }

          return {
            hook: this.name,
            action: 'validation',
            file: context.filePath,
            pattern,
            valid: result,
          };
        } catch (err) {
          return {
            hook: this.name,
            action: 'validation_error',
            file: context.filePath,
            error: err.message,
          };
        }
      }
    }

    return undefined;
  }

  _matchesPattern(filePath, pattern) {
    if (pattern === '*') {return true;}
    if (pattern.startsWith('*.')) {
      const ext = pattern.slice(1);
      return filePath.endsWith(ext);
    }
    return filePath.includes(pattern);
  }
}

/**
 * Hook 管理器：统一管理 Hooks 的注册和执行
 */
class ContextHookManager {
  constructor(options = {}) {
    this.hooks = new Map();
    this.contextManager = options.contextManager;
    this.logger = options.logger;
  }

  /**
   * 注册钩子
   * @param {ContextHook} hook - 钩子实例
   * @param {number} [priority=0] - 优先级（越高越先执行）
   */
  register(hook, priority = 0) {
    if (!this.hooks.has(priority)) {
      this.hooks.set(priority, []);
    }
    this.hooks.get(priority).push(hook);
    this.logger?.debug(`Hook registered: ${hook.name} (priority: ${priority})`);
  }

  /**
   * 注销钩子
   * @param {string} hookName - 钩子名称
   */
  unregister(hookName) {
    for (const [, hooks] of this.hooks) {
      const idx = hooks.findIndex(h => h.name === hookName);
      if (idx !== -1) {
        hooks.splice(idx, 1);
        return true;
      }
    }
    return false;
  }

  /**
   * 触发钩子
   * @param {string} event - 事件名称
   * @param {Object} context - 上下文信息
   * @returns {Array} 所有钩子的执行结果
   */
  async trigger(event, context = {}) {
    const results = [];

    // 按优先级排序执行
    const sortedPriorities = [...this.hooks.keys()].sort((a, b) => b - a);

    for (const priority of sortedPriorities) {
      const hooks = this.hooks.get(priority);
      for (const hook of hooks) {
        if (!hook.enabled) {continue;}

        try {
          const result = await hook.execute({ ...context, event });
          if (result) {
            results.push(result);
          }
        } catch (err) {
          this.logger?.warn(`Hook ${hook.name} failed: ${err.message}`);
        }
      }
    }

    return results;
  }

  /**
   * 创建并注册内置钩子
   */
  setupBuiltInHooks(options = {}) {
    // 预加载钩子
    if (options.enablePrefetch !== false) {
      const prefetchHook = new PrefetchHook({
        contextManager: this.contextManager,
        maxPrefetch: options.maxPrefetch || 5,
      });
      this.register(prefetchHook, 10);
    }

    // Phase 切换钩子
    if (options.enablePhaseTransition !== false) {
      const phaseHook = new PhaseTransitionHook({
        phaseManager: options.phaseManager,
        onPhaseChange: options.onPhaseChange,
      });
      this.register(phaseHook, 5);
    }

    // 上下文警告钩子
    if (options.enableContextWarning !== false) {
      const warningHook = new ContextWarningHook({
        onWarning: options.onWarning,
      });
      this.register(warningHook, 20);
    }

    // 验证钩子
    if (options.enableValidation !== false) {
      const validationHook = new ValidationHook({
        onValidation: options.onValidation,
      });
      this.register(validationHook, 15);
    }
  }

  /**
   * 获取所有已注册钩子
   */
  getRegisteredHooks() {
    const result = [];
    for (const [priority, hooks] of this.hooks) {
      for (const hook of hooks) {
        result.push({
          name: hook.name,
          priority,
          enabled: hook.enabled,
        });
      }
    }
    return result;
  }

  /**
   * 启用/禁用所有钩子
   */
  setEnabled(enabled) {
    for (const [, hooks] of this.hooks) {
      for (const hook of hooks) {
        hook.setEnabled(enabled);
      }
    }
  }
}

// ============================================================================
// 导出
// ============================================================================

module.exports = {
  ContextHook,
  PrefetchHook,
  PhaseTransitionHook,
  ContextWarningHook,
  ValidationHook,
  ContextHookManager,
};
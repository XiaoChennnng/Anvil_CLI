'use strict';

const fs = require('fs');
const path = require('path');

class TodoManager {
  constructor(options = {}) {
    this.filePath = options.filePath || path.join(options.projectDir || '.', '.anvil', 'todos.json');
    this.todos = [];
    this.maxTodos = options.maxTodos || 20;
    this._batchMode = 0;   // 批量模式嵌套计数
    this._dirty = false;    // 批量模式下需要保存
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, 'utf8');
        this.todos = JSON.parse(data);
      }
    } catch {
      this.todos = [];
    }
  }

  _save() {
    if (this._batchMode > 0) {
      this._dirty = true;
      return;
    }
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.todos, null, 2), 'utf8');
    } catch {
      // 静默失败
    }
  }

  beginBatch() {
    this._batchMode++;
  }

  endBatch() {
    if (this._batchMode > 0) {this._batchMode--;}
    if (this._batchMode === 0 && this._dirty) {
      this._dirty = false;
      this._save();
    }
  }

  /**
   * 添加 todo
   * @param {string} text - 任务描述
   * @param {Object} options - 选项
   * @returns {Object} 创建的 todo
   */
  add(text, options = {}) {
    if (!text || typeof text !== 'string') {return null;}

    const todo = {
      id: this._generateId(),
      text: text.trim(),
      completed: false,
      createdAt: new Date().toISOString(),
      completedAt: null,
      source: options.source || 'manual', // 'manual' | 'ai' | 'auto'
      priority: options.priority || 'normal', // 'low' | 'normal' | 'high'
    };

    this.todos.push(todo);

    // 超出限制时移除最旧的已完成任务（合并保存，避免两次写盘）
    if (this.todos.length > this.maxTodos) {
      this.beginBatch();
      this._cleanup();
      this.endBatch();
    }

    this._save();
    return todo;
  }

  /**
   * 完成 todo
   * @param {string} id - todo ID
   * @returns {boolean}
   */
  complete(id) {
    const todo = this.todos.find(t => t.id === id);
    if (todo) {
      todo.completed = true;
      todo.completedAt = new Date().toISOString();
      this._save();
      return true;
    }
    return false;
  }

  /**
   * 通过文本匹配完成 todo
   * @param {string} text - 部分文本匹配
   * @returns {boolean}
   */
  completeByText(text) {
    const todo = this.todos.find(t =>
      !t.completed && t.text.toLowerCase().includes(text.toLowerCase())
    );
    if (todo) {
      return this.complete(todo.id);
    }
    return false;
  }

  /**
   * 删除 todo
   * @param {string} id - todo ID
   * @returns {boolean}
   */
  remove(id) {
    const index = this.todos.findIndex(t => t.id === id);
    if (index !== -1) {
      this.todos.splice(index, 1);
      this._save();
      return true;
    }
    return false;
  }

  /**
   * 清空已完成的 todos
   */
  clearCompleted() {
    this.todos = this.todos.filter(t => !t.completed);
    this._save();
  }

  /**
   * 清空所有 todos
   */
  clearAll(onClear) {
    this.todos = [];
    this._save();
    if (typeof onClear === 'function') {onClear();}
  }

  /**
   * 获取所有 todos
   * @param {Object} filter - 过滤条件
   */
  getAll(filter = {}) {
    // 避免无条件完整拷贝：filter 已返回新数组，无需 [...this.todos]
    let result = this.todos;

    if (filter.completed !== undefined) {
      result = result.filter(t => t.completed === filter.completed);
    }

    if (filter.source) {
      result = result.filter(t => t.source === filter.source);
    }

    // 无过滤时拷贝一份再排序，避免污染原始数组
    if (result === this.todos) {
      result = [...result];
    }

    // 排序：未完成在前，高优先级在前
    result.sort((a, b) => {
      if (a.completed !== b.completed) {return a.completed ? 1 : -1;}
      const priorityOrder = { high: 0, normal: 1, low: 2 };
      return (priorityOrder[a.priority] || 1) - (priorityOrder[b.priority] || 1);
    });

    return result;
  }

  /**
   * 获取未完成的 todos
   */
  getPending() {
    return this.getAll({ completed: false });
  }

  /**
   * 获取已完成的 todos
   */
  getCompleted() {
    return this.getAll({ completed: true });
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const total = this.todos.length;
    const completed = this.todos.filter(t => t.completed).length;
    const pending = total - completed;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

    return { total, completed, pending, percent };
  }

  /**
   * 从 AI 响应中提取 todos
   * 支持多种格式：
   * - "- [ ] 任务描述"
   * - "- [x] 任务描述"
   * - "TODO: 任务描述"
   * - "1. 任务描述"
   * @param {string} content - AI 响应内容
   * @returns {Array} 提取的 todos
   */
  extractFromContent(content) {
    if (!content) {return [];}

    const extracted = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      // 格式1: "- [ ] 任务" 或 "- [x] 任务"
      const checkboxMatch = trimmed.match(/^[-*]\s*\[([ xX])\]\s*(.+)/);
      if (checkboxMatch) {
        const isCompleted = checkboxMatch[1] !== ' ';
        const text = checkboxMatch[2].trim();

        // 检查是否已存在
        const existing = this.todos.find(t =>
          t.text.toLowerCase() === text.toLowerCase()
        );

        if (!existing) {
          const todo = this.add(text, { source: 'ai' });
          if (isCompleted && todo) {
            this.complete(todo.id);
          }
          extracted.push(todo);
        } else if (isCompleted && !existing.completed) {
          this.complete(existing.id);
        }
        continue;
      }

      // 格式2: "TODO: 任务"
      const todoMatch = trimmed.match(/^TODO[:\s]+(.+)/i);
      if (todoMatch) {
        const text = todoMatch[1].trim();
        if (!this.todos.find(t => t.text.toLowerCase() === text.toLowerCase())) {
          extracted.push(this.add(text, { source: 'ai' }));
        }
        continue;
      }

      // 格式3: 数字列表 "1. 任务" (仅在明显是任务列表时)
      const numberMatch = trimmed.match(/^\d+\.\s+(.+)/);
      if (numberMatch && this._looksLikeTask(numberMatch[1])) {
        const text = numberMatch[1].trim();
        if (!this.todos.find(t => t.text.toLowerCase() === text.toLowerCase())) {
          extracted.push(this.add(text, { source: 'ai' }));
        }
        continue;
      }
    }

    return extracted.filter(Boolean);
  }

  /**
   * 判断文本是否看起来像任务
   */
  _looksLikeTask(text) {
    if (!text) {return false;}

    // 任务通常以动词开头
    const taskVerbs = [
      '创建', '修改', '删除', '添加', '实现', '修复', '更新', '优化',
      '检查', '测试', '编写', '重构', '部署', '配置', '安装',
      'create', 'fix', 'update', 'add', 'implement', 'write',
      'test', 'check', 'refactor', 'deploy', 'configure', 'install',
    ];

    const firstWord = text.split(/\s+/)[0].toLowerCase();
    return taskVerbs.some(v => firstWord.startsWith(v));
  }

  /**
   * 清理旧的已完成任务
   */
  _cleanup() {
    // 移除最旧的已完成任务（直接 splice 避免 remove 触发 _save）
    const completed = this.todos.filter(t => t.completed);
    if (completed.length > 0) {
      completed.sort((a, b) =>
        new Date(a.completedAt || a.createdAt) - new Date(b.completedAt || b.createdAt)
      );

      while (this.todos.length > this.maxTodos && completed.length > 0) {
        const oldest = completed.shift();
        const idx = this.todos.findIndex(t => t.id === oldest.id);
        if (idx !== -1) {
          this.todos.splice(idx, 1);
        }
      }
      this._dirty = true;
    }
  }

  /**
   * 生成唯一 ID
   */
  _generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  }
}

module.exports = TodoManager;

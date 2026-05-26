/**
 * 任务分发器
 * 负责将主任务分解为子任务，构建依赖图，并智能分配给Agent
 * @file task-distributor.js
 */

const { TaskTypes, TaskPriority } = require('./constants');

/**
 * 任务依赖图
 */
class TaskDependencyGraph {
  constructor() {
    this.nodes = new Map();  // taskId -> TaskNode
    this.edges = [];         // [fromId, toId]
  }

  addTask(task) {
    this.nodes.set(task.id, {
      id: task.id,
      description: task.description,
      type: task.type,
      estimatedComplexity: task.estimatedComplexity || 1,
      dependencies: new Set(task.dependencies || []),
    });
  }

  addEdge(fromId, toId) {
    const fromNode = this.nodes.get(fromId);
    const toNode = this.nodes.get(toId);

    if (fromNode && toNode) {
      fromNode.dependencies.add(toId);
      this.edges.push([fromId, toId]);
    }
  }

  /**
   * 获取拓扑排序后的任务列表
   */
  getTopologicalOrder() {
    const visited = new Set();
    const result = [];

    const visit = (nodeId) => {
      if (visited.has(nodeId)) {return;}
      visited.add(nodeId);

      const node = this.nodes.get(nodeId);
      if (node) {
        for (const depId of node.dependencies) {
          visit(depId);
        }
        result.push(node);
      }
    };

    for (const nodeId of this.nodes.keys()) {
      visit(nodeId);
    }

    return result;
  }

  /**
   * 获取可以并行执行的任务组
   */
  getParallelizableGroups() {
    const groups = [];
    const remaining = new Set(this.nodes.keys());
    const completed = new Set();

    while (remaining.size > 0) {
      const group = [];

      for (const taskId of remaining) {
        const node = this.nodes.get(taskId);
        const canExecute = [...node.dependencies].every(depId => completed.has(depId));

        if (canExecute) {
          group.push(node);
        }
      }

      if (group.length === 0 && remaining.size > 0) {
        // 死锁检测 - 有依赖未满足但无法执行
        throw new Error('任务依赖图存在循环引用');
      }

      for (const task of group) {
        remaining.delete(task.id);
        completed.add(task.id);
      }

      groups.push(group);
    }

    return groups;
  }
}

class TaskDistributor {
  constructor(options = {}) {
    this.logger = options.logger;

    // 角色-任务类型映射
    this.roleTaskMapping = {
      architect: [TaskTypes.DESIGN, TaskTypes.EXPLORE],
      executor: [TaskTypes.IMPLEMENT, TaskTypes.TEST],
      reviewer: [TaskTypes.REVIEW],
      coordinator: [TaskTypes.COORDINATE],
    };
  }

  /**
   * 创建任务执行计划
   * @param {Object} options
   * @returns {Promise<Object>}
   */
  async createTaskPlan(options) {
    const { task, agents, context } = options;

    // 1. 分解任务
    const subtasks = await this._decomposeTask(task, context);

    // 2. 构建依赖图
    const graph = this._buildDependencyGraph(subtasks);

    // 3. 获取并行化分组
    const parallelGroups = graph.getParallelizableGroups();

    // 4. 分配任务到Agent
    const assignments = this._assignTasksToAgents(subtasks, agents, parallelGroups);

    // 5. 设置优先级
    const priorities = this._calculatePriorities(assignments);

    return {
      subtasks,
      assignments,
      priorities,
      parallelGroups,
      estimatedDuration: this._estimateDuration(subtasks),
    };
  }

  /**
   * 分解主任务为子任务
   */
  async _decomposeTask(taskDescription, context = {}) {
    // 基于关键词的任务分解模式
    const decompositionPatterns = [
      {
        pattern: /需求分析|分析需求|了解需求/,
        tasks: [
          { id: 'explore', type: TaskTypes.EXPLORE, description: '探索现有代码库，理解项目结构' },
          { id: 'analyze', type: TaskTypes.EXPLORE, description: '分析需求和现有架构的匹配度' },
        ],
      },
      {
        pattern: /实现|开发|编写|写代码/,
        tasks: [
          { id: 'implement', type: TaskTypes.IMPLEMENT, description: '实现核心功能' },
          { id: 'integrate', type: TaskTypes.IMPLEMENT, description: '集成和联调' },
        ],
      },
      {
        pattern: /前端.{0,10}(和|与|以及|.+)后端|后端.{0,10}(和|与|以及|.+)前端/,
        tasks: [
          { id: 'frontend', type: TaskTypes.IMPLEMENT, description: '实现前端部分' },
          { id: 'backend', type: TaskTypes.IMPLEMENT, description: '实现后端部分' },
          { id: 'integration', type: TaskTypes.COORDINATE, description: '前后端集成' },
        ],
      },
      {
        pattern: /测试|验证|检查/,
        tasks: [
          { id: 'test_plan', type: TaskTypes.TEST, description: '制定测试计划' },
          { id: 'test_execute', type: TaskTypes.TEST, description: '执行测试' },
          { id: 'test_report', type: TaskTypes.REVIEW, description: '生成测试报告' },
        ],
      },
      {
        pattern: /重构|优化|改进/,
        tasks: [
          { id: 'analysis', type: TaskTypes.EXPLORE, description: '分析现有代码的问题' },
          { id: 'refactor', type: TaskTypes.IMPLEMENT, description: '执行重构' },
          { id: 'verify', type: TaskTypes.REVIEW, description: '验证重构正确性' },
        ],
      },
      {
        pattern: /同时|分别|并行|多个.{0,6}(模块|功能|组件|服务)/,
        tasks: [
          { id: 'module1', type: TaskTypes.IMPLEMENT, description: '实现模块一' },
          { id: 'module2', type: TaskTypes.IMPLEMENT, description: '实现模块二' },
          { id: 'module3', type: TaskTypes.IMPLEMENT, description: '实现模块三' },
          { id: 'integration', type: TaskTypes.COORDINATE, description: '模块集成' },
        ],
      },
    ];

    const tasks = [];
    let taskId = 1;

    // 识别分解模式
    for (const { pattern, tasks: patternTasks } of decompositionPatterns) {
      if (pattern.test(taskDescription)) {
        for (const task of patternTasks) {
          tasks.push({
            id: `${task.id}_${taskId++}`,
            type: task.type,
            description: task.description,
            estimatedComplexity: 1,
            dependencies: [],
          });
        }
        break;  // 只匹配一个主要模式
      }
    }

    // 如果没有匹配任何模式，创建默认子任务
    if (tasks.length === 0) {
      tasks.push({
        id: 'main_task',
        type: TaskTypes.IMPLEMENT,
        description: taskDescription,
        estimatedComplexity: 1,
        dependencies: [],
      });
    }

    // 添加任务间的隐式依赖
    this._addImplicitDependencies(tasks);

    return tasks;
  }

  /**
   * 添加隐式依赖关系
   */
  _addImplicitDependencies(tasks) {
    const typeOrder = {
      [TaskTypes.EXPLORE]: 0,
      [TaskTypes.DESIGN]: 1,
      [TaskTypes.IMPLEMENT]: 2,
      [TaskTypes.TEST]: 3,
      [TaskTypes.REVIEW]: 4,
      [TaskTypes.COORDINATE]: 5,
    };

    // 按类型排序，建立依赖
    tasks.sort((a, b) => typeOrder[a.type] - typeOrder[b.type]);

    for (let i = 1; i < tasks.length; i++) {
      if (!tasks[i].dependencies.includes(tasks[i - 1].id)) {
        tasks[i].dependencies.push(tasks[i - 1].id);
      }
    }
  }

  /**
   * 构建依赖图
   */
  _buildDependencyGraph(tasks) {
    const graph = new TaskDependencyGraph();

    for (const task of tasks) {
      graph.addTask(task);
    }

    for (const task of tasks) {
      for (const depId of task.dependencies) {
        graph.addEdge(task.id, depId);
      }
    }

    return graph;
  }

  /**
   * 分配任务到Agent（考虑负载均衡）
   */
  _assignTasksToAgents(tasks, agents, parallelGroups) {
    const assignments = {};

    // 初始化每个Agent的任务列表
    for (const agent of agents) {
      assignments[agent.agentId] = [];
    }

    // 按Agent角色分配
    for (const group of parallelGroups) {
      for (const task of group) {
        const suitableAgents = this._findSuitableAgents(task, agents);

        if (suitableAgents.length === 0) {
          // 没有合适角色，降级到executor
          const fallbackAgent = this._findLeastLoadedAgent(agents, assignments);
          if (fallbackAgent) {
            assignments[fallbackAgent.agentId].push(task);
          }
        } else {
          // 选择负载最轻的Agent
          const selectedAgent = this._selectLeastLoaded(suitableAgents, assignments);
          assignments[selectedAgent.agentId].push(task);
        }
      }
    }

    return assignments;
  }

  /**
   * 查找适合执行任务的Agent
   */
  _findSuitableAgents(task, agents) {
    const suitableRoles = Object.entries(this.roleTaskMapping)
      .filter(([, types]) => types.includes(task.type))
      .map(([role]) => role);

    return agents.filter(agent => suitableRoles.includes(agent.role));
  }

  /**
   * 查找负载最轻的Agent
   */
  _findLeastLoadedAgent(agents, assignments) {
    let minLoad = Infinity;
    let leastLoaded = null;

    for (const agent of agents) {
      const load = assignments[agent.agentId]?.length || 0;
      if (load < minLoad) {
        minLoad = load;
        leastLoaded = agent;
      }
    }

    return leastLoaded;
  }

  /**
   * 从候选集中选择负载最轻的
   */
  _selectLeastLoaded(candidates, assignments) {
    return this._findLeastLoadedAgent(candidates, assignments);
  }

  /**
   * 计算优先级
   */
  _calculatePriorities(assignments) {
    const priorities = {};

    for (const [agentId, tasks] of Object.entries(assignments)) {
      // 基于任务复杂度计算优先级
      const totalComplexity = tasks.reduce(
        (sum, task) => sum + (task.estimatedComplexity || 1),
        0
      );

      // 复杂度越高，优先级越高（数字越小）
      priorities[agentId] = totalComplexity > 5
        ? TaskPriority.HIGH
        : totalComplexity > 2
          ? TaskPriority.NORMAL
          : TaskPriority.LOW;
    }

    return priorities;
  }

  /**
   * 估算执行时间
   */
  _estimateDuration(tasks) {
    const baseTime = 5 * 60 * 1000;  // 5分钟基础时间
    const complexityFactor = tasks.reduce(
      (sum, task) => sum + (task.estimatedComplexity || 1),
      0
    );

    return baseTime * complexityFactor;
  }
}

module.exports = TaskDistributor;
module.exports.TaskDependencyGraph = TaskDependencyGraph;
module.exports.TaskTypes = TaskTypes;

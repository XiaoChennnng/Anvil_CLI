/**
 * 任务分发器：将主任务分解为子任务，构建依赖图，分配给Agent
 */

const { TaskTypes, TaskPriority } = require('./constants');

/**
 * Fallback 任务（无明确分解模式时）的角色视角前缀
 * 每个 agent 拿到同一段原始任务,加上自己的角色视角提示,LLM 知道从哪个角度切入
 * 关键:必须简洁,避免和 system prompt 的角色定义重复
 */
const FALLBACK_ROLE_ANGLES = {
  architect: '【架构师视角】请从整体架构、技术选型、模块划分、数据流/接口设计的角度分析这个任务:',
  executor: '【执行者视角】请从实现路径、代码组织、关键依赖、潜在技术难点的角度分析这个任务:',
  reviewer: '【审查者视角】请从方案完整性、合规性、安全风险、边界情况、可维护性的角度审查这个任务:',
  coordinator: '【协调者视角】请从跨模块一致性、依赖关系、整体可行性、可整合性的角度分析这个任务:',
};

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
      // 透传 _isFallback,fallback 展开依赖此标记
      _isFallback: task._isFallback === true,
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
    // 研究/调研类直接 fallback,避免误命中 /开发/ pattern
    const decompositionPatterns = [
      // 高优先级:研究/调研/分析类 → 不展开,直接 fallback 让 _assignTasksToAgents 按 agent 角色展开
      // 必须放最前面,避免被后续"开发/实现"等 pattern 抢先匹配
      {
        pattern: /研究|调研|探索|分析|多角度|可行性|方案设计|调研报告|可行性研究/,
        tasks: 'FALLBACK',
      },
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

    // purpose 描述模板:按 task type 给出明确说明,给子 Agent 提供工作目标
    const PURPOSE_BY_TYPE = {
      [TaskTypes.DESIGN]: '设计类:产出架构方案/接口设计/技术选型,作为下游实现的输入',
      [TaskTypes.EXPLORE]: '探索类:摸清现有代码/文档/约束,为后续设计提供事实依据',
      [TaskTypes.IMPLEMENT]: '实现类:按设计编写可工作的代码,确保自测通过',
      [TaskTypes.TEST]: '测试类:运行测试套件,记录失败用例,验证修复不引入回归',
      [TaskTypes.REVIEW]: '审查类:发现 bug/安全问题/规范违反,给出可执行的修复建议',
      [TaskTypes.COORDINATE]: '协调类:整合上游产出,处理冲突,推进整体进度',
    };

    // 识别分解模式
    for (const { pattern, tasks: patternTasks } of decompositionPatterns) {
      if (pattern.test(taskDescription)) {
        // 研究/调研类直接走 fallback,不再展开
        if (patternTasks === 'FALLBACK') {
          break;
        }
        for (const task of patternTasks) {
          tasks.push({
            id: `${task.id}_${taskId++}`,
            type: task.type,
            description: task.description,
            estimatedComplexity: 1,
            dependencies: [],
            purpose: PURPOSE_BY_TYPE[task.type] || `执行: ${task.description}`,
          });
        }
        break;  // 只匹配一个主要模式
      }
    }

    // 默认 _isFallback=true,按 agent 角色展开为 N 个角度化副本,避免空转+LLM 跑偏
    if (tasks.length === 0) {
      tasks.push({
        id: 'main_task',
        type: TaskTypes.EXPLORE,  // 改 EXPLORE:研究/调研类默认行为,EXPLORE 允许 architect 匹配
        description: taskDescription,
        estimatedComplexity: 1,
        dependencies: [],
        purpose: `研究/调研类:从可信来源收集信息,产出可作为决策依据的调研结论`,
        _isFallback: true,  // 标记 _assignTasksToAgents 按 agent 数量展开
      });
    }

    // 添加任务间的隐式依赖
    this._addImplicitDependencies(tasks);

    return tasks;
  }

  /**
   * 添加隐式依赖关系（拷贝后排序，避免污染调用方原数组）。
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

    // 用 slice() 拷贝再排序，避免污染原数组
    const sortedTasks = tasks.slice().sort((a, b) => typeOrder[a.type] - typeOrder[b.type]);

    for (let i = 1; i < sortedTasks.length; i++) {
      if (!sortedTasks[i].dependencies.includes(sortedTasks[i - 1].id)) {
        sortedTasks[i].dependencies.push(sortedTasks[i - 1].id);
      }
    }

    // 把排序+依赖关系写回原数组的元素对象（不重排原数组顺序，只更新每个 task 的 dependencies）
    // 这样既保持原数组顺序，又让依赖关系正确建立
    const depMap = new Map();
    for (let i = 1; i < sortedTasks.length; i++) {
      depMap.set(sortedTasks[i].id, sortedTasks[i].dependencies);
    }
    for (const task of tasks) {
      const deps = depMap.get(task.id);
      if (deps) {
        task.dependencies = [...deps];
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

    // 关键:兼容 agent.agentId / agent.id 两种字段名(mock 数据有时用 id)
    const getAgentId = (agent) => agent.agentId || agent.id;

    // 初始化每个Agent的任务列表
    for (const agent of agents) {
      assignments[getAgentId(agent)] = [];
    }

    // 按Agent角色分配
    for (const group of parallelGroups) {
      for (const task of group) {
        // _isFallback 任务按 agent 数量展开为角色视角副本,避免空转+LLM 跑偏
        if (task._isFallback) {
          // P3 修复:fallback 真分工
          // - N=1: 保留原任务
          // - N=2: 1 主分析 + 1【独立视角验证】
          // - N>=3: 1 主分析 + 1【独立视角】 + 1【交叉验证】 + 其余走【独立视角】
          // 每份仍带 FALLBACK_ROLE_ANGLES[role] 视角前缀
          const N = agents.length;
          for (let i = 0; i < N; i++) {
            const agent = agents[i];
            const agentId = getAgentId(agent);
            const roleHint = FALLBACK_ROLE_ANGLES[agent.role] || FALLBACK_ROLE_ANGLES.executor;
            // 第一份走"主分析",后续走不同分工
            const divisionHint = i === 0 ? '【主分析视角】这是主分析,其他 Agent 会从不同角度切入,请独立先展开你的视角。'
              : (N === 2 && i === 1)
                ? '【独立视角验证】请从独立视角重新分析,不要重复主分析的结论,寻找主分析可能忽略的盲点。'
                : (N >= 3 && i === 1)
                  ? '【独立视角】请从独立视角切入,不要重复主分析的结论。'
                  : (N >= 3 && i === 2)
                    ? '【交叉验证】请审视前面的产出,寻找偏倚、漏洞、共识或矛盾,最终给出你自己的判断。'
                    : '【独立视角】请从独立视角切入,与其他 Agent 输出保持差异性。';
            const angleTask = {
              ...task,
              id: `${task.id}_${agent.role}_${i}_${agentId.slice(0, 4)}`,
              description: `${roleHint}\n\n${divisionHint}\n\n${task.description}`,
              purpose: task.purpose
                ? `${task.purpose} | 分工: ${divisionHint}`
                : divisionHint,
            };
            assignments[agentId].push(angleTask);
          }
          continue;
        }

        const suitableAgents = this._findSuitableAgents(task, agents);

        if (suitableAgents.length === 0) {
          // 没有合适角色，降级到executor
          const fallbackAgent = this._findLeastLoadedAgent(agents, assignments);
          if (fallbackAgent) {
            assignments[getAgentId(fallbackAgent)].push(task);
          }
        } else {
          // 选择负载最轻的Agent
          const selectedAgent = this._selectLeastLoaded(suitableAgents, assignments);
          assignments[getAgentId(selectedAgent)].push(task);
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
   * 计算每个 Agent 的执行优先级
   * @param {Object} assignments - agentId -> tasks[] 分配表
   * @returns {Object<agentId, number>} agentId -> TaskPriority 数字（0/1/2/3）
   * @description 返回 TaskPriority 枚举的数字值，与 constants.js 保持类型一致，
   *              避免与字符串混用导致比较/排序/默认值回退时的类型错误。
   */
  _calculatePriorities(assignments) {
    const priorities = {};

    for (const [agentId, tasks] of Object.entries(assignments)) {
      // 基于任务复杂度计算总复杂度
      const totalComplexity = tasks.reduce(
        (sum, task) => sum + (task.estimatedComplexity || 1),
        0
      );

      // 复杂度越高，优先级越高（数字越小）
      // 显式使用 TaskPriority 数字常量，避免被误读为字符串
      priorities[agentId] = totalComplexity > 5
        ? TaskPriority.HIGH      // 1
        : totalComplexity > 2
          ? TaskPriority.NORMAL  // 2
          : TaskPriority.LOW;    // 3
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

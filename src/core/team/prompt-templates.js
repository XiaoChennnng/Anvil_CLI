// 动态提示词生成器

const { AgentRoles } = require('./constants');

class DynamicPromptGenerator {
  constructor(options = {}) {
    this.config = options.config || {};
    this.logger = options.logger;
  }

  /**
   * 生成子Agent的系统提示词
   * @param {Object} context
   * @returns {string}
   */
  generateSubAgentPrompt(context) {
    const {
      role,
      taskDescription,
      constraints = [],
      projectContext = '',
      teamSharedContext = null,
    } = context;

    let prompt = '';

    // 1. 角色定义
    prompt += this._generateRoleBlock(role);

    // 2. 项目上下文
    if (projectContext) {
      prompt += this._generateProjectContextBlock(projectContext);
    }

    // 3. 当前任务描述
    prompt += this._generateTaskBlock(taskDescription);

    // 4. 约束条件
    if (constraints.length > 0) {
      prompt += this._generateConstraintsBlock(constraints);
    }

    // 5. 团队共享上下文（其他Agent的产出）
    if (teamSharedContext) {
      prompt += this._generateSharedContextBlock(teamSharedContext);
    }

    // 6. 协作规范
    prompt += this._generateCollaborationBlock();

    // 7. 结束标记
    prompt += this._generateFooterBlock();

    return prompt;
  }

  /**
   * 生成角色定义块
   */
  _generateRoleBlock(role) {
    const roleConfig = AgentRoles[role.toUpperCase()] || AgentRoles.EXECUTOR;

    return `你是一位${roleConfig.description}。

你的核心职责：
${roleConfig.defaultPrompt.split('\n').slice(2, 6).join('\n')}

工作方式：
- 先深入理解任务要求，明确范围和目标
- 按照优先级有序执行，遇到阻塞及时上报
- 完成关键步骤后主动验证
- 遇到问题先尝试解决，实在无法解决再上报

`;
  }

  /**
   * 生成项目上下文块
   */
  _generateProjectContextBlock(projectContext) {
    return `
## 当前项目信息

${projectContext}

---
`;
  }

  /**
   * 生成任务描述块
   */
  _generateTaskBlock(taskDescription) {
    return `
## 你的任务

${taskDescription}

---
`;
  }

  /**
   * 生成约束条件块
   */
  _generateConstraintsBlock(constraints) {
    const SEVERITY_LABELS = {
      must: '【必须】',
      should: '【建议】',
      suggestion: '【可选】',
    };

    const constraintList = constraints.map((c, i) => {
      const desc = c.description || c;
      const severity = c.severity || 'must';
      const label = SEVERITY_LABELS[severity] || '';
      const reason = c.reason ? ` （原因：${c.reason}）` : '';
      return `${i + 1}. ${label} ${desc}${reason}`;
    }).join('\n');

    return `
## 约束条件

${constraintList}

---
`;
  }

  /**
   * 生成共享上下文块（其他Agent产出）
   */
  _generateSharedContextBlock(sharedContext) {
    let block = `
## 团队其他成员的产出

如有其他Agent已经完成相关工作，请先查阅以避免重复：

`;

    for (const [agentId, output] of Object.entries(sharedContext)) {
      block += `### ${agentId} 的产出\n${output}\n\n`;
    }

    block += `---\n`;
    return block;
  }

  /**
   * 生成协作规范块
   */
  _generateCollaborationBlock() {
    return `
## 协作规范

### 进度与通信
1. **进度报告**：关键进展时简要汇报，不要每个小步骤都报
2. **问题升级**：遇到阻塞超过 3 分钟无法解决时，简要说明已尝试的方案和需要的帮助
3. **结果提交**：完成后调用 task_complete 工具，一句话说明完成内容即可
4. **保持简洁**：不要说"任务已完成"等废话，直接说结果

### 依赖与等待
5. **等待上游**：如果任务依赖其他Agent的产出，先检查依赖是否就绪。未就绪时不要空等，先做不依赖的部分或主动请求依赖
6. **避免重复**：在开始前检查是否已有其他Agent处理过类似任务，不要重复造轮子

### 冲突处理
7. **方案冲突**：如果发现自己的方案与其他Agent的产出矛盾：
   - 先分析矛盾根源（设计理念不同？对需求理解不同？）
   - 如果时间允许，准备两种方案的优缺点对比
   - 上报给协调者裁决，不自作主张覆盖他人工作
8. **结果验证**：提交前自我验证产出质量，不要交半成品给协调者

`;
  }

  /**
   * 生成页脚块
   */
  _generateFooterBlock() {
    return `
## 开始执行

请专注于你的角色职责，在能力范围内最大化产出质量。
如果任务超出你的角色范围或遇到阻塞，及时上报。
`;
  }
}

module.exports = DynamicPromptGenerator;

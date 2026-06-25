'use strict';

// Team Mode 工具

async function startTeamTask(params, context) {
  const chatEngine = context.chatEngine;
  if (!chatEngine) {
    return { error: 'chatEngine 不可用' };
  }

  try {
    // force=true 表示用户明确要求启动,跳过内部复杂度评估
    const force = params.force === true;
    // suggestedRoles:AI 分析任务后指定的角色配置,如 [{role:'architect',count:1},...]
    // 不传则用默认 1 executor 兜底
    const suggestedRoles = Array.isArray(params.suggestedRoles) ? params.suggestedRoles : undefined;
    // executionOrder: 'parallel'(同时执行)或'sequential'(默认,串行防冲突)
    const executionOrder = params.executionOrder || 'sequential';
    const result = await chatEngine._startTeamTask(params.task, { force, suggestedRoles, executionOrder });
    return result;
  } catch (error) {
    return { error: error.message };
  }
}

async function evaluateTaskComplexity(params, context) {
  const chatEngine = context.chatEngine;
  if (!chatEngine) {
    return { error: 'chatEngine 不可用' };
  }

  try {
    const result = await chatEngine._evaluateTeamNeed(params.task);
    return result;
  } catch (error) {
    return { error: error.message };
  }
}

async function dissolveTeam(params, context) {
  const chatEngine = context.chatEngine;
  if (!chatEngine) {
    return { error: 'chatEngine 不可用' };
  }

  try {
    await chatEngine._dissolveTeam();
    return { success: true, message: '团队已解散' };
  } catch (error) {
    return { error: error.message };
  }
}

async function getTeamStatus(params, context) {
  const chatEngine = context.chatEngine;
  if (!chatEngine) {
    return { error: 'chatEngine 不可用' };
  }

  if (!chatEngine.teamManager) {
    return { teamExists: false, message: '当前没有活跃的团队' };
  }

  try {
    const status = chatEngine.teamManager.getStatus();
    return { teamExists: true, ...status };
  } catch (error) {
    return { error: error.message };
  }
}

// 注册 Team Mode 工具
function registerTeamTools(registry, chatEngine) {
  registry.register({
    name: 'start_team_task',
    description: '主动发起团队任务。当任务复杂、需要多模块并行开发时,调用此工具启动团队模式。系统会自动评估任务复杂度并组建子Agent团队协作完成。**当用户明确要求启用团队时,务必将 force 参数设为 true,跳过复杂度评估直接启动**。\n\n**多角色配置建议**:调用前先分析任务需要什么角色(架构师/执行者/审查者/协调者),通过 `suggestedRoles` 参数显式指定团队组成,而不是依赖默认 1 executor 配置。\n- 调研/研究/分析:architect + executor\n- 头脑风暴/多视角:architect + executor + reviewer\n- 完整实现:architect + executor + reviewer',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: '任务描述',
        },
        force: {
          type: 'boolean',
          description: '是否强制启动(跳过复杂度评估)。**用户明确要求开团队时必须设为 true**(如"用团队模式"/"team mode"/"组队"/"派子Agent"等关键词)。默认 false。',
          default: false,
        },
        suggestedRoles: {
          type: 'array',
          description: 'AI 指定的角色配置(强烈推荐显式传)。每项包含 role(角色名)和 count(数量)。role 取值:architect(架构师)、executor(执行者)、reviewer(审查者)、coordinator(协调者)。不传则默认 1 个 executor。',
          items: {
            type: 'object',
            properties: {
              role: {
                type: 'string',
                enum: ['architect', 'executor', 'reviewer', 'coordinator'],
                description: '角色名',
              },
              count: {
                type: 'integer',
                minimum: 1,
                maximum: 4,
                description: '该角色的 agent 数量,默认 1',
              },
            },
            required: ['role'],
          },
        },
      },
      required: ['task'],
    },
    execute: startTeamTask,
  });

  registry.register({
    name: 'evaluate_task_complexity',
    description: '评估任务复杂度。传入任务描述，返回是否需要团队模式的判断结果和建议（复杂度评分、建议的Agent角色配置）。',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: '任务描述',
        },
      },
      required: ['task'],
    },
    execute: evaluateTaskComplexity,
  });

  registry.register({
    name: 'dissolve_team',
    description: '解散当前团队。终止所有子Agent，回退到正常单Agent模式。当团队执行出现问题或需要重新评估任务时调用。',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: dissolveTeam,
  });

  registry.register({
    name: 'get_team_status',
    description: '查看当前团队状态。了解有多少子Agent、各自状态如何、团队当前处于什么阶段。',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: getTeamStatus,
  });
}

module.exports = { registerTeamTools };

'use strict';

// Team Mode 工具

async function startTeamTask(params, context) {
  const chatEngine = context.chatEngine;
  if (!chatEngine) {
    return { error: 'chatEngine 不可用' };
  }

  try {
    const result = await chatEngine._startTeamTask(params.task);
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
    description: '主动发起团队任务。当任务复杂、需要多模块并行开发时，调用此工具启动团队模式。系统会自动评估任务复杂度并组建子Agent团队协作完成。',
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

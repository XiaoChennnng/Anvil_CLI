'use strict';

/**
 * Plan Mode 相关工具
 * - enter_plan_mode: AI 主动请求进入计划模式
 * - request_plan_approval: AI 完成计划后请求用户批准（替代魔法字符串 [等待用户批准]）
 */

async function enterPlanMode(params, context) {
  if (context.chatEngine?._planMode) {
    return { alreadyEnabled: true, message: 'Plan Mode 已启用' };
  }

  if (context.chatEngine?.requestPlanMode) {
    const result = await context.chatEngine.requestPlanMode(params.reason || 'AI 主动请求');
    return result;
  }

  return { error: 'chatEngine 不可用' };
}

/**
 * AI 调用此工具来请求用户批准计划
 * 代码层检测到此工具调用 → 弹出同意/拒绝选项
 */
async function requestPlanApproval(params, context) {
  const chatEngine = context.chatEngine;
  if (!chatEngine) {
    return { error: 'chatEngine 不可用' };
  }

  // 拼接完整计划（展示给用户看的不只是 summary）
  const fullPlan = [
    params.summary ? `## 计划概述\n\n${params.summary}` : '',
    params.steps ? `\n## 实施步骤\n\n${params.steps}` : '',
    params.files ? `\n## 涉及文件\n\n${params.files}` : '',
    params.notes ? `\n## 备注\n\n${params.notes}` : '',
  ].filter(Boolean).join('\n');

  const planText = fullPlan || params.summary || '(无描述)';

  // 保存计划内容
  chatEngine._awaitingPlanApproval = true;
  chatEngine._pendingPlan = planText;
  chatEngine._suppressUI = false; // 确保 UI 事件重新开启

  if (fullPlan) {
    await chatEngine.savePlanToFile(fullPlan);
  }

  chatEngine.logger?.info('AI 调用 request_plan_approval 请求批准', {
    summary: (params.summary || '').slice(0, 100),
  });

  return {
    requested: true,
    message: '✅ 计划已提交并等待用户批准。**请立即停止**所有后续操作，不要再调用任何其他工具——用户的决定会通过系统消息传达给你。',
  };
}

/**
 * 注册 Plan Mode 相关工具
 */
function registerPlanModeTools(registry, chatEngine) {
  registry.register({
    name: 'enter_plan_mode',
    description: '请求进入计划模式。当任务涉及多文件修改、架构变更、新功能开发等复杂场景时调用此工具。进入后先做只读分析、产出计划、调用 request_plan_approval 请求批准，用户批准后再执行写操作。简单任务（查询信息、单行修改、闲聊）无需使用。',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: '进入计划模式的原因简述',
        },
      },
    },
    execute: enterPlanMode,
  });

  registry.register({
    name: 'request_plan_approval',
    description: '完成计划方案后调用此工具请求用户批准。调用后系统会弹出同意/拒绝选项让用户确认。只在 Plan Mode 下使用。用户批准后才能执行写操作。',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: '计划概述：一句话说明目标和方案',
        },
        steps: {
          type: 'string',
          description: '实施步骤：编号列表，每步说明做什么、涉及哪个文件',
        },
        files: {
          type: 'string',
          description: '涉及文件列表',
        },
        notes: {
          type: 'string',
          description: '额外备注或注意事项',
        },
      },
      required: ['summary'],
    },
    execute: requestPlanApproval,
  });
}

module.exports = { registerPlanModeTools };

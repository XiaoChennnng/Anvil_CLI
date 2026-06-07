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
 * 把任意类型规范化成多行 Markdown 列表字符串
 * - 数组 → 自动加 `1. ` 或 `- ` 前缀（按 ordered 选项）
 * - 对象 → 转 key: value 列表
 * - 字符串 → 处理字面 `\n` / `\r\n` / `\\n` 转义；已有列表标记保持原样
 * - 其他 → String(value)
 * @param {*} value - 原始值
 * @param {Object} [opts]
 * @param {boolean} [opts.ordered=false] - 数组用 1. 2. 3. (true) 还是 - - - (false)
 * @returns {string}
 */
function normalizeToMarkdownList(value, opts = {}) {
  const { ordered = false } = opts;
  if (value === null || value === undefined) {return '';}

  // 数组：直接加列表前缀
  if (Array.isArray(value)) {
    return value
      .map((item, i) => {
        const text = typeof item === 'object' ? JSON.stringify(item) : String(item).trim();
        if (!text) {return null;}
        const prefix = ordered ? `${i + 1}. ` : '- ';
        return prefix + text.replace(/\n/g, '\n  ');
      })
      .filter(Boolean)
      .join('\n');
  }

  // 对象（非数组）：转 key: value
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([k, v]) => `- **${k}**: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join('\n');
  }

  // 字符串：清理转义字符
  let str = String(value);
  // 处理字面 `\\n` `\\r\\n` `\\t`（LLM 双重转义传过来的）
  str = str.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '  ');
  // 处理真实 \r\n
  str = str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return str.trim();
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

  // 规范化各字段（处理 LLM 乱传数组/字面 \n / 对象的情况）
  const summary = normalizeToMarkdownList(params.summary);
  const steps = normalizeToMarkdownList(params.steps, { ordered: true });
  const files = normalizeToMarkdownList(params.files, { ordered: false });
  const notes = normalizeToMarkdownList(params.notes);

  // 拼接完整计划（展示给用户看的不只是 summary）
  const sections = [];
  if (summary) {sections.push(`## 计划概述\n\n${summary}`);}
  if (steps) {sections.push(`## 实施步骤\n\n${steps}`);}
  if (files) {sections.push(`## 涉及文件\n\n${files}`);}
  if (notes) {sections.push(`## 备注\n\n${notes}`);}
  const fullPlan = sections.join('\n\n');

  const planText = fullPlan || summary || '(无描述)';

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
          description: '计划概述：一段或几句话说明目标和方案（支持 Markdown）',
        },
        steps: {
          description: '实施步骤：推荐传字符串数组（每个元素是一步），也可以传多行 Markdown 字符串（每行一步，可用 "1. xxx" 或 "- xxx" 格式）。**禁止**把所有步骤挤在单行字符串里用字面 \\n 分隔。',
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
        },
        files: {
          description: '涉及文件列表：推荐传字符串数组（每个元素是一个文件路径或 "路径 - 说明"），也可以传多行 Markdown 字符串。**禁止**用逗号在一行里堆所有文件。',
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
        },
        notes: {
          type: 'string',
          description: '额外备注或注意事项（支持 Markdown）',
        },
      },
      required: ['summary'],
    },
    execute: requestPlanApproval,
  });
}

module.exports = { registerPlanModeTools, normalizeToMarkdownList };

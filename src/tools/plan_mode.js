'use strict';

// Plan Mode 工具

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

/** 规范化任意类型为 Markdown 列表字符串 */
function normalizeToMarkdownList(value, opts = {}) {
  const { ordered = false } = opts;
  if (value === null || value === undefined) {return '';}

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

  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([k, v]) => `- **${k}**: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join('\n');
  }

  let str = String(value);
  // 处理 LLM 双重转义的 \\n \\r\\n \\t
  str = str.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '  ');
  str = str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return str.trim();
}

// 请求用户批准计划
async function requestPlanApproval(params, context) {
  const chatEngine = context.chatEngine;
  if (!chatEngine) {
    return { error: 'chatEngine 不可用' };
  }

  // 规范化各字段
  const summary = normalizeToMarkdownList(params.summary);
  const steps = normalizeToMarkdownList(params.steps, { ordered: true });
  const files = normalizeToMarkdownList(params.files, { ordered: false });
  const notes = normalizeToMarkdownList(params.notes);

  // 拼接完整计划
  const sections = [];
  if (summary) {sections.push(`## 计划概述\n\n${summary}`);}
  if (steps) {sections.push(`## 实施步骤\n\n${steps}`);}
  if (files) {sections.push(`## 涉及文件\n\n${files}`);}
  if (notes) {sections.push(`## 备注\n\n${notes}`);}
  const fullPlan = sections.join('\n\n');

  const planText = fullPlan || summary || '(无描述)';

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
    message: '[完成] 计划已提交并等待用户批准。**请立即停止**所有后续操作，不要再调用任何其他工具——用户的决定会通过系统消息传达给你。',
  };
}

// 注册 Plan Mode 工具
function registerPlanModeTools(registry, chatEngine) {
  registry.register({
    name: 'enter_plan_mode',
    description: '请求进入计划模式。进入后先做只读分析熟悉现有代码，然后产出**包含背景分析、技术方案、详细实施步骤（每个步骤精确到文件名+函数名+代码改动）、文件清单表格、风险评估、验证方式的完整计划**，最后调用 request_plan_approval 请求批准。简单任务（查询信息、单行修改、闲聊）无需使用。',
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
    description: '完成计划方案后调用此工具请求用户批准。调用后系统会弹出同意/拒绝选项让用户确认。只在 Plan Mode 下使用。用户批准后才能执行写操作。**参数内容必须详细充实，禁止三言两语带过**。',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: '**计划概述（必填，必须详细）**：用 3-5 段说明整个计划——背景、目标、技术方案、关键决策原因。不要只写一句话。支持 Markdown。',
        },
        steps: {
          description: '**实施步骤（每步必须极其详细）**：推荐传字符串数组，每个元素是一步。**每步必须包含**：[文件名] + 具体改动（函数/类/行号级描述）+ 预期结果。示例：\n```\n"1. [src/core/parser.js] — 新增 parseInput() 函数，接收原始字符串，用正则提取 key=value 对，返回 Map 对象 —— 用户输入能正确结构化，后续处理不再裸操作字符串"\n```\n**禁止**用一句话描述一步。支持 Markdown 数组或字符串。',
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
        },
        files: {
          description: '**涉及文件列表（每行一个文件+改动说明）**：推荐传字符串数组。**每行必须包含**：文件路径 + 操作类型（修改/新增/删除）+ 改动什么（具体到函数或模块）。示例：\n```\n"- src/core/parser.js — 修改，新增 parseInput() 函数\n- test/parser.test.js — 新增，测试 parseInput 的边界情况"\n```\n**禁止**只用文件名不写改动内容。支持 Markdown 数组或字符串。',
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
        },
        notes: {
          type: 'string',
          description: '**备注（必须写）**：至少包含风险评估（兼容性/难点/回滚方案）和验证方式（如何确认改对了）。支持 Markdown。',
        },
      },
      required: ['summary'],
    },
    execute: requestPlanApproval,
  });
}

module.exports = { registerPlanModeTools, normalizeToMarkdownList };

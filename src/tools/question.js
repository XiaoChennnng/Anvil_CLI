'use strict';

async function askUserQuestion(params, context) {
  if (!context.onQuestion) {
    return { error: 'Question handler not available' };
  }

  if (!params.questions || !Array.isArray(params.questions) || params.questions.length === 0) {
    return { error: '至少需要一个问题' };
  }

  // 等待用户回答
  const result = await context.onQuestion(params);
  if (result && result.cancelled) {return { cancelled: true };}
  return { answers: result };
}

function registerQuestionTool(registry) {
  registry.register({
    name: 'ask_user_question',
    description: '向用户提出结构化问题并等待回答。当你需要用户做出选择来决定下一步方向时使用此工具。每个问题支持2-4个预定义选项，用户可以通过键盘选择（方向键浏览、Enter确认、Space多选、Esc跳过）。只在你的选择真正影响后续操作时使用，对于能从上下文推断的决策，自行判断即可。',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: '问题列表，支持1-4个问题同时展示',
          items: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: '问题描述，清晰说明需要用户决策的内容',
              },
              header: {
                type: 'string',
                description: '简短标签，用于问题切换时的标识（最多12个字符）',
              },
              options: {
                type: 'array',
                description: '选项列表（2-4个）',
                items: {
                  type: 'object',
                  properties: {
                    label: {
                      type: 'string',
                      description: '选项显示文本（1-5个词）',
                    },
                    description: {
                      type: 'string',
                      description: '选项说明，解释选择此选项的后果或含义',
                    },
                  },
                  required: ['label', 'description'],
                },
                minItems: 2,
                maxItems: 4,
              },
              multiSelect: {
                type: 'boolean',
                description: '是否允许多选（默认 false）。启用时用户可用 Space 切换选中状态',
              },
              customInput: {
                type: 'boolean',
                description: '是否允许用户输入自定义答案（默认 false）。启用时选项列表末尾会出现"自定义输入"选项，用户选择后可输入文字回答',
              },
            },
            required: ['question', 'header', 'options'],
          },
          minItems: 1,
          maxItems: 4,
        },
      },
      required: ['questions'],
    },
    execute: askUserQuestion,
  });
}

module.exports = { registerQuestionTool };

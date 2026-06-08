'use strict';

function registerTaskCompleteTool(registry, todoManager) {
  registry.register({
    name: 'task_complete',
    description: '声明当前任务已完成。调用此工具后，回复内容应直接结束，不要再重复说"任务已完成"或类似的总结性话语。',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: '完成摘要：简要说明完成了什么、改了哪些文件、结果如何（2-3句话）',
        },
        skipTodoCheck: {
          type: 'boolean',
          description: '是否跳过待办任务检查。简单问答/咨询类任务可设为 true 跳过。默认为 false。',
        },
      },
      required: ['summary'],
    },
    execute: async (params) => {
      const { summary, skipTodoCheck } = params;

      if (!summary || !summary.trim()) {
        return {
          complete: false,
          reason: '完成摘要不能为空，请提供 2-3 句话说明完成内容',
        };
      }

      // Todo 交叉校验
      if (!skipTodoCheck && todoManager) {
        const pendingTodos = todoManager.getPending();
        if (pendingTodos.length > 0) {
          return {
            complete: false,
            reason: `还有 ${pendingTodos.length} 个未完成的任务`,
            pendingTodos: pendingTodos.map(t => ({
              id: t.id,
              text: t.text,
              priority: t.priority,
            })),
            message: '请完成所有待办任务后再调用 task_complete，或先调用 complete_todo 标记已完成的任务',
          };
        }
      }

      return {
        complete: true,
        message: '任务完成',
        summary: summary.trim(),
      };
    },
  });
}

module.exports = { registerTaskCompleteTool };

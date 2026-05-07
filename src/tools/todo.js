'use strict';

async function addTodo(params, context) {
  const { text, priority } = params;
  const todoManager = context.todoManager;

  if (!text || !text.trim()) {
    return { error: '任务描述不能为空' };
  }

  const todo = todoManager.add(text.trim(), {
    source: 'ai',
    priority: priority || 'normal',
  });

  if (!todo) {
    return { error: '添加任务失败' };
  }

  if (context.onTodoChange) {
    context.onTodoChange(todoManager.getAll());
  }

  return {
    success: true,
    todo: {
      id: todo.id,
      text: todo.text,
      completed: todo.completed,
      priority: todo.priority,
    },
  };
}

async function completeTodo(params, context) {
  const { id, text } = params;
  const todoManager = context.todoManager;

  let success = false;
  if (id) {
    success = todoManager.complete(id);
  } else if (text) {
    success = todoManager.completeByText(text);
  } else {
    return { error: '需要提供 id 或 text 参数' };
  }

  if (!success) {
    return { error: '未找到匹配的任务' };
  }

  if (context.onTodoChange) {
    context.onTodoChange(todoManager.getAll());
  }

  return { success: true };
}

async function listTodos(params, context) {
  const todoManager = context.todoManager;
  const filter = {};

  if (params.filter === 'pending') {
    filter.completed = false;
  } else if (params.filter === 'completed') {
    filter.completed = true;
  }

  const todos = todoManager.getAll(filter);
  const stats = todoManager.getStats();

  return {
    todos: todos.map(t => ({
      id: t.id,
      text: t.text,
      completed: t.completed,
      priority: t.priority,
    })),
    stats,
  };
}

async function removeTodo(params, context) {
  const { id } = params;
  const todoManager = context.todoManager;

  if (!id) {
    return { error: '需要提供任务 id' };
  }

  const success = todoManager.remove(id);
  if (!success) {
    return { error: '未找到该任务' };
  }

  if (context.onTodoChange) {
    context.onTodoChange(todoManager.getAll());
  }

  return { success: true };
}

async function clearCompleted(params, context) {
  const todoManager = context.todoManager;
  todoManager.clearCompleted();

  if (context.onTodoChange) {
    context.onTodoChange(todoManager.getAll());
  }

  return { success: true };
}

function registerTodoTools(registry) {
  registry.register({
    name: 'add_todo',
    description: '添加一个新任务到待办列表。用于记录需要完成的工作、拆解复杂任务、追踪进度。',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '任务描述，以动词开头，简洁明确（如"创建登录页面"、"修复样式bug"）',
        },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high'],
          description: '优先级，默认 normal',
        },
      },
      required: ['text'],
    },
    execute: addTodo,
  });

  registry.register({
    name: 'complete_todo',
    description: '标记一个任务为已完成。可以通过 id 或文本模糊匹配。',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: '任务 ID（精确匹配）',
        },
        text: {
          type: 'string',
          description: '任务描述关键词（模糊匹配，与 id 二选一）',
        },
      },
    },
    execute: completeTodo,
  });

  registry.register({
    name: 'list_todos',
    description: '查看当前任务列表，支持按状态过滤。',
    parameters: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['all', 'pending', 'completed'],
          description: '过滤条件，默认 all',
        },
      },
    },
    execute: listTodos,
  });

  registry.register({
    name: 'remove_todo',
    description: '从任务列表中删除一个任务。',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: '任务 ID',
        },
      },
      required: ['id'],
    },
    execute: removeTodo,
  });

  registry.register({
    name: 'clear_completed_todos',
    description: '清空所有已完成的任务。',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: clearCompleted,
  });
}

module.exports = { registerTodoTools };

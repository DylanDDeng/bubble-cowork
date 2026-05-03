import type { BuiltinTodoItem, BuiltinTodoStore, BuiltinToolRegistryEntry } from '../types';
import { asString } from './common';

export function createTodoTool(store: BuiltinTodoStore): BuiltinToolRegistryEntry {
  return {
    name: 'todo_write',
    readOnly: true,
    description: 'Create or update the complete task list for complex multi-step work. Exactly one todo may be in_progress.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'Complete replacement list of todos.',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Imperative task description.' },
              activeForm: { type: 'string', description: 'Present continuous form shown while active.' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: 'Current todo status.',
              },
            },
            required: ['content', 'activeForm', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['todos'],
      additionalProperties: false,
    },
    async execute(args) {
      const rawTodos = Array.isArray(args.todos) ? args.todos : null;
      if (!rawTodos) return { content: "Error: 'todos' must be an array", isError: true, status: 'command_error' };
      const normalized: BuiltinTodoItem[] = [];
      for (let index = 0; index < rawTodos.length; index += 1) {
        const raw = rawTodos[index] as Record<string, unknown>;
        const content = asString(raw.content).trim();
        const activeForm = asString(raw.activeForm).trim();
        const status = raw.status;
        if (!content) return { content: `Error: todo ${index} has empty content`, isError: true, status: 'command_error' };
        if (!activeForm) return { content: `Error: todo ${index} has empty activeForm`, isError: true, status: 'command_error' };
        if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
          return { content: `Error: todo ${index} has invalid status`, isError: true, status: 'command_error' };
        }
        normalized.push({ content, activeForm, status });
      }
      const inProgressCount = normalized.filter((todo) => todo.status === 'in_progress').length;
      if (inProgressCount > 1) {
        return { content: `Error: at most one todo may be in_progress; found ${inProgressCount}`, isError: true, status: 'command_error' };
      }
      store.setTodos(normalized);
      const completed = normalized.filter((todo) => todo.status === 'completed').length;
      const pending = normalized.filter((todo) => todo.status === 'pending').length;
      return {
        content: `Todo list updated: ${normalized.length} item(s), ${completed} completed, ${inProgressCount} in progress, ${pending} pending.`,
        status: 'success',
        metadata: { kind: 'memory', matches: normalized.length },
      };
    },
  };
}


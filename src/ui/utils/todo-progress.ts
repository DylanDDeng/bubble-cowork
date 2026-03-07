type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoProgressItem {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

export interface TodoProgressState {
  todos: TodoProgressItem[];
  updateCount: number;
  completedCount: number;
  inProgressCount: number;
  pendingCount: number;
}

interface TodoWriteLikeBlock {
  name: string;
  input: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTodoStatus(value: unknown): TodoStatus | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'pending' || normalized === 'in_progress' || normalized === 'completed') {
    return normalized;
  }
  return null;
}

function parseTodoItem(value: unknown): TodoProgressItem | null {
  if (!isRecord(value)) {
    return null;
  }

  const content = typeof value.content === 'string' ? value.content.trim() : '';
  const status = normalizeTodoStatus(value.status);
  const activeForm =
    typeof value.activeForm === 'string' && value.activeForm.trim().length > 0
      ? value.activeForm.trim()
      : undefined;

  if (!content || !status) {
    return null;
  }

  return {
    content,
    status,
    activeForm,
  };
}

export function extractLatestTodoProgress(
  blocks: TodoWriteLikeBlock[]
): TodoProgressState | null {
  const todoWriteBlocks = blocks.filter((block) => block.name === 'TodoWrite');
  if (todoWriteBlocks.length === 0) {
    return null;
  }

  const latestBlock = [...todoWriteBlocks].reverse().find((block) => {
    if (!isRecord(block.input)) return false;
    return Array.isArray(block.input.todos);
  });

  if (!latestBlock || !isRecord(latestBlock.input) || !Array.isArray(latestBlock.input.todos)) {
    return null;
  }

  const todos = latestBlock.input.todos
    .map((todo) => parseTodoItem(todo))
    .filter((todo): todo is TodoProgressItem => !!todo);

  if (todos.length === 0) {
    return null;
  }

  const completedCount = todos.filter((todo) => todo.status === 'completed').length;
  const inProgressCount = todos.filter((todo) => todo.status === 'in_progress').length;
  const pendingCount = todos.length - completedCount - inProgressCount;

  return {
    todos,
    updateCount: todoWriteBlocks.length,
    completedCount,
    inProgressCount,
    pendingCount,
  };
}

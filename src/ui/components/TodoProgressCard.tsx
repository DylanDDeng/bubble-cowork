import { CheckCircle2, Circle, ListTodo, LoaderCircle } from 'lucide-react';
import type { TodoProgressItem, TodoProgressState } from '../utils/todo-progress';

function TodoStatusIcon({ item }: { item: TodoProgressItem }) {
  if (item.status === 'completed') {
    return <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-[var(--success)]" />;
  }

  if (item.status === 'in_progress') {
    return <LoaderCircle className="h-4 w-4 flex-shrink-0 animate-spin text-[var(--accent)]" />;
  }

  return <Circle className="h-4 w-4 flex-shrink-0 text-[var(--text-muted)]" />;
}

export function TodoProgressCard({
  state,
  className = '',
}: {
  state: TodoProgressState;
  className?: string;
}) {
  const summaryParts = [
    `${state.completedCount}/${state.todos.length} completed`,
    state.inProgressCount > 0 ? `${state.inProgressCount} in progress` : null,
    state.pendingCount > 0 ? `${state.pendingCount} pending` : null,
  ].filter(Boolean) as string[];

  return (
    <div
      className={`rounded-xl border border-[var(--border)] bg-[var(--bg-primary)]/90 px-3 py-3 ${className}`.trim()}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <ListTodo className="h-4 w-4 text-[var(--text-secondary)]" />
          <div>
            <div className="text-sm font-medium text-[var(--text-primary)]">Todo progress</div>
            <div className="text-xs text-[var(--text-muted)]">{summaryParts.join(' · ')}</div>
          </div>
        </div>
        {state.updateCount > 1 && (
          <div className="text-[11px] text-[var(--text-muted)]">
            updated {state.updateCount}x
          </div>
        )}
      </div>

      <div className="mt-3 space-y-2">
        {state.todos.map((todo, index) => {
          const displayText =
            todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content;

          return (
            <div key={`${todo.content}-${index}`} className="flex items-start gap-2.5">
              <TodoStatusIcon item={todo} />
              <div className="min-w-0 pt-0.5">
                <div
                  className={`text-sm leading-5 ${
                    todo.status === 'completed'
                      ? 'text-[var(--text-secondary)] line-through'
                      : 'text-[var(--text-primary)]'
                  }`}
                >
                  {displayText}
                </div>
                {todo.status === 'in_progress' && todo.activeForm && todo.activeForm !== todo.content && (
                  <div className="mt-0.5 text-xs text-[var(--text-muted)]">{todo.content}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

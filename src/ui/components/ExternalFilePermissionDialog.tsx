import type { ExternalFilePermissionInput, PermissionResult } from '../types';

export function ExternalFilePermissionDialog({
  input,
  onSubmit,
}: {
  input: ExternalFilePermissionInput;
  onSubmit: (result: PermissionResult) => void;
}) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/18 px-4 backdrop-blur-[1px]">
      <div className="w-full max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)] p-5 shadow-2xl">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
          External File Access
        </div>
        <div className="mt-2 text-lg font-semibold text-[var(--text-primary)]">
          {input.question}
        </div>
        <div className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
          The agent is trying to use <span className="font-semibold text-[var(--text-primary)]">{input.toolName}</span>{' '}
          on a file outside the current project folder.
        </div>

        <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--bg-tertiary)]/70 p-3">
          <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
            File Path
          </div>
          <div className="mt-1 break-all font-mono text-sm text-[var(--text-primary)]">
            {input.filePath}
          </div>
        </div>

        <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--bg-tertiary)]/40 p-3">
          <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
            Current Project
          </div>
          <div className="mt-1 break-all font-mono text-sm text-[var(--text-secondary)]">
            {input.cwd}
          </div>
        </div>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            onClick={() =>
              onSubmit({
                behavior: 'deny',
                message: 'User denied external file access',
              })
            }
            className="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
          >
            Reject
          </button>
          <button
            onClick={() =>
              onSubmit({
                behavior: 'allow',
                scope: 'once',
              })
            }
            className="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
          >
            Allow Once
          </button>
          <button
            onClick={() =>
              onSubmit({
                behavior: 'allow',
                scope: 'session',
              })
            }
            className="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)]"
          >
            Always Allow This Session
          </button>
        </div>
      </div>
    </div>
  );
}

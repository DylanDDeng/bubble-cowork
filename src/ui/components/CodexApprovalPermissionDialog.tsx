import { FilePenLine, ShieldAlert, SquareTerminal } from 'lucide-react';
import type { CodexApprovalPermissionInput, PermissionResult } from '../types';

export function CodexApprovalPermissionDialog({
  input,
  onSubmit,
}: {
  input: CodexApprovalPermissionInput;
  onSubmit: (result: PermissionResult) => void;
}) {
  const Icon =
    input.approvalKind === 'command'
      ? SquareTerminal
      : input.approvalKind === 'file-change'
        ? FilePenLine
        : ShieldAlert;
  const requester = input.method?.startsWith('aegis.builtin.')
    ? 'Aegis Built-in Agent'
    : 'Codex';

  const primaryDetailRows = [
    input.command ? { label: 'Command', value: input.command, mono: true } : null,
    input.cwd ? { label: 'Working Directory', value: input.cwd, mono: true } : null,
    input.grantRoot ? { label: 'Requested Root', value: input.grantRoot, mono: true } : null,
    input.reason ? { label: 'Reason', value: input.reason, mono: false } : null,
  ].filter((row): row is { label: string; value: string; mono: boolean } => Boolean(row));
  const detailRows =
    primaryDetailRows.length > 0
      ? primaryDetailRows
      : [{ label: 'Request', value: input.method, mono: true }];

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/18 px-4 backdrop-blur-[1px]">
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)] shadow-2xl">
        <div className="flex items-start gap-3 p-5">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--accent)]/25 bg-[var(--accent)]/10 text-[var(--accent)]">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
              {requester} Permission
            </div>
            <div className="mt-1 text-lg font-semibold text-[var(--text-primary)]">
              {input.question}
            </div>
            <div className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
              {requester} is requesting permission to use{' '}
              <span className="font-semibold text-[var(--text-primary)]">{input.toolName}</span>
              {input.approvalKind === 'permissions' ? ' with expanded access.' : '.'}
            </div>
          </div>
        </div>

        <div className="space-y-3 border-t border-[var(--border)] px-5 py-4">
          {detailRows.map((row) => (
            <div
              key={row.label}
              className="rounded-xl border border-[var(--border)] bg-[var(--bg-tertiary)]/70 p-3"
            >
              <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
                {row.label}
              </div>
              <div
                className={`mt-1 break-all text-sm text-[var(--text-primary)] ${
                  row.mono ? 'font-mono' : 'leading-6'
                }`}
              >
                {row.value}
              </div>
            </div>
          ))}

          {input.files && input.files.length > 1 ? (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-tertiary)]/70 p-3">
              <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
                Files
              </div>
              <div className="mt-2 max-h-28 space-y-1 overflow-y-auto">
                {input.files.map((file) => (
                  <div key={file} className="break-all font-mono text-sm text-[var(--text-primary)]">
                    {file}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {input.permissionSummary && input.permissionSummary.length > 0 ? (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-tertiary)]/70 p-3">
              <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
                Requested Permissions
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {input.permissionSummary.map((item) => (
                  <span
                    key={item}
                    className="inline-flex max-w-full items-center rounded-full border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-[var(--text-secondary)]"
                  >
                    <span className="truncate">{item}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--border)] px-5 py-4">
          <button
            onClick={() =>
              onSubmit({
                behavior: 'deny',
                message: `User denied ${requester} permission request`,
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
          {input.canAllowForSession !== false ? (
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
          ) : null}
        </div>
      </div>
    </div>
  );
}

import { memo, useMemo } from 'react';
import { Loader2, ShieldAlert } from 'lucide-react';
import { DecisionPanel } from './DecisionPanel';
import type {
  AskUserQuestionInput,
  CodexApprovalPermissionInput,
  ExternalFilePermissionInput,
  PermissionRequestPayload,
  PermissionResult,
} from '../types';

interface ComposerPendingPermissionPanelProps {
  request: PermissionRequestPayload;
  pendingCount: number;
  onSubmit: (toolUseId: string, result: PermissionResult) => void;
}

interface ComposerPendingPermissionActionsProps {
  request: PermissionRequestPayload;
  onSubmit: (toolUseId: string, result: PermissionResult) => void;
}

type ParsedPermission = {
  kindLabel: string;
  tool: string | null;
  fileName: string | null;
  fileDir: string | null;
  command: string | null;
  fallback: string | null;
  canAllowForSession: boolean;
  mode: 'approval' | 'question';
};

export const ComposerPendingPermissionPanel = memo(function ComposerPendingPermissionPanel({
  request,
  pendingCount,
  onSubmit,
}: ComposerPendingPermissionPanelProps) {
  const parsed = useMemo(() => parsePermissionRequest(request), [request]);

  return (
    <div className="overflow-hidden rounded-xl border border-[color-mix(in_srgb,var(--border)_82%,transparent)] bg-[var(--bg-primary)] shadow-[0_14px_36px_rgba(15,23,42,0.10)]">
      <div className="flex items-center justify-between gap-4 px-4 py-3 sm:px-5">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600" />
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <div className="flex min-w-0 items-baseline gap-1.5">
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
              {parsed.kindLabel}
              </span>
              {parsed.tool ? (
                <span className="truncate text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">
                  · {parsed.tool}
                </span>
              ) : null}
            </div>
            <div className="hidden h-5 w-px bg-[var(--border)] sm:block" />
            <ApprovalSummary parsed={parsed} />
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {pendingCount > 1 ? (
            <span className="rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-[var(--text-secondary)]">
              1/{pendingCount}
            </span>
          ) : null}
          <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-600">
            Waiting
          </span>
          <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--text-muted)]" />
        </div>
      </div>

      <div className="mx-4 border-t border-[var(--border)] sm:mx-5" />

      {parsed.mode === 'question' && isAskUserQuestionInput(request.input) ? (
        <div className="px-4 py-3 sm:px-5">
          <DecisionPanel
            chrome="bare"
            input={request.input}
            onSubmit={(result) => onSubmit(request.toolUseId, result)}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <p className="text-sm text-[var(--text-secondary)]">
            Resolve this approval request to continue
          </p>
          <ComposerPendingPermissionActions request={request} onSubmit={onSubmit} />
        </div>
      )}
    </div>
  );
});

export const ComposerPendingPermissionActions = memo(function ComposerPendingPermissionActions({
  request,
  onSubmit,
}: ComposerPendingPermissionActionsProps) {
  const parsed = useMemo(() => parsePermissionRequest(request), [request]);

  if (parsed.mode === 'question') {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <button
        type="button"
        onClick={() =>
          onSubmit(request.toolUseId, {
            behavior: 'deny',
            message: 'User cancelled tool execution.',
          })
        }
        className="rounded-lg px-3 py-1.5 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
      >
        Cancel turn
      </button>
      <button
        type="button"
        onClick={() =>
          onSubmit(request.toolUseId, {
            behavior: 'deny',
            message: 'User declined tool execution.',
          })
        }
        className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
      >
        Decline
      </button>
      {parsed.canAllowForSession ? (
        <button
          type="button"
          onClick={() =>
            onSubmit(request.toolUseId, {
              behavior: 'allow',
              scope: 'session',
            })
          }
          className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
        >
          Always allow this session
        </button>
      ) : null}
      <button
        type="button"
        onClick={() =>
          onSubmit(request.toolUseId, {
            behavior: 'allow',
            scope: 'once',
          })
        }
        className="rounded-lg bg-[var(--text-primary)] px-3 py-1.5 text-sm font-medium text-[var(--bg-primary)] transition-colors hover:opacity-90"
      >
        Approve once
      </button>
    </div>
  );
});

function ApprovalSummary({ parsed }: { parsed: ParsedPermission }) {
  if (parsed.fileName) {
    return (
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
        <span
          className="truncate text-[13px] font-medium leading-tight text-[var(--text-primary)]"
          title={parsed.fileDir ? `${parsed.fileDir}/${parsed.fileName}` : parsed.fileName}
        >
          {parsed.fileName}
        </span>
        {parsed.fileDir ? (
          <span
            className="truncate font-mono text-[11px] leading-tight text-[var(--text-secondary)]"
            title={parsed.fileDir}
          >
            {shortenPath(parsed.fileDir)}
          </span>
        ) : null}
      </div>
    );
  }

  if (parsed.command) {
    return (
      <pre
        className="min-w-0 overflow-hidden font-mono text-[11.5px] leading-snug text-[var(--text-primary)]/85"
        title={parsed.command}
      >
        <code className="block truncate">{parsed.command}</code>
      </pre>
    );
  }

  if (parsed.fallback) {
    return (
      <p
        className="truncate font-mono text-[11px] text-[var(--text-secondary)]"
        title={parsed.fallback}
      >
        {parsed.fallback}
      </p>
    );
  }

  return (
    <p className="text-[12px] text-[var(--text-secondary)]">
      Review the request to continue.
    </p>
  );
}

function parsePermissionRequest(request: PermissionRequestPayload): ParsedPermission {
  const input = request.input;
  if (isExternalFilePermissionInput(input)) {
    return {
      kindLabel: 'FILE ACCESS',
      tool: input.toolName,
      fileName: basenameOfPath(input.filePath),
      fileDir: dirnameOfPath(input.filePath) || input.cwd,
      command: null,
      fallback: null,
      canAllowForSession: true,
      mode: 'approval',
    };
  }

  if (isCodexApprovalPermissionInput(input)) {
    const filePath = input.filePath || input.files?.[0] || input.grantRoot || null;
    return {
      kindLabel: codexKindLabel(input),
      tool: input.toolName || request.toolName,
      fileName: input.command || !filePath ? null : basenameOfPath(filePath),
      fileDir: input.command || !filePath ? null : dirnameOfPath(filePath) || input.cwd || null,
      command: input.command || null,
      fallback:
        input.permissionSummary && input.permissionSummary.length > 0
          ? input.permissionSummary.join(' ')
          : input.question || input.title,
      canAllowForSession: input.canAllowForSession !== false,
      mode: 'approval',
    };
  }

  if (isAskUserQuestionInput(input)) {
    const firstQuestion = input.questions[0];
    return {
      kindLabel: 'QUESTION',
      tool: request.toolName,
      fileName: null,
      fileDir: null,
      command: firstQuestion?.header || null,
      fallback: firstQuestion?.question || 'Review the request to continue',
      canAllowForSession: false,
      mode: 'question',
    };
  }

  return {
    kindLabel: 'APPROVAL',
    tool: request.toolName,
    fileName: null,
    fileDir: null,
    command: null,
    fallback: 'Review the request to continue',
    canAllowForSession: false,
    mode: 'approval',
  };
}

function codexKindLabel(input: CodexApprovalPermissionInput): string {
  if (input.approvalKind === 'command') return 'COMMAND';
  if (input.approvalKind === 'file-change') return 'FILE CHANGE';
  if (input.approvalKind === 'permissions') return 'PERMISSION';
  return 'APPROVAL';
}

function isExternalFilePermissionInput(input: unknown): input is ExternalFilePermissionInput {
  return (
    typeof input === 'object' &&
    input !== null &&
    'kind' in input &&
    (input as { kind?: unknown }).kind === 'external-file-access'
  );
}

function isCodexApprovalPermissionInput(input: unknown): input is CodexApprovalPermissionInput {
  return (
    typeof input === 'object' &&
    input !== null &&
    'kind' in input &&
    (input as { kind?: unknown }).kind === 'codex-approval'
  );
}

function isAskUserQuestionInput(input: unknown): input is AskUserQuestionInput {
  return (
    typeof input === 'object' &&
    input !== null &&
    'questions' in input &&
    Array.isArray((input as { questions?: unknown }).questions)
  );
}

function basenameOfPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').filter(Boolean).at(-1) || path;
}

function dirnameOfPath(path: string): string | null {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) return null;
  return normalized.slice(0, lastSlash);
}

function shortenPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const homeMatch = normalized.match(/^\/(?:Users|home)\/[^/]+(?=\/|$)/);
  const withoutHome = homeMatch ? `~${normalized.slice(homeMatch[0].length)}` : normalized;
  const segments = withoutHome.split('/').filter((segment) => segment.length > 0);
  if (segments.length <= 3) return withoutHome;
  const leading = withoutHome.startsWith('~') ? '~' : '';
  return `${leading}/.../${segments.slice(-2).join('/')}`.replace(/^\/\.\.\./, '...');
}

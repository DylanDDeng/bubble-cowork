import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import * as Dialog from '@/ui/components/ui/dialog';
import { History } from './icons';
import type { ClaudeRewindFilesOutcome, ClaudeRewindScope } from '../types';

export interface ClaudeRewindTarget {
  sessionId: string;
  /** UUID of the SDK user message anchoring the checkpoint. */
  anchorMessageId: string;
  /** Prompt text of the user message being rewound past, for display. */
  promptPreview: string;
}

type FilesPreviewState =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'ready'; outcome: ClaudeRewindFilesOutcome };

export function ClaudeRewindDialog({
  target,
  onClose,
  onRewound,
}: {
  target: ClaudeRewindTarget | null;
  onClose: () => void;
  /** Called after a successful rewind; carries the removed prompt text (if any). */
  onRewound?: (removedPrompt: string | null) => void;
}) {
  const [scope, setScope] = useState<ClaudeRewindScope>('both');
  const [filesPreview, setFilesPreview] = useState<FilesPreviewState>({ status: 'loading' });
  const [executing, setExecuting] = useState(false);

  const open = target !== null;
  const filesUsable = filesPreview.status === 'ready' && filesPreview.outcome.canRewind;

  useEffect(() => {
    if (!target) {
      return;
    }

    let cancelled = false;
    setScope('both');
    setFilesPreview({ status: 'loading' });
    setExecuting(false);

    void window.electron
      .claudeRewind({
        sessionId: target.sessionId,
        anchorMessageId: target.anchorMessageId,
        scope: 'files',
        dryRun: true,
      })
      .then((result) => {
        if (cancelled) return;
        if (!result.filesAvailable || !result.files) {
          setFilesPreview({ status: 'unavailable' });
          setScope('conversation');
          return;
        }
        setFilesPreview({ status: 'ready', outcome: result.files });
        if (!result.files.canRewind) {
          setScope('conversation');
        }
      })
      .catch(() => {
        if (cancelled) return;
        setFilesPreview({ status: 'unavailable' });
        setScope('conversation');
      });

    return () => {
      cancelled = true;
    };
  }, [target]);

  const handleConfirm = async () => {
    if (!target || executing) return;
    setExecuting(true);
    try {
      const result = await window.electron.claudeRewind({
        sessionId: target.sessionId,
        anchorMessageId: target.anchorMessageId,
        scope,
      });
      if (!result.ok) {
        toast.error(result.message || 'Rewind failed.');
        return;
      }
      const parts: string[] = [];
      if (scope !== 'files') parts.push('conversation');
      if (scope !== 'conversation' && result.files?.canRewind) {
        parts.push(`${result.files.filesChanged?.length || 0} file(s)`);
      }
      toast.success(`Rewound ${parts.join(' and ') || 'session'}.`);
      onRewound?.(result.removedPrompt ?? null);
      onClose();
    } catch (error) {
      toast.error(`Rewind failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setExecuting(false);
    }
  };

  const scopeOptions: Array<{
    value: ClaudeRewindScope;
    label: string;
    description: string;
    disabled: boolean;
  }> = [
    {
      value: 'both',
      label: 'Conversation and code',
      description: 'Restore files and drop the messages after this point.',
      disabled: !filesUsable,
    },
    {
      value: 'conversation',
      label: 'Conversation only',
      description: 'Drop the messages; keep files as they are now.',
      disabled: false,
    },
    {
      value: 'files',
      label: 'Code only',
      description: 'Restore files; keep the conversation intact.',
      disabled: !filesUsable,
    },
  ];

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && !executing && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[420px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] p-5 shadow-[0_18px_44px_rgba(15,23,42,0.18)]">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-[var(--text-secondary)]" aria-hidden="true" />
            <Dialog.Title className="text-sm font-semibold text-[var(--text-primary)]">
              Rewind to before this message
            </Dialog.Title>
          </div>
          {target?.promptPreview ? (
            <Dialog.Description className="mt-2 line-clamp-2 rounded-md bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs text-[var(--text-secondary)]">
              “{target.promptPreview}”
            </Dialog.Description>
          ) : null}

          <div className="mt-4 space-y-1.5">
            {scopeOptions.map((option) => (
              <label
                key={option.value}
                className={`flex cursor-pointer items-start gap-2.5 rounded-[10px] border px-3 py-2 transition-colors ${
                  scope === option.value
                    ? 'border-[var(--accent)] bg-[var(--accent-light)]'
                    : 'border-[var(--border)] hover:bg-[var(--bg-secondary)]'
                } ${option.disabled ? 'cursor-not-allowed opacity-45' : ''}`}
              >
                <input
                  type="radio"
                  name="claude-rewind-scope"
                  className="mt-0.5 accent-[var(--accent)]"
                  checked={scope === option.value}
                  disabled={option.disabled}
                  onChange={() => setScope(option.value)}
                />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-[var(--text-primary)]">
                    {option.label}
                  </span>
                  <span className="block text-xs text-[var(--text-muted)]">{option.description}</span>
                </span>
              </label>
            ))}
          </div>

          <div className="mt-3 min-h-[32px] text-xs text-[var(--text-muted)]">
            {filesPreview.status === 'loading' ? (
              'Checking file checkpoints...'
            ) : filesPreview.status === 'unavailable' ? (
              'File rewind is unavailable for this session right now (it needs a live Claude runtime). Conversation rewind still works.'
            ) : !filesPreview.outcome.canRewind ? (
              `File rewind is unavailable: ${filesPreview.outcome.error || 'no checkpoint found for this message.'}`
            ) : filesPreview.outcome.filesChanged && filesPreview.outcome.filesChanged.length > 0 ? (
              <span>
                Restoring files would change{' '}
                <span className="font-medium text-[var(--text-secondary)]">
                  {filesPreview.outcome.filesChanged.length}
                </span>{' '}
                file(s)
                {typeof filesPreview.outcome.insertions === 'number' ||
                typeof filesPreview.outcome.deletions === 'number'
                  ? ` (+${filesPreview.outcome.insertions || 0} / -${filesPreview.outcome.deletions || 0})`
                  : ''}
                :
                <span className="mt-1 block max-h-[96px] overflow-auto rounded-md bg-[var(--bg-secondary)] px-2 py-1 font-mono text-[11px] leading-4">
                  {filesPreview.outcome.filesChanged.map((file) => (
                    <span key={file} className="block truncate" title={file}>
                      {file}
                    </span>
                  ))}
                </span>
              </span>
            ) : (
              'No file changes since this message — rewinding code is a no-op.'
            )}
          </div>

          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => !executing && onClose()}
              className="rounded-[10px] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={executing || (scope !== 'conversation' && !filesUsable)}
              className="rounded-[10px] border border-[var(--border)] bg-[var(--accent-light)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] shadow-sm transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {executing ? 'Rewinding...' : 'Rewind'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

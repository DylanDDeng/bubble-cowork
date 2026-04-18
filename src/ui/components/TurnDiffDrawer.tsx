import { useEffect, useMemo } from 'react';
import { X } from 'lucide-react';
import { FileTypeIcon } from './FileTypeIcon';
import { DiffStatLabel } from './DiffStatLabel';
import type { ChangeRecord } from '../utils/change-records';

function basename(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

function describeOperation(record: ChangeRecord): string {
  switch (record.operation) {
    case 'write':
    case 'added':
      return 'File created';
    case 'delete':
    case 'deleted':
      return 'File deleted';
    case 'renamed':
      return 'File renamed';
    case 'bash':
      return 'Changed via shell command';
    case 'untracked':
      return 'Untracked file';
    case 'edit':
    case 'modified':
    default:
      return 'File modified';
  }
}

function EmptyDiffState({ record }: { record: ChangeRecord }) {
  return (
    <div className="flex h-full flex-col items-start gap-2 p-6 text-[13px] text-[var(--text-muted)]">
      <div className="text-[var(--text-primary)]">{describeOperation(record)}</div>
      <div className="break-all font-mono text-[12px]">{record.filePath}</div>
      <div className="mt-2 text-[12px]">
        No unified diff was captured for this change, so there is nothing to
        render here. The change is still reflected in the files-changed
        summary above.
      </div>
    </div>
  );
}

type DiffRow =
  | { kind: 'hunk'; text: string }
  | { kind: 'context'; text: string; oldLine: number | null; newLine: number | null }
  | { kind: 'addition'; text: string; oldLine: number | null; newLine: number | null }
  | { kind: 'deletion'; text: string; oldLine: number | null; newLine: number | null }
  | { kind: 'separator'; text: string };

function parseRows(diffContent: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of diffContent.split('\n')) {
    if (!line) continue;

    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('new file mode') ||
      line.startsWith('deleted file mode') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ')
    ) {
      continue;
    }

    if (line.startsWith('@@')) {
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
      }
      rows.push({ kind: 'hunk', text: line });
      continue;
    }

    if (line.startsWith('\\')) {
      rows.push({ kind: 'separator', text: line });
      continue;
    }

    if (line.startsWith('+')) {
      rows.push({
        kind: 'addition',
        text: line.slice(1),
        oldLine: null,
        newLine,
      });
      newLine += 1;
      continue;
    }

    if (line.startsWith('-')) {
      rows.push({
        kind: 'deletion',
        text: line.slice(1),
        oldLine,
        newLine: null,
      });
      oldLine += 1;
      continue;
    }

    const text = line.startsWith(' ') ? line.slice(1) : line;
    rows.push({
      kind: 'context',
      text,
      oldLine,
      newLine,
    });
    oldLine += 1;
    newLine += 1;
  }

  return rows;
}

export function TurnDiffDrawer({
  record,
  onClose,
}: {
  record: ChangeRecord | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!record) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [record, onClose]);

  const rows = useMemo(
    () => (record?.diffContent ? parseRows(record.diffContent) : []),
    [record?.diffContent]
  );

  if (!record) {
    return null;
  }

  return (
    <div className="absolute inset-0 z-[60] flex justify-end">
      <div
        className="absolute inset-0 bg-black/15 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative flex h-full w-full max-w-[900px] flex-col border-l border-[var(--border)] bg-[var(--bg-primary)] shadow-xl">
        <div className="flex h-10 items-center gap-2 border-b border-[var(--border)] px-3">
          <FileTypeIcon name={basename(record.filePath)} className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--text-primary)]">
            {record.filePath}
          </span>
          <DiffStatLabel
            additions={record.addedLines}
            deletions={record.removedLines}
          />
          <button
            type="button"
            onClick={onClose}
            className="ml-1 inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
            aria-label="Close diff"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-[var(--bg-primary)]">
          {rows.length === 0 ? (
            <EmptyDiffState record={record} />
          ) : (
            <table className="w-full border-collapse font-mono text-[12px] leading-6">
              <tbody>
                {rows.map((row, index) => {
                  if (row.kind === 'hunk') {
                    return (
                      <tr
                        key={`hunk-${index}`}
                        className="bg-[var(--bg-secondary)]/45"
                      >
                        <td className="w-[4ch] px-2 py-0.5 text-right text-[var(--text-muted)]/60" />
                        <td className="w-[4ch] border-r border-[var(--border)]/50 px-2 py-0.5 text-right text-[var(--text-muted)]/60" />
                        <td className="px-3 py-0.5 text-[11px] text-[var(--text-muted)]">
                          {row.text}
                        </td>
                      </tr>
                    );
                  }

                  if (row.kind === 'separator') {
                    return (
                      <tr key={`sep-${index}`}>
                        <td className="w-[4ch] px-2 py-0.5 text-right text-[var(--text-muted)]/60" />
                        <td className="w-[4ch] border-r border-[var(--border)]/50 px-2 py-0.5 text-right text-[var(--text-muted)]/60" />
                        <td className="px-3 py-0.5 text-[var(--text-muted)]">
                          {row.text}
                        </td>
                      </tr>
                    );
                  }

                  const rowTone =
                    row.kind === 'addition'
                      ? 'bg-emerald-500/10'
                      : row.kind === 'deletion'
                        ? 'bg-rose-500/10'
                        : '';
                  const markerTone =
                    row.kind === 'addition'
                      ? 'text-emerald-600'
                      : row.kind === 'deletion'
                        ? 'text-rose-500'
                        : 'text-[var(--text-muted)]';
                  const marker =
                    row.kind === 'addition'
                      ? '+'
                      : row.kind === 'deletion'
                        ? '-'
                        : ' ';

                  return (
                    <tr key={`row-${index}`} className={rowTone}>
                      <td className="w-[4ch] select-none px-2 py-0.5 text-right text-[var(--text-muted)]/60">
                        {row.oldLine ?? ''}
                      </td>
                      <td className="w-[4ch] select-none border-r border-[var(--border)]/50 px-2 py-0.5 text-right text-[var(--text-muted)]/60">
                        {row.newLine ?? ''}
                      </td>
                      <td className="px-3 py-0.5">
                        <span className={`mr-2 select-none ${markerTone}`}>{marker}</span>
                        <span className="whitespace-pre text-[var(--text-primary)]">
                          {row.text || ' '}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

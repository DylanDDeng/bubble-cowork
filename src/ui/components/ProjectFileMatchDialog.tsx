import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { X } from './icons';
import { FileTypeIcon } from './FileTypeIcon';
import * as Dialog from '@/ui/components/ui/dialog';

export interface ProjectFileMatchOption {
  cwd: string;
  path: string;
  relativePath: string;
}

interface ProjectFileMatchRequest {
  requestedPath: string;
  matches: ProjectFileMatchOption[];
  resolve: (match: ProjectFileMatchOption | null) => void;
}

interface ProjectFileMatchStore {
  request: ProjectFileMatchRequest | null;
  open: (request: ProjectFileMatchRequest) => void;
  settle: (match: ProjectFileMatchOption | null) => void;
}

const useProjectFileMatchStore = create<ProjectFileMatchStore>((set, get) => ({
  request: null,
  open: (request) => {
    get().request?.resolve(null);
    set({ request });
  },
  settle: (match) => {
    const current = get().request;
    if (!current) return;
    set({ request: null });
    current.resolve(match);
  },
}));

export function pickProjectFileMatch(options: {
  requestedPath: string;
  matches: ProjectFileMatchOption[];
}): Promise<ProjectFileMatchOption | null> {
  if (options.matches.length === 0) return Promise.resolve(null);
  if (options.matches.length === 1) return Promise.resolve(options.matches[0]);
  return new Promise((resolve) => {
    useProjectFileMatchStore.getState().open({ ...options, resolve });
  });
}

function workspaceLabel(cwd: string): string {
  const normalized = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').filter(Boolean).pop() || normalized;
}

export function ProjectFileMatchDialogHost() {
  const request = useProjectFileMatchStore((state) => state.request);
  const settle = useProjectFileMatchStore((state) => state.settle);
  const [rendered, setRendered] = useState<ProjectFileMatchRequest | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    if (request) {
      setRendered(request);
      setSelectedIndex(0);
    }
  }, [request]);

  const open = request !== null;
  const active = request ?? rendered;
  if (!active) return null;

  const showWorkspace = new Set(active.matches.map((match) => match.cwd)).size > 1;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) settle(null);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[200] bg-black/25 backdrop-blur-[2px] transition-opacity duration-150 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[201] w-[460px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-[18px] border border-[var(--popover-border)] bg-[var(--popover-bg)] p-6 shadow-[var(--popover-shadow-lg)] outline-none transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0 data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0"
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setSelectedIndex((index) => Math.min(active.matches.length - 1, index + 1));
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setSelectedIndex((index) => Math.max(0, index - 1));
              return;
            }
            if (event.key === 'Enter' && !event.isDefaultPrevented()) {
              event.preventDefault();
              settle(active.matches[selectedIndex] ?? null);
            }
          }}
        >
          <Dialog.Close
            className="absolute right-4 top-4 flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
            aria-label="Close"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Dialog.Close>

          <Dialog.Title className="pr-8 text-[17px] font-semibold leading-snug tracking-tight text-[var(--text-primary)]">
            Which file should we open?
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-[13px] leading-[1.55] text-[var(--text-secondary)]">
            “{active.requestedPath}” matches more than one file.
          </Dialog.Description>

          <div className="mt-4 max-h-[280px] overflow-y-auto rounded-[12px] border border-[var(--border)] bg-[var(--bg-secondary)]/40 p-1">
            {active.matches.map((match, index) => {
              const selected = index === selectedIndex;
              return (
                <button
                  key={`${match.cwd}:${match.path}`}
                  type="button"
                  autoFocus={index === 0}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => settle(match)}
                  className={
                    selected
                      ? 'flex w-full items-start gap-2.5 rounded-[10px] bg-[var(--bg-secondary)] px-3 py-2 text-left transition-colors'
                      : 'flex w-full items-start gap-2.5 rounded-[10px] px-3 py-2 text-left transition-colors hover:bg-[var(--bg-secondary)]/70'
                  }
                >
                  <FileTypeIcon name={match.relativePath} className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium text-[var(--text-primary)]">
                      {match.relativePath}
                    </span>
                    {showWorkspace ? (
                      <span className="mt-0.5 block truncate text-[12px] text-[var(--text-muted)]">
                        {workspaceLabel(match.cwd)}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

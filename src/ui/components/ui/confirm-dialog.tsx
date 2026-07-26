import { useEffect, useState } from 'react';
import { X } from '../icons';
import { create } from 'zustand';
import * as Dialog from '@/ui/components/ui/dialog';

/**
 * Themed replacement for `window.confirm`.
 *
 * Native confirm() renders a Chromium sheet that ignores our theme tokens and
 * blocks the renderer. `confirmDialog()` keeps the same imperative call shape
 * (`if (await confirmDialog({...}))`) but paints a Base UI dialog styled from
 * the same CSS variables as the rest of the app, so it follows light/dark.
 *
 *   <ConfirmDialogHost /> is mounted once at the app root.
 */

export interface ConfirmDialogOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` paints the confirm button in the error tone. */
  tone?: 'danger' | 'default';
}

interface ConfirmRequest extends ConfirmDialogOptions {
  resolve: (confirmed: boolean) => void;
}

interface ConfirmDialogStore {
  request: ConfirmRequest | null;
  open: (request: ConfirmRequest) => void;
  settle: (confirmed: boolean) => void;
}

const useConfirmDialogStore = create<ConfirmDialogStore>((set, get) => ({
  request: null,
  open: (request) => {
    // A second confirm while one is pending cancels the older one rather than
    // leaving its promise dangling forever.
    get().request?.resolve(false);
    set({ request });
  },
  settle: (confirmed) => {
    const current = get().request;
    if (!current) return;
    set({ request: null });
    current.resolve(confirmed);
  },
}));

export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    useConfirmDialogStore.getState().open({ ...options, resolve });
  });
}

export function ConfirmDialogHost() {
  const request = useConfirmDialogStore((state) => state.request);
  const settle = useConfirmDialogStore((state) => state.settle);
  // Keep the last request around while the popup plays its exit animation, so
  // the text doesn't blank out mid-fade.
  const [rendered, setRendered] = useState<ConfirmRequest | null>(null);

  useEffect(() => {
    if (request) setRendered(request);
  }, [request]);

  const open = request !== null;
  const active = request ?? rendered;
  if (!active) return null;

  const danger = active.tone !== 'default';

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) settle(false);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[200] bg-black/25 backdrop-blur-[2px] transition-opacity duration-150 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[201] w-[420px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-[18px] border border-[var(--popover-border)] bg-[var(--popover-bg)] p-6 shadow-[var(--popover-shadow-lg)] outline-none transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0 data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0"
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.isDefaultPrevented()) {
              event.preventDefault();
              settle(true);
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
            {active.title}
          </Dialog.Title>
          {active.description ? (
            <Dialog.Description className="mt-2 text-[13px] leading-[1.55] text-[var(--text-secondary)]">
              {active.description}
            </Dialog.Description>
          ) : null}

          <div className="mt-6 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => settle(false)}
              className="rounded-[10px] px-4 py-2 text-[13px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
            >
              {active.cancelLabel || 'Cancel'}
            </button>
            <button
              type="button"
              autoFocus
              onClick={() => settle(true)}
              className={
                danger
                  ? 'rounded-[10px] bg-[color-mix(in_srgb,var(--error)_12%,transparent)] px-4 py-2 text-[13px] font-medium text-[var(--error)] transition-colors hover:bg-[color-mix(in_srgb,var(--error)_20%,transparent)]'
                  : 'rounded-[10px] bg-[var(--accent)] px-4 py-2 text-[13px] font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)]'
              }
            >
              {active.confirmLabel || 'Confirm'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { toast } from 'sonner';
import { create } from 'zustand';
import * as Dialog from '@/ui/components/ui/dialog';
import type { ScreenshotMode, ScreenshotRect } from '../../../shared/screenshot';
import { ScreenshotAreaSelector } from './ScreenshotAreaSelector';
import { useAppStore } from '../../store/useAppStore';
import { Screenshot, X } from '../icons';

const usePermissionPrompt = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export async function startScreenshotCapture(mode: ScreenshotMode = 'area'): Promise<void> {
  if (!window.electron?.captureScreenshot) return;
  const result = await window.electron.captureScreenshot(mode);
  if (result.status === 'permission-required') usePermissionPrompt.getState().setOpen(true);
  else if (result.status === 'error') toast.error(result.message);
}

export async function openLastScreenshot(): Promise<void> {
  const result = await window.electron.openLastScreenshot();
  if (result.status === 'error') toast.error(result.message);
}

/** Main-window selection layer, permission prompt and "Attach to chat" receiver. */
export function ScreenshotHost() {
  const open = usePermissionPrompt((state) => state.open);
  const setOpen = usePermissionPrompt((state) => state.setOpen);
  const [selectionId, setSelectionId] = useState<string | null>(null);
  useEffect(() => window.electron?.onScreenshotSelectArea?.(setSelectionId), []);
  const completeSelection = useCallback((rect: ScreenshotRect | null) => {
    if (!selectionId) return;
    flushSync(() => setSelectionId(null));
    void window.electron.completeScreenshotSelection(selectionId, rect);
  }, [selectionId]);

  useEffect(() => {
    if (!window.electron?.onScreenshotAttach) return;
    return window.electron.onScreenshotAttach((attachment) => {
      const state = useAppStore.getState();
      state.setShowSettings(false);
      state.setActiveWorkspace('chat');
      state.requestChatInjection({
        sessionId: state.activeSessionId ?? null,
        attachments: [attachment],
        mode: 'append',
        source: 'screenshot',
      });
    });
  }, []);

  return (
    <>
      {selectionId && <ScreenshotAreaSelector onComplete={completeSelection} />}
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[200] bg-black/25 backdrop-blur-[2px] transition-opacity duration-150 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[201] w-[380px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-[18px] border border-[var(--popover-border)] bg-[var(--popover-bg)] p-6 shadow-[var(--popover-shadow-lg)] outline-none transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0 data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0">
            <Dialog.Close
              className="absolute right-4 top-4 flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
              aria-label="Close"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Dialog.Close>
            <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-[10px] bg-[var(--accent-light)] text-[var(--accent)]">
              <Screenshot className="h-[18px] w-[18px]" aria-hidden="true" />
            </div>
            <Dialog.Title className="pr-8 text-[15px] font-semibold leading-snug text-[var(--text-primary)]">
              Allow screen recording
            </Dialog.Title>
            <Dialog.Description className="mt-1.5 text-[13px] leading-[1.55] text-[var(--text-secondary)]">
              macOS needs Screen Recording permission for Aegis to capture other apps. After turning it on, macOS may ask you to reopen Aegis.
            </Dialog.Description>
            <div className="mt-5 flex flex-col gap-2">
              <button
                type="button"
                autoFocus
                onClick={() => {
                  setOpen(false);
                  void window.electron.requestScreenRecordingPermission();
                }}
                className="h-9 rounded-[10px] bg-[var(--accent)] text-[13px] font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)]"
              >
                Open System Settings
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  void startScreenshotCapture('app');
                }}
                className="h-9 rounded-[10px] border border-[var(--border)] text-[13px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-secondary)]"
              >
                Capture Aegis window only
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

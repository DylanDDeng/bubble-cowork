import { useState } from 'react';
import { create } from 'zustand';
import * as Dialog from './dialog';

type Request = { id: number; title: string; label: string; value?: string; maxLength?: number; resolve: (value: string | null) => void };
let nextId = 0;
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));
function settle(value: string | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(value);
}
export function textInputDialog(options: Omit<Request, 'resolve' | 'id'>): Promise<string | null> {
  settle(null);
  return new Promise(resolve => useRequest.setState({ request: { ...options, resolve, id: ++nextId } }));
}
export function TextInputDialogHost() {
  const request = useRequest(s => s.request);
  return request ? <TextInputDialog key={request.id} request={request} /> : null;
}
function TextInputDialog({ request }: { request: Request }) {
  const [value, setValue] = useState(request.value || '');
  return <Dialog.Root open onOpenChange={open => { if (!open) settle(null); }}>
    <Dialog.Portal>
      <Dialog.Overlay data-environment-hub-layer className="fixed inset-0 z-[200] bg-black/25" />
      <Dialog.Content data-environment-hub-layer className="fixed left-1/2 top-1/2 z-[201] w-[420px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-[18px] border border-[var(--popover-border)] bg-[var(--popover-bg)] p-6 shadow-[var(--popover-shadow-lg)] outline-none">
        <form onSubmit={event => { event.preventDefault(); if (value.trim()) settle(value.trim()); }}>
          <Dialog.Title className="text-[17px] font-semibold text-[var(--text-primary)]">{request.title}</Dialog.Title>
          <input autoFocus aria-label={request.label} value={value} maxLength={request.maxLength || 200} onChange={event => setValue(event.target.value)} onFocus={event => event.target.select()} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }} className="mt-4 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
          <div className="mt-5 flex justify-end gap-2 text-[13px]">
            <button type="button" onClick={() => settle(null)} className="rounded-lg px-4 py-2 text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]">Cancel</button>
            <button type="submit" disabled={!value.trim()} className="rounded-lg bg-[var(--accent)] px-4 py-2 text-white disabled:opacity-50">Save</button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

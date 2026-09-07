import { setupSessionMenuIPC } from './session-menu';
import { clipboard } from 'electron';
import { createSessionLink, parseSessionLink } from '../../shared/session-links';
import type { ServerEvent } from '../../shared/types';
import * as sessions from '../libs/session-store';
import { ipcMainHandle } from '../util';

let emitEvent: ((event: ServerEvent) => void) | null = null;
let rendererReady = false;
let pendingLink: string | null = null;

export function queueSessionLink(url: string): boolean {
  if (!parseSessionLink(url)) return false;
  pendingLink = url;
  if (rendererReady) flushSessionLink();
  return true;
}

export function flushSessionLink(): void {
  rendererReady = true;
  if (!pendingLink) return;
  const url = pendingLink;
  pendingLink = null;
  try { openSessionLink(url); }
  catch (error) { emitEvent?.({ type: 'runner.error', payload: { message: String(error) } }); }
}

export function openSessionLink(url: string): boolean {
  const sessionId = parseSessionLink(url);
  if (!sessionId) return false;
  const session = sessions.getSession(sessionId);
  if (!session || session.hidden_from_threads) throw new Error('This conversation is no longer available.');
  emitEvent?.({ type: 'session.open', payload: { sessionId } });
  return true;
}

export function setupSessionLinksIPC(emit: (event: ServerEvent) => void): void {
  setupSessionMenuIPC();
  emitEvent = emit;
  rendererReady = false;
  ipcMainHandle('copy-session-value', async (_, sessionId: string, target: string) => {
    const session = typeof sessionId === 'string' ? sessions.getSession(sessionId) : undefined;
    if (!session || session.hidden_from_threads) throw new Error('This conversation is no longer available.');
    if (target !== 'link' && target !== 'cwd') throw new Error('Unknown copy action.');
    const value = target === 'link' ? createSessionLink(session.id) : session.cwd;
    if (!value) throw new Error('This conversation has no working directory.');
    clipboard.writeText(value);
  });
}

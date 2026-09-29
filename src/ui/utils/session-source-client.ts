import type { Attachment, SessionView } from '../types';
import { collectSessionSources, mergeSessionSources, type SessionSourcePreview } from '../../shared/session-sources';

type SourceBridge = Pick<Window['electron'], 'getSessionSources' | 'previewSessionSource' | 'loadOlderSessionHistory' | 'readAttachmentPreview' | 'readProjectFilePreview'>;
const reportedFallbacks = new Set<string>();

function unavailable(error: unknown, channel: string): boolean {
  return String(error).includes(`No handler registered for '${channel}'`);
}

function reportFallback(channel: string) {
  if (reportedFallbacks.has(channel)) return;
  reportedFallbacks.add(channel);
  console.info('[Sources] Using existing desktop API; main process predates Sources.', { channel });
}

/** Vite can update the renderer before the running Electron main process. */
export async function loadSessionSources(session: SessionView, bridge: SourceBridge, signal?: AbortSignal): Promise<Attachment[]> {
  signal?.throwIfAborted();
  if (typeof bridge.getSessionSources === 'function') {
    try { return await bridge.getSessionSources(session.id); }
    catch (error) { if (!unavailable(error, 'get-session-sources')) throw error; }
  }
  reportFallback('get-session-sources');
  let sources = collectSessionSources(session.messages);
  let cursor = session.hasMoreHistory ? session.historyCursor : null;
  if (session.hasMoreHistory && !cursor) throw new Error('Attachment history is incomplete.');
  const seen = new Set<string>();
  while (cursor) {
    signal?.throwIfAborted();
    if (seen.has(cursor)) throw new Error('Attachment history did not advance.');
    seen.add(cursor);
    const page = await bridge.loadOlderSessionHistory(session.id, cursor, 200);
    signal?.throwIfAborted();
    if (page.sessionId !== session.id) throw new Error('Attachment history belongs to another task.');
    sources = mergeSessionSources(collectSessionSources(page.messages), sources);
    if (page.hasMore && !page.cursor) throw new Error('Attachment history is incomplete.');
    cursor = page.hasMore ? page.cursor : null;
  }
  return sources;
}

export async function previewSessionSource(sessionId: string, source: Attachment, bridge: SourceBridge): Promise<SessionSourcePreview> {
  if (typeof bridge.previewSessionSource === 'function') {
    try { return await bridge.previewSessionSource(sessionId, source.path); }
    catch (error) { if (!unavailable(error, 'preview-session-source')) throw error; }
  }
  reportFallback('preview-session-source');
  // These APIs already handle explicitly opened local attachments. Never scan
  // the containing directory; request only the selected attachment.
  if (source.kind === 'image') {
    const url = await bridge.readAttachmentPreview(source.path);
    return url ? { kind: 'image', url } : { kind: 'error', message: 'Image attachment is missing or could not be read.' };
  }
  const separator = Math.max(source.path.lastIndexOf('/'), source.path.lastIndexOf('\\'));
  const cwd = source.path.slice(0, separator + 1);
  const result = await bridge.readProjectFilePreview(cwd, source.path) as {
    kind: string; dataUrl?: string; previewUrl?: string; text?: string; message?: string;
  };
  if (result.kind === 'image' && result.dataUrl) return { kind: 'image', url: result.dataUrl };
  if (['video', 'audio', 'pdf'].includes(result.kind) && result.previewUrl) {
    return { kind: result.kind as 'video' | 'audio' | 'pdf', url: result.previewUrl };
  }
  if (['text', 'markdown', 'html'].includes(result.kind) && typeof result.text === 'string') return { kind: 'text', text: result.text };
  if (result.kind === 'error') return { kind: 'error', message: result.message || 'Attachment is missing or could not be read.' };
  return { kind: 'file' };
}

import assert from 'node:assert/strict';
import { loadSessionSources, previewSessionSource } from '../../src/ui/utils/session-source-client';
import { sessionSourceTab, sessionSourceTabPath, resolveRightUtilityTabOpen, getRightUtilityTabKind } from '../../src/ui/utils/right-utility-tabs';
import { persistRightPanelBySessionId, parseRightPanelBySessionId } from '../../src/ui/utils/session-right-panel';
import type { Attachment, SessionView } from '../../src/ui/types';

async function main() {
  const image: Attachment = { id: 'image', path: '/attachments/参考图.png', name: '参考图.png', kind: 'image', mimeType: 'image/png', size: 1 };
  const video: Attachment = { ...image, id: 'video', path: '/attachments/reference.mp4', name: 'reference.mp4', kind: 'file', mimeType: 'video/mp4' };
  const missing = (channel: string) => Promise.reject(new Error(`Error invoking remote method '${channel}': Error: No handler registered for '${channel}'`));
  let pageReads = 0, imageReads = 0;
  const bridge = {
    getSessionSources: () => missing('get-session-sources'),
    previewSessionSource: () => missing('preview-session-source'),
    loadOlderSessionHistory: async (sessionId: string, cursor: string) => {
      pageReads++;
      return { sessionId, status: 'completed', messages: [{ type: 'user_prompt', prompt: '', attachments: cursor === 'recent' ? [video] : [image] }], cursor: cursor === 'recent' ? 'older' : null, hasMore: cursor === 'recent' };
    },
    readAttachmentPreview: async (path: string) => { imageReads++;assert.equal(path, image.path);return 'data:image/png;base64,fixture'; },
    readProjectFilePreview: async (cwd: string, path: string) => { assert.equal(cwd, '/attachments/');assert.equal(path, video.path);return { kind: 'video', previewUrl: 'http://127.0.0.1/fixture' }; },
  } as unknown as Parameters<typeof previewSessionSource>[2];
  const session = { id: 'one', messages: [{ type: 'user_prompt', prompt: '', attachments: [video] }], hasMoreHistory: true, historyCursor: 'recent' } as SessionView;
  assert.deepEqual((await loadSessionSources(session, bridge)).map(source => source.path), [image.path, video.path]);
  assert.equal(pageReads, 2);
  assert.equal((await previewSessionSource('one', image, bridge)).kind, 'image');
  assert.equal((await previewSessionSource('one', video, bridge)).kind, 'video');
  assert.equal((await previewSessionSource('one', image, { ...bridge, previewSessionSource: undefined } as unknown as typeof bridge)).kind, 'image', 'old preloads without the method also work');
  const reads = imageReads;
  await assert.rejects(previewSessionSource('one', image, { ...bridge, previewSessionSource: async () => { throw Error('Unauthorized IPC sender'); } }), /Unauthorized/);
  assert.equal(imageReads, reads, 'real errors are never treated as old-runtime compatibility');
  const denied = await previewSessionSource('one', image, { ...bridge, previewSessionSource: async () => ({ kind: 'error', message: 'Not attached to this task.' }) });
  assert.equal(denied.kind, 'error');assert.equal(imageReads, reads);
  const controller = new AbortController();controller.abort();
  await assert.rejects(loadSessionSources(session, bridge, controller.signal), { name: 'AbortError' });
  await assert.rejects(loadSessionSources({ ...session, historyCursor: null }, bridge), /incomplete/);
  await assert.rejects(loadSessionSources(session, { ...bridge, loadOlderSessionHistory: async () => ({ sessionId: 'another-task', messages: [], hasMore: false, cursor: null }) } as unknown as typeof bridge), /another task/);
  const tab = sessionSourceTab(image.path);
  assert.equal(sessionSourceTabPath(tab), image.path);
  assert.equal(getRightUtilityTabKind(tab), 'sources');
  const opened = resolveRightUtilityTabOpen(['sources'], tab);
  assert.deepEqual(opened.tabs, ['sources', tab]);
  assert.equal(resolveRightUtilityTabOpen(opened.tabs, tab).tabs.length, 2, 'repeat opens reuse the file tab');
  assert.equal(resolveRightUtilityTabOpen(opened.tabs, 'sources').activeTab, 'sources');
  const snapshot = { tabs: opened.tabs, activeTab: tab, hidden: false, fullscreen: null, fileTabsByUtilityTab: {}, reviewDiffSelection: null };
  const restored = parseRightPanelBySessionId(persistRightPanelBySessionId({ one: snapshot }));
  assert.deepEqual(restored.one.tabs, ['sources', tab]);
  assert.equal(restored.one.activeTab, tab, 'restore the selected file separately from the source list');
  console.log('PASS Sources client: old main/preload, paginated history, image/video fallback, genuine errors, cancellation, separate deduplicated tabs');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });

import assert from 'node:assert/strict';
import fs, { createReadStream } from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path, { extname } from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { collectSessionSources, mergeSessionSources } from '../../src/shared/session-sources';
import { ATTACHMENT_MIME_TYPES } from '../../src/shared/attachment-policy';
import type { Attachment, StreamMessage } from '../../src/shared/types';
import { persistRightPanelBySessionId, parseRightPanelBySessionId } from '../../src/ui/utils/session-right-panel';

async function main() {
const temp = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bubble-sources-test-'));
const servers = new Map();
try {
  const directory = path.join(temp, 'Library', 'Application Support', 'CleanShot');
  await fsPromises.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, 'reference.mp4');
  await fsPromises.writeFile(filePath, '0123456789');
  await fsPromises.writeFile(path.join(directory, 'neighbor.txt'), 'not attached');
  const attachment: Attachment = { id: 'a', name: 'reference.mp4', path: filePath, size: 10, mimeType: 'video/mp4', kind: 'file' };
  const messages: StreamMessage[] = [
    { type: 'user_prompt', prompt: 'reference', attachments: [attachment] },
    { type: 'user_prompt', prompt: 'repeat', attachments: [{ ...attachment, id: 'duplicate' }] },
    { type: 'user_prompt', parentToolUseId: 'child', prompt: 'nested', attachments: [{ ...attachment, path: '/child-only' }] },
  ];
  assert.equal(collectSessionSources(messages).length, 1);
  assert.equal(mergeSessionSources(collectSessionSources(messages), [attachment]).length, 1);
  const source = fs.readFileSync('src/electron/ipc-handlers.ts', 'utf8');
  const ast = ts.createSourceFile('ipc.ts', source, ts.ScriptTarget.Latest, true);
  const names = new Set(['getLocalPreviewMimeType', 'sendPreviewResponse', 'parsePreviewByteRange', 'streamPreviewFile', 'handleLocalPreviewRequest', 'ensureLocalPreviewServer']);
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text)).map(node => node.getText(ast)).join('\n');
  const start = source.indexOf('  const loadSessionSources =');
  const end = source.indexOf("  ipcMainHandle(\n    'load-session-history-around'", start);
  assert(start >= 0 && end > start);
  const handlers = new Map<string, Function>();
  const context = vm.createContext({
    Buffer, URL, createReadStream, createServer, fsPromises, extname, uuidv4: randomUUID,
    localPreviewServers: servers, LOCAL_PREVIEW_MIME_TYPES: ATTACHMENT_MIME_TYPES,
    resolvePreviewRequestFile: () => { throw Error('Attachment preview must not resolve a directory'); },
    ipcMainHandle: (name: string, callback: Function) => handlers.set(name, callback),
    sessions: { getSession: (id: string) => ['one', 'empty'].includes(id) ? { id } : null },
    toUnifiedSessionRecord: (session: unknown) => session,
    getHistorySourceForSession: () => ({ loadAll: async (session: { id: string }) => session.id === 'one' ? messages : [] }),
    collectSessionSources, ATTACHMENT_MIME_TYPES,
  });
  vm.runInContext(ts.transpileModule(functions + '\n' + source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const list = handlers.get('get-session-sources')!;
  const preview = handlers.get('preview-session-source')!;
  assert.equal((await list(null, 'one'))[0].path, filePath, 'full history source includes old attachments');
  assert.equal((await list(null, 'empty')).length, 0);
  assert.equal((await preview(null, 'empty', filePath)).kind, 'error', 'other tasks cannot preview this attachment');
  assert.equal((await preview(null, 'one', path.join(directory, 'neighbor.txt'))).kind, 'error');
  const media = await preview(null, 'one', filePath);
  assert.equal(media.kind, 'video');
  const range = await fetch(media.url, { headers: { Range: 'bytes=2-5' } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), '2345');
  assert.equal(range.headers.get('content-type'), 'video/mp4');
  assert.equal((await fetch(media.url + '/neighbor.txt')).status, 404, 'token exposes only the attached file');
  assert.equal((await fetch(media.url, { method: 'POST' })).status, 405);
  await fsPromises.unlink(filePath);
  assert.equal((await preview(null, 'one', filePath)).kind, 'error', 'missing attachment is explained');
  const snapshots = { one: { tabs: ['sources' as const], activeTab: 'sources' as const, hidden: false, fullscreen: null, fileTabsByUtilityTab: {}, reviewDiffSelection: null } };
  assert.equal(parseRightPanelBySessionId(persistRightPanelBySessionId(snapshots)).one.activeTab, 'sources');
  console.log('PASS Sources: full history, dedupe, task isolation, exact-file streaming, byte ranges, missing files, tab restore');
} finally {
  for (const entry of servers.values()) { entry.server.closeAllConnections(); entry.server.close(); }
  await fsPromises.rm(temp, { recursive: true, force: true });
}
}
void main().catch(error => { console.error(error); process.exitCode = 1; });

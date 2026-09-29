import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { getHtmlPreviewUrl, isLocalFileUrl } from '../../src/electron/libs/html-preview';

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-html-preview-'));
  try {
    const project = path.join(temp, 'project');
    const worktree = path.join(temp, 'worktree');
    const outside = path.join(temp, 'output', '中文 #100%.html');
    await Promise.all([fs.mkdir(project), fs.mkdir(worktree), fs.mkdir(path.dirname(outside))]);
    await Promise.all([fs.writeFile(outside, '<h1>External</h1>'), fs.writeFile(path.join(worktree, 'index.html'), '<h1>Worktree</h1>')]);
    assert.deepEqual(await getHtmlPreviewUrl(project, outside), { ok: true, url: pathToFileURL(outside).href });
    assert.deepEqual(await getHtmlPreviewUrl(project, '../output/中文 #100%.html'), { ok: true, url: pathToFileURL(outside).href });
    assert.deepEqual(await getHtmlPreviewUrl(worktree, 'index.html'), { ok: true, url: pathToFileURL(path.join(worktree, 'index.html')).href });
    assert.deepEqual(await getHtmlPreviewUrl('', pathToFileURL(outside).href), { ok: true, url: pathToFileURL(outside).href });
    assert.equal((await getHtmlPreviewUrl('', 'index.html')).ok, false);
    assert.equal((await getHtmlPreviewUrl(project, 'missing.html')).ok, false);
    assert.equal((await getHtmlPreviewUrl(project, outside.replace('.html', '.txt'))).ok, false);
    await fs.mkdir(path.join(project, 'directory.html'));
    assert.equal((await getHtmlPreviewUrl(project, 'directory.html')).ok, false);
    await fs.symlink(outside, path.join(project, 'linked.html'));
    assert.deepEqual(await getHtmlPreviewUrl(project, 'linked.html'), { ok: true, url: pathToFileURL(path.join(project, 'linked.html')).href });
    let served = 0;
    const serveProject = async () => { served++; return { ok: true as const, url: 'http://127.0.0.1/preview' }; };
    assert.deepEqual(await getHtmlPreviewUrl(worktree, 'index.html', serveProject), { ok: true, url: 'http://127.0.0.1/preview' });
    assert.deepEqual(await getHtmlPreviewUrl(project, outside, serveProject), { ok: true, url: pathToFileURL(outside).href });
    assert.equal((await getHtmlPreviewUrl(project, 'linked.html', serveProject)).ok, true);
    assert.equal(served, 1, 'only files contained by the real project root use its HTTP server');
    const relativeToHome = path.relative(os.homedir(), outside);
    assert.deepEqual(await getHtmlPreviewUrl(project, `~/${relativeToHome}`), { ok: true, url: pathToFileURL(outside).href });
    for (const url of ['file://remote/share/a.html', 'file:///bad%00.html', 'https://example.com', 'javascript:alert(1)']) {
      assert.equal(isLocalFileUrl(url), false, url);
    }

    // Exercise App's actual completion effect with deferred preview I/O.
    // In particular, the closure's activeSessionId stays A while the store
    // changes to B, just as it does during a real session switch.
    const source = await fs.readFile('src/ui/App.tsx', 'utf8');
    const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let effect = '';
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
        && node.arguments[1]?.getText(ast).includes('sessionStatusFingerprint')) effect = node.getText(ast);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    assert.ok(effect);
    const js = ts.transpileModule(effect, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    function harness() {
      const artifact = { toolUseId: 'write-1', filePath: outside, fileName: path.basename(outside) };
      const session = { id: 'A', status: 'completed', cwd: project, worktreePath: worktree, messages: [artifact] };
      const state = { activeSessionId: 'A', activeWorkspace: 'chat', showSettings: false, sessions: { A: session }, rightUtilityPanelHidden: true };
      const requests: any[] = [], revealed: string[] = [], errors: string[] = [];
      const pending = { current: new Set<string>() };
      const context = vm.createContext({
        useEffect: (fn: () => void) => fn(), sessionStatusFingerprint: '', activeSessionId: 'A',
        useAppStore: { getState: () => state },
        sessionStatusSnapshotRef: { current: new Map([['A', 'running']]) },
        pendingAutoPreviewSessionsRef: pending, autoPreviewedArtifactsRef: { current: new Set() },
        extractLatestSuccessfulHtmlArtifactFromLatestTurn: (messages: unknown[]) => messages[0],
        openHtmlFileInBrowserTab: (input: unknown) => new Promise((resolve, reject) => requests.push({ input, resolve, reject })),
        openRightUtilityTab: (tab: string) => revealed.push(`${state.activeSessionId}:${tab}`),
        setRightPanelLauncherOpen: () => {}, console: { warn: () => {} }, toast: { error: (message: string) => errors.push(message) },
      });
      return { state, requests, revealed, errors, pending, run: () => vm.runInContext(js, context) };
    }
    const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
    const switched = harness(); switched.run();
    assert.equal(switched.requests[0].input.cwd, worktree);
    assert.equal(switched.pending.current.size, 0);
    switched.state.activeSessionId = 'B'; switched.run();
    switched.requests[0].resolve(); await flush();
    assert.deepEqual(switched.revealed, [], 'a delayed preview must not reveal Browser in another session');
    switched.state.activeSessionId = 'A'; switched.run();
    assert.equal(switched.requests.length, 1, 'switching sessions must not replay completion');
    const failed = harness(); failed.run(); failed.requests[0].reject(new Error('missing file')); await flush();
    failed.run(); assert.equal(failed.requests.length, 1); assert.equal(failed.errors.length, 1, 'real failure remains visible once');
    const current = harness(); current.run(); current.requests[0].resolve(); await flush();
    assert.deepEqual(current.revealed, ['A:browser']);
    const resumed = harness(); resumed.run(); resumed.state.sessions.A.status = 'running'; resumed.run();
    resumed.requests[0].resolve(); await flush(); assert.deepEqual(resumed.revealed, [], 'old completion cannot interrupt a newer turn');
    console.log('PASS HTML preview: external/relative/worktree/file URL paths, encoding, symlinks, invalid targets, async session switching, once-only completion, visible errors');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });

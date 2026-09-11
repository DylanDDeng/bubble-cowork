import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, Module } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
// Outside platform tmp: DeepSeek intentionally already permits writes to tmp.
const temp = fs.mkdtempSync(path.join(process.cwd(), '.aegis-project-roots-'));
const primary = path.join(temp, 'primary'), extra = path.join(temp, 'extra'), outside = path.join(temp, 'outside');
for (const dir of [primary, extra, outside]) fs.mkdirSync(dir);
const oldLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { getPath: () => temp, isPackaged: false } };
  return oldLoad.call(this, name, ...args);
};
const base = '../../dist-electron/electron/libs/';
const sessions = require(base + 'session-store.js');
const access = require(base + 'provider/project-access.js');
try {
  sessions.initialize();
  const row = sessions.createSession({ title: 'Project roots test', cwd: extra, provider: 'bubble' });
  sessions.moveSessionWithProjectSources(row.id, primary, [extra]);
  sessions.close(); sessions.initialize();
  const covered = p => access.projectContainsPaths(row.id, primary, p);
  assert(covered([path.join(extra, 'new/sub/file.txt')]));
  assert(!covered([])); assert(!covered(['relative.txt']));
  assert(!covered([path.join(extra, '../outside/file.txt')]));
  fs.symlinkSync(outside, path.join(extra, 'escape'));
  assert(!covered([path.join(extra, 'escape/new/file.txt')]));
  assert(!covered([extra, outside]));
  const fileApproval = (request, mode = 'default') => access.isProjectFileApproval(row.id, primary, mode, request);
  assert(fileApproval({ type: 'write', path: path.join(extra, 'file.txt') }));
  assert(!fileApproval({ type: 'write', path: extra }, 'plan'));
  assert(!fileApproval({ type: 'bash', command: `touch ${extra}/file` }));
  assert(!fileApproval({ type: 'agent_profile', path: extra }));
  assert(fileApproval({ type: 'patch', paths: [extra, primary], files: [{path:extra}, {path:primary}] }));
  assert(!fileApproval({ type: 'patch', paths: [extra], files: [{path:extra}, {path:outside}] }));
  assert(!fileApproval({ type: 'patch', paths: [outside], files: [{path:extra}] }));
  const directory = (patterns, permission = 'external_directory') => access.isProjectDirectoryApproval(row.id, primary, permission, patterns);
  assert(directory([extra + '/*'])); assert(directory([extra + '/**']));
  assert(!directory([temp + '/*'])); assert(!directory([extra + '/**/x']));
  assert(!directory([extra + '/*', outside + '/*'])); assert(!directory([extra], 'bash'));
  assert(!directory([extra + '/escape/**']));

  // Actual Bubble tool + native controller: native deny/Plan run before our handler.
  const { BubbleSdkAdapter } = require(base + 'provider/bubble-sdk-adapter.js');
  const bubble = new BubbleSdkAdapter();
  const active = { threadId: row.id, cwd: primary, status: 'idle', permissionMode: 'default', pendingRequests: new Map() };
  bubble.sessions.set(row.id, active);
  const { PermissionAwareApprovalController } = await import('../../node_modules/@bubblebrain-ai/bubble/dist/approval/controller.js');
  const { createWriteTool } = await import('../../node_modules/@bubblebrain-ai/bubble/dist/tools/write.js');
  const { buildRuleSet } = await import('../../node_modules/@bubblebrain-ai/bubble/dist/permissions/rule.js');
  let rules = buildRuleSet([], []);
  const controller = new PermissionAwareApprovalController({ cwd: primary, getMode: () => active.permissionMode,
    getRuleSet: () => rules, handlerRef: { current: req => bubble.requestApproval(active, req) } });
  const write = createWriteTool(primary, {}, controller);
  const bubbleFile = path.join(extra, 'bubble.txt');
  await write.execute({path: bubbleFile, content: 'bubble'});
  assert.equal(fs.readFileSync(bubbleFile, 'utf8'), 'bubble');
  active.permissionMode = 'plan';
  await write.execute({path: bubbleFile, content: 'plan-must-not-write'});
  assert.equal(fs.readFileSync(bubbleFile, 'utf8'), 'bubble');
  active.permissionMode = 'default'; rules = buildRuleSet([], ['Write']);
  await write.execute({path: bubbleFile, content: 'deny-must-not-write'});
  assert.equal(fs.readFileSync(bubbleFile, 'utf8'), 'bubble');

  // All OpenCode protocol generations, and failed replies remain answerable.
  const { OpenCodeSdkAdapter } = require(base + 'provider/opencode-sdk-adapter.js');
  const oc = new OpenCodeSdkAdapter({}); const events = []; oc.emit = e => events.push(e);
  const state = { threadId: row.id, providerSessionId: 'native', cwd: primary, permissionMode: 'default',
    pendingRequests: new Map(), emittedPermissionIds: new Set() };
  for (const [method, responder, fields] of [
    ['handlePermissionUpdated', 'respondToOpenCodePermission', {type:'external_directory', pattern:extra+'/*'}],
    ['handlePermissionAsked', 'respondToOpenCodePermissionReply', {permission:'external_directory', patterns:[extra+'/*']}],
    ['handlePermissionV2Asked', 'respondToOpenCodePermissionV2', {action:'external_directory', resources:[extra+'/*']}],
  ]) {
    let reply; oc[responder] = async (...args) => {reply = args[2];};
    oc[method](state, {sessionID:'native', id:method, ...fields});
    await new Promise(resolve => setImmediate(resolve)); assert.equal(reply, 'once');
    assert(!state.pendingRequests.has(method));
    oc[responder] = async () => { throw new Error('test reply failure'); };
    oc[method](state, {sessionID:'native', id:method+'-failure', ...fields});
    await new Promise(resolve => setImmediate(resolve));
    assert(events.some(e => e.requestId === method+'-failure'));
  }
  oc.handlePermissionAsked(state, {sessionID:'native', id:'shell', permission:'bash', patterns:[extra]});
  assert(events.some(e => e.requestId === 'shell'));

  // Pi has no cwd sandbox: exercise the actual SDK file tools, no model request.
  const { createWriteToolDefinition } = await import('../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/write.js');
  const { createReadToolDefinition } = await import('../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js');
  const piFile = path.join(extra, 'pi.txt');
  await createWriteToolDefinition(primary).execute('write', { path: piFile, content: 'pi project folder' });
  const read = await createReadToolDefinition(primary).execute('read', { path: piFile });
  assert.match(JSON.stringify(read), /pi project folder/);

  // Grok ACP reverse file requests already use native absolute paths.
  const { GrokAcpAdapter } = require(base + 'provider/grok-acp-adapter.js');
  const grok = new GrokAcpAdapter(); let rpcResult;
  const rpc = {respond: (id, result, error) => {assert.equal(error, undefined); rpcResult = result;}};
  const grokFile = path.join(extra, 'grok.txt');
  grok.handleWriteTextFile(rpc, {id:1, params:{path:grokFile, content:'grok project folder'}}, {cwd:primary});
  grok.handleReadTextFile(rpc, {id:2, params:{path:grokFile}}, {cwd:primary});
  assert.equal(rpcResult.content, 'grok project folder');

  // Real DeepSeek filesystem implementation and macOS kernel sandbox.
  const profile = '../../dev-fixtures/deepseek-harness/';
  const { installProjectRoots } = await import(profile + 'runtime-project-roots.mjs');
  const { SandboxedFileSystem } = await import(profile + 'node_modules/@deepseek-ai/dsh-fs-sandbox/lib/index.js');
  const { LocalSandboxProvider } = await import(profile + 'node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js');
  installProjectRoots(JSON.stringify([primary, extra]));
  const policy = {mode:'workspace-write', workspaceRoot:primary};
  const dsh = Object.create(SandboxedFileSystem.prototype);
  Object.assign(dsh, {config:{cwd:primary, diffBasisMaxBytes:65536}, locks:new Map(), internals:{}, ctx:{sandboxPolicy:{resolve:()=>policy}}});
  const dshFile = path.join(extra, 'deepseek.txt');
  await dsh.writeText(await dsh.resolve(dshFile), 'deepseek', undefined, undefined, policy);
  assert.equal(fs.readFileSync(dshFile, 'utf8'), 'deepseek');
  for (const target of [path.join(outside,'bad.txt'), path.join(extra,'escape/bad.txt')]) {
    await assert.rejects(dsh.writeText(await dsh.resolve(target), 'bad', undefined, undefined, policy), {code:'FS_SANDBOX_DENIED'});
  }
  await assert.rejects(dsh.writeText(await dsh.resolve(dshFile), 'bad', undefined, undefined, {...policy,mode:'read-only'}), {code:'FS_SANDBOX_DENIED'});
  const local = Object.create(LocalSandboxProvider.prototype);
  local.seatbeltExec = () => '/usr/bin/sandbox-exec';
  if (process.platform === 'darwin') {
    for (const [target, mode, allowed] of [[path.join(extra,'shell.txt'),'workspace-write',true],
      [path.join(outside,'shell.txt'),'workspace-write',false], [path.join(extra,'escape/shell.txt'),'workspace-write',false],
      [path.join(extra,'plan.txt'),'read-only',false]]) {
      const argv = local.runnerArgv('seatbelt', {...policy, mode});
      const result = spawnSync(argv[0], [...argv.slice(1), '--', '/bin/sh', '-c', 'echo shell > "$1"', 'probe', target], {encoding:'utf8'});
      assert.equal(result.status === 0, allowed, result.stderr);
      assert.equal(fs.existsSync(target), allowed);
    }
  }
  local.landlockLauncher = () => '/fixture/landlock';
  assert(local.runnerArgv('landlock', policy).includes(extra));
  assert(!local.runnerArgv('landlock', {...policy,mode:'read-only'}).includes(extra));
  const bwrap = local.runnerArgv('bwrap', policy);
  assert(bwrap.includes(extra)); assert(!local.runnerArgv('bwrap', {...policy, mode:'read-only'}).includes(extra));
  // The Windows path uses the real SDK's public grant/token contract. Native
  // execution is covered on Windows; here verify isolation and cleanup wiring.
  const {runWindowsProjectCommand} = await import(profile + 'runtime-project-roots-windows.mjs');
  const configurations = [], grants = [];
  class Grant {
    static create(sid) { const g = new Grant(); g.sid = sid; g.paths = []; grants.push(g); return g; }
    add(root) { this.paths.push(root); }
    dispose() { this.disposed = true; }
  }
  class Sandbox {
    constructor(config) { configurations.push(config); }
    async init() {}
    spawn() {return {wait:async()=>({exitCode:0})};}
    dispose() {}
  }
  const originalTemp = process.env.TMP;
  for (let i = 0; i < 2; i++) await runWindowsProjectCommand([primary, extra], 'cmd.exe', ['/c','echo fixture'], {AclSandbox:Sandbox, AclWriteGrant:Grant});
  assert.notEqual(configurations[0].writeSid, configurations[1].writeSid);
  assert(configurations.every(c => c.manageDacls === false && c.writableDirs.includes(extra)));
  assert(grants.every(g => g.disposed)); assert.equal(process.env.TMP, originalTemp);
  assert(local.runnerArgv('windows-acl', policy)[1].endsWith('runtime-project-roots-windows.mjs'));

  const {KimiServerManager} = require(base + 'provider/kimi-server-manager.js');
  const calls = [];
  await assert.rejects(KimiServerManager.prototype.submitPrompt.call({request:async (method, route) => {
    calls.push(route); return {plan_mode:false};
  }}, 'native', {content:[],model:'fixture',plan_mode:true}), /No prompt was submitted/);
  assert(!calls.some(route => route.endsWith('/prompts')));
  console.log('Provider project roots: persisted roots, Bubble native write/deny/Plan, OpenCode approvals/retry, Pi and Grok read/write, DeepSeek filesystem and kernel sandbox passed');
} finally {
  sessions.close(); Module._load = oldLoad; fs.rmSync(temp, {recursive:true,force:true});
}

// Real SQLite and production IPC handlers; Electron shell is stubbed so this
// regression also runs when a desktop/WindowServer is unavailable.
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-organization-'));
const handlers = new Map();
const windows = [];
let copied = '', exported, shared;
class Window extends EventEmitter {
  constructor(options = {}) {
    super(); this.options = options; this.destroyed = false; this.sent = [];
    this.webContents = new EventEmitter();
    Object.assign(this.webContents, { id: windows.length + 1, isDestroyed: () => this.destroyed,
      send: (...args) => this.sent.push(args), setWindowOpenHandler: fn => { this.openHandler = fn; },
      getURL: () => this.url || '', mainFrame: { url: 'http://127.0.0.1:10087' } });
    windows.push(this);
  }
  isDestroyed() { return this.destroyed; }
  async loadURL(url) { this.url = url; }
  async loadFile(file, options) { this.file = file; this.loadOptions = options; }
  show() { this.visible = true; }
  destroy() { this.destroyed = true; this.emit('closed'); }
  static getAllWindows() { return windows.filter(w => !w.destroyed); }
  static fromWebContents(sender) { return windows.find(w => w.webContents === sender); }
}
const electron = {
  app: { getPath: () => tmp, isPackaged: false, getAppPath: () => path.resolve(__dirname, '../..') },
  BrowserWindow: Window,
  ipcMain: { removeHandler: name => handlers.delete(name), handle: (name, fn) => handlers.set(name, fn) },
  clipboard: { writeText: text => { copied = text; } },
  dialog: { showSaveDialog: async (_, options) => { exported = options; return { filePath: path.join(tmp, 'export.md') }; } },
  shell: { showItemInFolder: file => { shared = file; }, openExternal: () => {} },
  ShareMenu: class { constructor(options) { shared = options; } popup() {} },
  Menu: { buildFromTemplate: items => ({ items }) },
  nativeImage: { createMenuSymbol: symbol => symbol },
};
const originalLoad = Module._load;
Module._load = function(name, ...args) { return name === 'electron' ? electron : originalLoad.call(this, name, ...args); };
const root = path.resolve(__dirname, '../../dist-electron/electron');
const sessions = require(path.join(root, 'libs/session-store.js'));
const organization = require(path.join(root, 'ipc/session-organization.js'));
const sessionWindows = require(path.join(root, 'ipc/session-windows.js'));
const project = require(path.join(root, 'ipc/session-project.js'));
const { buildSessionNativeMenu } = require(path.join(root, 'ipc/session-menu.js'));
const invoke = (window, channel, ...args) => handlers.get(channel)({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, ...args);
(async () => {
  sessions.initialize();
  const primary = new Window();
  const a = sessions.createSession({ title: 'Research', cwd: tmp, provider: 'codex' });
  const b = sessions.createSession({ title: 'Other task', cwd: tmp, provider: 'kimi' });
  organization.setupSessionOrganizationIPC();
  let snapshot = await invoke(primary, 'change-session-organization', { kind: 'create-section', sessionId: a.id, name: '  My   Section  ' });
  const sectionId = snapshot.sessions[a.id].sectionId;
  assert.equal(snapshot.sections[0].name, 'My Section');
  await invoke(primary, 'change-session-organization', { kind: 'section', sessionId: b.id, sectionId });
  await invoke(primary, 'change-session-organization', { kind: 'unread', sessionId: a.id, unread: true });
  await invoke(primary, 'change-session-organization', { kind: 'archive', sessionId: a.id, archived: true });
  sessions.close(); sessions.initialize();
  assert.deepEqual(sessions.getSessionOrganization().sessions[a.id], { archived: true, unread: true, sectionId });
  await invoke(primary, 'change-session-organization', { kind: 'rename-section', sectionId, name: 'Renamed' });
  assert.equal(sessions.getSessionOrganization().sections[0].name, 'Renamed');
  await invoke(primary, 'change-session-organization', { kind: 'remove-section', sectionId });
  assert.equal(sessions.getSessionOrganization().sessions[a.id].sectionId, null);
  assert.equal(sessions.getSessionOrganization().sessions[b.id].sectionId, null);
  assert.ok(sessions.getSession(a.id)); assert.ok(sessions.getSession(b.id));
  await invoke(primary, 'change-session-organization', { kind: 'archive', sessionId: a.id, archived: false });
  sessions.updateSessionStatus(a.id, 'running');
  await assert.rejects(invoke(primary, 'change-session-organization', { kind: 'archive', sessionId: a.id, archived: true }), /Stop the task/);
  sessions.updateSessionStatus(a.id, 'idle');
  for (const change of [{kind:'unread',sessionId:a.id,unread:'yes'}, {kind:'section',sessionId:a.id,sectionId:'missing'}, {kind:'create-section',sessionId:a.id,name:' '}, {kind:'archive',sessionId:'missing',archived:true}]) {
    await assert.rejects(invoke(primary, 'change-session-organization', change));
  }
  for (let i = 0; i < 130; i++) sessions.addMessage(a.id, { type: 'user_prompt', prompt: 'Prompt ' + i, createdAt: 1000 + i });
  sessions.addMessage(a.id, { type:'assistant', message:{ role:'assistant',content:[{type:'text',text:'Answer'},{type:'thinking',thinking:'PRIVATE'},{type:'tool_use',name:'secret',input:{secret:'PRIVATE'}}]},createdAt:2000 });
  sessions.addMessage(a.id, { type:'user', message:{ role:'user',content:[{type:'tool_result',content:'PRIVATE'}]},createdAt:2001 });
  await invoke(primary, 'copy-session-markdown', a.id);
  assert.ok(copied.includes('Prompt 0')); assert.ok(copied.includes('Prompt 129')); assert.ok(copied.includes('Answer')); assert.ok(!copied.includes('PRIVATE'));
  await invoke(primary, 'export-session-markdown', a.id, false);
  assert.equal(fs.readFileSync(path.join(tmp, 'export.md'), 'utf8'), copied); assert.equal(exported.defaultPath, 'Research.md');
  const retired = [], changed = []; let moving = false;
  project.setupSessionProjectIPC({isMoving:()=>moving,retireRunner:id=>retired.push(id),changed:id=>changed.push(id)});
  const target = path.join(tmp, 'new-project');fs.mkdirSync(target);
  const pending = await invoke(primary, 'move-session-project', a.id, target);
  assert.equal(pending.status, 'needs-confirmation');
  assert.deepEqual(pending.missingSources, [fs.realpathSync(tmp)]);
  assert.equal(sessions.getSession(a.id).cwd, tmp);
  assert.deepEqual(retired, []);
  await invoke(primary, 'move-session-project', a.id, target, pending.approvalToken);
  assert.equal(sessions.getSession(a.id).cwd, fs.realpathSync(target));assert.deepEqual(retired,[a.id]);assert.deepEqual(changed,[a.id]);
  // Shared roots persist across reload and apply to another chat in the target.
  sessions.close();sessions.initialize();
  assert.deepEqual(sessions.getProjectSources(target), [fs.realpathSync(target), fs.realpathSync(tmp)]);
  const sibling = sessions.createSession({title:'Sibling',cwd:target,provider:'qoder'});
  assert.deepEqual(sessions.getSessionProjectSources(sibling.id,target),sessions.getProjectSources(target));
  assert.ok(sessions.buildProjectSourcesContext(target,target).includes(JSON.stringify(fs.realpathSync(tmp))));
  const again = await invoke(primary,'move-session-project',b.id,target);
  assert.equal(again.status,'moved','Already included source moves without confirmation');
  const noOp = await invoke(primary,'move-session-project',b.id,target);
  assert.equal(noOp.status,'unchanged');
  const alias = path.join(tmp,'target-alias');fs.symlinkSync(target,alias);
  assert.equal((await invoke(primary,'move-session-project',b.id,alias)).status,'unchanged');
  const child = path.join(target,'child');fs.mkdirSync(child);
  const nested = sessions.createSession({title:'Nested',cwd:child,provider:'kimi'});
  assert.equal((await invoke(primary,'move-session-project',nested.id,target)).status,'moved','Parent folder already covers child');
  const other = path.join(tmp,'other');fs.mkdirSync(other);
  const leaf = path.join(other,'leaf');fs.mkdirSync(leaf);
  const outside = sessions.createSession({title:'Outside',cwd:other,provider:'pi'});
  const missing = await invoke(primary,'move-session-project',outside.id,leaf);
  assert.equal(missing.status,'needs-confirmation','Child folder does not cover its parent');
  const invalid = await invoke(primary,'move-session-project',outside.id,leaf,'made-up-token');
  assert.equal(invalid.status,'needs-confirmation');
  assert.deepEqual(sessions.getProjectSources(leaf),[fs.realpathSync(leaf)]);
  // Changing the source while confirmation is open must request approval again.
  sessions.updateSessionWorkspace(outside.id,{projectCwd:tmp});
  const stale = await invoke(primary,'move-session-project',outside.id,leaf,invalid.approvalToken);
  assert.equal(stale.status,'needs-confirmation');
  assert.deepEqual(stale.missingSources,[fs.realpathSync(tmp)]);
  assert.equal(sessions.getSession(outside.id).cwd,tmp);
  // Real provider option builders consume the persisted roots, keeping plan mode read-only.
  const {CodexAppServerManager} = require(path.join(root,'libs/provider/codex-app-server-manager.js'));
  const manager = new CodexAppServerManager('/unused-codex','test');
  const sent = [];
  manager.sendRequest = async (method,params) => {sent.push({method,params});return method==='turn/start'?{turn:{id:'test-turn'}}:{items:[]};};
  for (const mode of ['defaultPermissions','auto']) {
    manager.sessions.set(b.id,{threadId:b.id,providerThreadId:'provider-test',cwd:target,generation:manager.generation,status:'ready'});
    await manager.sendTurn(b.id,'Inspect project folders',undefined,undefined,undefined,{codexPermissionMode:mode});
    assert.deepEqual(sent.at(-1).params.sandboxPolicy.writableRoots,sessions.getProjectSources(target));
    assert.equal(sent.at(-1).params.sandboxPolicy.type,'workspaceWrite');
  }
  manager.sessions.set(b.id,{threadId:b.id,providerThreadId:'provider-test',cwd:target,generation:manager.generation,status:'ready'});
  await manager.sendTurn(b.id,'Plan',undefined,undefined,undefined,{codexExecutionMode:'plan'});
  assert.equal(sent.at(-1).params.sandboxPolicy.type,'readOnly');
  const {QoderSdkAdapter} = require(path.join(root,'libs/provider/qoder-sdk-adapter.js'));
  const queryOptions = new QoderSdkAdapter().buildQueryOptions({qodercliAuth:()=>({})},{threadId:b.id},target);
  assert.deepEqual(queryOptions.additionalDirectories,[fs.realpathSync(tmp)]);
  const {isWithinProjectPath} = require(path.join(root,'libs/project-paths.js'));
  const escape = path.join(target,'escape');fs.symlinkSync(other,escape);
  assert.equal(isWithinProjectPath(path.join(escape,'new-file.txt'),target),false);
  assert.equal(isWithinProjectPath(path.join(target,'new-file.txt'),target),true);
  assert.equal(isWithinProjectPath(target+'-sibling',target),false);
  const folderless = sessions.createSession({title:'No folder',provider:'grok'});
  assert.equal((await invoke(primary,'move-session-project',folderless.id,leaf)).status,'moved');
  // Worktree execution replaces only the primary root, not the extra folders.
  sessions.updateSessionWorkspace(sibling.id,{projectCwd:target,envMode:'worktree',worktreePath:child});
  assert.deepEqual(sessions.getSessionProjectSources(sibling.id,child),[fs.realpathSync(child),fs.realpathSync(tmp)]);
  moving = true;await assert.rejects(invoke(primary,'move-session-project',a.id,tmp),/workspace operation/);moving=false;
  sessions.updateSessionStatus(a.id,'running');await assert.rejects(invoke(primary,'move-session-project',a.id,tmp),/finish/);sessions.updateSessionStatus(a.id,'idle');
  sessions.updateSessionWorkspace(a.id,{envMode:'worktree',worktreePath:target});
  await assert.rejects(invoke(primary,'move-session-project',a.id,tmp),/local project/);
  await assert.rejects(invoke(primary,'move-session-project',a.id,'relative'));
  const originalState = {'cowork-app-storage':JSON.stringify({state:{theme:'dark',activeWorkspace:'board',workspaceLayout:{old:true}},version:1}), 'cowork-tabs-storage':'old', 'codex-model':'gpt-5'};
  sessionWindows.setupSessionWindowsIPC({backgroundColor:()=> '#111111',rendererState:()=>originalState,onCreate:()=>{}});
  await invoke(primary,'open-session-window',a.id);
  const secondary = windows.at(-1), state = sessionWindows.sessionWindows.get(secondary.webContents.id);
  assert.equal(new URL(secondary.url).searchParams.get('sessionWindow'),a.id);
  assert.equal(secondary.options.webPreferences.sandbox,true);assert.equal(secondary.options.webPreferences.nodeIntegration,false);
  assert.equal(JSON.parse(state.rendererState['cowork-app-storage']).state.theme,'dark');
  assert.equal(JSON.parse(state.rendererState['cowork-app-storage']).state.workspaceLayout,undefined);
  assert.equal(state.rendererState['cowork-tabs-storage'],undefined); assert.equal(originalState['cowork-tabs-storage'],'old');
  assert.equal(state.rendererState['codex-model'],'gpt-5');
  sessionWindows.broadcastSessionEvent(primary,{type:'session.status',payload:{sessionId:a.id,status:'running'}});
  assert.equal(secondary.sent.at(-1)[0],'server-event');
  const count=secondary.sent.length;
  sessionWindows.broadcastSessionEvent(primary,{type:'session.open',payload:{sessionId:b.id}});
  assert.equal(secondary.sent.length,count,'Primary navigation must not switch secondary task');
  await invoke(primary,'change-session-organization',{kind:'unread',sessionId:a.id,unread:false});
  assert.equal(secondary.sent.at(-1)[0],'session-organization-changed');
  secondary.destroy(); assert.equal(sessionWindows.sessionWindows.size,0);assert.ok(sessions.getSession(a.id));
  const menu = buildSessionNativeMenu({items:[{label:'Project',icon:'folder',enabled:false,submenu:[{id:'project:0',label:'Project A',icon:'folder',checked:true}]}]},()=>{});
  assert.equal(menu.items[0].submenu[0].enabled,false);assert.equal(menu.items[0].submenu[0].checked,true);
  assert.throws(()=>buildSessionNativeMenu({items:[{id:'unknown',label:'Bad',icon:'folder'}]},()=>{}));
  sessions.deleteSession(b.id);assert.equal(sessions.getSessionOrganization().sessions[b.id],undefined);
  console.log('Session organization: SQLite persistence, IPC validation, full Markdown/export, project guards, window isolation and broadcast passed');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{sessions.close();Module._load=originalLoad;fs.rmSync(tmp,{recursive:true,force:true})});

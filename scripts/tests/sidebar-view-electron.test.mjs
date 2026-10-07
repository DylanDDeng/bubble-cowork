import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// Sidebar view options (the Kanban replacement): filters, Group by
// Project/State/Date, derived session states, PR glyphs and the Archived
// entry, rendered with the real components against fixture sessions.
// QA_CAPTURE=<dir> saves a screenshot of each view.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const qaRoot = path.join(root, 'dev-fixtures');
await mkdir(qaRoot, { recursive: true });
const tmp = await mkdtemp(path.join(qaRoot, 'sidebar-view-'));
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {FolderTreeView} from '/src/ui/components/FolderTreeView.tsx';
import {SidebarViewMenu} from '/src/ui/components/sidebar/SidebarViewMenu.tsx';
import {useAppStore} from '/src/ui/store/useAppStore.ts';
import {useSidebarViewStore} from '/src/ui/store/useSidebarViewStore.ts';
import '/src/ui/index.css';
const a=useAppStore.getState();const draft=a.createDraftSession('/projects/coworker');const base=useAppStore.getState().sessions[draft];
const now=Date.now();const min=60000;
const permission=[{toolUseId:'t1',toolName:'Bash',input:{command:'rm -rf build'}}];
const rows=[
 ['s1','Screenshot editor polish','coworker',{status:'running',permissionRequests:permission},2],
 ['s2','Kimi image upload via /files','bubble-cowork',{status:'error',runtimeNotice:'error'},30],
 ['s3','Sidebar filter replaces Kanban','coworker',{status:'running'},1],
 ['s4','Design canvas snapping','qoder',{status:'running',envMode:'worktree',worktreePath:'/projects/qoder/.worktrees/snap',associatedWorktreeBranch:'aegis/snap'},5],
 ['s5','Stream perf P3 batching','coworker',{status:'completed',runtimeNotice:'completed'},12],
 ['s6','Compaction activity trace','coworker',{status:'completed'},60*26],
 ['s7','Worktree apply-back flow','coworker',{status:'completed',envMode:'worktree',worktreePath:'/projects/coworker/.worktrees/apply',associatedWorktreeBranch:'aegis/apply'},60*50],
 ['s8','Narrow pane composer pickers','coworker',{status:'completed'},60*72],
 ['s9','Review loop triage rules','bubble-cowork',{status:'completed'},60*80],
 ['s10','Release checklist v0.0.62','coworker',{status:'completed',pinned:true},60*3],
 ['s11','Old archived research','coworker',{status:'completed'},60*24*3],
 ['s12','Legacy onboarding copy','qoder',{status:'completed'},60*24*60],
];
useAppStore.setState({sessions:Object.fromEntries(rows.map(([id,title,project,extra,age])=>[id,{...base,id,isDraft:false,title,cwd:'/projects/'+project,projectCwd:'/projects/'+project,provider:id==='s4'||id==='s6'||id==='s8'?'codex':'claude',messages:[],permissionRequests:[],status:'idle',envMode:'local',worktreePath:null,...extra,updatedAt:now-age*min,createdAt:now-age*min-1000}]))});
a.setActiveSession('s3');
window.qa={app:useAppStore,view:useSidebarViewStore};
function Harness(){
 const s=useAppStore();
 return <Tooltip.Provider><div style={{display:'flex',height:'100vh',background:'var(--bg-primary)'}}>
 <aside style={{width:300,padding:'12px 8px',background:'var(--app-sidebar-surface)',overflow:'auto'}}>
  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'4px 4px 12px'}}><b style={{fontSize:20,letterSpacing:'-0.04em'}}>Aegis</b><SidebarViewMenu/></div>
  <FolderTreeView projectCwd="/projects/coworker" onSessionClick={s.setActiveSession} onSelectProjectFolder={()=>{}} onNewSessionForProject={()=>{}} />
 </aside><main style={{flex:1}}/></div></Tooltip.Provider>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main = `
const {app,BrowserWindow,ipcMain}=require('electron');
// CI runners have Reduce Motion on; tests expect the default motion preference.
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));fs.mkdirSync(app.getPath('userData'),{recursive:true});
const root=process.env.QA_ROOT;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 ipcMain.on('get-ui-resume-state-sync',e=>{e.returnValue=null});ipcMain.on('renderer-state:get-all-sync',e=>{e.returnValue={}});ipcMain.on('save-ui-resume-state-sync',e=>{e.returnValue=true});
 ipcMain.on('renderer-state:set',()=>{});ipcMain.handle('set-theme',()=>{});
 ipcMain.handle('get-session-organization',()=>({sessions:{s9:{unread:false},s11:{archived:true}},sections:[],projectSources:{}}));
 const pr=(number,state)=>({number,title:'PR '+number,state,url:'https://github.com/o/r/pull/'+number});
 ipcMain.handle('list-sidebar-pull-requests',()=>({s6:pr(41,'open'),s8:pr(38,'merged'),s4:pr(44,'open')}));
 ipcMain.handle('get-git-branch',()=>({ok:true,branch:'master'}));ipcMain.handle('get-environment-editor-launchers',()=>[]);
 const win=new BrowserWindow({width:760,height:820,show:true,webPreferences:{backgroundThrottling:false,preload:path.join(root,'dist-electron/electron/preload.cjs')}});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=code=>win.webContents.executeJavaScript(code,true);
 // Menus render a little later on CI runners: wait for the element instead of failing at once.
 const point=async selector=>js('new Promise((resolve,reject)=>{const start=performance.now();const t=()=>{const e='+selector+';if(e){const r=e.getBoundingClientRect();resolve({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});return}if(performance.now()-start>5000){reject(Error("Missing element"));return}setTimeout(t,50)};t()})');
 const byText=text=>'[...document.querySelectorAll("[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],button")].find(e=>e.textContent.trim().startsWith('+JSON.stringify(text)+'))';
 const click=async selector=>{win.focus();win.webContents.focus();const p=await point(selector);win.webContents.sendInputEvent({type:'mouseMove',...p});win.webContents.sendInputEvent({type:'mouseDown',...p,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',...p,button:'left',clickCount:1});await delay(220)};
 const hover=async selector=>{const p=await point(selector);win.webContents.sendInputEvent({type:'mouseMove',...p});await delay(420)};
 const screenshot=async name=>{if(!process.env.QA_CAPTURE)return;fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG())};
 const rowIds=()=>js('[...document.querySelectorAll("[data-session-id]")].map(e=>e.dataset.sessionId)');
 const setView=patch=>js('qa.view.setState('+JSON.stringify(patch)+')').then(()=>delay(150));
 try{
  await win.loadURL(process.env.QA_URL);
  await js('new Promise(r=>{const t=()=>document.querySelector("[data-session-id]")?r():setTimeout(t,50);t()})');await delay(400);

  // Group by Project (default): pinned on top, archived hidden behind the entry at the bottom.
  assert.equal(await js('document.querySelector("[aria-label=\\\\"View options\\\\"]")!==null'),true,'default options leave the trigger untinted');
  const projectRows=await rowIds();
  assert.equal(projectRows[0],'s10','pinned threads lead');
  assert.equal(projectRows.includes('s11'),false,'archived threads stay out of Active');
  assert.equal(await js(byText('Archived')+'!==undefined'),true);
  assert.equal(await js('document.body.textContent.includes("Projects")'),true);
  assert.equal(await js('!!document.querySelector("[data-session-id=s6] [aria-label^=\\\\"Pull request #41\\\\"]")'),true,'PR status shows on the row');
  assert.equal(await js('!!document.querySelector("[data-session-id=s1] [aria-label=\\\\"Waiting for your approval\\\\"]")'),true);
  await screenshot('1-project');

  // The menu drives the same store; Group by -> State from the submenu.
  await click('document.querySelector("[aria-label=\\\\"View options\\\\"]")');
  for(const label of ['Status','Project','Last activity','Group by','Sort by','Show PR status'])assert.equal(await js(byText(label)+'!==undefined'),true,'menu row '+label);
  await hover(byText('Group by'));
  await screenshot('2-menu');
  await click(byText('State'));
  assert.equal(await js('qa.view.getState().groupBy'),'state');
  await js('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');await delay(200);

  // Group by State: most urgent first, derived from live status, unread and PRs.
  const order=await js('[...document.querySelectorAll("[data-sidebar-state]")].map(e=>e.dataset.sidebarState)');
  assert.deepEqual(order,['needs-input','running','review','completed']);
  const members=async state=>js('[...document.querySelectorAll("[data-sidebar-state='+state+'] [data-session-id]")].map(e=>e.dataset.sessionId).sort()');
  assert.deepEqual(await members('needs-input'),['s1','s2']);
  assert.deepEqual(await members('running'),['s3','s4']);
  assert.deepEqual(await members('review'),['s5','s6','s7'],'unseen result, open PR and live worktree wait on review');
  assert.deepEqual(await members('completed'),[],'Completed starts folded');
  assert.equal(await js('document.querySelector("[aria-label=\\\\"View options (customized)\\\\"]")!==null'),true,'changed options tint the trigger');
  assert.equal(await js('document.querySelector("[data-session-id=s5]").textContent.includes("coworker")'),false,'rows show the session only, not its project');
  await screenshot('3-state');
  await click('document.querySelector("[data-sidebar-state=completed] button")');
  assert.deepEqual(await members('completed'),['s10','s12','s8','s9'].sort(),'a merged PR lands in Completed');

  // Group by Date: every session has a bucket, old ones by month.
  await setView({groupBy:'date'});
  const dateHeaders=await js('[...document.querySelectorAll("section > div")].map(e=>e.textContent)');
  assert.ok(dateHeaders.includes('Today'));
  assert.equal((await rowIds()).includes('s12'),true,'sessions older than a week still appear');
  await screenshot('4-date');

  // Filters compose: activity window, project, status.
  await setView({activity:'7d'});
  assert.equal((await rowIds()).includes('s12'),false,'the activity window hides stale threads');
  await setView({activity:'all',project:'/projects/bubble-cowork',groupBy:'none'});
  assert.deepEqual((await rowIds()).sort(),['s2','s9']);
  await setView({project:null,groupBy:'project'});
  await click(byText('Archived'));
  assert.equal(await js('qa.view.getState().status'),'archived');
  assert.deepEqual(await rowIds(),['s11']);
  await screenshot('5-archived');
  await click(byText('Back to active threads'));
  assert.equal(await js('qa.view.getState().status'),'active');

  // PR glyphs are optional decoration.
  await setView({showPullRequests:false});
  assert.equal(await js('!!document.querySelector("[aria-label^=\\\\"Pull request #\\\\"]")'),false);

  assert.deepEqual(errors.filter(e=>!/No handler registered/.test(e)),[]);
  console.log(JSON.stringify({ok:true,checks:['project grouping with pinned and archived entry','view menu rows and submenu','derived state groups','collapsed completed','date buckets','activity, project and status filters','PR glyph toggle']}));
  app.exit(0);
 }catch(e){console.error(e);console.error(errors);await screenshot('failure');app.exit(1)}
});
`;
let server;
try {
  await writeFile(path.join(tmp, 'index.html'), '<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(tmp, 'harness.tsx'), harness);
  await writeFile(path.join(tmp, 'main.cjs'), main);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await server.listen();
  const url = new URL(path.relative(root, tmp) + '/index.html', server.resolvedUrls.local[0]).href;
  await new Promise((resolve, reject) => {
    const env = { ...process.env, QA_ROOT: root, QA_URL: url, DEV_SERVER_URL: server.resolvedUrls.local[0] };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.env.QA_ELECTRON_EXECUTABLE || path.join(root, 'node_modules/.bin/electron'), [path.join(tmp, 'main.cjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; process.stdout.write(c); });
    child.stderr.on('data', (c) => { err += c; process.stderr.write(c); });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Timed out\n' + out + '\n' + err)); }, 120000);
    child.on('error', reject);
    child.on('exit', (code) => { clearTimeout(timeout); code === 0 && out.includes('"ok":true') ? resolve() : reject(new Error(out + '\n' + err)); });
  });
  console.log('Sidebar view Electron regression passed');
} finally { await server?.close(); await rm(tmp, { recursive: true, force: true }); }

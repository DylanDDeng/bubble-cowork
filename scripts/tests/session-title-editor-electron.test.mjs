import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const qaRoot = path.join(root, '.aegis-design-qa');
await mkdir(qaRoot, { recursive: true });
const tmp = await mkdtemp(path.join(qaRoot, 'session-title-'));
const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Tooltip } from '@base-ui-components/react/tooltip';
import { Toaster } from 'sonner';
import { SessionTitleEditor } from '/src/ui/components/SessionTitleEditor.tsx';
import { AppTabBar } from '/src/ui/components/AppTabBar.tsx';
import { FolderTreeView } from '/src/ui/components/FolderTreeView.tsx';
import { useAppStore } from '/src/ui/store/useAppStore.ts';
import { useTabsStore } from '/src/ui/store/useTabsStore.ts';
import { useBoardStore, ensureBoardSessionSync } from '/src/ui/store/useBoardStore.ts';
import '/src/ui/index.css';
const id = new URLSearchParams(location.search).get('session');
const a = useAppStore.getState();
const draft = a.createDraftSession('/projects/coworker');
const base = useAppStore.getState().sessions[draft];
useAppStore.setState({ sessions: { [id]: {...base, id, isDraft:false, title:'复制 Codex Session 标题交互', status:'running', messages:[{type:'user_prompt',prompt:'请按照录屏实现标题的原位编辑',createdAt:Date.now()}]} } });
a.setActiveSession(id);
useTabsStore.getState().openTab({kind:'chat',sessionId:id});
const boardId=useBoardStore.getState().addTask({title:'复制 Codex Session 标题交互',sessionId:id,titleFollowsSession:true});
ensureBoardSessionSync();
window.electron.onServerEvent(e=>a.handleServerEvent(e));
window.qa={store:useAppStore,id,boardId,board:useBoardStore,input:()=>document.querySelector('[aria-label="Conversation title"]'),button:()=>document.querySelector('[aria-label^="Rename conversation:"]')};
function Harness(){
 const s=useAppStore(); const active=s.sessions[s.activeSessionId];
 return <Tooltip.Provider><div style={{display:'flex',height:'100vh',background:'var(--bg-primary)'}}>
 <aside style={{width:230,flexShrink:0,padding:12,background:'var(--sidebar-bg)'}}><div style={{padding:'14px 12px',fontWeight:600}}>Aegis</div><FolderTreeView projectCwd="/projects/coworker" onSessionClick={s.setActiveSession} onSelectProjectFolder={()=>{}} onNewSessionForProject={()=>{}} /></aside>
 <main style={{flex:1,minWidth:0}}><AppTabBar/><header style={{height:44,display:'flex',alignItems:'center',padding:'0 16px',gap:12}}><div style={{flex:1,minWidth:0,display:'flex'}}><SessionTitleEditor session={active} className="text-[13px] font-medium text-[var(--text-primary)]"/></div><button id="outside">Open</button></header><div style={{padding:'70px 48px',color:'var(--text-secondary)'}}>请按照录屏实现标题的原位编辑</div></main><Toaster/></div></Tooltip.Provider>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main = `
const {app,BrowserWindow,ipcMain}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
fs.mkdirSync(app.getPath('userData'),{recursive:true});
const root=process.env.QA_ROOT;
const sessions=require(path.join(root,'dist-electron/electron/libs/session-store.js'));
const {setupSessionTitleIPC}=require(path.join(root,'dist-electron/electron/ipc/session-title.js'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 sessions.initialize();
 const row=sessions.createSession({title:'复制 Codex Session 标题交互',cwd:'/projects/coworker',provider:'claude'});
 const win=new BrowserWindow({width:1100,height:740,show:true,webPreferences:{preload:path.join(root,'dist-electron/electron/preload.cjs')}});
 const errors=[]; win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
 let broadcasts=0;
 const emit=e=>{broadcasts++;win.webContents.send('server-event',JSON.stringify(e));};
 setupSessionTitleIPC(emit);
 ipcMain.on('get-ui-resume-state-sync',e=>{e.returnValue=null;});
 ipcMain.on('renderer-state:get-all-sync',e=>{e.returnValue={};});
 ipcMain.on('save-ui-resume-state-sync',e=>{e.returnValue=true;});
 ipcMain.handle('set-theme',()=>{});
 const js=code=>win.webContents.executeJavaScript(code,true);
 const key=async keyCode=>{win.webContents.sendInputEvent({type:'keyDown',keyCode});win.webContents.sendInputEvent({type:'keyUp',keyCode});await delay(120);};
 const edit=async text=>{await js('qa.button().click()');await delay(70);if(text!==undefined){await win.webContents.insertText(text);await delay(50);}};
 const title=()=>js('qa.store.getState().sessions[qa.id].title');
 const screenshot=async name=>{if(process.env.QA_CAPTURE){fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG());}};
 try{
  console.log('Loading title editor fixture');
  await win.loadURL(process.env.QA_URL+'?session='+row.id);
  console.log('Title editor fixture loaded');
  for(let i=0;i<150;i++){if(await js('!!window.qa && !!qa.button()'))break;await delay(100);}
  win.focus();
  await screenshot('title-idle');
  await edit();
  assert.equal(await js('document.activeElement===qa.input()'),true);
  assert.equal(await js('qa.input().selectionEnd-qa.input().selectionStart'),row.title.length);
  await screenshot('title-selected');
  await win.webContents.insertText('新的会话标题');await key('Enter');
  assert.equal(await title(),'新的会话标题');assert.equal(sessions.getSession(row.id).title,'新的会话标题');
  assert.equal(broadcasts,1,'Enter must save exactly once');
  assert.equal(await js('document.activeElement===qa.button()'),true,'keyboard focus returns to title');
  assert.equal(await js('qa.board.getState().tasks[qa.boardId].title'),'新的会话标题');
  assert.equal(await js('!!Array.from(document.querySelectorAll("[role=tab]")).find(el=>el.textContent.includes("新的会话标题"))'),true);
  assert.equal(await js('document.querySelector("[data-session-id]").textContent.includes("新的会话标题")'),true);
  assert.equal(await js('qa.store.getState().sessions[qa.id].status'),'running','renaming preserves live run state');
  await edit('取消这次修改');await key('Escape');assert.equal(await title(),'新的会话标题');assert.equal(broadcasts,1);
  await edit('失焦后保存');await js('document.querySelector("#outside").focus()');await delay(200);
  assert.equal(await title(),'失焦后保存');assert.equal(broadcasts,2);
  assert.equal(await js('document.activeElement.id'),'outside','blur does not steal focus');
  await edit('   ');await key('Enter');assert.equal(await title(),'失焦后保存');assert.equal(broadcasts,2);
  // Composition Enter must accept a candidate without committing the title.
  await edit('中文输入');
  await js('qa.input().dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true}));qa.input().dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",isComposing:true,bubbles:true}))');
  assert.equal(await js('!!qa.input()'),true);assert.equal(broadcasts,2);
  await js('qa.input().dispatchEvent(new CompositionEvent("compositionend",{bubbles:true}))');await key('Enter');
  assert.equal(await title(),'中文输入');assert.equal(broadcasts,3);
  await edit('短');const short=await js('qa.input().getBoundingClientRect().width');
  await js('qa.input().select()');await win.webContents.insertText('很长的会话标题'.repeat(20));await delay(80);
  const long=await js('qa.input().getBoundingClientRect().width');assert.ok(long>short);
  win.setSize(500,740);await delay(150);
  assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true,'long title does not overflow narrow window');
  assert.ok(await js('qa.input().getBoundingClientRect().right<=document.querySelector("#outside").getBoundingClientRect().left'));
  await screenshot('title-narrow');await key('Escape');win.setSize(1100,740);
  // Failed IPC leaves persisted state unchanged and retains the draft for retry.
  ipcMain.removeHandler('rename-session');ipcMain.handle('rename-session',()=>{throw new Error('Save failed for test');});
  await edit('可重试的标题');await key('Enter');
  assert.equal(await title(),'中文输入');assert.equal(await js('qa.input().value'),'可重试的标题');
  setupSessionTitleIPC(emit);await key('Enter');assert.equal(await title(),'可重试的标题');
  // Storage race and validation checks go through the same production API/storage.
  assert.equal(sessions.updateSessionTitle(row.id,'late generated title',row.title),false);
  assert.equal(sessions.getSession(row.id).title,'可重试的标题');
  assert.equal(await js('window.electron.renameSession(qa.id," ").then(()=>false,()=>true)'),true);
  assert.equal(await js('window.electron.renameSession(qa.id,"x".repeat(201)).then(()=>false,()=>true)'),true);
  assert.equal(await js('window.electron.renameSession("missing","Valid title").then(()=>false,()=>true)'),true);
  const before=broadcasts;await edit();await key('Enter');assert.equal(broadcasts,before,'unchanged title does not write');
  // Switching sessions cancels the editor without renaming either session.
  await edit('Do not leak this edit');
  await js('qa.other=qa.store.getState().createDraftSession("/projects/other");qa.store.getState().setActiveSession(qa.other)');await delay(100);
  assert.equal(await js('!!qa.input()'),false);assert.equal(await title(),'可重试的标题');
  await edit('自定义草稿标题');await key('Enter');
  assert.equal(await js('qa.store.getState().sessions[qa.other].draftTitleEdited'),true);assert.equal(broadcasts,before);
  await js('qa.store.getState().setActiveSession(qa.id)');await delay(100);
  await screenshot('title-saved');
  sessions.close();sessions.initialize();assert.equal(sessions.getSession(row.id).title,'可重试的标题','title survives database reopen');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,broadcasts,shortWidth:short,longWidth:long,persistedTitle:sessions.getSession(row.id).title}));
  sessions.close();app.exit(0);
 }catch(e){console.error(e);console.error(errors);await screenshot('failure');app.exit(1);}
});
`;
let server;
try {
  await writeFile(path.join(tmp,'index.html'),'<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(tmp,'harness.tsx'),harness);
  await writeFile(path.join(tmp,'main.cjs'),main);
  server=await createServer({root,configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0,strictPort:false}});
  await server.listen();
  const url=new URL(path.relative(root,tmp)+'/index.html',server.resolvedUrls.local[0]).href;
  await new Promise((resolve,reject)=>{
    const env={...process.env,QA_ROOT:root,QA_URL:url,DEV_SERVER_URL:server.resolvedUrls.local[0]};delete env.ELECTRON_RUN_AS_NODE;
    const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(tmp,'main.cjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
    let out='',err='';child.stdout.on('data',c=>{out+=c;process.stdout.write(c);});child.stderr.on('data',c=>{err+=c;process.stderr.write(c);});
    const timeout=setTimeout(()=>{child.kill();reject(new Error('Timed out\n'+out+'\n'+err));},120000);
    child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);if(code===0 && out.includes('\"ok\":true')){resolve();}else reject(new Error(out+'\n'+err));});
  });
  console.log('Session title editor Electron regression passed');
} finally {await server?.close();await rm(tmp,{recursive:true,force:true});}

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await mkdir(path.join(root, 'dev-fixtures'), {recursive:true});
const tmp = await mkdtemp(path.join(root, 'dev-fixtures', 'session-windows-'));
const harness = `
import React,{useEffect} from 'react';import {createRoot} from 'react-dom/client';
import {useIPC,sendEvent} from '/src/ui/hooks/useIPC.ts';
import {useAppStore} from '/src/ui/store/useAppStore.ts';
import {useSessionOrganization} from '/src/ui/store/useSessionOrganizationStore.ts';
import '/src/ui/index.css';
window.qa={store:useAppStore};
function Harness(){useIPC();const s=useAppStore();const org=useSessionOrganization();
useEffect(()=>{if(s.connected)sendEvent({type:'session.list'})},[s.connected]);
return <main style={{padding:32}}><h1>{s.sessions[s.activeSessionId]?.title||'No conversation'}</h1><div id="active">{s.activeSessionId}</div><div id="status">{s.sessions[s.activeSessionId]?.status}</div><div id="sections">{org.sections.map(s=>s.name).join(', ')}</div></main>}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main = `
const {app,BrowserWindow,ipcMain}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));fs.mkdirSync(app.getPath('userData'),{recursive:true});
const root=process.env.QA_ROOT;const load=file=>require(path.join(root,'dist-electron/electron',file));
const sessions=load('libs/session-store.js');const windows=load('ipc/session-windows.js');const {ipcMainHandle,ipcMainOn}=load('util.js');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{try{
 sessions.initialize();const a=sessions.createSession({title:'First conversation',cwd:__dirname,provider:'codex'});const b=sessions.createSession({title:'Second conversation',cwd:__dirname,provider:'kimi'});
 const original={'cowork-app-storage':JSON.stringify({state:{theme:'dark',activeWorkspace:'board',workspaceLayout:{old:true}},version:0})};
 ipcMainOn('renderer-state:get-all-sync',event=>{event.returnValue=windows.sessionWindows.get(event.sender.id)?.rendererState||original});
 ipcMainOn('renderer-state:set',(event,key,value)=>{(windows.sessionWindows.get(event.sender.id)?.rendererState||original)[key]=value});
 ipcMainOn('get-ui-resume-state-sync',event=>{event.returnValue=null});ipcMainOn('save-ui-resume-state-sync',event=>{event.returnValue={ok:true}});ipcMainHandle('save-ui-resume-state',()=>({ok:true}));ipcMainHandle('set-theme',()=>({ok:true}));
 ipcMainOn('client-event',(event,json)=>{if(JSON.parse(json).type==='session.list')event.sender.send('server-event',JSON.stringify({type:'session.list',payload:{sessions:sessions.listSessions().map(row=>({id:row.id,title:row.title,cwd:row.cwd,provider:row.provider,status:row.status,createdAt:row.created_at,updatedAt:row.updated_at}))}}))});
 load('ipc/session-organization.js').setupSessionOrganizationIPC();
 windows.setupSessionWindowsIPC({backgroundColor:()=> '#ffffff',rendererState:()=>original,onCreate:()=>{}});
 const win=new BrowserWindow({show:false,webPreferences:{preload:path.join(root,'dist-electron/electron/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)});
 await win.loadURL(process.env.QA_URL);const js=code=>win.webContents.executeJavaScript(code,true);
 for(let i=0;i<100&&!await js('Boolean(window.qa?.store.getState().sessionsLoaded)');i++)await delay(50);
 await js('qa.store.getState().setActiveSession('+JSON.stringify(b.id)+');true');
 await js('window.electron.openSessionWindow('+JSON.stringify(a.id)+')');
 assert.equal(windows.sessionWindows.size,1);const secondary=[...windows.sessionWindows.values()][0].window;
 secondary.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)});
 const js2=code=>secondary.webContents.executeJavaScript(code,true);
 for(let i=0;i<100&&!await js2('Boolean(window.qa?.store.getState().sessionsLoaded)');i++)await delay(50);
 assert.equal(await js2('qa.store.getState().activeSessionId'),a.id);assert.equal(await js('qa.store.getState().activeSessionId'),b.id);
 assert.equal(await js2('qa.store.getState().activeWorkspace'),'chat');
 const primarySaved=original['cowork-app-storage'];await js2('qa.store.getState().setSidebarWidth(340);true');await delay(100);assert.equal(original['cowork-app-storage'],primarySaved);
 windows.broadcastSessionEvent(win,{type:'session.status',payload:{sessionId:a.id,status:'running'}});await delay(150);
 assert.equal(await js2('qa.store.getState().sessions[qa.store.getState().activeSessionId].status'),'running');
 assert.equal(await js('qa.store.getState().sessions['+JSON.stringify(a.id)+'].status'),'running');
 windows.broadcastSessionEvent(win,{type:'stream.user_prompt',payload:{sessionId:a.id,prompt:'Continue in both windows',createdAt:Date.now()}});
 windows.broadcastSessionEvent(win,{type:'stream.message',payload:{sessionId:a.id,message:{type:'assistant',uuid:'window-test-reply',message:{role:'assistant',content:[{type:'text',text:'Shared streamed reply'}]}}}});await delay(150);
 assert.ok(await js2('JSON.stringify(qa.store.getState().sessions['+JSON.stringify(a.id)+'].messages).includes("Shared streamed reply")'));
 assert.ok(await js('JSON.stringify(qa.store.getState().sessions['+JSON.stringify(a.id)+'].messages).includes("Shared streamed reply")'));
 windows.broadcastSessionEvent(win,{type:'session.renamed',payload:{sessionId:a.id,title:'Updated conversation',updatedAt:Date.now()}});await delay(100);
 assert.equal(await js2('document.querySelector("h1").textContent'),'Updated conversation');assert.equal(await js('qa.store.getState().activeSessionId'),b.id);
 await js2('window.electron.changeSessionOrganization({kind:"create-section",sessionId:'+JSON.stringify(a.id)+',name:"Research"})');await delay(100);
 assert.equal(await js('document.querySelector("#sections").textContent'),'Research');assert.equal(await js2('document.querySelector("#sections").textContent'),'Research');
 if(process.env.QA_CAPTURE){fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,'secondary-window.png'),(await secondary.webContents.capturePage()).toPNG())}
 secondary.close();await delay(100);assert.equal(windows.sessionWindows.size,0);assert.equal(win.isDestroyed(),false);assert.ok(sessions.getSession(a.id));
 assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks:['new window target hydration','sandboxed preload','independent layout persistence','live messages, status and title broadcast','shared organization','closing window preserves task and primary']}));sessions.close();app.exit(0);
}catch(error){console.error(error);app.exit(1)}});
`;
let server;
try {
 await writeFile(path.join(tmp,'index.html'),'<div id="root"></div><script type="module" src="./harness.tsx"></script>');
 await writeFile(path.join(tmp,'harness.tsx'),harness);await writeFile(path.join(tmp,'main.cjs'),main);
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0,strictPort:false}});await server.listen();
 const url=new URL(path.relative(root,tmp)+'/index.html',server.resolvedUrls.local[0]).href;
 await new Promise((resolve,reject)=>{
  const env={...process.env,QA_ROOT:root,QA_URL:url,DEV_SERVER_URL:url};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(process.env.QA_ELECTRON_EXECUTABLE||path.join(root,'node_modules/.bin/electron'),[path.join(tmp,'main.cjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});let out='';
  child.stdout.on('data',data=>{out+=data;process.stdout.write(data)});child.stderr.on('data',data=>process.stderr.write(data));
  const timeout=setTimeout(()=>{child.kill();reject(new Error('Window regression timed out'))},120000);
  child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);code===0&&out.includes('"ok":true')?resolve():reject(new Error('Window regression failed'))});
 });
}finally{await server?.close();await rm(tmp,{recursive:true,force:true})}

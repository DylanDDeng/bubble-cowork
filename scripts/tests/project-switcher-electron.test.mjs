import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const qaRoot = path.join(root, '.aegis-design-qa');
await mkdir(qaRoot, { recursive: true });
const tmp = await mkdtemp(path.join(qaRoot, 'project-switcher-'));
const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Tooltip } from '@base-ui-components/react/tooltip';
import { NewThreadLanding } from '/src/ui/components/NewThreadLanding.tsx';
import { NewThreadProjectHeading } from '/src/ui/components/NewThreadProjectHeading.tsx';
import { FolderTreeView } from '/src/ui/components/FolderTreeView.tsx';
import { useAppStore } from '/src/ui/store/useAppStore.ts';
import { openProjectNewChat } from '/src/ui/utils/project-new-chat.ts';
import '/src/ui/index.css';
window.electron = { getRecentCwds: async () => ['/projects/Alpha', '/projects/Beta', '/projects/RecentOnly'], selectDirectory: async () => window.browseResult, gitBranch: async () => null };
const a = useAppStore.getState();
const old = a.createDraftSession('/projects/Beta');
useAppStore.setState(s => ({ sessions: { ...s.sessions, [old]: {...s.sessions[old], isDraft: false, title: 'Existing conversation', messages: [{id: 'message', role: 'user', content: 'Keep this history'}]} } }));
a.setProjectCwd('/projects/Alpha');
a.setShowNewSession(true);
a.setActiveChannelForProject('/projects/Alpha', 'alpha-channel');
a.setActiveChannelForProject('/projects/Beta', 'beta-channel');
window.qa = { store: useAppStore, openProjectNewChat, old, snapshot: () => {
 const s = useAppStore.getState(); const active = s.sessions[s.activeSessionId];
 const row = document.querySelector('[data-session-id="'+s.activeSessionId+'"]');
 return {cwd:s.projectCwd, active: active && {id:active.id,cwd:active.cwd,channelId:active.channelId,isDraft:active.isDraft}, draftCount:Object.values(s.sessions).filter(x=>x.isDraft).length, oldExists:!!s.sessions[old], selected:row?.getAttribute('aria-current'), visible:!!row && row.getBoundingClientRect().height>0, heading:document.querySelector('h1')?.textContent};
}};
function Harness() {
 const s = useAppStore();
 const active = s.activeSessionId ? s.sessions[s.activeSessionId] : null;
 return <Tooltip.Provider><div style={{display:'flex',height:'100vh',background:'var(--bg-primary)'}}>
 <aside style={{width:280,flexShrink:0,overflowY:'auto',padding:12,background:'var(--sidebar-bg)'}}><FolderTreeView projectCwd={s.projectCwd} onSessionClick={s.setActiveSession} onSelectProjectFolder={()=>{}} onNewSessionForProject={openProjectNewChat}/></aside>
 <NewThreadLanding heading={<NewThreadProjectHeading cwd={active?.projectCwd || s.projectCwd || ''} sessionId={active?.id} disabled={s.pendingStart}/>}><div style={{padding:24,border:'1px solid var(--border)',borderRadius:18,color:'var(--text-muted)'}}>Start a new chat</div></NewThreadLanding>
 </div></Tooltip.Provider>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main = `
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
const delay = ms => new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1200,height:800,show:false});
 const js = async code => {try {return await win.webContents.executeJavaScript(code,true);}catch(e){throw new Error(code+' :: '+e.message);}};
 win.webContents.on('console-message',event=>{if(event.level==='error')console.error(event.message);});
 const click = async selector => {await js('document.querySelector('+JSON.stringify(selector)+').click()');await delay(160);};
 try {
  await win.loadURL(process.env.QA_URL);
  for(let i=0;i<150;i++){if(await js('!!window.qa && !!document.querySelector("h1")'))break;await delay(100);}
  // Collapse destination first: selecting it must reveal its New chat again.
  await js('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="Beta").click()');
  await click('[aria-label="Switch project: Alpha"]');
  assert.equal(await js('document.activeElement.getAttribute("aria-label")'),'Search projects');
  await win.webContents.insertText('Beta'); await delay(150);
  assert.equal(await js('document.querySelectorAll("[cmdk-item][title]").length'),1);
  await win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});await win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});await delay(250);
  const beta=await js('qa.snapshot()');
  assert.equal(beta.cwd,'/projects/Beta');assert.equal(beta.active.channelId,'beta-channel');assert.equal(beta.selected,'page');assert.equal(beta.visible,true);assert.equal(beta.draftCount,1);assert.equal(beta.oldExists,true);
  // Current project is checked and selecting it is a no-op.
  await click('[aria-label="Switch project: Beta"]');
  assert.equal(await js('!!document.querySelector("[aria-label^=Current]")'),true);
  await click('[cmdk-item][title="/projects/Beta"]');
  assert.equal((await js('qa.snapshot()')).active.id,beta.active.id);
  await click('[aria-label="Switch project: Beta"]');
  await click('[cmdk-item][title="/projects/Alpha"]');
  const alpha=await js('qa.snapshot()');assert.equal(alpha.active.channelId,'alpha-channel');assert.equal(alpha.draftCount,1);assert.equal(alpha.oldExists,true);assert.equal(alpha.selected,'page');
  // Escape closes, no-match state works, cancelling browse preserves selection.
  await click('[aria-label="Switch project: Alpha"]');
  await win.webContents.insertText('missing-project');await delay(100);
  assert.equal(await js('document.body.textContent.includes("No projects found")'),true);
  await win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});await delay(150);
  assert.equal(await js('!!document.querySelector("[aria-label^=Search]")'),false);
  await click('[aria-label="Switch project: Alpha"]');
  await js('window.browseResult=null');await click('[cmdk-item][data-value="__browse_project__"]');
  assert.equal((await js('qa.snapshot()')).active.id,alpha.active.id);
  await click('[aria-label="Switch project: Alpha"]');
  await js('window.browseResult="/projects/NewFolder"');await click('[cmdk-item][data-value="__browse_project__"]');
  assert.equal((await js('qa.snapshot()')).cwd,'/projects/NewFolder');
  // Direct guard check: sending must not race a project switch.
  await js('qa.store.setState({pendingStart:true});qa.openProjectNewChat("/projects/Beta")');
  assert.equal((await js('qa.snapshot()')).cwd,'/projects/NewFolder');
  await js('qa.store.setState({pendingStart:false})');
  await click('[aria-label="Switch project: NewFolder"]');
  const output=process.env.QA_CAPTURE;
  if(output){fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'project-switcher.png'),(await win.webContents.capturePage()).toPNG());}
  console.log(JSON.stringify({ok:true,beta,alpha}));app.exit(0);
 } catch(e){console.error(e);app.exit(1);}
});
`;
let server;
try {
  await writeFile(path.join(tmp, 'index.html'), '<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(tmp, 'harness.tsx'), harness);
  await writeFile(path.join(tmp, 'main.cjs'), main);
  server = await createServer({root, configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0,strictPort:false}});
  await server.listen();
  const url = new URL(path.relative(root,tmp)+'/index.html',server.resolvedUrls.local[0]).href;
  await new Promise((resolve,reject)=>{
    const env={...process.env,QA_URL:url,QA_CAPTURE:process.env.QA_CAPTURE || ''};
    delete env.ELECTRON_RUN_AS_NODE;
    const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(tmp,'main.cjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
    let out='';let err='';
    child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);
    const timeout=setTimeout(()=>{child.kill();reject(new Error('Timed out\n'+out+'\n'+err));},45000);
    child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);if(code===0){console.log(out.trim());resolve();}else reject(new Error(out+'\n'+err));});
  });
  console.log('project switcher Electron regression passed');
} finally {
  await server?.close();
  await rm(tmp,{recursive:true,force:true});
}

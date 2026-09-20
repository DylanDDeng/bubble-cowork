import { createServer } from 'vite';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const dir = await mkdtemp(path.join(root, '.aegis-design-qa/board-attachments-'));
let server;
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {Toaster} from 'sonner';
import {BoardView} from '/src/ui/components/BoardView';
import {useBoardStore} from '/src/ui/store/useBoardStore';
import {useAppStore} from '/src/ui/store/useAppStore';
import '/src/ui/index.css';
const preview=(()=>{const c=document.createElement('canvas');c.width=400;c.height=280;const x=c.getContext('2d');x.fillStyle='#c4d7cc';x.fillRect(0,0,400,280);x.fillStyle='#718c7a';x.fillRect(45,45,310,190);x.fillStyle='#eee5ca';x.beginPath();x.arc(200,140,65,0,7);x.fill();return c.toDataURL()})();
let latency=0,fail=false,native=[];const sent=[];
const attachment=name=>({id:crypto.randomUUID(),kind:'image',name,path:'/attachments/'+name,mimeType:'image/png',size:100});
window.electron={
 getRecentCwds:async()=>['/tmp/project'],listPullRequests:async()=>({prs:[],repositories:[],errors:[]}),
 getGitRepoBrief:async()=>({isGitRepository:false}),getGitOverview:async()=>({ok:true,hasRepo:false}),
 getUserProfile:async()=>({displayName:'Test',handle:'test'}),sendClientEvent:()=>{},
 getAgentRuntimeDirectory:async()=>({checkedAt:Date.now(),entries:[]}),
 getClaudeCompatibleProviderConfig:async()=>({}),getBubbleProvidersConfig:async()=>({providers:[]}),
 chooseAttachments:async()=>{if(latency)await new Promise(r=>setTimeout(r,latency));return fail?{attachments:[],errors:['Could not import image']}:{attachments:[attachment('reference.png')],errors:[]}},
 getPathForFile:()=>'',getClipboardFilePaths:()=>native,
 createFileAttachment:async name=>attachment(name),importAttachments:async paths=>({attachments:paths.map(p=>attachment(p.split('/').pop())),errors:[]}),
 readAttachmentPreview:async()=>preview,
 startBackgroundSession:async payload=>{sent.push(payload);return {ok:true,sessionId:'board-run-'+sent.length}},
};
for(const p of ['Claude','Codex','Kimi','Grok','Opencode','Pi','Bubble','Qoder','Deepseek'])window.electron['get'+p+'ModelConfig']=async()=>({defaultModel:null,options:[],availableModels:[]});
window.electron.getClaudeModelConfig=async()=>({defaultModel:'claude-sonnet-4-6',options:['claude-sonnet-4-6']});
useAppStore.setState({projectCwd:'/tmp/project',sessions:{}});useAppStore.getState().setTheme('light');
window.qa={board:useBoardStore,store:useAppStore,sent,slow:ms=>latency=ms,fail:value=>fail=value,native:paths=>native=paths};
createRoot(document.getElementById('root')).render(<Tooltip.Provider><div style={{height:'100vh',display:'flex',background:'var(--bg-primary)'}}><BoardView/></div><Toaster/></Tooltip.Provider>);
`;
const main = String.raw`
const {app,BrowserWindow}=require('electron');const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1200,height:850,show:true});const errors=[];
 w.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=s=>w.webContents.executeJavaScript(s,true);
 const delay=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async(s,label)=>{for(let i=0;i<100;i++){if(await js(s))return;await delay(80)}throw Error('Timed out: '+label)};
 const click=async selector=>{await js('document.querySelector('+JSON.stringify(selector)+').click()');await delay(100)};
 const button=async text=>{await js('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==='+JSON.stringify(text)+').click()');await delay(100)};
 const title=async text=>{await js('(()=>{const e=document.querySelector("[role=dialog] input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,'+JSON.stringify(text)+');e.dispatchEvent(new Event("input",{bubbles:true}))})()');await delay(100)};
 const shot=async name=>{await delay(150);fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 const thumbs='document.querySelectorAll("[role=dialog] [aria-label=\\"Task attachments\\"] img").length';
 try{
  await w.loadURL(process.env.QA_URL);await until('!!window.qa','board');
  await click('[aria-label="New task in Todo"]');await title('Inspect the references');
  await js('qa.slow(550)');await click('[aria-label="Attach files"]');
  assert.equal(await js('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Save to Todo").disabled'),true,'saving waits for attachment import');
  await until(thumbs+'===1','picked thumbnail');await js('qa.slow(0)');
  await js('(()=>{const d=new DataTransfer();d.items.add(new File(["png"],"pasted.png",{type:"image/png"}));document.querySelector("[aria-label=\\"Task description\\"]").dispatchEvent(new ClipboardEvent("paste",{bubbles:true,cancelable:true,clipboardData:d}))})()');
  await until(thumbs+'===2','pasted thumbnail');
  await js('(()=>{const d=new DataTransfer();d.items.add(new File(["png"],"dropped.png",{type:"image/png"}));document.querySelector("[role=dialog]").dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:d}))})()');
  await until(thumbs+'===3','dropped thumbnail');
  await click('[aria-label="Attach files"]');assert.equal(await js(thumbs),3,'duplicate path is not added twice');
  await shot('create-light');await js('qa.store.getState().setTheme("dark")');await shot('create-dark');
  await js('qa.fail(true)');await click('[aria-label="Attach files"]');assert.equal(await js(thumbs),3,'failed import preserves references');await js('qa.fail(false)');
  await button('Save to Todo');await until('!document.querySelector("[role=dialog]")','saved');
  assert.equal(await js('Object.values(qa.board.getState().tasks)[0].attachments.length'),3);
  assert.equal(await js('qa.board.getState().selectedTaskId'),null,'saving a new task stays on the board');
  await click('button[draggable="true"]');
  await until('document.querySelectorAll("[aria-label=\\"Task attachments\\"] img").length===3','detail images');
  await click('[aria-label="Open image attachment reference.png"]');await until('!!document.querySelector("[aria-label=\\"Close image preview\\"]")','image preview');await click('[aria-label="Close image preview"]');
  await w.reload();await until('!!window.qa && Object.values(qa.board.getState().tasks).length===1','persisted task');
  assert.equal(await js('Object.values(qa.board.getState().tasks)[0].attachments.length'),3,'references survive reload');
  await js('qa.board.getState().setSelectedTask(null)');await delay(100);
  await js('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("Inspect the references")).dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:450,clientY:180}))');await delay(100);await button('Edit details');
  await until(thumbs+'===3','edit retains references');await click('[aria-label="Remove attachment"]');await until(thumbs+'===2','remove reference');
  await button('Save to Todo');
  assert.equal(await js('qa.board.getState().selectedTaskId'),null,'editing from the board stays on the board');
  await click('button[draggable="true"]');await button('Start Task');
  assert.equal(await js('qa.board.getState().selectedTaskId'),null,'starting from task detail returns to the board');
  assert.deepEqual(await js('qa.sent[0].attachments.map(a=>a.name)'),['pasted.png','dropped.png']);
  assert.equal(await js('qa.sent[0].prompt'),'Inspect the references');
  await js('qa.board.getState().setSelectedTask(null)');await delay(100);await click('[aria-label="New task in Todo"]');await title('Start with image');
  await click('[aria-label="Attach files"]');await until(thumbs+'===1','new reference');await button('Start now');
  assert.deepEqual(await js('qa.sent[1].attachments.map(a=>a.name)'),['reference.png'],'Start now sends images too');
  assert.equal(await js('qa.board.getState().selectedTaskId'),null,'Start now stays on the board');
  assert.equal(await js('Object.values(qa.board.getState().tasks).find(t=>t.title==="Start with image").stage'),'working','started task moves to Working');
  assert.equal(await js('document.querySelectorAll("button[draggable=true]").length'),2,'task cards remain visible after starting');
  await shot('board-after-start');
  await js('qa.board.getState().setSelectedTask(null)');await delay(100);await click('[aria-label="New task in Todo"]');await js('qa.slow(400)');await click('[aria-label="Attach files"]');
  await js('document.querySelector("[aria-label=\\\"Close task composer\\\"]").click()');await delay(100);await click('[aria-label="New task in Todo"]');await delay(450);
  assert.equal(await js(thumbs),0,'cancelled imports cannot leak into a new task');
  assert.deepEqual(errors,[]);console.log('Board attachments Electron: pick, paste, drop, failures, cancel, save/reload, edit, preview and both start paths passed');app.exit(0);
 }catch(error){console.error(error,errors);await shot('failure');app.exit(1)}
});
`;
try {
 await writeFile(path.join(dir,'index.html'),'<html><body style="margin:0"><div id="root"></div><script type="module" src="./probe.tsx"></script></body></html>');
 await writeFile(path.join(dir,'probe.tsx'),harness);await writeFile(path.join(dir,'main.cjs'),main);
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0,strictPort:false}});await server.listen();
 const env={...process.env,QA_URL:new URL(path.relative(root,dir)+'/index.html',server.resolvedUrls.local[0]).href,QA_CAPTURE:path.join(root,'output/playwright/board-attachments')};delete env.ELECTRON_RUN_AS_NODE;
 await new Promise((resolve,reject)=>{const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(dir,'main.cjs')],{env,stdio:'inherit'});const timer=setTimeout(()=>{child.kill();reject(Error('Board attachments test timed out'))},60000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Board attachments test failed: '+code))})});
} finally {await server?.close();await rm(dir,{recursive:true,force:true});}

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const qaRoot = path.join(root, '.aegis-design-qa');
await mkdir(qaRoot, { recursive: true });
const tmp = await mkdtemp(path.join(qaRoot, 'jump-to-latest-'));
const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Tooltip } from '@base-ui-components/react/tooltip';
import { ChatPane } from '/src/ui/components/ChatPane.tsx';
import { useAppStore } from '/src/ui/store/useAppStore.ts';
import '/src/ui/index.css';
window.electron = { getSessionUserPrompts: async () => [], sendClientEvent: () => {}, getRecentCwds: async () => [] };
for (const provider of ['Claude','Codex','Kimi','Grok','Opencode','Pi','Bubble','Qoder','Deepseek']) {window.electron['get'+provider+'ModelConfig'] = async () => ({defaultModel:null, options:[], availableModels:[]});}
window.electron.getClaudeCompatibleProviderConfig = async () => ({});
const a = useAppStore.getState();
const first = a.createDraftSession('');
const second = a.createDraftSession('');
function messages(count) {return Array.from({length:count},(_,i)=>({type:'user_prompt',prompt:'Turn '+(i+1)+': Please review the latest changes and explain how the updated chat navigation behaves. Include the expected behavior when reading earlier messages.',createdAt:1000+i*1000}));}
useAppStore.setState(s=>({sessions:{...s.sessions,[first]:{...s.sessions[first],isDraft:false,messages:messages(30)},[second]:{...s.sessions[second],isDraft:false,messages:messages(1)}}}));
a.setActiveSession(first);
window.qa = { first, second, store:useAppStore, scroll: () => document.querySelector('[data-chat-scroll-container]'), snapshot: () => {
 const el=qa.scroll();const button=document.querySelector('[aria-label="Scroll to latest turn"]');
 return {top:el.scrollTop,gap:el.scrollHeight-el.scrollTop-el.clientHeight,visible:!!button,buttonBottom:button?.getBoundingClientRect().bottom,scrollBottom:el.getBoundingClientRect().bottom,composerTop:document.querySelector('.aegis-chat-composer')?.getBoundingClientRect().top};
}, append:()=>{const s=useAppStore.getState();const id=s.activeSessionId;useAppStore.setState({sessions:{...s.sessions,[id]:{...s.sessions[id],messages:[...s.sessions[id].messages,{type:'user_prompt',prompt:'A new turn has arrived. '+ 'New output. '.repeat(100),createdAt:Date.now()}]}}});} };
function Harness() {const id=useAppStore(s=>s.activeSessionId);return <Tooltip.Provider><div style={{display:'flex',height:'100vh',background:'var(--bg-primary)'}}><ChatPane paneId="primary" sessionId={id} isActive onActivate={()=>{}} codexModelConfig={{}} showHeader={false}/></div></Tooltip.Provider>;}
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
 const win=new BrowserWindow({width:1000,height:800,show:false});
 const errors=[];
 win.webContents.on('console-message',event=>{if(event.level==='error'){errors.push(event.message);console.error(event.message);}});
 const js=async code=>{try{return await win.webContents.executeJavaScript(code,true);}catch(e){throw new Error(code+' :: '+e.message);}};
 const snapshot=()=>js('qa.snapshot()');
 const jump=async()=>{await js('document.querySelector("[aria-label^=Scroll]").click()');await delay(200);};
 try {
  await win.loadURL(process.env.QA_URL);
  console.log('Loaded chat fixture');
  for(let i=0;i<150;i++){if(await js('!!window.qa && !!qa.scroll()'))break;await delay(100);}
  await delay(400);
  assert.equal((await snapshot()).visible,false,'hidden on initial bottom');
  await js('qa.scroll().scrollTop -= 650');await delay(200);
  const scrolled=await snapshot();assert.equal(scrolled.visible,true);
  assert.ok(scrolled.buttonBottom < scrolled.composerTop,'button sits above the composer');
  assert.ok(scrolled.scrollBottom-scrolled.buttonBottom<=20,'button stays near the transcript bottom');
  const output=process.env.QA_CAPTURE;
  if(output){fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'jump-to-latest.png'),(await win.webContents.capturePage()).toPNG());}
  await js('qa.append()');await delay(200);
  assert.equal((await snapshot()).top,scrolled.top,'new output preserves history-reading position');
  await jump();assert.ok((await snapshot()).gap<2);assert.equal((await snapshot()).visible,false);
  await js('qa.append()');await delay(200);
  assert.ok((await snapshot()).gap<2,'explicit jump restores following');
  // Restore a scrolled session after visiting a short conversation.
  await js('qa.scroll().scrollTop -= 450');await delay(150);
  const saved=await snapshot();
  await js('qa.store.getState().setActiveSession(qa.second)');await delay(250);
  assert.equal((await snapshot()).visible,false,'short transcript has no jump button');
  await js('qa.store.getState().setActiveSession(qa.first)');await delay(250);
  assert.equal((await snapshot()).visible,true);assert.ok(Math.abs((await snapshot()).top-saved.top)<2);
  await jump();
  // Jumping from the oldest loaded message also reaches the bottom.
  await js('qa.scroll().scrollTop=0');await delay(150);
  await jump();
  assert.ok((await snapshot()).gap<2);
  await js('qa.scroll().scrollTop -= 300');await delay(150);
  await js('qa.scroll().scrollTop=qa.scroll().scrollHeight');await delay(150);
  assert.equal((await snapshot()).visible,false,'manual bottom scroll hides button');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,scrolled}));app.exit(0);
 }catch(e){console.error(e);app.exit(1);}
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
    const timeout=setTimeout(()=>{child.kill();reject(new Error('Timed out\n'+out+'\n'+err));},120000);
    child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);if(code===0){console.log(out.trim());resolve();}else reject(new Error(out+'\n'+err));});
  });
  console.log('jump to latest Electron regression passed');
} finally {
  await server?.close();
  await rm(tmp,{recursive:true,force:true});
}

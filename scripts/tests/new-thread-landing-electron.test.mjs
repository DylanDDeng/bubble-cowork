import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';

const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const tmp = await mkdtemp(path.join(root, '.aegis-design-qa/new-thread-'));
const capture = path.join(root, 'output/playwright/new-thread-landing');
const harness = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {Toaster} from 'sonner';
import {NewSessionView} from '/src/ui/components/NewSessionView';
import {ChatPane} from '/src/ui/components/ChatPane';
import {useAppStore} from '/src/ui/store/useAppStore';
import '/src/ui/index.css';
localStorage.setItem('cowork.preferredProvider','deepseek');
localStorage.setItem('cowork.preferredDeepseekModel','deepseek-flash');
const Alpha='/projects/My Personal Digital Garden';
const Beta='/projects/Beta';
const Notes='/projects/Notes';
const Long='/projects/A very long project name that should wrap naturally without truncating the destination or moving the composer away from the bottom';
window.qa={calls:[],Alpha,Beta,Notes,Long,store:useAppStore,browseResult:null};
window.electron={
 getRecentCwds:async()=>[Alpha,Beta,Notes,Long],selectDirectory:async()=>qa.browseResult,
 getSessionUserPrompts:async()=>[],sendClientEvent:e=>qa.calls.push(e),
 getGitBranches:async cwd=>{await new Promise(r=>setTimeout(r,120));return cwd===Notes?{ok:false}:{ok:true,entries:[{name:'main',current:true,remote:false},{name:'feature',current:false,remote:false}]};},
 gitCheckoutBranch:async p=>{qa.calls.push(p);return {ok:true};},
 getProjectGitSummary:async()=>({isGitRepository:true}),getProjectTree:async()=>null,
 getAgentRuntimeDirectory:async()=>({checkedAt:Date.now(),entries:[]}),getClaudeCompatibleProviderConfig:async()=>({}),
 chooseAttachments:async()=>({attachments:[{id:'file',name:'notes.txt',path:'/tmp/notes.txt',mimeType:'text/plain',size:10}],errors:[]}),
 getSessionGoal:async id=>({sessionId:id,supported:false,goal:null,revision:0}),onSessionGoalChanged:()=>()=>{},
};
for(const p of ['Claude','Codex','Kimi','Grok','Opencode','Pi','Bubble','Qoder','Deepseek'])window.electron['get'+p+'ModelConfig']=async()=>({defaultModel:null,options:[],availableModels:[]});
window.electron.getDeepseekModelConfig=async()=>({defaultModel:'deepseek-flash',options:['deepseek-flash'],availableModels:[{id:'deepseek-flash',name:'DeepSeek V4.1 Flash',reasoningEfforts:['none','high','max']}]});
const a=useAppStore.getState();a.setProjectCwd(Alpha);a.setShowNewSession(true);
a.setActiveChannelForProject(Beta,'beta-channel');
function Harness(){
 const [draft,setDraft]=useState(false);qa.setDraft=()=>{const id=a.createDraftSession(Alpha);qa.draftId=id;setDraft(true);};
 const id=useAppStore(s=>s.activeSessionId);
 return <Tooltip.Provider><div style={{height:'100vh',display:'flex',flexDirection:'column',background:'var(--bg-primary)',color:'var(--text-primary)'}}>
 <header style={{height:48,flexShrink:0,padding:'14px 24px',fontSize:13}}>New task</header>
 {draft?<ChatPane paneId="primary" sessionId={id} isActive onActivate={()=>{}} codexModelConfig={{}} showHeader={false}/>:<NewSessionView/>}
 <Toaster/>
 </div></Tooltip.Provider>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main = String.raw`
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1124,height:879,show:true});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error'){errors.push(e.message);console.error(e.message);}});
 const js=code=>win.webContents.executeJavaScript(code,true);
 const until=async(code,label)=>{for(let i=0;i<100;i++){if(await js(code))return;await delay(100);}throw Error('Timed out: '+label);};
 const click=async selector=>{await js('document.querySelector('+JSON.stringify(selector)+').click()');await delay(180);};
 const key=async keyCode=>{win.webContents.sendInputEvent({type:'keyDown',keyCode});win.webContents.sendInputEvent({type:'keyUp',keyCode});await delay(180);};
 const shot=async name=>{await delay(200);fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG());};
 const rect=selector=>js('document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect().toJSON()');
 const measure=async()=>({composer:await rect('.aegis-new-thread-composer'),heading:await rect('h1'),height:await js('innerHeight')});
 const select=async(entrance,destination)=>{await click(entrance);assert.equal(await js('document.activeElement.getAttribute("aria-label")'),'Search projects');await js('Array.from(document.querySelectorAll("[cmdk-item][title]")).find(x=>x.title===qa.'+destination+').click()');await delay(250);};
 try{
  await win.loadURL(process.env.QA_URL);await until('!!window.qa && !!document.querySelector("[role=textbox]")','initial composer');
  await until('document.querySelector("h1").innerText.includes("build in")','git heading');
  const initial=await measure();assert(Math.abs(initial.height-initial.composer.bottom-16)<2,'composer is 16px from bottom');
  assert(initial.composer.top-initial.heading.bottom>100,'hero is separate from composer');
  const logo=await rect('.aegis-new-thread-logo');
  assert.equal(logo.width,56);assert.equal(logo.height,56);
  assert(Math.abs(initial.heading.top-logo.bottom-24)<1,'logo has 24px title gap');
  assert(Math.abs((logo.left+logo.width/2)-(initial.heading.left+initial.heading.width/2))<1,'logo is centered over title');
  assert.equal(await js('getComputedStyle(document.querySelector(".aegis-new-thread-logo")).opacity'),'0.3');
  await js('document.querySelector(".aegis-new-thread-logo").dispatchEvent(new PointerEvent("pointerup",{bubbles:true,button:0,pointerType:"mouse"}))');
  await delay(150);
  assert.notEqual(await js('getComputedStyle(document.querySelector(".aegis-new-thread-logo")).transform'),'none','logo responds to pointer');
  await delay(1200);
  await shot('new-task-light');
  // The same anchor survives window resizing and longer input.
  win.setContentSize(920,1000);await delay(200);const tall=await measure();assert(Math.abs(tall.height-tall.composer.bottom-16)<2);
  await js('document.querySelector("[role=textbox]").focus();document.execCommand("insertText",false,"Keep this draft while switching projects")');
  await click('[aria-label="Add files or photos"]');
  await until('!!document.querySelector("[aria-label=\\"Remove attachment\\"]")','attachment');
  await select('[aria-label^="Switch project:"]','Beta');
  assert.equal(await js('qa.store.getState().showNewSession'),true,'heading selection keeps first-entry surface');
  assert((await js('document.querySelector("[role=textbox]").textContent')).includes('Keep this draft'));
  assert.equal(await js('document.querySelectorAll("[aria-label=\\"Remove attachment\\"]").length'),1);
  await select('[aria-label="Project folder"]','Notes');
  assert((await js('document.querySelector("h1").innerText')).includes('work on in'));
  assert.equal(await js('!!document.querySelector("button[title=\\"Switch branch\\"]")'),false);
  // No stale Git controls from the previous project while new metadata loads.
  await select('[aria-label^="Switch project:"]','Long');
  await shot('long-project');
  win.setContentSize(390,700);await delay(200);
  const narrow=await measure();assert(Math.abs(narrow.height-narrow.composer.bottom-16)<2);
  assert(narrow.heading.height>48,'long title wraps');
  assert.equal(await js('document.documentElement.scrollWidth>innerWidth'),false);
  assert(await js('Array.from(document.querySelectorAll(".aegis-composer-toolbar button,.aegis-composer-context-row button")).every(b=>{const r=b.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})'),'all controls remain inside viewport');
  await shot('new-task-narrow');
  // Portals open above the anchored input, escape closes, and focus returns.
  await click('[aria-label="Select agent and model"]');
  const menu=await rect('[role="menu"]');const model=await rect('[aria-label="Select agent and model"]');
  assert(menu.bottom<=model.top+1,'model menu opens upward');assert(menu.top>=0);
  await shot('model-menu-narrow');await key('Escape');
  await click('[data-composer-control="permission"]');
  assert((await rect('[role="menu"]')).bottom<=(await rect('[data-composer-control="permission"]')).top+1);
  await key('ArrowDown');await key('Escape');
  assert.equal(await js('document.activeElement.getAttribute("data-composer-control")'),'permission');
  await click('[data-composer-control="preset"]');
  assert((await rect('[role="menu"]')).bottom<=(await rect('[data-composer-control="preset"]')).top+1);
  await key('Escape');
  await click('[data-composer-control="permission"]');
  await js('qa.store.setState({pendingStart:true})');await delay(150);
  assert.equal(await js('!!document.querySelector("[role=menu]")'),false,'starting closes permission menu');
  await js('qa.store.setState({pendingStart:false})');
  await click('[data-composer-control="preset"]');await shot('preset-menu');
  await js('qa.store.setState({pendingStart:true})');await delay(150);
  assert.equal(await js('!!document.querySelector("[role=menu]")'),false,'starting closes preset menu');
  await js('qa.store.setState({pendingStart:false})');await delay(150);
  // Clicking the input surface (outside controls) focuses the editor.
  await js('document.activeElement.blur();document.querySelector(".aegis-new-thread-composer-surface").dispatchEvent(new MouseEvent("mousedown",{bubbles:true,button:0,cancelable:true}))');
  assert.equal(await js('document.activeElement.getAttribute("role")'),'textbox');
  await js('qa.store.getState().setTheme("dark")');await shot('new-task-dark');
  assert.equal(await js('getComputedStyle(document.querySelector(".aegis-new-thread-logo")).color'),await js('getComputedStyle(document.querySelector("h1")).color'),'logo follows theme text color');
  assert((await js('getComputedStyle(document.querySelector(".aegis-new-thread-composer-surface")).boxShadow')).includes('inset'));
  // Short windows scroll the independent regions without overlap or clipping.
  win.setContentSize(600,420);await delay(180);
  await js('const landing=document.querySelector(".aegis-new-thread-landing");landing.scrollTop=landing.scrollHeight');
  await delay(100);assert((await rect('.aegis-new-thread-composer')).bottom<=420);
  await shot('new-task-short');
  // The real ChatPane draft entrance must preserve the session and its inputs.
  win.setContentSize(1124,879);await js('qa.store.getState().setTheme("light");qa.setDraft()');
  await until('!!document.querySelector("h1") && document.querySelector("h1").innerText.includes("Garden")','draft entrance');
  await js('document.querySelector("[role=textbox]").focus();document.execCommand("insertText",false,"Draft session text")');
  await click('[aria-label="Add files or photos"]');await delay(150);
  await select('[aria-label="Project folder"]','Beta');
  assert.equal(await js('qa.store.getState().activeSessionId===qa.draftId'),true);
  assert.equal(await js('qa.store.getState().sessions[qa.draftId].channelId'),'beta-channel');
  assert((await js('document.querySelector("[role=textbox]").textContent')).includes('Draft session text'));
  assert.equal(await js('document.querySelectorAll("[aria-label=\\"Remove attachment\\"]").length'),1);
  await select('[aria-label^="Switch project:"]','Alpha');
  assert((await js('document.querySelector("[role=textbox]").textContent')).includes('Draft session text'));
  await shot('draft-task-light');
  assert.equal(await js('document.querySelectorAll(".aegis-new-thread-logo").length'),1,'draft entry uses the same home logo');
  const draft=await measure();assert(Math.abs(draft.height-draft.composer.bottom-16)<2);
  // Clearing the folder restores the projectless heading and leaves a chooser.
  await js('qa.store.setState(s=>({sessions:{...s.sessions,[qa.draftId]:{...s.sessions[qa.draftId],cwd:"",projectCwd:""}}}))');await delay(150);
  assert.equal(await js('document.querySelector("h1").textContent'),'What should we build?');
  assert.equal(await js('document.querySelector("[aria-label=\\"Project folder\\"]").textContent'),'Choose project');
  await shot('projectless');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,initial,tall,narrow,draft,captures:process.env.QA_CAPTURE}));app.exit(0);
 }catch(e){console.error(e);await shot('failure');app.exit(1);}
});
`;
let server;
try {
  await writeFile(path.join(tmp,'index.html'),'<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(tmp,'harness.tsx'),harness);
  await writeFile(path.join(tmp,'main.cjs'),main);
  server=await createServer({root,configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0,strictPort:false,watch:{ignored:['**/.aegis-design-qa/**']}}});await server.listen();
  const url=new URL(path.relative(root,tmp)+'/index.html',server.resolvedUrls.local[0]).href;
  await new Promise((resolve,reject)=>{
    const env={...process.env,QA_URL:url,QA_CAPTURE:capture};delete env.ELECTRON_RUN_AS_NODE;
    const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(tmp,'main.cjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
    let out='';child.stdout.on('data',c=>{out+=c;process.stdout.write(c);});child.stderr.on('data',c=>process.stderr.write(c));
    const timeout=setTimeout(()=>{child.kill();reject(Error('New task Electron test timed out'));},90000);
    child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);code===0&&out.includes('"ok":true')?resolve():reject(Error('New task Electron regression failed'));});
  });
} finally {await server?.close();await rm(tmp,{recursive:true,force:true});}

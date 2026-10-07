import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
const root=process.cwd();
await mkdir(path.join(root,'.aegis-design-qa'),{recursive:true});
const dir=await mkdtemp(path.join(root,'.aegis-design-qa/composer-long-text-'));
const harness=`
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {PromptInput} from '/src/ui/components/PromptInput';
import {NewSessionView} from '/src/ui/components/NewSessionView';
import {TaskFollowUpEditor} from '/src/ui/components/TaskFollowUpEditor';
import {useAppStore} from '/src/ui/store/useAppStore';
import '/src/ui/index.css';
localStorage.setItem('cowork.preferredProvider','deepseek');
window.electron={createInlineTextAttachment:async()=>{qa.textAttachmentCalls++;throw Error('Text must remain inline')},getProjectTree:async()=>null,cancelProjectTreeRead:async()=>{},getRecentCwds:async()=>[],getProjectGitSummary:async()=>({isGitRepository:false}),getAgentRuntimeDirectory:async()=>({checkedAt:Date.now(),entries:[]}),getSessionUserPrompts:async()=>[],getSessionGoal:async()=>({goal:null,supported:false,revision:0}),onSessionGoalChanged:()=>()=>{},getClaudeCompatibleProviderConfig:async()=>({}),getBubbleProvidersConfig:async()=>({providers:[]}),getProjectFolders:async()=>[],getModels:async()=>[],listCodexSkills:async()=>({skills:[]}),sendClientEvent:event=>qa.events.push(event)};
for(const p of ['Claude','Kimi','Grok','Opencode','Pi','Bubble','Qoder','Deepseek','Devin','Codex'])window.electron['get'+p+'ModelConfig']=async()=>({defaultModel:null,options:[],availableModels:[]});
window.electron.getDevinThoughtLevels=async()=>({model:null,levels:[],defaultLevel:null});
window.electron.getDeepseekModelConfig=async()=>({defaultModel:'deepseek-flash',options:['deepseek-flash'],availableModels:[{id:'deepseek-flash',name:'DeepSeek V4.1 Flash',reasoningEfforts:['none','high','max']}]});
const store=useAppStore,id=store.getState().createDraftSession('/tmp/composer-qa');
store.setState(s=>({connected:true,projectCwd:'/tmp/composer-qa',activeSessionId:id,sessions:{...s.sessions,[id]:{...s.sessions[id],isDraft:false,provider:'deepseek',model:'deepseek-flash',status:'completed',messages:[],hydrated:true}}}));
window.qa={store,id,events:[],textAttachmentCalls:0};
function Harness(){const [mode,setMode]=useState('new'),[value,setValue]=useState('');qa.mode=setMode;
return <Tooltip.Provider><div style={{height:'100vh',display:'flex',flexDirection:'column',overflow:'hidden',background:'var(--bg-primary)',color:'var(--text-primary)'}}><header style={{height:56,flexShrink:0}}>Composer long text QA</header>
{mode==='new'?<NewSessionView/>:<><main style={{flex:1,minHeight:0,overflow:'auto'}}>Conversation content</main><div className="aegis-chat-composer px-8 pb-4">{mode==='chat'?<PromptInput sessionId={id}/>:<TaskFollowUpEditor value={value} onChange={setValue} onSubmit={payload=>{qa.events.push({type:'followup',payload});return true}} session={store.getState().sessions[id]} placeholder="Follow up" className="min-h-[56px] max-h-[200px] p-4"/>}</div></>}
</div></Tooltip.Provider>}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main=String.raw`
const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
// CI runners have Reduce Motion on; tests expect the default motion preference.
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
app.setPath('userData',path.join(__dirname,'profile'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1000,height:800,show:true,webPreferences:{backgroundThrottling:false}}),js=s=>win.webContents.executeJavaScript(s,true);
 const until=async(s,label)=>{for(let i=0;i<100;i++){if(await js(s))return;await delay(50)}throw Error('Timed out: '+label)};
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const shot=async name=>{win.webContents.invalidate();await delay(150);fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG())};
 try{
 await win.loadURL(process.env.QA_URL);await until('!!document.querySelector("[role=textbox]")','composer');
 const text=Array.from({length:90},(_,i)=>'Line '+i+': Keep the entire long prompt in the editor. 中文长文本，不转换成附件。').join('\n');
 for(const mode of ['new','chat','followup']){
  console.log('Testing composer:',mode);
  win.setContentSize(1000,800);
  await js('qa.store.setState({pendingStart:false})');
  await js('qa.mode('+JSON.stringify(mode)+')');await delay(100);
  await js('(()=>{const e=document.querySelector("[role=textbox]");e.focus();const data=new DataTransfer();data.setData("text/plain",'+JSON.stringify(text)+');e.dispatchEvent(new ClipboardEvent("paste",{clipboardData:data,bubbles:true,cancelable:true}))})()');
  await until('document.querySelector("[role=textbox]").textContent.includes("Line 89")','full paste '+mode);
  // Native Edit > Select All followed by shortcut keyup used to collapse the
  // first selection when the real new/chat parent echoed cursorIndex=0.
  win.webContents.selectAll();
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'a',modifiers:['meta']});
  await delay(100);
  assert.equal(await js('getSelection().toString()'),text,mode+' first select-all keeps the full prompt selected');
  // Pasting over the selection replaces it and normalizes clipboard newlines.
  await js('(()=>{const e=document.querySelector("[role=textbox]"),data=new DataTransfer();data.setData("text/plain",'+JSON.stringify(text.replaceAll('\n','\r\n'))+');e.dispatchEvent(new ClipboardEvent("paste",{clipboardData:data,bubbles:true,cancelable:true}))})()');
  await delay(100);
  assert.equal(await js('document.querySelector("[role=textbox]").textContent'),text,'paste replaces the selection without duplicating the prompt');
  for(const [width,height] of [[1000,800],[540,420]]){
   win.setContentSize(width,height);await delay(100);
   await js('(()=>{const landing=document.querySelector(".aegis-new-thread-landing");if(landing)landing.scrollTop=landing.scrollHeight})()');
   const m=await js('(()=>{const e=document.querySelector("[role=textbox]"),r=e.getBoundingClientRect(),t=document.querySelector(".aegis-composer-toolbar")?.getBoundingClientRect() ?? {top:innerHeight,bottom:innerHeight};e.scrollTop=0;return {height:r.height,scroll:e.scrollHeight,client:e.clientHeight,overflow:getComputedStyle(e).overflowY,bottom:r.bottom,toolbarTop:t.top,toolbarBottom:t.bottom,screen:innerHeight,pageOverflow:document.documentElement.scrollHeight>innerHeight}})()');
   assert.equal(m.overflow,'auto');assert(m.scroll>m.client);assert(m.height<=200);assert(m.bottom<=m.toolbarTop,'text clears toolbar');assert(m.toolbarBottom<=m.screen,'toolbar in view');assert.equal(m.pageOverflow,false);
   await js('document.querySelector("[role=textbox]").scrollTop=99999');assert(await js('document.querySelector("[role=textbox]").scrollTop>0'),'scroll to last line');
  }
  await js('(()=>{const landing=document.querySelector(".aegis-new-thread-landing");if(landing)landing.scrollTop=landing.scrollHeight})()');
  await shot(mode+'-long-prompt');
  await js('document.querySelector("[role=textbox]").scrollTop=0');
  await shot(mode+'-long-prompt-top');
  assert.equal(await js('document.querySelectorAll("[aria-label=\\"Remove attachment\\"]").length'),0,'paste creates no attachment chip');
  await js('(()=>{const e=document.querySelector("[role=textbox]");e.focus();const r=document.createRange();r.selectNodeContents(e);r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r)})()');
  win.webContents.insertText(' appended');await delay(100);
  assert.equal(await js('document.querySelector("[role=textbox]").textContent'),text+' appended','editing a long prompt preserves it');
  const before=await js('qa.events.length');
  if(mode==='followup'){
   win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
  }else{
   await until('!!document.querySelector("button[aria-label=\\"Send\\"]") && !document.querySelector("button[aria-label=\\"Send\\"]").disabled','send enabled');
   await js('document.querySelector("button[aria-label=\\"Send\\"]").click()');
  }
  await until('qa.events.length>'+before,'send');
  const sent=await js('qa.events.at(-1)');assert.equal(sent.payload.prompt,text+' appended');assert.equal(sent.payload.effectivePrompt,text+' appended');assert.deepEqual(sent.payload.attachments??[],[]);
 }
 assert.equal(await js('qa.textAttachmentCalls'),0,'no text file creation on paste, editing, or send');
 assert.deepEqual(errors,[]);console.log('PASS: long text stays inline and sends intact in new/chat/follow-up composers; bounded height and inner scrolling at both sizes');app.exit(0);
 }catch(e){console.error(e,errors,await js('({text:document.querySelector("[role=textbox]")?.textContent,editable:document.querySelector("[role=textbox]")?.contentEditable,events:qa.events.map(e=>e.type)})'));await shot('failure');app.exit(1)}
});
`;
let server;
try{
 await writeFile(path.join(dir,'index.html'),'<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
 await writeFile(path.join(dir,'harness.tsx'),harness);await writeFile(path.join(dir,'main.cjs'),main);
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),cacheDir:path.join(dir,'vite-cache'),server:{host:'127.0.0.1',port:0,watch:{ignored:['**/.aegis-design-qa/**']}}});await server.listen();
 const env={...process.env,BUBBLE_HOME:path.join(dir,'bubble-home'),QA_URL:new URL(path.relative(root,dir)+'/index.html',server.resolvedUrls.local[0]).href,QA_CAPTURE:path.join(root,'output/playwright/composer-long-text')};delete env.ELECTRON_RUN_AS_NODE;
 await new Promise((resolve,reject)=>{const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(dir,'main.cjs')],{env,stdio:'inherit'});const timer=setTimeout(()=>{child.kill();reject(Error('Composer long text QA timed out'))},60000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Composer long text QA failed: '+code))})});
}finally{await server?.close();await rm(dir,{recursive:true,force:true})}

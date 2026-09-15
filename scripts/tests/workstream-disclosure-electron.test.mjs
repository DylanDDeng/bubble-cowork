import { createServer } from 'vite';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const dir = await mkdtemp(path.join(root, '.aegis-design-qa/workstream-'));
let server;
const harness = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {WorkstreamDisclosure} from '/src/ui/components/ToolExecutionBatch';
import {ChatPane} from '/src/ui/components/ChatPane';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {useAppPreferences} from '/src/ui/store/useAppPreferences';
import {useAppStore} from '/src/ui/store/useAppStore';
import '/src/ui/index.css';
window.electron = {
 sendClientEvent:()=>{},getProjectTree:async()=>null,getRecentCwds:async()=>[],getProjectGitSummary:async()=>({isGitRepository:false}),
 getAgentRuntimeDirectory:async()=>({checkedAt:Date.now(),entries:[]}),getSessionUserPrompts:async()=>[],
 getSessionGoal:async()=>({goal:null,supported:false,revision:0}),onSessionGoalChanged:()=>()=>{},
 getClaudeCompatibleProviderConfig:async()=>({}),getBubbleProvidersConfig:async()=>({providers:[]}),
 getProjectFolders:async()=>[],getModels:async()=>[],
};
for(const p of ['Claude','Kimi','Grok','Opencode','Pi','Bubble','Qoder','Deepseek','Codex'])window.electron['get'+p+'ModelConfig']=async()=>({defaultModel:null,options:[],availableModels:[]});
const config={defaultModel:'gpt-test',options:['gpt-test'],availableModels:[{name:'gpt-test',label:'GPT Test'}]};
window.electron.getCodexModelConfig=async()=>config;
const store=useAppStore;
const chatId=store.getState().createDraftSession('/tmp/workstream-ui');
const prompt={type:'user_prompt',prompt:'Inspect the project and summarize the result',createdAt:1000};
const thought={type:'assistant',uuid:'thought',createdAt:1100,message:{content:[{type:'thinking',thinking:'Check the project configuration'}]}};
const read={type:'assistant',uuid:'read',createdAt:1200,message:{content:[{type:'tool_use',id:'read-tool',name:'Read',input:{file_path:'/tmp/project/package.json'}}]}};
const result={type:'user',uuid:'read-result',createdAt:1500,message:{content:[{type:'tool_result',tool_use_id:'read-tool',content:'{"name":"demo"}'}]}};
store.setState(s=>({sessions:{...s.sessions,[chatId]:{...s.sessions[chatId],isDraft:false,hydrated:true,provider:'codex',status:'running',model:'gpt-test',messages:[prompt,thought,read,result]}}}));
const emit=message=>store.getState().handleServerEvent({type:'stream.message',payload:{sessionId:chatId,message}});

useAppStore.getState().setTheme('light');
const tool = (id, status='success') => ({id,type:'tool',toolName:'mcp__docs__read',kind:'other',summary:'Read project documentation '+id,status,
  block:{type:'tool_use',id,name:'mcp__docs__read',input:{page:'overview'}},
  ...(status==='pending'?{liveOutput:'Loading documentation…'}:{result:{type:'tool_result',tool_use_id:id,content:'Documentation output for '+id}})});
const model = (entries, running=true, durationMs) => ({state:running?'running':'completed',title:'Working',summary:'Work',entries,previewEntries:entries,
  toolCount:entries.filter(e=>e.type==='tool').length,noteCount:entries.filter(e=>e.type==='thinking'||e.type==='note').length,
  hiddenEntryCount:0,startedAt:1000,durationMs,todoProgress:null});
function App(){
 const [n,setN]=useState(10),[running,setRunning]=useState(true),[turn,setTurn]=useState(1),[states,setStates]=useState(false),[chat,setChat]=useState(false);
 window.qa={chat:()=>setChat(true),store,chatId,
  stopThinking:()=>store.setState(s=>({sessions:{...s.sessions,[chatId]:{...s.sessions[chatId],messages:[prompt,thought],status:'completed'}}})),
  answer:()=>emit({type:'assistant',uuid:'answer',createdAt:2000,streaming:true,phase:'final_answer',message:{content:[{type:'text',text:'The project is ready.'}]}}),
  complete:()=>{emit({type:'assistant',uuid:'answer',createdAt:2000,streaming:false,phase:'final_answer',message:{content:[{type:'text',text:'The project is ready.'}]}});emit({type:'result',subtype:'success',duration_ms:44000,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}});store.setState(s=>({sessions:{...s.sessions,[chatId]:{...s.sessions[chatId],status:'completed'}}}));},
  states:()=>setStates(true),advance:()=>setN(n+1),finish:()=>setRunning(false),newTurn:()=>{setTurn(turn+1);setRunning(true)},
   reduced:()=>useAppPreferences.setState({reduceMotion:'on'}),
   dark:()=>useAppStore.getState().setTheme('dark')};
 const entries=Array.from({length:n},(_,i)=>tool('step-'+i,running&&i===n-1?'pending':'success'));
 if(chat) return <div id="real-chat" style={{height:'100vh',display:'flex'}}><ChatPane paneId="qa" sessionId={chatId} isActive onActivate={()=>{}} codexModelConfig={config} /></div>;
 if(states) return <main>
   <section id="stopped"><WorkstreamDisclosure model={model([tool('stopped','interrupted')],false)} isRunning={false}/></section>
   <section id="waiting"><WorkstreamDisclosure model={model([tool('done'),{id:'permission',type:'approval',summary:'Waiting for approval',detail:'Allow reading the selected directory',state:'waiting'}])} isRunning/></section>
   <section id="error"><WorkstreamDisclosure model={model([tool('ok'),tool('failed','error')],false)} isRunning={false} defaultExpanded/></section>
 </main>;
 return <main style={{maxWidth:780,padding:'24px 32px',margin:'auto',background:'var(--bg-primary)',color:'var(--text-primary)'}}>
  <section id="completed"><h3>Completed turn</h3><WorkstreamDisclosure model={model([tool('finished')],false,44000)} isRunning={false}/><p>The implementation is ready for review.</p></section>
  <section id="thinking"><h3>Reasoning</h3><WorkstreamDisclosure model={model([{id:'thought',type:'thinking',summary:'Compare the two implementations',detail:'Visible reasoning summary\\nInspect the event lifecycle before changing the renderer.',state:'active'}])} isRunning defaultExpanded/></section>
  <section id="mcp"><h3>Successful tool</h3><WorkstreamDisclosure model={model([tool('mcp')],false)} isRunning={false} defaultExpanded/></section>
  <section id="reset"><h3>Explicit disclosure choice</h3><WorkstreamDisclosure model={model(entries,running,running?undefined:44000)} isRunning={running} defaultExpanded={running} resetKey={'turn:'+turn}/></section>
  <section id="auto"><h3>Lifecycle default</h3><WorkstreamDisclosure model={model([tool('auto',running?'pending':'success')],running,44000)} isRunning={running} defaultExpanded={running} resetKey={'turn:'+turn}/></section>
 </main>;
}
createRoot(document.getElementById('root')).render(<Tooltip.Provider><App/></Tooltip.Provider>);
`;
const main = String.raw`
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',path.join(__dirname,'profile'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1000,height:980,show:true});
 const errors=[];w.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=async s=>{try{return await w.webContents.executeJavaScript(s,true)}catch(e){console.error('Failed expression:',s,errors);throw e}};
 const until=async(s,label)=>{for(let i=0;i<60;i++){if(await js(s))return;await delay(100)}throw Error('Timed out: '+label)};
 const click=async(s)=>{await js('document.querySelector('+JSON.stringify(s)+').click()');await delay(320)};
 const expanded=s=>js('document.querySelector('+JSON.stringify(s)+'+" .workstream-toggle-row button").getAttribute("aria-expanded")');
 const shot=async(name)=>{fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 try{
  await w.loadURL(process.env.QA_URL);await until('!!window.qa','renderer');await delay(500);
  assert.equal(await expanded('#completed'),'false');
  assert(await js('document.querySelector("#completed [data-workstream-divider]").getBoundingClientRect().top >= document.querySelector("#completed .workstream-toggle-row button").getBoundingClientRect().bottom'),'divider sits below Worked for');
  assert.equal(await js('document.querySelector("#completed .workstream-toggle-row button").textContent'),'Worked for 44s');
  assert.equal(await js('document.querySelector("#mcp .workstream-toggle-row button").textContent'),'1 previous message','unknown duration never uses Date.now');
  assert.equal(await js('document.querySelectorAll("#thinking .workstream-toggle-row").length'),0,'running trace has no whole-turn collapse');
  await click('#thinking [aria-expanded="false"]');
  assert((await js('document.querySelector("#thinking").innerText')).includes('Visible reasoning summary'));
  assert.equal(await js('!!document.querySelector("#mcp button[disabled]")'),false);
  await click('#mcp [data-workstream-stage] > button');
  assert((await js('document.querySelector("#mcp").innerText')).includes('Documentation output for mcp'));
  await click('#mcp [aria-label="Show raw tool call output"]');
  assert((await js('document.querySelector("[role=dialog]").innerText')).includes('overview'));
  await click('[aria-label="Close raw output"]');
  await click('#reset [data-workstream-group]');
  assert.equal(await js('document.querySelectorAll("#reset [data-workstream-stage]").length'),10,'all stages retained');
  assert.equal(await js('(()=>{const a=document.querySelector("#reset .workstream-scroll-area"),r=a.getBoundingClientRect(),last=a.lastElementChild.lastElementChild.getBoundingClientRect();return last.bottom<=r.bottom+1&&last.top>=r.top})()'),true,'latest pending stage visible');
  assert.equal(await js('document.querySelector("#reset .workstream-scroll-area").dataset.fadeTop'),'true');
  await js('document.querySelector("#reset .workstream-scroll-area").scrollTop=0');await delay(100);
  await js('qa.advance()');await delay(200);
  assert.equal(await js('document.querySelector("#reset .workstream-scroll-area").scrollTop'),0,'reader scrolling into history is respected');
  await click('#reset [data-workstream-group]');
  await js('qa.advance()');await delay(200);
  assert.equal(await js('document.querySelector("#reset [data-workstream-group]").getAttribute("aria-expanded")'),'false','new messages preserve group collapse');
  await click('#reset [data-workstream-group]');
  await click('#mcp .workstream-toggle-row button');
  await js('qa.advance()');await delay(200);assert.equal(await expanded('#mcp'),'false','new messages preserve turn collapse');
  await click('#mcp .workstream-toggle-row button');
  assert.equal(await js('document.querySelector("#mcp [data-workstream-stage] > button").getAttribute("aria-expanded")'),'true','tool choice survives hiding the whole trace');
  await js('qa.finish()');await delay(320);
  assert.equal(await expanded('#mcp'),'true','explicit expansion survives rerender');
  assert.equal(await expanded('#auto'),'false','untouched trace collapses on completion');
  await js('qa.newTurn()');await delay(320);
  assert.equal(await js('document.querySelectorAll("#auto .workstream-toggle-row").length'),0,'next running turn is open');
  await click('#reset [data-workstream-group]');
  await shot('light');
  const lightBg=await js('getComputedStyle(document.querySelector("main")).backgroundColor');
  await js('qa.dark()');await delay(150);await shot('dark');
  assert.notEqual(await js('getComputedStyle(document.querySelector("main")).backgroundColor'),lightBg,'dark theme actually changes the palette');
  w.setContentSize(390,850);await delay(200);await shot('narrow');
  assert.equal(await js('document.documentElement.scrollWidth>innerWidth'),false,'no horizontal overflow');
  await js('qa.reduced()');await delay(150);
  assert.equal(await js('document.querySelectorAll(".workstream-activity-shimmer").length'),0,'app reduced motion disables shimmer');
  // Native keyboard interaction uses the same disclosure button.
  app.focus({steal:true});w.show();w.focus();w.webContents.focus();
  await js('document.querySelector("#completed .workstream-toggle-row button").focus()');await delay(100);
  w.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});w.webContents.sendInputEvent({type:'char',keyCode:'\r'});w.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});await delay(150);
  assert.equal(await expanded('#completed'),'true');
  await js('qa.states()');await delay(320);
  assert.equal(await js('document.querySelectorAll("#stopped .workstream-toggle-row").length'),0,'stopped work is not presented as a completed collapsed turn');
  assert.equal(await js('document.querySelector("#waiting [data-workstream-group]").getAttribute("aria-expanded")'),'true','approval group opens by default');
  assert.equal(await js('document.querySelector("#error [data-workstream-group]").getAttribute("aria-expanded")'),'true','error group opens by default');
  assert((await js('document.querySelector("#error").innerText')).includes('Documentation output for failed'));
  w.setContentSize(1100,850);
  await js('qa.chat()');await until('!!document.querySelector("#real-chat")','actual ChatPane');await delay(500);
  assert.equal(await js('document.querySelectorAll("#real-chat .workstream-toggle-row").length'),0,'real running ChatPane keeps activity inline');
  await js('qa.answer()');await delay(320);
  assert.equal(await js('document.querySelector("#real-chat .workstream-toggle-row button").getAttribute("aria-expanded")'),'false','native final-answer signal collapses in the actual ChatPane');
  assert((await js('document.querySelector("#real-chat").innerText')).includes('The project is ready.'));
  await js('qa.complete()');await delay(350);
  assert.equal(await js('document.querySelector("#real-chat .workstream-toggle-row button").textContent'),'Worked for 44s');
  await click('#real-chat .workstream-toggle-row button');await shot('chat-expanded-dark');
  await js('qa.store.getState().setTheme("light")');await delay(150);await shot('chat-expanded-light');
  w.setContentSize(390,850);await delay(200);await shot('chat-narrow');
  assert.equal(await js('document.documentElement.scrollWidth>innerWidth'),false,'actual ChatPane has no narrow overflow');
  await js('qa.stopThinking()');await delay(350);
  assert.equal(await js('document.querySelectorAll("#real-chat .workstream-toggle-row").length'),0,'stopping during thinking keeps the real trace visible');
  assert((await js('document.querySelector("#real-chat").innerText')).includes('Reasoning'));
  assert.deepEqual(errors,[],'renderer console errors');
  console.log('workstream disclosure: lifecycle, reasoning, tool output, scrolling, keyboard and themes passed');app.exit(0);
 }catch(e){console.error(e);await shot('failure');app.exit(1)}
});
`;
try {
 await writeFile(path.join(dir,'index.html'),'<html><body style="margin:0;background:var(--bg-primary)"><div id="root"></div><script type="module" src="./probe.tsx"></script></body></html>');
 await writeFile(path.join(dir,'probe.tsx'),harness);
 await writeFile(path.join(dir,'main.cjs'),main);
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0,strictPort:false}});
 await server.listen();
 const env={...process.env,QA_URL:new URL(path.relative(root,dir)+'/index.html',server.resolvedUrls.local[0]).href,QA_CAPTURE:path.join(root,'output/playwright/workstream-disclosure')};
 delete env.ELECTRON_RUN_AS_NODE;
 await new Promise((resolve,reject)=>{
  const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(dir,'main.cjs')],{env,stdio:'inherit'});
  const timeout=setTimeout(()=>{child.kill();reject(Error('Electron test timed out'))},45000);
  child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);code===0?resolve():reject(Error('Electron test failed: '+code))});
 });
} finally { await server?.close();await rm(dir,{recursive:true,force:true}); }

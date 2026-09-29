import { createServer } from 'vite';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const dir = await mkdtemp(path.join(root, '.aegis-design-qa/compaction-'));
let server;
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ChatPane} from '/src/ui/components/ChatPane';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {useAppStore} from '/src/ui/store/useAppStore';
import {getLatestBubbleContextSnapshot} from '/src/ui/utils/context-usage';
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
const store=useAppStore,chatId=store.getState().createDraftSession('/tmp/compaction-qa');
let turn=0, messages=[],provider='codex';
const note=(id,text,at,phase='commentary')=>({type:'assistant',uuid:id,createdAt:at,agentId:'qa-agent',agentRunId:'run-'+turn,phase,message:{content:[{type:'text',text}]}});
const set=(status='running')=>store.setState(s=>({sessions:{...s.sessions,[chatId]:{...s.sessions[chatId],isDraft:false,hydrated:true,provider,status,model:'gpt-test',messages:[...messages],streaming:{isStreaming:false,text:'',thinking:''}}}}));
window.qa={
 nativeBubbleUsage:()=>{
  provider='bubble';messages=[];set();
  store.setState(s=>({sessions:{...s.sessions,[chatId]:{...s.sessions[chatId],streaming:{isStreaming:true,text:'Keep streaming',thinking:'Keep thinking'}}}}));
  const message={type:'system',subtype:'token_usage',provider:'bubble',uuid:'native-usage',session_id:chatId,model:'gpt-test',usage:{inputTokens:20,outputTokens:0,cachedInputTokens:0,reasoningOutputTokens:0,totalTokens:20,contextWindow:100}};
  store.getState().handleServerEvent({type:'stream.message',payload:{sessionId:chatId,message}});
  const session=store.getState().sessions[chatId];
  return {text:session.streaming.text,thinking:session.streaming.thinking,snapshot:getLatestBubbleContextSnapshot(session.messages,'gpt-test')};
 },
 trust:()=>{
  provider='bubble';messages=[];set();
  store.getState().handleServerEvent({type:'permission.request',payload:{sessionId:chatId,toolUseId:'trust',toolName:'ProjectTrust',input:{kind:'acp-permission',provider:'bubble',toolName:'ProjectTrust',question:'Trust the configuration in /projects/example?\\nPermission rule: Bash(npm test)\\nMCP server: docs\\nLSP server: typescript\\nApproval remembers this exact configuration; changes require trust again.',options:[{optionId:'approve',name:'Trust configuration',kind:'allow_once'},{optionId:'reject',name:'Keep disabled',kind:'reject_once'}]}}});
 },
 provider:(value)=>{provider=value},
 begin:(only=false,delay=0,manual=false)=>{
  turn++;const at=Date.now()-delay;
  messages=[{type:'user_prompt',prompt:manual?'/compact':'Align the environment panel behavior',createdAt:at-200},
   ...(!only?[note('before-'+turn,'Read the existing panel layout.',at-100)]:[]),
   {type:'system',subtype:'compact_status',uuid:'start-'+turn,compactionId:'compact-'+turn,session_id:chatId,createdAt:at,trigger:manual?'manual':'auto',status:'started'}];set();
 },
 finish:(only=false,manual=false)=>{
  const at=Date.now();messages.push({type:'system',subtype:'compact_boundary',uuid:'end-'+turn,compactionId:'compact-'+turn,session_id:chatId,createdAt:at,compactMetadata:{trigger:manual?'manual':'auto',preTokens:21699}});
  if(!only)messages.push(note('after-'+turn,'Updated the layout and verified the behavior.',at+1));set();
 },
 answer:()=>{messages.push(note('answer-'+turn,'The layout now follows the available conversation width.',Date.now()+2,'final_answer'));set()},
 complete:()=>{messages.push({type:'result',subtype:'success',duration_ms:460000,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}});set('completed')},
 stop:()=>set('idle'),
 reload:()=>{messages=JSON.parse(JSON.stringify(messages));set('completed')},
 dark:()=>store.getState().setTheme('dark'),
};
store.getState().setTheme('light');qa.begin();
createRoot(document.getElementById('root')).render(<Tooltip.Provider><div style={{height:'100vh',display:'flex'}}><ChatPane paneId="qa" sessionId={chatId} isActive onActivate={()=>{}} codexModelConfig={config}/></div></Tooltip.Provider>);
`;
const main = String.raw`
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',path.join(__dirname,'profile'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1040,height:760,show:true,webPreferences:{backgroundThrottling:false}});
 const errors=[];w.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=async s=>{try{return await w.webContents.executeJavaScript(s,true)}catch(e){console.error("Failed expression:",s,errors);throw e}};
 const until=async(s,label)=>{for(let i=0;i<70;i++){if(await js(s))return;await delay(100)}throw Error('Timed out: '+label+'; '+errors.join(' | '))};
 const shot=async name=>{fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 const click=async()=>{await js('document.querySelector(".workstream-toggle-row button").click()');await delay(400)};
 try{
  await w.loadURL(process.env.QA_URL);await until('!!document.querySelector("[data-compaction-activity]")','initial compaction');
  assert.equal(await js('document.querySelector("[data-compaction-activity]").textContent'),'Compacting contextCompacting context');
  await js('window.originalCompaction=document.querySelector("[data-compaction-activity]");qa.finish()');await delay(100);
  assert(await js('document.querySelector("[data-compaction-activity]")===window.originalCompaction'),'completion retains the same DOM row');
  assert.equal(await js('document.querySelectorAll("[data-compaction-activity]").length'),1);
  assert(await js('document.body.innerText.includes("Context automatically compacted")'));
  assert.equal(await js('document.body.innerText.includes("22K")'),false);
  const positions=await js('(()=>{const row=document.querySelector("[data-compaction-activity]");const text=[...document.querySelectorAll("p")];return [text.find(e=>e.textContent.includes("Read the existing")).getBoundingClientRect().top,row.getBoundingClientRect().top,text.find(e=>e.textContent.includes("Updated the layout")).getBoundingClientRect().top]})()');
  assert(positions[0]<positions[1]&&positions[1]<positions[2],'compact stays between before/after work');
  await shot('expanded');
  await js('qa.answer()');await until('document.querySelector(".workstream-toggle-row button")?.getAttribute("aria-expanded")==="false"','collapse when final answer begins');await delay(450);
  assert.equal(await js('document.querySelector("[data-compaction-activity]")===null'),true);
  await js('qa.complete()');await delay(150);await shot('collapsed');
  await click();assert(await js('!!document.querySelector("[data-compaction-activity]")'));
  await js('qa.reload()');await delay(150);assert(await js('!!document.querySelector("[data-compaction-activity]")'),'history keeps explicit expansion');
  await click();await js('qa.reload()');await delay(150);assert(await js('document.querySelector("[data-compaction-activity]")===null'),'history keeps collapse');
  await js('qa.begin(true,9800)');await until('document.querySelector("[data-compaction-activity]")?.textContent.includes("This can take a few minutes")','ten second delay notice');
  assert.equal(await js('document.querySelectorAll(".workstream-toggle-row").length'),0,'compact alone has no nested toggle');await shot('compacting');
  await js('qa.stop()');await until('document.querySelector("[data-compaction-activity]")?.getAttribute("data-compaction-activity")==="interrupted"','stopped');
  assert(await js('document.body.innerText.includes("Compaction interrupted")'));await shot('interrupted');
  await js('qa.begin(true,0,true);qa.finish(true,true);qa.complete()');await delay(200);
  assert.equal(await js('document.querySelector("[data-compaction-activity]").textContent'),'Context compacted');
  assert.equal(await js('document.querySelectorAll(".workstream-toggle-row").length'),0);await shot('manual');
  await js('qa.dark()');w.setSize(620,760);await delay(250);await shot('manual-dark-narrow');
  for(const provider of ['claude','kimi','grok','opencode','pi','bubble','qoder','deepseek']) {
   await js('qa.provider('+JSON.stringify(provider)+');qa.begin(true)');await delay(100);
   assert.equal(await js('document.querySelector("[data-compaction-activity]")?.getAttribute("data-compaction-activity")'),'inProgress',provider+' starts');
   await js('qa.finish(true);qa.complete()');await delay(100);
   assert.equal(await js('document.querySelector("[data-compaction-activity]")?.textContent'),'Context automatically compacted',provider+' finishes');
   await js('qa.begin(true);qa.stop()');await delay(100);
   assert.equal(await js('document.querySelector("[data-compaction-activity]")?.getAttribute("data-compaction-activity")'),'interrupted',provider+' stops');
   await js('qa.begin(true,0,true);qa.finish(true,true);qa.complete();qa.reload()');await delay(100);
   assert.equal(await js('document.querySelector("[data-compaction-activity]")?.textContent'),'Context compacted',provider+' manual history');
  }
  await shot('all-providers');
  const native=await js('qa.nativeBubbleUsage()');
  assert.equal(native.text,'Keep streaming');assert.equal(native.thinking,'Keep thinking');
  assert.equal(native.snapshot.percent,20);
  await js('qa.trust()');await until('!!document.querySelector("[data-bubble-project-trust]")','project trust details');
  const trust=await js('document.querySelector("[data-bubble-project-trust]").innerText');
  assert(trust.includes('Bash(npm test)')&&trust.includes('MCP server: docs')&&trust.includes('LSP server: typescript'));
  await shot('bubble-project-trust');
  assert.deepEqual(errors,[]);
  console.log('compaction Electron: stable row, sequence, final-answer collapse, history, delay, manual, stop and dark/narrow passed');app.exit(0);
 }catch(e){console.error(e);await shot('failure');app.exit(1)}
});
`;
try {
 await writeFile(path.join(dir,'index.html'),'<html><body style="margin:0"><div id="root"></div><script type="module" src="./probe.tsx"></script></body></html>');
 await writeFile(path.join(dir,'probe.tsx'),harness);
 await writeFile(path.join(dir,'main.cjs'),main);
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0}});
 await server.listen();
 const env={...process.env,QA_URL:new URL(path.relative(root,dir)+'/index.html',server.resolvedUrls.local[0]).href,QA_CAPTURE:path.join(root,'output/playwright/compaction')};
 delete env.ELECTRON_RUN_AS_NODE;
 await new Promise((resolve,reject)=>{
  const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(dir,'main.cjs')],{env,stdio:'inherit'});
  const timeout=setTimeout(()=>{child.kill();reject(Error('Compaction Electron test timed out'))},40000);
  child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);code===0?resolve():reject(Error('Compaction Electron test failed: '+code))});
 });
} finally { await server?.close();await rm(dir,{recursive:true,force:true}); }

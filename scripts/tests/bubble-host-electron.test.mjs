import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
const root=process.cwd();
await mkdir(path.join(root,'.aegis-design-qa'),{recursive:true});
const dir=await mkdtemp(path.join(root,'.aegis-design-qa/bubble-host-'));
const harness=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {PromptInput} from '/src/ui/components/PromptInput';
import {useAppStore} from '/src/ui/store/useAppStore';
import {getLatestBubbleContextSnapshot} from '/src/ui/utils/context-usage';
import '/src/ui/index.css';
localStorage.setItem('cowork.preferredProvider','bubble');
localStorage.setItem('cowork.preferredBubblePermissionMode','bypassPermissions');
window.electron={getProjectTree:async()=>null,cancelProjectTreeRead:async()=>{},getRecentCwds:async()=>[],getProjectGitSummary:async()=>({isGitRepository:false}),getAgentRuntimeDirectory:async()=>({checkedAt:Date.now(),entries:[]}),getSessionUserPrompts:async()=>[],getSessionGoal:async()=>({goal:null,supported:false,revision:0}),onSessionGoalChanged:()=>()=>{},getClaudeCompatibleProviderConfig:async()=>({}),getBubbleProvidersConfig:async()=>({providers:[]}),getProjectFolders:async()=>[],getModels:async()=>[],sendClientEvent:e=>qa.events.push(e)};
for(const p of ['Claude','Kimi','Grok','Opencode','Pi','Bubble','Qoder','Deepseek','Devin','Mimo','Codex'])window.electron['get'+p+'ModelConfig']=async()=>({defaultModel:null,options:[],availableModels:[]});
window.electron.getDevinThoughtLevels=async()=>({model:null,levels:[],defaultLevel:null});
window.electron.getBubbleModelConfig=async()=>({defaultModel:'openai:contract',options:['openai:contract'],availableModels:[{name:'openai:contract',label:'Contract',enabled:true}]});
const store=useAppStore,id=store.getState().createDraftSession('/tmp/bubble-host-qa');
store.setState(s=>({connected:true,activeSessionId:id,projectCwd:'/tmp/bubble-host-qa',preferences:{...s.preferences,showContextUsage:true},sessions:{...s.sessions,[id]:{...s.sessions[id],provider:'bubble',model:'openai:contract',bubblePermissionMode:'plan',status:'idle',hydrated:true}}}));
window.qa={store,id,events:[],warm:()=>store.setState(s=>({pendingStart:false,sessions:{...s.sessions,[id]:{...s.sessions[id],isDraft:false,bubblePermissionMode:'plan',status:'completed'}}})),compact:(unknownWindow=false)=>{
 const usage=(uuid,tokens,estimated=false)=>({type:'system',subtype:'token_usage',uuid,session_id:id,provider:'bubble',model:'openai:contract',usage:{inputTokens:tokens,outputTokens:0,cachedInputTokens:0,reasoningOutputTokens:0,totalTokens:tokens,contextWindow:unknownWindow&&uuid==='after'?0:1000,estimated}});
 const messages=[usage('before',900),{type:'system',subtype:'compact_boundary',uuid:'compact',session_id:id,compactMetadata:{trigger:'manual',preTokens:900}},usage('after',200,true),{type:'result',subtype:'success',duration_ms:0,total_cost_usd:0,model:'openai:contract',usage:{input_tokens:0,output_tokens:0}}];
 store.setState(s=>({pendingStart:false,sessions:{...s.sessions,[id]:{...s.sessions[id],status:'completed',messages}}}));
 return getLatestBubbleContextSnapshot(messages,'openai:contract');
}};
createRoot(document.getElementById('root')).render(<Tooltip.Provider><div style={{height:'100vh',display:'flex',flexDirection:'column',background:'var(--bg-primary)',color:'var(--text-primary)'}}><main style={{flex:1,padding:32}}>Bubble host integration</main><div className="aegis-chat-composer p-6"><PromptInput sessionId={id}/></div></div></Tooltip.Provider>);
`;
const main=String.raw`
const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
// CI runners have Reduce Motion on; tests expect the default motion preference.
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
app.setPath('userData',path.join(__dirname,'profile'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:800,height:640,show:true,webPreferences:{backgroundThrottling:false}});
 const errors=[];
 const js=async s=>{try{return await w.webContents.executeJavaScript(s,true)}catch(e){console.error('Failed expression:',s,errors);throw e}};
 w.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const until=async(s,label)=>{for(let i=0;i<100;i++){if(await js(s))return;await delay(50)}throw Error(label+': '+errors.join(' | '))};
 try{
  await w.loadURL(process.env.QA_URL);await until('!!document.querySelector("[role=textbox]")','composer');
  for(const kind of ['session.start','session.continue']){
   if(kind==='session.continue')await js('qa.warm()');
   await delay(150);
   await js('(()=>{const e=document.querySelector("[role=textbox]");e.focus();const d=new DataTransfer();d.setData("text/plain","Plan the fixture");e.dispatchEvent(new ClipboardEvent("paste",{clipboardData:d,bubbles:true,cancelable:true}))})()');
   await until('document.querySelector("[aria-label=Send]")?.disabled===false','send enabled');
   await js('document.querySelector("[aria-label=Send]").click()');
   await until('qa.events.some(e=>e.type==='+JSON.stringify(kind)+')','send '+kind);
   const event=await js('qa.events.find(e=>e.type==='+JSON.stringify(kind)+')');
   assert.equal(event.payload.provider,'bubble');
   assert.equal(event.payload.bubblePermissionMode,'plan');
   assert.equal(event.payload.bubblePlanExitMode,'bypassPermissions');
  }
  const snapshot=await js('qa.compact()');assert.equal(snapshot.percent,20);assert.equal(snapshot.estimated,true);
  const contextSelector=JSON.stringify('[aria-label="Bubble context and token usage"]');
  await until('!!document.querySelector('+contextSelector+')','context ring');
  w.focus();w.webContents.focus();
  const point=await js('(()=>{const r=document.querySelector('+contextSelector+').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
  w.webContents.sendInputEvent({type:'mouseMove',...point});
  await js('document.querySelector('+contextSelector+').focus()');
  await until('document.body.innerText.includes("Used (estimated)")','estimated snapshot label');
  assert(await js('document.body.innerText.includes("200")'),'post-compact tokens shown');
  fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});await delay(150);
  fs.writeFileSync(path.join(process.env.QA_CAPTURE,'bubble-host-fixed.png'),(await w.webContents.capturePage()).toPNG());
  const restored=await js('qa.compact(true)');assert.equal(restored.used,200);assert.equal(restored.percent,20);assert.equal(restored.estimated,true);
  assert.deepEqual(errors,[]);
  console.log('Bubble Electron: actual new/warm Plan payloads and post-compact context display passed');app.exit(0);
 }catch(e){console.error(e);console.error(await js('JSON.stringify({text:document.body.innerText,focus:document.activeElement?.outerHTML})'));app.exit(1)}
});
`;
let server;
try{
 await writeFile(path.join(dir,'index.html'),'<html><body style="margin:0"><div id="root"></div><script type="module" src="./probe.tsx"></script></body></html>');
 await writeFile(path.join(dir,'probe.tsx'),harness);await writeFile(path.join(dir,'main.cjs'),main);
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0,strictPort:false}});await server.listen();
 const env={...process.env,QA_URL:new URL(path.relative(root,dir)+'/index.html',server.resolvedUrls.local[0]).href,QA_CAPTURE:path.join(root,'output/playwright/compaction')};delete env.ELECTRON_RUN_AS_NODE;
 await new Promise((resolve,reject)=>{const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(dir,'main.cjs')],{env,stdio:'inherit'});const timer=setTimeout(()=>{child.kill();reject(Error('Bubble Electron timeout'))},40000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Bubble Electron failed: '+code))})});
}finally{await server?.close();await rm(dir,{recursive:true,force:true})}

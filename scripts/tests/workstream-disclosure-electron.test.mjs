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
import {WorkstreamActivityLabel} from '/src/ui/components/WorkstreamPrimitives';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {useAppPreferences} from '/src/ui/store/useAppPreferences';
import {useAppStore} from '/src/ui/store/useAppStore';
import {StreamRetryTracker} from '/src/electron/libs/stream-retry-tracker';
import '/src/ui/index.css';
window.electron = {
 sendClientEvent:()=>{},getProjectTree:async()=>null,getRecentCwds:async()=>[],getProjectGitSummary:async()=>({isGitRepository:false}),
 getAgentRuntimeDirectory:async()=>({checkedAt:Date.now(),entries:[]}),getSessionUserPrompts:async()=>[],
 getSessionGoal:async()=>({goal:null,supported:false,revision:0}),onSessionGoalChanged:()=>()=>{},
 getClaudeCompatibleProviderConfig:async()=>({}),getBubbleProvidersConfig:async()=>({providers:[]}),
 getProjectFolders:async()=>[],getModels:async()=>[],
 readProjectFilePreview:async()=>{const c=document.createElement('canvas');c.width=320;c.height=240;const x=c.getContext('2d');x.fillStyle='#c5d2bf';x.fillRect(0,0,320,240);return {kind:'image',dataUrl:c.toDataURL()}},
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

const retryTracker=new StreamRetryTracker();
let retryHistory=[];
const emitTracked=message=>{const tracked=retryTracker.observe(message,{agentId:'qa-profile',agentRunId:'qa-run'});for(const event of [tracked.resolved,tracked.message]){if(!event)continue;if(event.type!=='stream_event')retryHistory.push(JSON.parse(JSON.stringify(event)));emit(event)}};
useAppStore.getState().setTheme('light');
const tool = (id, status='success') => ({id,type:'tool',toolName:'mcp__docs__read',kind:'other',summary:'Read project documentation '+id,status,
  block:{type:'tool_use',id,name:'mcp__docs__read',input:{page:'overview '+id}},
  ...(status==='pending'?{liveOutput:'Loading documentation…'}:{result:{type:'tool_result',tool_use_id:id,content:'Documentation output for '+id}})});
const model = (entries, running=true, durationMs) => ({state:running?'running':'completed',title:'Working',summary:'Work',entries,previewEntries:entries,
  toolCount:entries.filter(e=>e.type==='tool').length,noteCount:entries.filter(e=>e.type==='thinking'||e.type==='note').length,
  hiddenEntryCount:0,startedAt:1000,durationMs,todoProgress:null});
function App(){
 const [n,setN]=useState(10),[running,setRunning]=useState(true),[turn,setTurn]=useState(1),[states,setStates]=useState(false),[chat,setChat]=useState(false),[label,setLabel]=useState('Reading first.ts'),[labelActive,setLabelActive]=useState(true),[shellDone,setShellDone]=useState(false);
 window.qa={emit,
  persistedRetryTurn:()=>{retryTracker.reset();retryHistory=[];store.setState(s=>({sessions:{...s.sessions,[chatId]:{...s.sessions[chatId],provider:'claude',status:'running',messages:[],streaming:{isStreaming:false,text:'',thinking:''}}}}));emitTracked({...prompt,createdAt:Date.now()});emitTracked({...thought,createdAt:Date.now(),agentId:'qa-profile',agentRunId:'qa-run'});emitTracked({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'Durable reasoning before retry'}}});emitTracked({type:'system',subtype:'api_retry',uuid:'durable-retry',session_id:chatId,attempt:1,maxRetries:10,delayMs:500,errorStatus:null})},
  reloadRetryHistory:(status='running')=>store.getState().handleServerEvent({type:'session.history',payload:{sessionId:chatId,status,messages:JSON.parse(JSON.stringify(retryHistory))}}),
  resumeTracked:()=>emitTracked({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'Recovered reasoning'}}}),
  completeTracked:()=>{emitTracked({type:'assistant',uuid:'durable-answer',agentId:'qa-profile',agentRunId:'qa-run',phase:'final_answer',message:{content:[{type:'text',text:'Task complete after retry'}]}});emitTracked({type:'result',subtype:'success',duration_ms:6000,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}})},
  retryTurn:(withTools=false)=>store.setState(s=>({sessions:{...s.sessions,[chatId]:{...s.sessions[chatId],provider:'claude',status:'running',messages:[{...prompt,createdAt:Date.now()},...(withTools?[thought,read,result]:[])],streaming:{isStreaming:true,thinking:'Original reasoning before connection loss',text:''}}}})),
  retry:(attempt=1)=>emit({type:'system',subtype:'api_retry',uuid:'retry-'+attempt,session_id:chatId,attempt,maxRetries:10,delayMs:500,errorStatus:null}),
  resume:()=>emit({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'New reasoning after recovery'}}}),
  label:(text,active=true)=>{setLabel(text);setLabelActive(active)},shellDone:()=>setShellDone(true),chat:()=>setChat(true),store,chatId,
  imageTurn:(provider,stage)=>{
   const imageTool={type:'assistant',uuid:'image-tool',createdAt:1200,message:{content:[{type:'tool_use',id:'image-edit',name:'image_edit',input:{prompt:'Make the cat white',__aegisGeneratedMedia:[{kind:'image',path:'/tmp/white-cat.png'}]}}]}};
   const imageResult={type:'user',uuid:'image-result',createdAt:1400,message:{content:[{type:'tool_result',tool_use_id:'image-edit',content:'/tmp/white-cat.png'}]}};
   const reply={type:'assistant',uuid:'image-reply',createdAt:1800,streaming:stage==='streaming',...(provider==='codex'?{phase:'final_answer'}:{}),message:{content:[{type:'text',text:'The cat is now white. The pose and background are unchanged.'}]}};
   const messages=[{...prompt,createdAt:provider==='grok'?1001:1002},{...thought,uuid:provider+'-image-thought'},imageTool,imageResult,...(stage==='generated'?[]:[reply]),...(stage==='completed'?[{type:'result',subtype:'success',duration_ms:19000,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}}]:[])];
   store.setState(s=>({sessions:{...s.sessions,[chatId]:{...s.sessions[chatId],provider,status:stage==='completed'?'completed':'running',messages}}}));
  },
  readingTurn:(resolved=false)=>store.setState(s=>({sessions:{...s.sessions,[chatId]:{...s.sessions[chatId],provider:'codex',status:'running',messages:[{...prompt,createdAt:1003},thought,read,...(resolved?[result]:[])]}}})),
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
   <section id="error"><WorkstreamDisclosure model={model([tool('ok'),tool('failed','error')])} isRunning/></section>
   <section id="shell"><WorkstreamDisclosure model={model([{...tool('shell',shellDone?'success':'pending'),toolName:'Bash',kind:'command_execution',summary:shellDone?'Ran npm test':'Running npm test',block:{type:'tool_use',id:'shell',name:'Bash',input:{command:'npm test'}},execution:{startedAt:Date.now()-5000,...(shellDone?{durationMs:5100,exitCode:0}:{})},liveOutput:'Running test suite…'}],!shellDone,shellDone?6000:undefined)} isRunning={!shellDone} resetKey="shell"/></section>
   <section id="denied"><WorkstreamDisclosure model={model([tool('before-denial'),{id:'deny',type:'approval',summary:'Action denied',detail:'Reading outside the selected folder was denied',state:'denied'}],false,7000)} isRunning={false}/></section>
 </main>;
 return <main style={{maxWidth:780,padding:'24px 32px',margin:'auto',background:'var(--bg-primary)',color:'var(--text-primary)'}}>
  <section id="cadence"><WorkstreamActivityLabel active={labelActive}>{label}</WorkstreamActivityLabel></section>
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
 const w=new BrowserWindow({width:1000,height:980,show:true,webPreferences:{backgroundThrottling:false}});
 const errors=[];w.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=async s=>{try{return await w.webContents.executeJavaScript(s,true)}catch(e){console.error('Failed expression:',s,errors);throw e}};
 const until=async(s,label)=>{for(let i=0;i<60;i++){if(await js(s))return;await delay(100)}throw Error('Timed out: '+label)};
 const click=async(s)=>{await js('document.querySelector('+JSON.stringify(s)+').click()');await delay(320)};
 const expanded=s=>js('document.querySelector('+JSON.stringify(s)+'+" .workstream-toggle-row button").getAttribute("aria-expanded")');
 const shot=async(name)=>{fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 try{
  await w.loadURL(process.env.QA_URL);await until('!!window.qa','renderer');await delay(500);
  await js('qa.label("Reading second.ts")');await delay(80);
  assert.equal(await js('document.querySelector("#cadence").textContent.includes("Reading first.ts")'),true,'rapid summaries retain the previous activity');
  await js('qa.label("Read 2 files",false)');await delay(60);
  assert.equal(await js('document.querySelector("#cadence").textContent'),'Read 2 files','completed summary bypasses the hold');
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
  assert.equal(await expanded('#reset'),'true','inspecting nested activities prevents automatic turn collapse');
  await js('qa.newTurn()');await delay(320);
  assert.equal(await js('document.querySelectorAll("#auto .workstream-toggle-row").length'),0,'next running turn is open');
  await click('#reset [data-workstream-group]');
  await shot('light');
  const lightBg=await js('getComputedStyle(document.querySelector("main")).backgroundColor');
  await js('qa.dark()');await delay(150);await shot('dark');
  assert.notEqual(await js('getComputedStyle(document.querySelector("main")).backgroundColor'),lightBg,'dark theme actually changes the palette');
  w.setContentSize(390,850);await delay(200);await shot('narrow');
  assert.equal(await js('document.documentElement.scrollWidth>innerWidth'),false,'no horizontal overflow');
  await js('(()=>{const b=document.querySelector("#completed .workstream-toggle-row button");b.click();setTimeout(()=>b.click(),40);setTimeout(()=>b.click(),80)})()');await delay(500);
  assert.equal(await expanded('#completed'),'true','rapid open-close-open settles expanded');
  assert.equal(await js('document.querySelector("#completed [data-workstream-collapse]").dataset.workstreamCollapse'),'expanded');
  await click('#completed .workstream-toggle-row button');
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
  assert.equal(await js('document.querySelector("#error [data-workstream-group]").getAttribute("aria-expanded")'),'false','error group stays collapsed while the agent is working');
  assert.equal(await js('document.querySelector("#error [data-workstream-group]").textContent'),'Thinking(1 failed)','collapsed group retains its activity and failure count');
  await click('#error [data-workstream-group]');
  assert.equal(await js('document.querySelector("#error [data-workstream-stage=\\"stage:error:failed\\"] > button").getAttribute("aria-expanded")'),'false','failed tool details stay collapsed');
  assert((await js('document.querySelector("#error [data-workstream-stage=\\"stage:error:failed\\"] > button").textContent')).endsWith('(1 failed)'));
  assert(!(await js('document.querySelector("#error").innerText')).includes('Documentation output for failed'));
  await shot('error-collapsed');
  await click('#error [data-workstream-stage="stage:error:failed"] > button');
  assert((await js('document.querySelector("#error").innerText')).includes('Documentation output for failed'));
  await click('#error [data-workstream-stage="stage:error:failed"] > button');
  assert(!(await js('document.querySelector("#error").innerText')).includes('Documentation output for failed'));
  assert.equal(await js('document.querySelector("#shell [data-workstream-stage] > button").getAttribute("aria-expanded")'),'false','running shell stays collapsed by default');
  assert(!(await js('document.querySelector("#shell").innerText')).includes('$ npm test'));
  await click('#shell [data-workstream-stage] > button');
  assert((await js('document.querySelector("#shell").innerText')).includes('$ npm test'),'running shell details can be opened manually');
  assert((await js('document.querySelector("#shell").innerText')).includes('Running test suite…'),'running command output streams through the stage');
  await click('#shell [data-workstream-stage] > button');
  assert(!(await js('document.querySelector("#shell").innerText')).includes('$ npm test'));
  await shot('shell-collapsed');
  await click('#shell [data-workstream-stage] > button');
  await js('qa.shellDone()');await delay(350);
  assert.equal(await expanded('#shell'),'true','reading command output prevents whole-turn collapse');
  assert.equal(await js('document.querySelector("#shell [data-workstream-stage] > button").getAttribute("aria-expanded")'),'true','command completion preserves the open detail');
  assert((await js('document.querySelector("#shell").innerText')).includes('Exit code 0'));
  assert((await js('document.querySelector("#shell [data-workstream-elapsed]").textContent')).includes('5s'));
  await click('#denied [data-denied-action-count]');await delay(350);
  assert.equal(await expanded('#denied'),'true');
  assert((await js('document.querySelector("#denied").innerText')).includes('Reading outside the selected folder was denied'));
  await until('document.activeElement.hasAttribute("data-denied-action")','denial shortcut focus');
  assert.equal(await js('document.activeElement.hasAttribute("data-denied-action")'),true,'denial shortcut focuses the recorded denial');
  await shot('completion-and-denial');
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
  await js('qa.store.getState().handleServerEvent({type:"session.status",payload:{sessionId:qa.chatId,status:"error"}});qa.store.getState().handleServerEvent({type:"runner.error",payload:{sessionId:qa.chatId,message:"Agent connection closed"}})');await delay(150);
  assert((await js('document.querySelector("[data-turn-failure]").textContent')).includes('Agent connection closed'));
  await shot('chat-interrupted');
  await js('qa.store.getState().handleServerEvent({type:"session.status",payload:{sessionId:qa.chatId,status:"running"}})');await delay(150);
  assert.equal(await js('document.querySelector("[data-turn-failure]")===null'),true,'new turn clears the failure notice');
  assert.equal(await js('qa.store.getState().sessions[qa.chatId].lastTurnError'),undefined);
  w.setContentSize(1000,850);
  await js('qa.readingTurn()');await delay(200);
  await click('#real-chat [data-workstream-stage] > button');
  assert.equal(await js('document.querySelector("#real-chat [data-workstream-stage] > button").getAttribute("aria-expanded")'),'true');
  await js('qa.readingTurn(true)');await delay(200);
  assert.equal(await js('document.querySelector("#real-chat [data-workstream-stage] > button").getAttribute("aria-expanded")'),'true','real tool result retains open details');
  await js('qa.answer()');await delay(350);
  assert.equal(await js('document.querySelector("#real-chat .workstream-toggle-row button").getAttribute("aria-expanded")'),'true','real final-answer regrouping retains inspected trace');
  await js('qa.complete()');await delay(350);
  await click('#real-chat .workstream-toggle-row button');
  assert.equal(await js('document.querySelector("#real-chat .workstream-toggle-row button").getAttribute("aria-expanded")'),'false','explicit turn collapse still wins over inspection protection');
  for(const provider of ['grok','codex']){
   await js('qa.imageTurn('+JSON.stringify(provider)+',"generated")');
   await until('document.querySelectorAll("#real-chat img[alt=\\"white-cat.png\\"]").length===1','image appears before reply');
   for(const stage of ['streaming','completed']){
    await js('qa.imageTurn('+JSON.stringify(provider)+','+JSON.stringify(stage)+')');await delay(350);
    await until('document.querySelectorAll("#real-chat img[alt=\\"white-cat.png\\"]").length===1','one image throughout completion');
    assert(await js('(()=>{const image=document.querySelector("#real-chat img[alt=\\"white-cat.png\\"]"),reply=[...document.querySelectorAll("#real-chat p")].find(p=>p.textContent.startsWith("The cat is now white."));return !!reply&&image.getBoundingClientRect().bottom<=reply.getBoundingClientRect().top})()'),provider+' '+stage+': image stays above reply');
    await shot('image-order-'+provider+'-'+stage);
   }
   assert.equal(await js('document.querySelector("#real-chat .workstream-toggle-row button").getAttribute("aria-expanded")'),'false','completed image turn collapses');
   await click('#real-chat .workstream-toggle-row button');
   assert.equal(await js('document.querySelectorAll("#real-chat img[alt=\\"white-cat.png\\"]").length'),1,'opening trace does not duplicate image');
  }
  assert.deepEqual(errors,[],'renderer console errors');
  // Real ChatPane + real store: trace visibility must never suppress retry status.
  for(const withTools of [false,true]){
   await js('qa.retryTurn('+withTools+')');await delay(200);
   await js('(()=>{const b=[...document.querySelectorAll("#real-chat button[aria-expanded]")].find(b=>b.textContent==="Thinking");if(b?.getAttribute("aria-expanded")==="false")b.click()})()');await delay(320);
   await js('window.frozenReasoning=[...document.querySelectorAll("#real-chat .workstream-text")].find(e=>e.textContent==="Original reasoning before connection loss")');
   assert(await js('!!window.frozenReasoning'),'reasoning is expanded');
   await js('qa.retry(1)');await delay(150);
   assert((await js('document.querySelector("[data-stream-retry]").textContent')).includes('Reconnecting 1/10'));
   assert(await js('window.frozenReasoning.isConnected'),'retry preserves the existing reasoning DOM');
   await js('window.retryRow=document.querySelector("[data-stream-retry]");qa.retry(2)');await delay(150);
   assert(await js('window.retryRow===document.querySelector("[data-stream-retry]")'),'retries update the same status row');
   assert(await js('window.frozenReasoning.isConnected'),'repeated retries do not remount reasoning');
   assert.equal(await js('document.querySelectorAll("[data-stream-retry]").length'),1);
   assert.equal(await js('[...document.querySelectorAll("#real-chat .workstream-text")].some(e=>e.textContent.trim()==="Working")'),false,'retry replaces the generic working footer');
   assert((await js('window.retryRow.textContent')).includes('2/10'));
   w.webContents.invalidate();await delay(150);
   await shot(withTools?'retry-with-tools':'retry-thinking');
   await js('qa.resume()');await until('!qa.store.getState().sessions[qa.chatId].streaming.retry','retry cleared in store');await delay(220);
   assert.equal(await js('document.querySelector("[data-stream-retry]")===null'),true,'real output clears retry immediately: '+errors.join(' | '));
   assert.equal(await js('qa.store.getState().sessions[qa.chatId].streaming.thinking'),'New reasoning after recovery');
   assert.equal(await js('qa.store.getState().sessions[qa.chatId].messages.filter(m=>m.interrupted).length'),1);
   assert((await js('document.querySelector("#real-chat").innerText')).includes('Reasoning · interrupted'));
   await js('qa.retry(3);qa.store.getState().handleServerEvent({type:"session.status",payload:{sessionId:qa.chatId,status:"error"}})');await delay(200);
   assert.equal(await js('document.querySelector("[data-stream-retry]")'),null,'terminal failure removes retry');
   assert(await js('!!document.querySelector("[data-turn-failure]")'),'terminal failure is visible');
  }
  await js('qa.persistedRetryTurn();qa.reloadRetryHistory()');await delay(250);
  assert((await js('document.querySelector("[data-stream-retry]").textContent')).includes('Reconnecting 1/10'),'history restores the retry indicator');
  await js('qa.resumeTracked();qa.reloadRetryHistory()');await delay(250);
  assert(await js('document.querySelector("[data-stream-retry]")===null'),'history after first recovery delta has no stale retry');
  assert.equal(await js('qa.store.getState().sessions[qa.chatId].messages.filter(m=>m.interrupted).length'),1);
  await js('qa.completeTracked();qa.reloadRetryHistory("completed")');await delay(300);
  assert.equal(await js('document.querySelectorAll("#real-chat .workstream-toggle-row").length'),1,'profile retry stays in one completed work group');
  await click('#real-chat .workstream-toggle-row button');
  await js('(()=>{const b=[...document.querySelectorAll("#real-chat button[aria-expanded]")].find(b=>b.textContent.includes("Reasoning · interrupted"));if(b?.getAttribute("aria-expanded")==="false")b.click()})()');await delay(200);
  assert((await js('document.querySelector("#real-chat").innerText')).includes('Durable reasoning before retry'),'archived thinking remains readable after history reload');
  w.webContents.invalidate();await delay(100);await shot('retry-restored-history');
  assert.deepEqual(errors,[],'renderer errors after retry tests');
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

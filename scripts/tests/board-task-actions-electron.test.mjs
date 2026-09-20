import { createServer } from 'vite';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const dir = await mkdtemp(path.join(root, '.aegis-design-qa/board-actions-'));
let server;
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {Toaster} from 'sonner';
import {BoardView} from '/src/ui/components/BoardView';
import {useBoardStore} from '/src/ui/store/useBoardStore';
import {useAppStore} from '/src/ui/store/useAppStore';
import {useComposerQueueStore} from '/src/ui/store/useComposerQueueStore';
import {startQueueAutoFlush} from '/src/ui/lib/queue-auto-flush';
import {savePreferredQoderPermissionMode} from '/src/ui/utils/qoder-permission';
import {savePreferredKimiPermissionMode} from '/src/ui/utils/kimi-permission';
import '/src/ui/index.css';
const sent=[],events=[];
window.electron={
 getRecentCwds:async()=>['/tmp/project','/tmp/source-project'],
 listPullRequests:async()=>({prs:[],repositories:[],errors:[]}),
 getGitRepoBrief:async()=>({ok:false}),getGitOverview:async()=>({ok:true,hasRepo:false}),
 getProjectTree:async()=>null,getProjectGitSummary:async()=>({isGitRepository:false}),getSessionUserPrompts:async()=>[],
 getUserProfile:async()=>({displayName:'Test',handle:'test'}),sendClientEvent:event=>events.push(event),
 getAgentRuntimeDirectory:async()=>({checkedAt:Date.now(),entries:[]}),
 getClaudeCompatibleProviderConfig:async()=>({}),getBubbleProvidersConfig:async()=>({providers:[]}),
 chooseAttachments:async()=>({attachments:[{id:'file',kind:'file',name:'notes.txt',path:'/attachments/notes.txt',mimeType:'text/plain',size:10}],errors:[]}),
 getClipboardFilePaths:()=>[],getPathForFile:()=>'',
 startBackgroundSession:async payload=>{sent.push(payload);return {ok:true,sessionId:crypto.randomUUID()}},
};
for(const p of ['Claude','Codex','Kimi','Grok','Opencode','Pi','Bubble','Qoder','Deepseek'])window.electron['get'+p+'ModelConfig']=async()=>({defaultModel:null,options:[],availableModels:[]});
window.electron.getClaudeModelConfig=async()=>({defaultModel:'claude-sonnet-4-6',options:['claude-sonnet-4-6']});
const source='af98b1a1-65ef-4ca9-8a3d-a6562939f0cc';
const idle='10000000-0000-4000-8000-000000000001';
const busy='10000000-0000-4000-8000-000000000002';
const draft=useAppStore.getState().createDraftSession('/tmp/project');
const base={...useAppStore.getState().sessions[draft],isDraft:false,hydrated:true,provider:'claude',model:'claude-sonnet-4-6',status:'completed',messages:[],projectCwd:'/tmp/project',cwd:'/tmp/project'};
const sessions={
 [source]:{...base,id:source,title:'Source work',projectCwd:'/tmp/source-project',cwd:'/tmp/source-worktree',envMode:'worktree',worktreePath:'/tmp/source-worktree'},
 [idle]:{...base,id:idle,title:'Existing task',provider:'qoder',model:'glm-5-flash'},
 [busy]:{...base,id:busy,title:'Running task',provider:'kimi',status:'running'},
};
useAppStore.setState({projectCwd:'/tmp/project',sessions});
useAppStore.getState().setTheme('light');
savePreferredQoderPermissionMode('bypassPermissions');
savePreferredKimiPermissionMode('yolo');
startQueueAutoFlush();
if(!Object.keys(useBoardStore.getState().tasks).length){
 for(const session of Object.values(sessions))useBoardStore.getState().addTask({title:session.title,description:'Keep original notes',projectCwd:session.projectCwd,sessionId:session.id,stage:session.id===busy?'working':'done'});
 useBoardStore.getState().addTask({title:'Unstarted task',projectCwd:'/tmp/project'});
}
window.qa={board:useBoardStore,store:useAppStore,queue:useComposerQueueStore,sent,events,source,idle,busy,
 taskFor:id=>Object.values(useBoardStore.getState().tasks).find(t=>t.sessionIds.includes(id)),
 status:(id,status)=>useAppStore.setState(s=>({sessions:{...s.sessions,[id]:{...s.sessions[id],status}}})),
};
createRoot(document.getElementById('root')).render(<Tooltip.Provider><div style={{height:'100vh',display:'flex',background:'var(--bg-primary)'}}><BoardView/></div><Toaster/></Tooltip.Provider>);
`;
const main = String.raw`
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1200,height:850,show:true});const errors=[];
 w.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=s=>w.webContents.executeJavaScript(s,true);
 const delay=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async(s,label)=>{for(let i=0;i<100;i++){if(await js(s))return;await delay(80)}throw Error('Timed out: '+label)};
 const click=async selector=>{await js('document.querySelector('+JSON.stringify(selector)+').click()');await delay(100)};
 const button=async text=>{await js('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==='+JSON.stringify(text)+').click()');await delay(100)};
 const input=async(label,text)=>{await js('(()=>{const e=document.querySelector('+JSON.stringify('[aria-label="'+label+'"]')+');Object.getOwnPropertyDescriptor(e.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,"value").set.call(e,'+JSON.stringify(text)+');e.dispatchEvent(new Event("input",{bubbles:true}))})()');await delay(100)};
 const available='[...document.querySelectorAll('+JSON.stringify('[aria-label="Available tasks"] button')+')]';
 const choose=async title=>{await input('Search tasks',title);await js(available+'.find(b=>b.firstElementChild.textContent==='+JSON.stringify(title)+').click()');await delay(100)};
 const open=async()=>{await js('qa.board.getState().setSelectedTask(null)');await delay(100);await click('[aria-label="New task in Todo"]')};
 const screenshot=async name=>{fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});for(let attempt=0;attempt<3;attempt++){await delay(200);try{const image=await w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),image.toPNG());return}catch(error){if(attempt===2)throw error}}};
 const count='Object.keys(qa.board.getState().tasks).length';
 try {
  await w.loadURL(process.env.QA_URL);await until('!!window.qa','board');
  const initialCount=await js(count);
  await open();await button('Based on a task');await choose('Source work');
  await input('Task title','Follow-up feature');await input('Task description','Private board notes');
  await screenshot('reference-light');await js('qa.store.getState().setTheme("dark")');await screenshot('reference-dark');
  await button('Save to Todo');
  assert.equal(await js('qa.sent.length'),0,'saving a reference does not start a session');
  assert.equal(await js(count),initialCount+1);
  assert.equal(await js('Object.values(qa.board.getState().tasks).find(t=>t.title==="Follow-up feature").sourceSessionId'),await js('qa.source'));
  await w.reload();await until('!!window.qa','reloaded');
  assert.equal(await js('Object.values(qa.board.getState().tasks).find(t=>t.title==="Follow-up feature").sourceSessionId'),await js('qa.source'),'source survives reload');
  await js('qa.board.getState().setSelectedTask(Object.values(qa.board.getState().tasks).find(t=>t.title==="Follow-up feature").id)');await delay(120);
  await button('Start Task');
  assert.equal(await js('qa.sent.length'),1);
  assert.equal(await js('qa.board.getState().selectedTaskId'),null,'starting a saved task returns to the board');
  assert.equal(await js('document.querySelectorAll("button[draggable=true]").length'),initialCount+1,'cards are visible after starting a saved task');
  assert.equal(await js('qa.sent[0].cwd'),'/tmp/project','reference does not inherit source worktree');
  assert.equal(await js('qa.sent[0].worktreePath'),undefined);
  assert.equal(await js('qa.sent[0].title'),'Follow-up feature');
  assert.ok((await js('qa.sent[0].prompt')).includes('aegis://sessions/af98b1a1'));
  assert.equal(await js('qa.sent[0].prompt.includes("Private board notes")'),false);
  assert.equal(await js('qa.taskFor(qa.source).stage'),'done','source card keeps its status');
  assert.deepEqual(await js('qa.taskFor(qa.source).sessionIds'),[await js('qa.source')]);

  await open();await button('Based on a task');await choose('Source work');await input('Task title','Immediate follow-up');
  await button('Start now');assert.equal(await js('qa.sent.length'),2,'reference Start now uses the same start path');
  assert.equal(await js('qa.board.getState().selectedTaskId'),null,'starting a reference task stays on the board');
  assert.equal(await js('qa.sent[1].cwd'),'/tmp/project');
  assert.ok((await js('qa.sent[1].prompt')).includes('aegis://sessions/af98b1a1'));

  await open();await button('Continue a task');
  assert.equal(await js(available+'.some(b=>b.textContent.includes("Source work"))'),false,'continue filters by project');
  await choose('Existing task');await input('Task instructions','Please adjust the result');await click('[aria-label="Attach files"]');
  assert.equal(await js('!!document.querySelector('+JSON.stringify('[aria-label="Task description"]')+')'),false,'continue has no board notes input');
  await screenshot('continue-light');
  const beforeContinue=await js(count);
  await js('(()=>{const button=[...document.querySelectorAll("[role=dialog] button")].find(b=>b.textContent==="Reopen and continue");button.click();button.click()})()');await delay(150);
  assert.equal(await js(count),beforeContinue,'continue does not create a card');
  assert.equal(await js('qa.sent.length'),2,'continue does not start a new session');
  const continuation=await js('qa.events.filter(e=>e.type==="session.continue")');
  assert.equal(continuation.length,1);assert.equal(continuation[0].payload.sessionId,await js('qa.idle'));
  assert.equal(continuation[0].payload.prompt,'Please adjust the result');
  assert.equal(continuation[0].payload.qoderPermissionMode,'bypassPermissions','Kanban continuation keeps the Full Access setting used by the chat composer');
  assert.equal(continuation[0].payload.attachments[0].name,'notes.txt');
  assert.equal(await js('qa.taskFor(qa.idle).title'),'Existing task');
  assert.equal(await js('qa.taskFor(qa.idle).description'),'Keep original notes');
  assert.equal(await js('qa.board.getState().selectedTaskId'),null,'continuing through the task window stays on the board');
  assert.equal(await js('document.querySelectorAll("button[draggable=true]").length'),beforeContinue,'continuation keeps Kanban cards visible');
  assert.equal(await js('qa.taskFor(qa.idle).stage'),'working');

  await open();await button('Continue a task');await choose('Running task');await screenshot('running');await button('Open task');
  assert.equal(await js('qa.events.filter(e=>e.type==="session.continue").length'),1,'running target is opened without sending or queueing');
  assert.equal(await js('qa.board.getState().selectedTaskId'),await js('qa.taskFor(qa.busy).id'));

  await open();await button('Continue a task');await choose('Existing task');await input('Task instructions','Race check');
  await js('qa.status(qa.idle,"running")');await until('[...document.querySelectorAll("[role=dialog] button")].some(b=>b.textContent==="Open task")','live status');
  await button('Open task');assert.equal(await js('qa.events.filter(e=>e.type==="session.continue").length'),1);

  await open();await button('Continue a task');await choose('Unstarted task');await button('Open task');
  assert.equal(await js('qa.sent.length'),2,'unstarted task is opened instead of creating another one');

  await open();await button('Based on a task');await choose('Source work');await input('Task title','Deleted source');
  await js('qa.store.setState(s=>{const sessions={...s.sessions};delete sessions[qa.source];return {sessions}})');await delay(100);
  assert.equal(await js('[...document.querySelectorAll("[role=dialog] button")].find(b=>b.textContent.trim()==="Start now").disabled'),true,'unavailable source cannot start');
  await button('New task');await button('Start now');
  assert.equal(await js('qa.board.getState().selectedTaskId'),null,'starting a new task stays on the board');
  assert.equal(await js('qa.sent[2].prompt'),'Deleted source','switching to new clears the reference');

  await open();await button('Continue a task');await choose('Running task');await button('Open task');
  await js('qa.queue.getState().enqueue(qa.busy,{id:"steer",displayPrompt:"Steer with Full Access",effectivePrompt:"Steer with Full Access",attachments:[],references:{}})');await delay(100);
  await button('Steer');
  assert.equal(await js('qa.events.filter(e=>e.type==="session.continue").at(-1).payload.kimiPermissionMode'),'yolo','Board Steer keeps Full Access');
  await js('qa.board.getState().setSelectedTask(null);qa.queue.getState().enqueue(qa.busy,{id:"flush",displayPrompt:"Queued Full Access",effectivePrompt:"Queued Full Access",attachments:[],references:{}});qa.status(qa.busy,"completed")');await delay(100);
  assert.equal(await js('qa.events.filter(e=>e.type==="session.continue").at(-1).payload.prompt'),'Queued Full Access');
  assert.equal(await js('qa.events.filter(e=>e.type==="session.continue").at(-1).payload.kimiPermissionMode'),'yolo','ownerless auto-flush keeps Full Access');
  assert.deepEqual(errors,[]);
  console.log('Board task actions Electron: reference save/reload/start, workspace, ownership, continuation, attachments, running/missing sessions, mode switching and Full Access through continue/Steer/auto-flush passed');
  app.exit(0);
 } catch(error) { console.error(error,errors);await screenshot('failure');app.exit(1); }
});
`;

try {
  await writeFile(path.join(dir, 'index.html'), '<html><body style="margin:0"><div id="root"></div><script type="module" src="./probe.tsx"></script></body></html>');
  await writeFile(path.join(dir, 'probe.tsx'), harness);
  await writeFile(path.join(dir, 'main.cjs'), main);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await server.listen();
  const env = { ...process.env, QA_URL: new URL(path.relative(root, dir) + '/index.html', server.resolvedUrls.local[0]).href, QA_CAPTURE: path.join(root, 'output/playwright/board-task-actions') };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(root, 'node_modules/.bin/electron'), [path.join(dir, 'main.cjs')], { env, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(Error('Board task actions test timed out')); }, 60000);
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('Board task actions test failed: ' + code)); });
  });
} finally {
  await server?.close();
  await rm(dir, { recursive: true, force: true });
}

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// In-chat workflow board: an assistant message whose start_workflow tool call
// renders the workflow it started (real MessageCard → AssistantWorkstream →
// WorkflowBoard) against stubbed workflow IPC. Walks planning → plan card
// (Start confirms with the current revision) → running lanes (a reviewer lane
// opens that member in the right panel; the chat's own fix lane does not) →
// stays visible while the finished turn's trace is collapsed →
// a question → the outcome with "Mark verified". QA_CAPTURE=<dir> saves screenshots.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const qaRoot = path.join(root, 'dev-fixtures');
await mkdir(qaRoot, { recursive: true });
const tmp = await mkdtemp(path.join(qaRoot, 'workflow-board-'));

const member = (key, role, agent, provider, extra = {}) => ({
  key, role, agent, provider, model: null, focus: null, source: 'user',
  permissionMode: null, permissionModeIsDefault: false,
  readOnlyMechanism: role === 'implementer' ? null : 'confinedSandbox',
  degraded: [], unverified: false, currentSessionId: null, ...extra,
});
const step = (key, stepId, kind, state, extra = {}) => ({
  key, stepId, kind, phase: null, label: stepId, memberKey: null, iteration: null, group: null,
  state, sessionId: null, version: null, summary: null, verdict: null, ...extra,
});
const run = {
  id: 'run-1', title: 'Have DeepSeek review your changes', goal: 'Have DeepSeek review your changes and fix what it finds.',
  cwd: '/tmp/board-project', location: 'current', status: 'planning', revision: 1, createdAt: Date.now(), updatedAt: Date.now(),
  description: null, members: [], acceptance: [], checks: [], unsupported: [], assumptions: [], warnings: [], confirmReasons: [],
  steps: [], needsInput: null, error: null, finalVersion: null, plannerSessionId: 's-plan', isolated: null,
  includesUserChanges: false, spec: null, parent: { sessionId: 'PARENT', toolUseId: 'toolu_wf', provider: 'claude' },
};
const plannedMembers = [
  member('current', 'implementer', 'current', 'claude', { currentSessionId: 'PARENT' }),
  member('reviewer', 'reviewer', 'deepseek', 'deepseek', { source: 'user', currentSessionId: 's-rev' }),
];

const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {Toaster} from 'sonner';
import {MessageCard} from '/src/ui/components/MessageCard';
import {ToolExecutionBatch} from '/src/ui/components/ToolExecutionBatch';
import {deriveTranscriptTimelineItems} from '/src/ui/utils/transcript-timeline';
import {useAppStore} from '/src/ui/store/useAppStore';
import '/src/ui/index.css';
window.qa={actions:[],store:useAppStore};
window.electron={getProjectTree:async()=>null,getRecentCwds:async()=>[],sendClientEvent:()=>{},getAgentRuntimeDirectory:async()=>({checkedAt:Date.now(),entries:[]}),getProjectGitSummary:async()=>({isGitRepository:false}),getSessionUserPrompts:async()=>[],
  workflows:{list:async()=>[],get:async()=>null,setDefaults:async()=>{},start:async()=>({ok:false,error:'unused'}),act:async a=>{qa.actions.push(a);return qa.onAct(a)}}};
const a=useAppStore.getState();const id=a.createDraftSession('/tmp/board-project');
const toolUse={type:'tool_use',id:'toolu_wf',name:'mcp__aegis-sessions__start_workflow',input:{request:'Have DeepSeek review your changes and fix what it finds.'}};
const toolResult={type:'tool_result',tool_use_id:'toolu_wf',content:JSON.stringify({workflowId:'run-1',status:'planning'})};
const messages=[{type:'user_prompt',uuid:'u1',prompt:'让 DeepSeek review 一下你的改动',createdAt:Date.now()},{type:'assistant',uuid:'a1',message:{content:[{type:'text',text:'Starting a workflow.'},toolUse]}},{type:'user',uuid:'r1',message:{content:[toolResult]}}];
useAppStore.setState(s=>({projectCwd:'/tmp/board-project',sessions:{...s.sessions,[id]:{...s.sessions[id],provider:'claude',isDraft:false,status:'completed',hydrated:true,messages}}}));
a.setActiveSession(id);
function Conversation(){const session=useAppStore(s=>s.sessions[s.activeSessionId]);const results=new Map([['toolu_wf',toolResult]]);const status=new Map([['toolu_wf','success']]);
 return <div style={{flex:1,minHeight:0,overflow:'auto',padding:40}}>{deriveTranscriptTimelineItems(session?.messages||[]).map((item,i)=>item.type==='message'?<MessageCard key={i} sessionId={session.id} message={item.message} assistantPresentation={item.assistantPresentation} completedGoals={item.completedGoals} toolStatusMap={status} toolResultsMap={results}/>:<ToolExecutionBatch key={i} messages={item.group.messages} toolStatusMap={status} toolResultsMap={results} isSessionRunning={false} isLastBatch={item.active} durationMs={item.group.durationMs} subagentMessagesByParent={new Map()} defaultExpanded={false} canCollapse={item.canCollapse} isStopped={false} resetKey="t"/>)}</div>}
createRoot(document.getElementById('root')).render(<Tooltip.Provider><div style={{height:'100vh',display:'flex',background:'var(--bg-primary)',color:'var(--text-primary)'}}><Conversation/><Toaster/></div></Tooltip.Provider>);
`;

const main = String.raw`
const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const RUN=${JSON.stringify(run)};const MEMBERS=${JSON.stringify(plannedMembers)};
const STEP=${step.toString()};
app.whenReady().then(async()=>{const win=new BrowserWindow({width:1000,height:760,show:false});const errors=[];
win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
const js=code=>win.webContents.executeJavaScript(code,true);
const push=view=>js('qa.store.getState().handleServerEvent({type:"workflow.updated",payload:'+JSON.stringify(view)+'});0').then(()=>delay(200));
const text=()=>js('document.body.textContent');
const waitFor=async(cond,label)=>{for(let i=0;i<100;i++){if(await js(cond))return;await delay(100)}throw Error('Timed out waiting for '+label+'\n'+await text())};
const clickButton=label=>js('(()=>{const b=[...document.querySelectorAll("[data-workflow-board] button")].find(e=>e.textContent.trim().startsWith('+JSON.stringify(label)+'));if(!b)throw Error("no button "+'+JSON.stringify(label)+');b.click()})()').then(()=>delay(200));
const capture=async name=>{if(!process.env.QA_CAPTURE)return;fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG())};
try{
 await win.loadURL(process.env.QA_URL);
 await waitFor('document.body.textContent.includes("Starting workflow")','pending board');
 let view={...RUN};await push(view);
 await waitFor('!!document.querySelector("[data-workflow-board]")','board');
 let body=await text();
 assert.match(body,/Planning the workflow/);assert.doesNotMatch(body,/start_workflow/);
 await capture('1-planning');

 // Plan card: confirm with the revision shown.
 view={...view,status:'awaiting_confirmation',revision:2,description:'DeepSeek reviews this chat\'s changes; this chat fixes; one re-review',members:MEMBERS,
  checks:[{stepId:'tests',argv:['npm','test'],authorization:'confirm',basis:null,highlight:false,reasons:[]}],assumptions:['npm test is the test command'],
  acceptance:[{id:'a1',description:'DeepSeek approves',kind:'review',source:'user',status:'pending'}],
  steps:[STEP('build.rounds','build.review.reviewer','agent','pending',{memberKey:'reviewer',phase:'review'})]};
 await js('qa.onAct=a=>({ok:true,run:'+JSON.stringify({...view,status:'running',revision:3})+'});0');
 await push(view);
 await waitFor('document.body.textContent.includes("Start this workflow?")','plan');
 body=await text();
 assert.match(body,/DeepSeek/);assert.match(body,/reviewer, read-only/);assert.match(body,/npm test/);assert.match(body,/Assumes: npm test is the test command/);
 assert.doesNotMatch(body,/This chat.*writes code/,'the chat itself is not listed as a new member');
 await capture('2-plan');
 await clickButton('Start');
 assert.deepEqual(await js('qa.actions[0]'),{type:'confirm',runId:'run-1',expectedRevision:2});

 // Running: reviewer lane opens the member panel; the chat's own fix lane is not a link.
 view={...view,status:'running',revision:4,steps:[
  STEP('build.rounds[0]/build.review.reviewer','build.review.reviewer','agent','succeeded',{memberKey:'reviewer',phase:'review',iteration:[0],group:'build.rounds',sessionId:'s-rev',verdict:'changes_requested',summary:'One blocking finding'}),
  STEP('build.rounds[0]/build.fix','build.fix','agent','running',{memberKey:'current',phase:'fix',iteration:[0],group:'build.rounds',sessionId:'PARENT'}),
  STEP('build.rounds[1]/build.review.reviewer','build.review.reviewer','agent','pending',{memberKey:'reviewer',phase:'review',iteration:[1],group:'build.rounds'})]};
 await push(view);
 await waitFor('document.body.textContent.includes("This chat · fix")','lanes');
 body=await text();
 assert.match(body,/DeepSeek · review · round 1/);assert.match(body,/changes requested/);
 assert.match(body,/Assumes: npm test is the test command/,'assumptions stay visible once running');
 await capture('3-running');
 await js('[...document.querySelectorAll("[data-workflow-board] button")].find(e=>e.textContent.includes("DeepSeek · review · round 1")).click()');await delay(150);
 assert.equal(await js('qa.store.getState().activeRightUtilityTab'),'workflow-member:s-rev');
 assert.equal(await js('[...document.querySelectorAll("[data-workflow-board] button")].find(e=>e.textContent.includes("This chat · fix")).disabled'),true);

 // A question for the user.
 view={...view,status:'needs_input',revision:5,needsInput:{reason:'dispute-maintained',detail:null,instanceKey:null,stepId:'build.rounds',question:null,options:[{id:'extra-round',label:'Run one more round'},{id:'finish',label:'Finish here'}]}};
 await js('qa.onAct=a=>({ok:true,run:'+JSON.stringify({...view,status:'running',revision:6,needsInput:null})+'});0');
 await push(view);
 await waitFor('document.body.textContent.includes("A disputed finding was kept")','needs input');
 await capture('4-needs-input');
 await clickButton('Finish here');
 assert.deepEqual(await js('qa.actions[1]'),{type:'answer',runId:'run-1',expectedRevision:5,optionId:'finish'});

 // Outcome with a manual item.
 view={...view,status:'completed_with_gaps',revision:7,needsInput:null,acceptance:[{id:'a1',description:'DeepSeek approves',kind:'review',source:'user',status:'satisfied'},{id:'a2',description:'The login page still renders',kind:'manual',source:'user',status:'manual'}],
  steps:view.steps.map(s=>s.state==='pending'?s:{...s,state:'succeeded'})};
 await js('qa.onAct=a=>({ok:true,run:'+JSON.stringify({...view,status:'succeeded',revision:8})+'});0');
 await push(view);
 await waitFor('document.body.textContent.includes("Mark verified")','outcome');
 body=await text();
 assert.match(body,/done with open items/);assert.doesNotMatch(body,/waiting/,'unreached steps are hidden once finished');
 await capture('5-outcome');
 await clickButton('Mark verified');
 assert.deepEqual(await js('qa.actions[2]'),{type:'verify-manual',runId:'run-1',acceptanceId:'a2'});
 await waitFor('document.body.textContent.includes("done ·")||document.body.textContent.includes("· done")','succeeded');
 assert.deepEqual(errors.filter(e=>!/Failed to load resource|DevTools/.test(e)),[]);
 console.log(JSON.stringify({ok:true}));app.exit(0);
}catch(e){console.error(e);console.error(errors);await capture('failure');app.exit(1)}
});
`;

let server;
try {
  await writeFile(path.join(tmp, 'index.html'), '<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(tmp, 'harness.tsx'), harness);
  await writeFile(path.join(tmp, 'main.cjs'), main);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await server.listen();
  const url = new URL(path.relative(root, tmp) + '/index.html', server.resolvedUrls.local[0]).href;
  await new Promise((resolve, reject) => {
    const env = { ...process.env, QA_URL: url };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.env.QA_ELECTRON_EXECUTABLE || path.join(root, 'node_modules/.bin/electron'), [path.join(tmp, 'main.cjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; process.stdout.write(c); });
    child.stderr.on('data', (c) => { err += c; process.stderr.write(c); });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Timed out\n' + out + '\n' + err)); }, 120000);
    child.on('error', reject);
    child.on('exit', (code) => { clearTimeout(timeout); code === 0 && out.includes('"ok":true') ? resolve() : reject(new Error(out + '\n' + err)); });
  });
  console.log('Workflow board Electron regression passed');
} finally { await server?.close(); await rm(tmp, { recursive: true, force: true }); }

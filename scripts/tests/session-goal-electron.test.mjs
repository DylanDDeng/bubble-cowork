import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const tmp = await mkdtemp(path.join(root, '.aegis-design-qa/goal-'));
const harness = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {Toaster,toast} from 'sonner';
import {RightUtilityWorkspace} from '/src/ui/App';
import {PromptInput} from '/src/ui/components/PromptInput';
import {GoalEditorPanel} from '/src/ui/components/SessionGoal';
import {MessageCard} from '/src/ui/components/MessageCard';
import {deriveTranscriptTimelineItems} from '/src/ui/utils/transcript-timeline';
import {NewSessionView} from '/src/ui/components/NewSessionView';
import {ConfirmDialogHost} from '/src/ui/components/ui/confirm-dialog';
import {useAppStore} from '/src/ui/store/useAppStore';
import {useSessionGoalStore} from '/src/ui/hooks/useSessionGoal';
import '/src/ui/index.css';
localStorage.setItem('cowork.preferredProvider','codex');
const listeners=new Set();const snapshots={};let revision=0;
const addMessage=(id,message)=>useAppStore.getState().handleServerEvent({type:'stream.message',payload:{sessionId:id,message}});
const publish=(id,goal,extra={})=>{const s={sessionId:id,goal,supported:true,revision:++revision,...extra};snapshots[id]=s;if(goal?.status==='complete')addMessage(id,{type:'goal_completed',uuid:'goal:'+goal.createdAt+':'+goal.objective,goal,createdAt:goal.updatedAt*1000});listeners.forEach(f=>f(s));return s;};
const goal=(status='active')=>({threadId:'native',objective:'Finish the model picker and verify its keyboard interactions',status,tokenBudget:null,tokensUsed:12345,timeUsedSeconds:85,createdAt:Date.now()/1000-85,updatedAt:Date.now()/1000});
window.qa={dismissToasts:()=>toast.dismiss(),events:[],calls:[],fail:false,publish,goal,addMessage,store:useAppStore,goals:useSessionGoalStore};
window.electron={getProjectTree:async()=>null,getRecentCwds:async()=>['/tmp/goal-project'],sendClientEvent:e=>qa.events.push(e),getAgentRuntimeDirectory:async()=>({checkedAt:Date.now(),entries:[]}),getSessionGoal:async id=>snapshots[id]||{sessionId:id,goal:null,supported:true,revision:0},onSessionGoalChanged:f=>{listeners.add(f);return()=>listeners.delete(f);},changeSessionGoal:async(id,action,settings)=>{qa.calls.push({id,action,settings});if(qa.fail)throw new Error('Could not update native goal');const prior=snapshots[id]?.goal;return publish(id,action.type==='clear'?null:{...goal(),...prior,...action,updatedAt:Date.now()/1000});},getProjectGitSummary:async()=>({isGitRepository:false}),getSessionUserPrompts:async()=>[]};
for(const p of ['Claude','Kimi','Grok','Opencode','Pi','Bubble','Qoder','Deepseek'])window.electron['get'+p+'ModelConfig']=async()=>({defaultModel:null,options:[],availableModels:[]});
window.electron.getClaudeModelConfig=async()=>({defaultModel:'claude-sonnet-4-6',options:['claude-sonnet-4-6'],availableModels:[]});
window.electron.getClaudeCompatibleProviderConfig=async()=>({});
window.electron.getCodexModelConfig=async()=>({defaultModel:'gpt-test',defaultReasoningEffort:'high',options:['gpt-test'],availableModels:[{name:'gpt-test',label:'GPT Test',defaultReasoningEffort:'high',supportedReasoningLevels:[{effort:'low'},{effort:'high'}]}]});
const a=useAppStore.getState();const first=a.createDraftSession('/tmp/goal-project');const second=a.createDraftSession('/tmp/second');
useAppStore.setState(s=>({projectCwd:'/tmp/goal-project',pendingStart:false,sessions:{...s.sessions,[first]:{...s.sessions[first],provider:'codex',model:'gpt-test',codexExecutionMode:'plan',isDraft:false,status:'completed',messages:[]},[second]:{...s.sessions[second],provider:'codex',model:'gpt-test',isDraft:false,status:'completed',messages:[]}}}));
a.setActiveSession(first);qa.first=first;qa.second=second;
function Conversation(){const session=useAppStore(s=>s.sessions[s.activeSessionId]);return <div data-testid="conversation" style={{flex:1,minHeight:0,overflow:'auto',padding:40}}>{deriveTranscriptTimelineItems(session?.messages||[]).map((item,i)=>item.type==='message'?<div key={i} data-answer-id={item.message.type==='assistant'?item.message.uuid:undefined}><MessageCard sessionId={session.id} message={item.message} assistantPresentation={item.assistantPresentation} completedGoals={item.completedGoals} toolStatusMap={new Map()} toolResultsMap={new Map()}/></div>:null)}</div>}
function App(){const [page,setPage]=useState('chat');const id=useAppStore(s=>s.activeSessionId);const tabs=useAppStore(s=>s.rightUtilityTabs);const active=useAppStore(s=>s.activeRightUtilityTab);qa.setPage=setPage;return <Tooltip.Provider><div style={{height:'100vh',background:'var(--bg-primary)',color:'var(--text-primary)',display:'flex'}}><div style={{display:'flex',flexDirection:'column',flex:1,minWidth:0}}><header style={{padding:24,fontSize:14}}>Goal interaction preview</header>{page==='new'?<NewSessionView/>:<><Conversation/><div style={{width:'min(800px,100%)',margin:'0 auto 24px'}}><PromptInput sessionId={id}/></div></>}</div>{tabs.length>0&&<RightUtilityWorkspace hidden={false} instantReveal={true} activePanel="goal" tabs={tabs.map(id=>({id,kind:'goal',label:'Edit goal'}))} activeTab={active} browserAvailable={false} width={380} resizable={false} fullscreen={false} windowControlsInset={false} onWidthChange={()=>{}} onSelectTab={a.setActiveRightUtilityTab} onCloseTab={a.closeRightUtilityTab} onOpenTab={a.openRightUtilityTab} onTogglePanel={a.closeRightUtilityPanels} onToggleFullscreen={null}>{tabs.filter(tab=>tab.startsWith('goal:')).map(tab=><GoalEditorPanel key={tab} sessionId={tab.slice(5)} hidden={active!==tab}/>)}</RightUtilityWorkspace>}<ConfirmDialogHost/><Toaster/></div></Tooltip.Provider>}
createRoot(document.getElementById('root')).render(<App/>);
`;
const main = String.raw`
const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
if(process.env.QA_REDUCED==='1')app.commandLine.appendSwitch('force-prefers-reduced-motion');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{const win=new BrowserWindow({width:1050,height:760,show:false});const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error'){errors.push(e.message);console.error(e.message);}});
const js=async code=>{try{return await win.webContents.executeJavaScript(code,true);}catch(e){throw new Error(code+' :: '+e.message);}};
const click=async selector=>{await js('document.querySelector('+JSON.stringify(selector)+').click()');await delay(160);};
const key=async(keyCode,modifiers=[])=>{win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await delay(100);};
const text=async value=>{await js('document.querySelector("[role=textbox]").focus()');await key('a',['meta']);win.webContents.insertText(value);await delay(200);};
const capture=async name=>{if(process.env.QA_CAPTURE){fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG());}};
const moveMouse=async(x,y)=>{win.webContents.sendInputEvent({type:'mouseMove',x,y});await delay(220);};
const hoverAnswer=async id=>{const point=await js('(()=>{const el=document.querySelector('+JSON.stringify('[data-answer-id="'+id+'"] .goal-completion-summary')+');el.scrollIntoView({block:"nearest"});const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()');await moveMouse(point.x,point.y);};
const actionOpacity=async id=>js('getComputedStyle(document.querySelector('+JSON.stringify('[data-answer-id="'+id+'"] .goal-completion-summary')+').parentElement).opacity');
try{await win.loadURL(process.env.QA_URL);for(let i=0;i<150;i++){if(await js('!!document.querySelector("[role=textbox]")'))break;await delay(100);}await delay(600);
assert.equal(await js('!!document.querySelector(".session-goal-row")'),false);
await text('/goal');await capture('goal-slash-menu');await key('Return');
assert.equal(await js('!!document.querySelector(".goal-mode-pill")'),true,'slash selection enters goal composition');
assert.equal(await js('qa.events.length'),0,'selecting goal does not submit a turn');
assert.equal(await js('!!document.querySelector("[aria-label^=Exit]")'),false,'goal exits Plan');
await text('Build the feature');await key('Return');await delay(200);
assert.equal(await js('qa.calls.length'),1);assert.equal(await js('qa.calls[0].action.objective'),'Build the feature');assert.equal(await js('qa.calls[0].settings.codexReasoningEffort'),'high');
assert.equal(await js('qa.events.length'),0,'native goal uses control IPC');assert.equal(await js('document.querySelector(".session-goal-status").textContent'),'Pursuing goal');await capture('goal-active');
await click('[aria-label="Pause goal"]');assert.equal(await js('document.querySelector(".session-goal-status").textContent'),'Paused goal');
await click('[aria-label="Resume goal"]');assert.equal(await js('qa.calls.at(-1).action.status'),'active');
await click('[aria-label="Open goal editor"]');await capture('goal-editor');
await js('(()=>{const el=document.querySelector("textarea[aria-label=Goal]");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(el,"Updated objective");el.dispatchEvent(new Event("input",{bubbles:true}));})()');await delay(150);
await click('[aria-label="Revert goal changes"]');assert.equal(await js('document.querySelector("textarea[aria-label=Goal]").value'),'Build the feature');
await js('(()=>{const el=document.querySelector("textarea[aria-label=Goal]");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(el,"Updated objective");el.dispatchEvent(new Event("input",{bubbles:true}));})()');await delay(100);await click('.goal-save-button');assert.equal(await js('qa.calls.at(-1).action.objective'),'Updated objective');
await click('[aria-label="Close Edit goal"]');
await js('qa.fail=true');await click('[aria-label="Pause goal"]');assert.equal(await js('document.querySelector(".session-goal-status").textContent'),'Pursuing goal','failed mutation preserves actual status');await js('qa.fail=false;qa.dismissToasts()');
await text('/goal');await key('Return');await text('Replacement objective');await key('Return');assert.ok(await js('document.body.textContent.includes("Replace current goal?")'));
const calls=await js('qa.calls.length');await js('Array.from(document.querySelectorAll("button")).find(e=>e.textContent==="Cancel").click()');await delay(150);assert.equal(await js('qa.calls.length'),calls);assert.equal(await js('document.querySelector("[role=textbox]").textContent'),'Replacement objective');
await click('[aria-label="Send"]');await js('Array.from(document.querySelectorAll("button")).find(e=>e.textContent==="Replace goal").click()');await delay(200);assert.equal(await js('qa.calls.at(-1).action.objective'),'Replacement objective');
await text('An ordinary follow-up');await key('Return');assert.equal(await js('qa.events.at(-1).type'),'session.continue');assert.equal(await js('qa.events.at(-1).payload.codexGoal'),undefined,'normal follow-up never recreates goal');
await js('qa.store.getState().setActiveSession(qa.second)');await delay(200);assert.equal(await js('!!document.querySelector(".session-goal-row")'),false);
await js('qa.store.getState().setActiveSession(qa.first)');await delay(200);assert.equal(await js('document.querySelector(".session-goal-objective").textContent'),'Replacement objective');
await js('qa.publish(qa.first,{...qa.goal("budgetLimited"),tokenBudget:50000,tokensUsed:50000})');await delay(150);assert.equal(await js('document.querySelector(".session-goal-progress").textContent'),'· 50K / 50K');assert.equal(await js('!!document.querySelector("[aria-label^=Resume]")'),false,'budget limited requires a budget change, not blind resume');
await js('qa.publish(qa.first,qa.goal("paused"),{resumeConfirmation:true})');await delay(150);assert.ok(await js('document.body.textContent.includes("Resume paused goal?")'));await click('.goal-confirm-cancel');assert.equal(await js('document.querySelector(".session-goal-status").textContent'),'Paused goal');
await js('qa.publish(qa.first,qa.goal("usageLimited"),{resumeConfirmation:true})');await delay(150);await click('.goal-confirm-dialog .goal-save-button');await delay(150);
assert.equal(await js('document.querySelector(".session-goal-status").textContent'),'Pursuing goal');
await js('qa.store.getState().setTheme("dark")');await delay(250);assert.equal(await js('document.documentElement.dataset.themeVariant'),'dark');await capture('goal-dark');
await js('qa.addMessage(qa.first,{type:"assistant",uuid:"codex-answer",createdAt:Date.now()-1000,message:{content:[{type:"text",text:"The Codex goal is complete."}]}});qa.publish(qa.first,qa.goal("complete"))');await delay(150);
assert.equal(await js('!!document.querySelector(".session-goal-row")'),false);assert.equal(await js('document.querySelector(".goal-completion-summary").textContent'),'Goal achieved in 1m 25s');
await js('document.activeElement?.blur()');await moveMouse(10,10);
assert.equal(await actionOpacity('codex-answer'),'0','Codex completion and copy are hidden outside the reply');await capture('codex-goal-idle');
await hoverAnswer('codex-answer');assert.equal(await actionOpacity('codex-answer'),'1','hover reveals the entire Codex action row');await capture('codex-goal-hover');
assert.equal(await js('getComputedStyle(document.querySelector(".goal-completion-summary").parentElement).transitionProperty'),process.env.QA_REDUCED==='1'?'none':'opacity','action row fades unless reduced motion is requested');
if(process.env.QA_REDUCED!=='1')assert.equal(await js('getComputedStyle(document.querySelector(".goal-completion-summary").parentElement).transitionDuration'),'0.15s');
await moveMouse(10,10);assert.equal(await actionOpacity('codex-answer'),'0','leaving the reply hides completion again');
await js('document.querySelector("[data-answer-id=codex-answer] button").focus()');await delay(220);assert.equal(await actionOpacity('codex-answer'),'1','keyboard focus also reveals the action row');
await js('document.activeElement.blur()');await delay(220);assert.equal(await actionOpacity('codex-answer'),'0');
await js('qa.publish(qa.first,null)');
win.setContentSize(520,650);await js('qa.publish(qa.first,qa.goal("active"))');await delay(150);assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'),true,'narrow window has no horizontal overflow');await capture('goal-narrow');win.setContentSize(1050,760);
await js('qa.setPage("new");qa.store.setState({pendingStart:false})');await delay(500);await text('/goal');await key('Return');assert.equal(await js('!!document.querySelector(".goal-mode-pill")'),true);
await text('A new goal');await key('Return');await delay(250);assert.equal(await js('qa.events.at(-1).type'),'session.start');assert.equal(await js('qa.events.at(-1).payload.codexGoal.objective'),'A new goal');assert.equal(await js('qa.events.at(-1).payload.codexExecutionMode'),'execute');
// Reuse the same production surfaces for Claude, with provider-native counters.
await js('qa.setPage("chat");qa.store.setState(s=>({pendingStart:false,sessions:{...s.sessions,[qa.first]:{...s.sessions[qa.first],provider:"claude",model:"claude-sonnet-4-6",claudeAccessMode:"default",claudeExecutionMode:"plan",claudeReasoningEffort:"high"}}}));qa.publish(qa.first,null);qa.store.getState().setActiveSession(qa.first)');await delay(500);
await text('/goal');await key('Return');assert.equal(await js('!!document.querySelector(".goal-mode-pill")'),true);
await text('Verify Claude native Goal');await key('Return');await delay(200);
assert.equal(await js('qa.calls.at(-1).action.objective'),'Verify Claude native Goal');assert.equal(await js('qa.calls.at(-1).settings.claudeReasoningEffort'),'high');
assert.equal(await js('qa.store.getState().sessions[qa.first].claudeExecutionMode'),'execute');
await js('qa.publish(qa.first,{...qa.goal(),objective:"Verify Claude native Goal",claude:{iterations:2,lastReason:"A verification step remains"}})');await delay(100);
assert.equal(await js('document.querySelector(".session-goal-progress").textContent'),'· 2 checks');await capture('claude-goal-dark');
await click('[aria-label="Pause goal"]');assert.equal(await js('document.querySelector(".session-goal-status").textContent'),'Paused goal');
await click('[aria-label="Resume goal"]');assert.equal(await js('qa.calls.at(-1).action.status'),'active');
await click('[aria-label="Open goal editor"]');assert.equal(await js('!!document.querySelector(".goal-editor-panel")'),true);
const darkBackground=await js('getComputedStyle(document.querySelector(".goal-editor-panel")).backgroundColor');
await js('qa.store.getState().setTheme("light")');await delay(250);assert.equal(await js('document.documentElement.dataset.themeVariant'),'light');
assert.notEqual(await js('getComputedStyle(document.querySelector(".goal-editor-panel")).backgroundColor'),darkBackground,'editor applies the light theme');await capture('claude-goal-editor-light');
await js('qa.addMessage(qa.first,{type:"user_prompt",prompt:"/goal Verify Claude native Goal",createdAt:Date.now()-45000});qa.addMessage(qa.first,{type:"assistant",uuid:"claude-answer",createdAt:Date.now()-1000,message:{content:[{type:"text",text:"I verified the project. The goal is complete."}]}})');
await js('qa.publish(qa.first,{...qa.goal("complete"),objective:"Verify Claude native Goal",timeUsedSeconds:42.776,claude:{iterations:1,lastReason:"The goal has been achieved."}})');await delay(250);
assert.equal(await js('!!document.querySelector(".session-goal-row")'),false);
assert.equal(await js('document.querySelector("[data-answer-id=claude-answer] .goal-completion-summary").textContent'),'Goal achieved in 42s');
assert.equal(await js('document.querySelector("[data-answer-id=claude-answer] .goal-completion-summary").title'),'Verify Claude native Goal\n\n1 check\n\nLast check: The goal has been achieved.');
await js('document.activeElement?.blur()');await moveMouse(10,10);assert.equal(await actionOpacity('claude-answer'),'0');
await hoverAnswer('claude-answer');assert.equal(await actionOpacity('claude-answer'),'1','Claude uses the same hover behavior and retains native duration');
await capture('claude-goal-complete-light');
await js('qa.store.getState().setTheme("dark")');await delay(250);await capture('claude-goal-complete-dark');
await js('qa.publish(qa.first,null);qa.addMessage(qa.first,{type:"user_prompt",prompt:"An ordinary follow-up",createdAt:Date.now()});qa.addMessage(qa.first,{type:"assistant",uuid:"follow-up-answer",createdAt:Date.now()+1,message:{content:[{type:"text",text:"This is the next turn. The earlier goal result stays above."}]}})');await delay(250);
assert.equal(await js('!!document.querySelector("[data-answer-id=follow-up-answer] .goal-completion-summary")'),false);
assert.equal(await js('document.querySelector("[data-answer-id=claude-answer] .goal-completion-summary").textContent'),'Goal achieved in 42s');
await js('qa.store.setState(s=>({sessions:{...s.sessions,[qa.first]:{...s.sessions[qa.first],messages:JSON.parse(JSON.stringify(s.sessions[qa.first].messages))}}}))');await delay(150);
assert.equal(await js('document.querySelector("[data-answer-id=claude-answer] .goal-completion-summary").textContent'),'Goal achieved in 42s');await capture('claude-goal-next-turn');
await moveMouse(10,10);assert.equal(await actionOpacity('claude-answer'),'0','older completed turns return to their hidden action state');
// A fresh Claude composer sends a native slash prompt and no Codex action.
await js('qa.store.setState(s=>({sessions:{...s.sessions,[qa.first]:{...s.sessions[qa.first],isDraft:true}}}))');await delay(300);
await text('/goal');await key('Return');await text('A fresh Claude goal');await key('Return');await delay(250);
assert.equal(await js('qa.events.at(-1).type'),'session.start');assert.equal(await js('qa.events.at(-1).payload.provider'),'claude');
assert.equal(await js('qa.events.at(-1).payload.prompt'),'/goal A fresh Claude goal');assert.equal(await js('qa.events.at(-1).payload.codexGoal'),undefined);
assert.equal(await js('qa.events.at(-1).payload.claudeExecutionMode'),'execute');
assert.deepEqual(errors,[]);console.log('session-goal Electron: Codex and Claude production composers, slash, native dispatch, controls, editing, replacement, themes, and session isolation passed');app.exit(0);
}catch(e){console.error(e);await capture('failure');app.exit(1);}});
`;
let server;
try {
  await writeFile(
    path.join(tmp, 'index.html'),
    '<html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>',
  );
  await writeFile(path.join(tmp, 'harness.tsx'), harness);
  await writeFile(path.join(tmp, 'main.cjs'), main);
  server = await createServer({
    root,
    plugins: [
      {
        name: 'goal-qa-panel',
        enforce: 'pre',
        transform(source, id) {
          if (id.endsWith('/src/ui/App.tsx')) return source + '\nexport { RightUtilityWorkspace };';
        },
      },
    ],
    configFile: path.join(root, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  await server.listen();
  const url = new URL(path.relative(root, tmp) + '/index.html', server.resolvedUrls.local[0]).href;
  await new Promise((resolve, reject) => {
    const env = { ...process.env, QA_URL: url };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      path.join(root, 'node_modules/.bin/electron'),
      [path.join(tmp, 'main.cjs')],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (d) => {
        output += d;
        process.stdout.write(d);
      });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Goal UI test timed out'));
    }, 120000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(output));
    });
  });
} finally {
  await server?.close();
  await rm(tmp, { recursive: true, force: true });
}

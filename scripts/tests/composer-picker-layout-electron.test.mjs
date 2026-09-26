import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
const root=process.cwd();
await mkdir(path.join(root,'.aegis-design-qa'),{recursive:true});
const dir=await mkdtemp(path.join(root,'.aegis-design-qa/composer-picker-layout-'));
const testProvider=process.env.QA_PROVIDER || 'codex';
const harness=`
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {PromptInput} from '/src/ui/components/PromptInput';
import {NewSessionView} from '/src/ui/components/NewSessionView';

import {useAppStore} from '/src/ui/store/useAppStore';
import '/src/ui/index.css';
localStorage.setItem('cowork.preferredProvider','${testProvider}');
window.electron={createInlineTextAttachment:async()=>{qa.textAttachmentCalls++;throw Error('Text must remain inline')},getProjectTree:async()=>null,cancelProjectTreeRead:async()=>{},getRecentCwds:async()=>[],getProjectGitSummary:async()=>({isGitRepository:false}),getAgentRuntimeDirectory:async()=>({checkedAt:Date.now(),entries:[]}),getSessionUserPrompts:async()=>[],getSessionGoal:async()=>({goal:null,supported:false,revision:0}),onSessionGoalChanged:()=>()=>{},getClaudeCompatibleProviderConfig:async()=>({}),getBubbleProvidersConfig:async()=>({providers:[]}),getProjectFolders:async()=>[],getModels:async()=>[],listCodexSkills:async()=>({skills:[]}),sendClientEvent:event=>qa.events.push(event)};
for(const p of ['Claude','Kimi','Grok','Opencode','Pi','Bubble','Qoder','Deepseek','Codex'])window.electron['get'+p+'ModelConfig']=async()=>({defaultModel:null,options:[],availableModels:[]});
window.electron.getDeepseekModelConfig=async()=>({defaultModel:'deepseek-flash',options:['deepseek-flash'],availableModels:[{id:'deepseek-flash',name:'DeepSeek V4.1 Flash',reasoningEfforts:['none','high','max']}]});
window.electron.getCodexModelConfig=async()=>({defaultModel:'gpt-6-astra',defaultReasoningEffort:'ultra',options:['gpt-6-astra'],availableModels:[{name:'gpt-6-astra',label:'GPT 6 Astra',enabled:true,isDefault:true,defaultReasoningEffort:'ultra',supportedReasoningLevels:[{effort:'ultra',description:'Maximum reasoning'}],supportsFastMode:true}]});
const store=useAppStore,id=store.getState().createDraftSession('/tmp/composer-qa');
store.setState(s=>({connected:true,projectCwd:'/tmp/composer-qa',activeSessionId:id,sessions:{...s.sessions,[id]:{...s.sessions[id],isDraft:false,provider:'${testProvider}',model:'${testProvider === 'codex' ? 'gpt-6-astra' : 'deepseek-flash'}',codexPermissionMode:'fullAccess',codexReasoningEffort:'ultra',status:'completed',messages:[],hydrated:true}}}));
window.qa={store,id,events:[],textAttachmentCalls:0};
function Harness(){const [mode,setMode]=useState('chat'),[width,setWidth]=useState(600);qa.mode=setMode;qa.width=setWidth;
return <Tooltip.Provider><div style={{height:'100vh',display:'flex',background:'var(--bg-primary)',color:'var(--text-primary)'}}><aside style={{width:180,flexShrink:0,background:'var(--bg-secondary)'}}>Sidebar</aside><section style={{width,flexShrink:0,minWidth:0,display:'flex',flexDirection:'column'}}>
{mode==='new'?<NewSessionView/>:<><main style={{flex:1,minHeight:0,overflow:'auto'}}>Conversation</main><div className="aegis-chat-composer px-8 pb-4"><PromptInput sessionId={id}/></div></>}
</section><aside style={{flex:1,minWidth:0,borderLeft:'1px solid var(--border)'}}>Browser</aside></div></Tooltip.Provider>}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main=String.raw`
const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
app.setPath('userData',path.join(__dirname,'profile'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1200,height:800,show:true,webPreferences:{backgroundThrottling:false}}),js=s=>win.webContents.executeJavaScript(s,true);
 const until=async(s,label)=>{for(let i=0;i<100;i++){if(await js(s))return;await delay(50)}throw Error('Timed out: '+label)};
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const shot=async name=>{win.webContents.invalidate();await delay(100);fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG())};
 const geometry=()=>js('(()=>{const t=document.querySelector(".aegis-composer-toolbar"),r=t.getBoundingClientRect(),s=getComputedStyle(t);const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};return {toolbar:rect(t),contentWidth:r.width-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight),buttons:[...t.querySelectorAll("button")].map(e=>({...rect(e),label:e.getAttribute("aria-label")||e.title})),labels:[...t.querySelectorAll(".aegis-composer-responsive-label")].map(e=>getComputedStyle(e).display),pageOverflow:document.documentElement.scrollWidth>innerWidth}})()');
 const check=async label=>{
  const g=await geometry();assert.equal(g.pageOverflow,false,label+' page overflow');
  for(const b of g.buttons){assert(b.width>=16,label+' button collapsed '+b.label);assert(b.left>=g.toolbar.left-1&&b.right<=g.toolbar.right+1,label+' button outside composer '+JSON.stringify(b));assert(b.height<=34,label+' text wrapped '+b.label)}
  for(let i=0;i<g.buttons.length;i++)for(let j=i+1;j<g.buttons.length;j++){const a=g.buttons[i],b=g.buttons[j];assert(a.right<=b.left+1||b.right<=a.left+1||a.bottom<=b.top+1||b.bottom<=a.top+1,label+' overlapping '+a.label+' / '+b.label)}
  assert(g.labels.every(display=>g.contentWidth<=475?display==='none':display!=='none'),label+' labels follow footer width');
  return g;
 };
 try{
 await win.loadURL(process.env.QA_URL);await until('!!document.querySelector("[data-composer-control=model]")','composer');
 for(const mode of ['chat','new']){
  await js('qa.mode('+JSON.stringify(mode)+')');await delay(200);
  for(const width of [760,600,540,480,360,280,240,200,180]){
   await js('qa.width('+width+')');await delay(120);
   await check(mode+' '+width);
   if(width===240)await shot(mode+'-narrow-browser');
  }
  // Both compact controls retain accessible triggers and usable menus.
  await js('qa.width(240)');await delay(100);
  await js('document.querySelector("[data-composer-control=permission]").click()');await delay(150);
  assert(await js('[...document.querySelectorAll("[role=menuitem]")].some(e=>e.textContent.includes("Full Access"))'),'permission menu available');
  await js('[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent.includes("Full Access")).click()');await delay(120);
  assert.match(await js('document.querySelector("[data-composer-control=permission]").getAttribute("aria-label")'),/Full Access/);
  await check(mode+' full access');
  await js('document.querySelector("[data-composer-control=model]").click()');await delay(200);
  await check(mode+' model open');
  assert(await js('!!document.querySelector("[role=menu]")'),'model menu available');
  await shot(mode+'-narrow-model-menu');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await delay(150);
  await js('qa.width(760)');await delay(150);await check(mode+' restored');await shot(mode+'-wide');
 }
 assert.deepEqual(errors,[]);console.log('PASS: new/chat composer controls at 180–760px with a wide window and Browser pane; no overlap, text wrapping, or clipping; compact menus and restored labels');app.exit(0);
 }catch(e){console.error(e,errors,await geometry());await shot('failure');app.exit(1)}
});
`;
let server;
try{
 await writeFile(path.join(dir,'index.html'),'<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
 await writeFile(path.join(dir,'harness.tsx'),harness);await writeFile(path.join(dir,'main.cjs'),main);
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),cacheDir:path.join(dir,'vite-cache'),server:{host:'127.0.0.1',port:0,watch:{ignored:['**/.aegis-design-qa/**']}}});await server.listen();
 const env={...process.env,BUBBLE_HOME:path.join(dir,'bubble-home'),QA_URL:new URL(path.relative(root,dir)+'/index.html',server.resolvedUrls.local[0]).href,QA_CAPTURE:path.join(root,'output/playwright/composer-picker-layout',testProvider)};delete env.ELECTRON_RUN_AS_NODE;
 await new Promise((resolve,reject)=>{const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(dir,'main.cjs')],{env,stdio:'inherit'});const timer=setTimeout(()=>{child.kill();reject(Error('Composer picker layout QA timed out'))},60000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Composer picker layout QA failed: '+code))})});
}finally{await server?.close();await rm(dir,{recursive:true,force:true})}

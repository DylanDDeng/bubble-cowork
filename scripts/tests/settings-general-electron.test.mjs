import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
const root=process.cwd();
await mkdir(path.join(root,'.aegis-design-qa'),{recursive:true});
const tmp=await mkdtemp(path.join(root,'.aegis-design-qa/settings-'));
const harness=`
import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {Toaster} from 'sonner';
import {Settings} from '/src/ui/components/settings/Settings';
import {PromptInput} from '/src/ui/components/PromptInput';
import {EnvironmentEditorPicker} from '/src/ui/components/environment/EnvironmentHub';
import {useAppStore} from '/src/ui/store/useAppStore';
import {useAppPreferences,subscribeAppPreferences} from '/src/ui/store/useAppPreferences';
import {useComposerQueueStore} from '/src/ui/store/useComposerQueueStore';
import '/src/ui/index.css';
window.qa={store:useAppStore,prefs:useAppPreferences,queue:useComposerQueueStore,calls:[]};
window.electron={...window.preferenceBridge,
 getEnvironmentEditorLaunchers:()=>window.preferenceBridge.getEnvironmentEditorLaunchers(),
 openInEditor:async input=>{qa.opened=input;return {ok:true};},
 getAppVersion:async()=>'0.0.59',checkForUpdates:async()=>{},
 getUserProfile:async()=>({displayName:'Test User',handle:'test'}),saveUserProfile:async p=>p,
 getAgentUsageReport:async()=>{throw Error('No test usage');},
 getCodexRateLimits:async()=>{throw Error('No test account');},getClaudePlanUsage:async()=>{throw Error('No test account');},
 getGrokPlanUsage:async()=>{throw Error('No test account');},getQoderPlanUsage:async()=>{throw Error('No test account');},
 getRecentCwds:async()=>['/tmp'],getSessionUserPrompts:async()=>[],sendClientEvent:e=>qa.calls.push(e),
 getAgentRuntimeDirectory:async()=>({checkedAt:Date.now(),entries:[]}),getClaudeCompatibleProviderConfig:async()=>({}),
 getSessionGoal:async id=>({sessionId:id,supported:false,goal:null,revision:0}),onSessionGoalChanged:()=>()=>{},
 getProjectGitSummary:async()=>({isGitRepository:false}),getProjectTree:async()=>null,
};
for(const p of ['Claude','Codex','Kimi','Grok','Opencode','Pi','Bubble','Qoder','Deepseek'])window.electron['get'+p+'ModelConfig']=async()=>({defaultModel:null,options:[],availableModels:[]});
useAppStore.setState({showSettings:true,activeSettingsTab:'general'});
function Harness(){
 useEffect(subscribeAppPreferences,[]);
 const [composer,setComposer]=useState(false);qa.showComposer=provider=>{const a=useAppStore.getState();const id=a.createDraftSession('/tmp');qa.id=id;useAppStore.setState(s=>({sessions:{...s.sessions,[id]:{...s.sessions[id],isDraft:false,provider,status:'running',model:provider==='codex'?'gpt-5.4':'sonnet',messages:[]}},pendingStart:false}));setComposer(true);};
 return <Tooltip.Provider><div style={{height:'100vh',background:'var(--bg-primary)',color:'var(--text-primary)'}}>{composer?<><EnvironmentEditorPicker context={{effectiveCwd:"/tmp"}}/><PromptInput sessionId={qa.id}/></>:<Settings/>}<Toaster/></div></Tooltip.Provider>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const preload=String.raw`
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('preferenceBridge',{
 getEnvironmentEditorLaunchers:()=>ipcRenderer.invoke('editors'),
 getAppPreferences:()=>ipcRenderer.invoke('prefs:get'),setAppPreferences:p=>ipcRenderer.invoke('prefs:set',p),
 getTerminalShellOptions:()=>ipcRenderer.invoke('shells'),
 getNotificationSettings:()=>ipcRenderer.invoke('notices:get'),setNotificationSettings:p=>ipcRenderer.invoke('notices:set',p),
 onAppPreferencesChanged:fn=>{const listener=(_,p)=>fn(p);ipcRenderer.on('app-preferences-changed',listener);return()=>ipcRenderer.removeListener('app-preferences-changed',listener);},
});
`;
const main=String.raw`
const {app,BrowserWindow,ipcMain}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
const prefs=require(path.join(process.cwd(),'dist-electron/electron/libs/app-preferences.js'));
const notices=require(path.join(process.cwd(),'dist-electron/electron/libs/notifications.js'));
const {execFileSync}=require('node:child_process');
function appIcon(appPath,id){
 try {
  const icon=execFileSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleIconFile',path.join(appPath,'Contents/Info.plist')],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  const source=path.join(appPath,'Contents/Resources',icon.endsWith('.icns')?icon:icon+'.icns');
  const target=path.join(__dirname,id+'.png');
  execFileSync('sips',['-s','format','png','-z','32','32',source,'--out',target],{stdio:'ignore'});
  return 'data:image/png;base64,'+fs.readFileSync(target).toString('base64');
 }catch{return undefined;}
}
ipcMain.handle('editors',async()=>Promise.all([
 // Simulate an old application list retained across a renderer hot update.
 ['auto','Automatic','/nonexistent'],
 ['code','VS Code','/Applications/Visual Studio Code.app'],['cursor','Cursor','/Applications/Cursor.app'],
 ['zed','Zed','/Applications/Zed.app'],['sublime','Sublime Text','/Applications/Sublime Text.app'],
 ['finder','Finder','/System/Library/CoreServices/Finder.app'],['trae','Trae','/Applications/Trae.app'],
 ['xcode','Xcode','/Applications/Xcode.app'],['terminal','Terminal','/System/Applications/Utilities/Terminal.app'],
 ['iterm','iTerm2','/Applications/iTerm.app'],['ghostty','Ghostty','/Applications/Ghostty.app'],
 ['warp','Warp','/Applications/Warp.app'],['windsurf','Windsurf','/Applications/Windsurf.app'],
].map(async([id,label,appPath])=>({id,label,available:true,iconDataUrl:appIcon(appPath,id)}))));
ipcMain.handle('prefs:get',()=>prefs.getAppPreferences());ipcMain.handle('prefs:set',(_,p)=>prefs.setAppPreferences(p));
ipcMain.handle('shells',()=>prefs.getTerminalShellOptions());ipcMain.handle('notices:get',()=>notices.getNotificationSettings());ipcMain.handle('notices:set',(_,p)=>notices.setNotificationSettings(p));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1124,height:900,show:true,webPreferences:{preload:path.join(__dirname,'preload.cjs')}});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error'){errors.push(e.message);console.error(e.message);}});
 const js=c=>win.webContents.executeJavaScript(c,true);
 const until=async(c,label)=>{for(let i=0;i<100;i++){if(await js(c))return;await delay(100);}throw Error('Timed out: '+label);};
 const click=async s=>{await js('document.querySelector('+JSON.stringify(s)+').click()');await delay(200);};
 const choose=async(label,value)=>{await click('[aria-label="'+label+'"]');await click('[data-preference-option="'+value+'"]');};
 const text=async(selector,value)=>{await js('var el=document.querySelector('+JSON.stringify(selector)+');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,'+JSON.stringify(value)+');el.dispatchEvent(new Event("input",{bubbles:true}))');await delay(150);};
 const key=async(modifiers=[])=>{win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return',modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return',modifiers});await delay(200);};
 const shot=async name=>{await delay(200);fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG());};
 const search=async value=>{await text('[aria-label="Search settings"]',value);await click('[aria-label="Settings search results"] button');};
 try{
  await win.loadURL(process.env.QA_URL);await until('!!document.querySelector("[data-preference-value]")&&!document.querySelector("[data-preference-value]").disabled','preferences loaded');
  assert.equal(await js('document.querySelector("h1").textContent'),'General');
  assert.equal(await js('!!document.querySelector("[data-settings-label=Mode]")'),false);
  assert.equal(await js('document.querySelector("[aria-label=\\"Default open destination\\"]").textContent.includes("Automatic")'),false,'legacy automatic value resolves to an application');
  await shot('general-light');
  await click('[aria-label="Default open destination"]');assert.equal(await js('!!document.querySelector("[data-preference-option=auto]")'),false,'retained automatic entry is not rendered');await shot('application-menu-light');
  await js('document.querySelector("[data-application-destination-menu] > div").scrollTop=1000');await shot('application-menu-scrolled');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await delay(150);
  await choose('Default open destination','code');await choose('Send with','modifier');await choose('Follow-up behavior','steer');
  await click('[aria-label="Show context usage"]');
  assert.equal(prefs.getAppPreferences().showContextUsage,false);assert.equal(prefs.getAppPreferences().defaultEditor,'code');
  await choose('Task completed','off');await click('[aria-label="Approval required"]');
  assert.equal(notices.getNotificationSettings().enabled,false);assert.equal(notices.getNotificationSettings().approvalRequired,false);
  const saved=JSON.parse(fs.readFileSync(path.join(app.getPath('userData'),'app-preferences.json'),'utf8'));assert.equal(saved.enterBehavior,'modifier');
  await win.reload();await until('!!document.querySelector("[data-preference-value]")&&!document.querySelector("[data-preference-value]").disabled','reload');
  assert.equal(await js('document.querySelector("[aria-label=\\"Send with\\"]").dataset.preferenceValue'),'modifier');
  assert.equal(await js('document.querySelector("[aria-label=\\"Show context usage\\"]").getAttribute("aria-checked")'),'false');
  // Main-process updates propagate to the mounted renderer without reopening Settings.
  prefs.setAppPreferences({showContextUsage:true});await until('qa.prefs.getState().showContextUsage','broadcast');
  await search('terminal');assert.equal(await js('document.activeElement.dataset.settingsLabel'),'Terminal shell');
  assert.equal(await js('document.activeElement.dataset.searchMatch'),'true');
  await search('dark theme');assert.equal(await js('document.querySelector("h1").textContent'),'Appearance');
  assert.equal(await js('document.activeElement.dataset.settingsLabel'),'Dark Theme');
  await js('document.querySelector("main").scrollTop=0');await shot('appearance-light');
  await search('display name');assert.equal(await js('document.querySelector("h1").textContent'),'Usage');
  assert.equal(await js('document.activeElement.dataset.settingsLabel'),'Display name');
  await search('General');await js('qa.store.getState().setTheme("dark")');await shot('general-dark');
  await click('[aria-label="Default open destination"]');await shot('application-menu-dark');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await delay(150);
  win.setContentSize(390,740);await delay(200);await shot('general-narrow');
  assert.equal(await js('document.documentElement.scrollWidth>innerWidth'),false);
  assert(await js('Array.from(document.querySelectorAll("main [data-preference-value],main [role=switch]")).every(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})'));
  await search('Appearance');await js('document.querySelector("main").scrollTop=0');await shot('appearance-narrow');
  assert.equal(await js('document.querySelector("main").scrollWidth>document.querySelector("main").clientWidth'),false,'appearance has no horizontal overflow');
  // Real composer: supported providers can queue/steer; other providers queue safely.
  win.setContentSize(1124,900);prefs.setAppPreferences({enterBehavior:'enter',followUpBehavior:'queue'});
  await js('qa.showComposer("codex")');await until('!!document.querySelector("[role=textbox]")','composer');
  await until('!!document.querySelector("[aria-label=\\"Open workspace in VS Code\\"]")','default editor');
  prefs.setAppPreferences({defaultEditor:'finder'});await until('!!document.querySelector("[aria-label=\\"Open workspace in Finder\\"]")','changed default editor');
  await click('[aria-label="Open workspace in Finder"]');assert.equal(await js('qa.opened.editorId'),'finder');
  await js('qa.store.setState(s=>({sessions:{...s.sessions,[qa.id]:{...s.sessions[qa.id],messages:[{type:"system",subtype:"token_usage",provider:"codex",usage:{contextWindow:200000,totalTokens:10000}}]}}}))');
  await until('!!document.querySelector("[aria-label=\\"Context window usage\\"]")','context indicator');
  prefs.setAppPreferences({showContextUsage:false});await until('!document.querySelector("[aria-label=\\"Context window usage\\"]")','context hidden');
  prefs.setAppPreferences({showContextUsage:true});await until('!!document.querySelector("[aria-label=\\"Context window usage\\"]")','context restored');
  const type=async value=>{await js('document.querySelector("[role=textbox]").focus();document.execCommand("insertText",false,'+JSON.stringify(value)+')');await delay(100);};
  await type('Queued follow-up');await key();
  assert.equal(await js('(qa.queue.getState().queues[qa.id]||[]).length'),1);
  assert.equal(await js('qa.calls.filter(e=>e.type==="session.continue").length'),0);
  await type('Steer follow-up');await key(['meta']);
  assert.equal(await js('qa.calls.filter(e=>e.type==="session.continue").length'),1);
  await js('qa.queue.getState().takeAll(qa.id);qa.calls=[];qa.store.setState(s=>({sessions:{...s.sessions,[qa.id]:{...s.sessions[qa.id],provider:"claude",model:"sonnet"}}}))');
  prefs.setAppPreferences({followUpBehavior:'steer'});await delay(200);
  await type('Claude queued');await key();
  assert.equal(await js('(qa.queue.getState().queues[qa.id]||[]).length'),1);
  assert.equal(await js('qa.calls.filter(e=>e.type==="session.continue").length'),0);
  assert.equal(await js('document.querySelector("button[title=\\"Send as the next message\\"]").disabled'),true);
  await js('qa.store.setState(s=>({sessions:{...s.sessions,[qa.id]:{...s.sessions[qa.id],status:"completed"}}}))');
  await until('qa.calls.some(e=>e.type==="session.continue")','Claude queue flush');
  prefs.setAppPreferences({enterBehavior:'modifier'});await delay(100);
  await type('Line one');await key();assert((await js('document.querySelector("[role=textbox]").textContent')).includes('Line one'));
  const before=await js('qa.calls.length');await key(['meta']);assert((await js('qa.calls.length'))>before);
  // Switching plain text preserves the literal input and removes only its rich rendering.
  await js('var clipboard=new DataTransfer();clipboard.setData("text/plain","https://github.com/openai/codex");document.querySelector("[role=textbox]").dispatchEvent(new ClipboardEvent("paste",{bubbles:true,cancelable:true,clipboardData:clipboard}))');
  await until('!!document.querySelector("[data-segment-type=link]")','rich link');
  prefs.setAppPreferences({plainTextComposer:true});await until('!document.querySelector("[data-segment-type=link]")','plain link');
  assert((await js('document.querySelector("[role=textbox]").textContent')).includes('https://github.com/openai/codex'));
  prefs.setAppPreferences({plainTextComposer:false});await until('!!document.querySelector("[data-segment-type=link]")','rich link restored');
  if(process.platform==='darwin'){
    const {TerminalManager}=require(path.join(process.cwd(),'dist-electron/electron/libs/terminal-manager.js'));
    const events=[];const terminal=new TerminalManager(e=>events.push(e));
    process.env.AEGIS_TERMINAL_HISTORY_DIR=path.join(__dirname,'terminal-history');
    try {
      prefs.setAppPreferences({terminalShell:'/bin/bash'});
      const opened=await terminal.open({threadId:'settings-shell-test',terminalId:'default',cwd:__dirname,agentKind:'shell'});
      assert(opened.ok,opened.message);
      terminal.write({threadId:'settings-shell-test',terminalId:'default',data:"printf 'PREFERRED_%s_END\\n' bash-$BASH_VERSION\r"});
      for(let i=0;i<80&&!events.some(e=>e.type==='output'&&/PREFERRED_bash-[0-9]/.test(e.data));i++)await delay(100);
      assert(events.some(e=>e.type==='output'&&/PREFERRED_bash-[0-9]/.test(e.data)),'new terminal uses selected bash shell');
    } finally {terminal.disposeAll();}
  }
  assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,captures:process.env.QA_CAPTURE}));app.exit(0);
 }catch(error){console.error(error);await shot('failure');app.exit(1);}
});
`;
let server;
try{
 await writeFile(path.join(tmp,'index.html'),'<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
 await writeFile(path.join(tmp,'harness.tsx'),harness);await writeFile(path.join(tmp,'preload.cjs'),preload);await writeFile(path.join(tmp,'main.cjs'),main);
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0,strictPort:false,watch:{ignored:['**/.aegis-design-qa/**']}}});await server.listen();
 const url=new URL(path.relative(root,tmp)+'/index.html',server.resolvedUrls.local[0]).href;
 await new Promise((resolve,reject)=>{
  const env={...process.env,QA_URL:url,QA_CAPTURE:path.join(root,'output/playwright/settings-general')};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(tmp,'main.cjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});let out='';
  child.stdout.on('data',c=>{out+=c;process.stdout.write(c);});child.stderr.on('data',c=>process.stderr.write(c));
  const timeout=setTimeout(()=>{child.kill();reject(Error('Settings Electron test timed out'));},90000);
  child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);code===0&&out.includes('"ok":true')?resolve():reject(Error('Settings Electron regression failed'));});
 });
}finally{await server?.close();await rm(tmp,{recursive:true,force:true});}

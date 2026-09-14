import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
const root=process.cwd();
await mkdir(path.join(root,'.aegis-design-qa'),{recursive:true});
const tmp=await mkdtemp(path.join(root,'.aegis-design-qa/settings-integration-'));
const harness=String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Settings} from '/src/ui/components/settings/Settings';
import {useAppStore} from '/src/ui/store/useAppStore';
import {ConfirmDialogHost} from '/src/ui/components/ui/confirm-dialog';
import {Toaster,toast} from 'sonner';
import {Tooltip} from '@base-ui-components/react/tooltip';
import '/src/ui/index.css';
window.qa={store:useAppStore,toast,calls:[],profile:{displayName:'Test User',handle:'test'},permissions:{enabled:true,origins:{}},bridge:{enabled:true,appId:'test-app',appSecret:'fixture-secret',defaultCwd:'/tmp/example',provider:'claude',model:'',allowedUserIds:'',autoStart:false},bridgeStatus:{running:false,connected:false,activeBindings:0},cookieStatus:{importedAt:null,profileName:null,cookieCount:0,domains:[]}};
window.electron={
 getBrowserUsePermissions:async()=>{if(qa.failBrowser)throw Error('Browser unavailable');return qa.permissions;},
 setBrowserUseEnabled:async enabled=>qa.permissions={...qa.permissions,enabled},
 listChromeCookieProfiles:async()=>({platformSupported:true,chromeRunning:true,profiles:[{profileName:'Personal',profilePath:'/tmp/profile-1',hasCookies:true},{profileName:'Work',profilePath:'/tmp/profile-2',hasCookies:true}]}),
 getChromeCookieImportStatus:async()=>qa.cookieStatus,
 importChromeCookies:async input=>{qa.calls.push({type:'cookies',input});qa.cookieStatus={importedAt:Date.now(),profileName:'Work',cookieCount:4,domains:['example.test']};return {ok:true,cookies:{imported:4,discovered:4,failed:0,skippedPartitioned:0,skippedExpired:0,skippedInvalid:0}};},
 clearImportedChromeCookies:async()=>{qa.cookieStatus={importedAt:null,profileName:null,cookieCount:0,domains:[]};return {ok:true,removed:4};},
 getFeishuBridgeConfig:async()=>{if(qa.failBridge)throw Error('Bridge unavailable');return qa.bridge;},getFeishuBridgeStatus:async()=>qa.bridgeStatus,
 saveFeishuBridgeConfig:async config=>{if(qa.failSave)throw Error('Save failed');return qa.bridge=config;},
 startFeishuBridge:async()=>qa.bridgeStatus={running:true,connected:true,activeBindings:1},stopFeishuBridge:async()=>qa.bridgeStatus={running:false,connected:false,activeBindings:0},selectDirectory:async()=>'/tmp/new-project',
 getUserProfile:async()=>qa.profile,saveUserProfile:async profile=>qa.profile={...qa.profile,...profile},
 getBubbleProvidersConfig:async()=>({providers:[{id:'openai',name:'OpenAI',configured:true,enabled:true,hasApiKey:true,isDefault:true},{id:'google',name:'Google',configured:false,enabled:false,hasApiKey:false}],defaultProviderId:'openai'}),
 getClaudeCompatibleProviderConfig:async()=>({}),getDeepseekKeyStatus:async()=>({hasApiKey:false}),getAgentRuntimeDirectory:async()=>({checkedAt:Date.now(),entries:[]}),
 getAgentUsageReport:async provider=>({rangeDays:365,costMode:'actual',totals:{inputTokens:8000,outputTokens:2000,totalTokens:10000,totalCostUsd:1.25,sessionCount:2,cacheReadTokens:1000,cacheHitRate:.125},models:[],daily:[{date:'2026-09-12',inputTokens:8000,outputTokens:2000,totalTokens:10000,totalCostUsd:1.25,sessionCount:2,cacheReadTokens:1000}]}),
 getCodexRateLimits:async()=>({rateLimits:null,rateLimitsByLimitId:{}}),getClaudePlanUsage:async()=>{throw Error('No subscription');},getGrokPlanUsage:async()=>{throw Error('No subscription');},getQoderPlanUsage:async()=>{throw Error('No subscription');},
 getKimiModelConfig:async()=>({defaultModel:null,options:[],availableModels:[]}),
 listCodexMcpStatus:async()=>({ok:true,servers:[{name:'calendar',authStatus:'notLoggedIn',toolNames:[]}]}),
 startCodexMcpOauthLogin:async()=>{qa.calls.push({type:'oauth'});if(qa.failAuth)throw Error('Authorization failed');return {ok:true};},
 sendClientEvent:event=>{qa.calls.push(event);if(event.type==='mcp.save-config'){const map={globalServers:'mcpGlobalServers',codexGlobalServers:'mcpCodexGlobalServers',opencodeGlobalServers:'mcpOpencodeGlobalServers',kimiGlobalServers:'mcpKimiGlobalServers',qoderGlobalServers:'mcpQoderGlobalServers',bubbleGlobalServers:'mcpBubbleGlobalServers',deepseekGlobalServers:'mcpDeepseekGlobalServers'};for(const [key,value]of Object.entries(event.payload))if(map[key])useAppStore.setState({[map[key]]:value});}},
};
for(const name of ['Claude','Codex','Opencode','Kimi','Grok'])window.electron['get'+name+'RuntimeStatus']=async()=>({ready:true,kind:'ready',summary:'Ready',detail:'',checkedAt:Date.now()});
useAppStore.setState({showSettings:true,activeSettingsTab:'browser',mcpCodexGlobalServers:{calendar:{type:'http',url:'https://example.test/mcp'},filesystem:{type:'stdio',command:'npx',enabled:false}},mcpGlobalServers:{filesystem:{type:'stdio',command:'npx'}}});
useAppStore.getState().setTheme('light');
createRoot(document.getElementById('root')).render(<Tooltip.Provider><div style={{height:'100vh',background:'var(--bg-primary)',color:'var(--text-primary)'}}><Settings/><ConfirmDialogHost/><Toaster/></div></Tooltip.Provider>);
`;
const main=String.raw`
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1124,height:1000,show:true});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
 const delay=ms=>new Promise(r=>setTimeout(r,ms));
 const js=async code=>{try{return await win.webContents.executeJavaScript(code,true);}catch(error){console.error('Failed evaluation:',code);throw error;}};
 const until=async(code)=>{for(let i=0;i<100;i++){if(await js(code))return;await delay(100);}throw Error('Timed out: '+code);};
 const click=async selector=>{await js('document.querySelector('+JSON.stringify(selector)+').click()');await delay(100);};
 const text=async(selector,value)=>{await js('var input=document.querySelector('+JSON.stringify('input'+selector)+');input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,'+JSON.stringify(value)+');input.dispatchEvent(new Event("input",{bubbles:true}))');};
 const shot=async name=>{await js('qa.toast.dismiss()');await delay(250);fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG());};
 const menu=async(scope,label,action)=>{await click('[aria-label="More actions for '+scope+': '+label+'"]');await js('Array.from(document.querySelectorAll("[role=menuitem]")).find(e=>e.textContent==='+JSON.stringify(action)+').click()');await delay(100);};
 const button=async(label,scope='main')=>{await js('Array.from(document.querySelectorAll('+JSON.stringify(scope+' button,'+scope+' [role=menuitem]')+')).find(e=>e.textContent.trim()==='+JSON.stringify(label)+').click()');await delay(150);};
 const nav=async tab=>{await js('qa.store.setState({activeSettingsTab:'+JSON.stringify(tab)+'})');await delay(250);};
 const choose=async(label,value)=>{await click('[aria-label="'+label+'"]');await click('[data-preference-option="'+value+'"]');};
 const search=async(query,label)=>{await text('[aria-label="Search settings"]',query);await delay(350);await button(label,'[aria-label="Settings search results"]');await delay(350);};
 try{
  await win.loadURL(process.env.QA_URL);await until('!!document.querySelector("[aria-label=\\"Toggle browser use\\"]")');
  await shot('browser-light');await click('[aria-label="Toggle browser use"]');assert.equal(await js('qa.permissions.enabled'),false);
  await button('Import…');await click('[aria-label="Chrome profile"]');await shot('browser-profile-menu');
  await js('Array.from(document.querySelectorAll("[role=menuitem]")).find(e=>e.textContent.includes("Work")).click()');await delay(100);
  await button('Import','[role=dialog]');assert.equal(await js('qa.calls.find(c=>c.type==="cookies").input.profilePath'),'/tmp/profile-2');
  await button('Clear');assert.equal(await js('qa.cookieStatus.cookieCount'),0);
  await nav('bridge');await until('!!document.querySelector("[aria-label=\\"App ID\\"]")');await shot('bridge-light');
  await text('[aria-label="App ID"]','test-changed');await button('Cancel');assert.equal(await js('document.querySelector("[aria-label=\\"App ID\\"]").value'),'test-app');
  await text('[aria-label="App ID"]','test-saved');await choose('Bridge runtime','codex');await button('Browse');await button('Save');
  assert.equal(await js('qa.bridge.appId'),'test-saved');assert.equal(await js('qa.bridge.provider'),'codex');assert.equal(await js('qa.bridge.defaultCwd'),'/tmp/new-project');
  await button('Start');assert.equal(await js('qa.bridgeStatus.running'),true);await button('Stop');
  await text('[aria-label="App ID"]','retry-value');await js('qa.failSave=true');await button('Save');assert.equal(await js('qa.bridge.appId'),'test-saved');await js('qa.failSave=false');await button('Save');
  await search('Allowed user IDs','Allowed user IDsBridge');assert.equal(await js('document.activeElement.dataset.settingsLabel'),'Allowed user IDs');assert.equal(await js('document.querySelector(".settings-disclosure").open'),true);
  await nav('profile');await until('!!document.querySelector("[aria-label=\\"Display name\\"]")&&!document.querySelector("[aria-label=\\"Display name\\"]").disabled');
  await text('[aria-label="Display name"]','QA Person');await button('Cancel');assert.equal(await js('qa.profile.displayName'),'Test User');await text('[aria-label="Display name"]','QA Person');await button('Save');assert.equal(await js('qa.profile.displayName'),'QA Person');await shot('profile-light');
  await nav('usage');await until('!!document.querySelector("[aria-label=\\"Usage provider\\"]")');
  assert.equal(await js('document.querySelector("main").textContent.includes("QA Person")'),false);await shot('usage-light');await choose('Usage provider','deepseek');assert.equal(await js('document.querySelector("[aria-label=\\"Usage provider\\"]").dataset.preferenceValue'),'deepseek');
  await nav('mcp');await js('qa.store.setState({mcpSettingsRuntime:"codex"})');await delay(300);await shot('mcp-light');
  await js('qa.failAuth=true');await button('Authorize');await delay(100);assert.equal(await js('Array.from(document.querySelectorAll("main button")).find(e=>e.textContent==="Authorize").disabled'),false);
  await js('qa.failAuth=false');await button('Authorize');assert.equal(await js('qa.calls.filter(c=>c.type==="oauth").length'),2);
  await js('window.dispatchEvent(new CustomEvent("codex-mcp-oauth-completed",{detail:{serverName:"calendar",success:false,error:"Cancelled"}}))');
  await click('[aria-label="Enable filesystem"]');assert.equal(await js('qa.store.getState().mcpCodexGlobalServers.filesystem.enabled'),undefined);
  await button('Add server');await text('[aria-label="Server name"]','test-server');await button('Save');assert.equal(await js('qa.store.getState().mcpCodexGlobalServers["test-server"]'),undefined);
  await text('[aria-label="Command to launch"]','test-command');await shot('mcp-editor-light');await button('Save');assert.equal(await js('qa.store.getState().mcpCodexGlobalServers["test-server"].command'),'test-command');
  await click('[aria-label="Configure test-server"]');await text('[aria-label="Command to launch"]','changed');await button('Cancel');assert.equal(await js('qa.store.getState().mcpCodexGlobalServers["test-server"].command'),'test-command');
  await click('[aria-label="More actions for test-server"]');await shot('mcp-menu');await button('Remove server','[role=menu]');await button('Remove server','[role=dialog]');assert.equal(await js('qa.store.getState().mcpCodexGlobalServers["test-server"]'),undefined);
  await search('filesystem codex','filesystemMCP Servers · Codex');assert.equal(await js('document.activeElement.dataset.settingsId'),'mcp:codex:filesystem');
  await search('filesystem claude','filesystemMCP Servers · Claude Code');assert.equal(await js('document.activeElement.dataset.settingsId'),'mcp:claude:filesystem');
  await search('Google bubble','GoogleProviders · Bubble');assert.equal(await js('document.activeElement.dataset.settingsId'),'Bubble:Google');
  await search('display name','Display nameProfile');assert.equal(await js('document.querySelector("h1").textContent'),'Profile');
  await js('qa.toast.dismiss();qa.store.getState().setTheme("dark")');await nav('bridge');await shot('bridge-dark');
  win.setContentSize(390,850);
  for(const tab of ['bridge','browser','mcp','usage','profile']){await nav(tab);await shot(tab+'-narrow');assert.equal(await js('document.querySelector("main").scrollWidth>document.querySelector("main").clientWidth'),false,tab+' does not overflow');}
  await js('qa.failBrowser=true');await nav('profile');await nav('browser');await until('!!document.querySelector("[role=alert]")');await js('qa.failBrowser=false');await button('Retry');await until('!!document.querySelector("[aria-label=\\"Toggle browser use\\"]")');
  await js('qa.failBridge=true');await nav('bridge');await until('!!document.querySelector("[role=alert]")');assert.equal(await js('document.querySelector("[aria-label=\\"App ID\\"]")'),null);await js('qa.failBridge=false');await button('Retry');await until('!!document.querySelector("[aria-label=\\"App ID\\"]")');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,captures:process.env.QA_CAPTURE}));app.exit(0);
 }catch(error){console.error(error);await shot('failure');app.exit(1);}
});
`;
let server;
try{
 await writeFile(path.join(tmp,'index.html'),'<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
 await writeFile(path.join(tmp,'harness.tsx'),harness);await writeFile(path.join(tmp,'main.cjs'),main);
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0,strictPort:false,watch:{ignored:['**/.aegis-design-qa/**']}}});await server.listen();
 const url=new URL(path.relative(root,tmp)+'/index.html',server.resolvedUrls.local[0]).href;
 await new Promise((resolve,reject)=>{
  const env={...process.env,QA_URL:url,QA_CAPTURE:path.join(root,'output/playwright/settings-integration')};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(tmp,'main.cjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',c=>process.stdout.write(c));child.stderr.on('data',c=>process.stderr.write(c));
  const timeout=setTimeout(()=>{child.kill();reject(Error('Providers test timed out'));},120000);
  child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);code===0?resolve():reject(Error('Settings integration regression failed'));});
 });
}finally{await server?.close();await rm(tmp,{recursive:true,force:true});}

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
const root=process.cwd();
await mkdir(path.join(root,'.aegis-design-qa'),{recursive:true});
const tmp=await mkdtemp(path.join(root,'.aegis-design-qa/providers-'));
const harness=String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Settings} from '/src/ui/components/settings/Settings';
import {useAppStore} from '/src/ui/store/useAppStore';
import {normalizeCompatibleProvidersConfig} from '/src/ui/hooks/useCompatibleProviderConfig';
import {Toaster} from 'sonner';
import {Tooltip} from '@base-ui-components/react/tooltip';
import '/src/ui/index.css';
const config=normalizeCompatibleProvidersConfig({});
config.providers.zhipu={...config.providers.zhipu,enabled:true,secret:'test-placeholder',model:'glm-5.3'};
window.qa={store:useAppStore,config,failSave:false,calls:[],bubble:{defaultProviderId:'openai',providers:[
 {id:'openai',name:'OpenAI',hasApiKey:true,configured:true,enabled:true,isDefault:true},
 {id:'zhipuai-coding-plan',name:'Zhipu Coding Plan',hasApiKey:true,configured:true,enabled:true,isDefault:false},
 {id:'deepseek',name:'DeepSeek',hasApiKey:false,configured:false,enabled:false,isDefault:false},
]},deep:{hasApiKey:true,keySource:'aegis',dshKeyAvailable:false}};
window.electron={
 getClaudeCompatibleProviderConfig:async()=>{if(qa.failLoad)throw Error('Load failed');return qa.config;},
 saveClaudeCompatibleProviderConfig:async next=>{if(qa.saveDelay)await new Promise(resolve=>setTimeout(resolve,qa.saveDelay));if(qa.failSave)throw Error('Could not save configuration');qa.calls.push('claude-save');return qa.config=next;},
 getAgentRuntimeDirectory:async()=>({checkedAt:Date.now(),entries:[]}),
 getBubbleProvidersConfig:async()=>qa.bubble,
 getBubbleProviderKey:async()=>new Promise(resolve=>setTimeout(()=>resolve('test-stored-key'),600)),
 setBubbleProviderKey:async(id,key)=>{qa.calls.push({type:'bubble-key',id,key});return qa.bubble={...qa.bubble,providers:qa.bubble.providers.map(p=>p.id===id?{...p,hasApiKey:true,configured:true,enabled:true}:p)};},
 setBubbleProviderEnabled:async(id,enabled)=>qa.bubble={...qa.bubble,providers:qa.bubble.providers.map(p=>p.id===id?{...p,enabled}:p)},
 setBubbleDefaultProvider:async id=>qa.bubble={...qa.bubble,defaultProviderId:id,providers:qa.bubble.providers.map(p=>({...p,isDefault:p.id===id}))},
 removeBubbleProvider:async id=>qa.bubble={...qa.bubble,providers:qa.bubble.providers.map(p=>p.id===id?{...p,hasApiKey:false,configured:false,enabled:false,isDefault:false}:p)},
 getDeepseekKeyStatus:async()=>qa.deep,getDeepseekApiKey:async()=>new Promise(resolve=>setTimeout(()=>resolve('test-deepseek-key'),600)),
 setDeepseekApiKey:async key=>{qa.calls.push({type:'deepseek-key',key});return qa.deep={...qa.deep,hasApiKey:true,keySource:'aegis'};},
 clearDeepseekApiKey:async()=>qa.deep={hasApiKey:false,keySource:null,dshKeyAvailable:false},
};
for(const name of ['Claude','Codex','Opencode','Kimi','Grok'])window.electron['get'+name+'RuntimeStatus']=async()=>({ready:true,kind:'ready',cliAvailable:true,summary:'Ready',detail:'',checkedAt:Date.now()});
useAppStore.setState({showSettings:true,activeSettingsTab:'providers'});
useAppStore.getState().setTheme('light');
createRoot(document.getElementById('root')).render(<Tooltip.Provider><div style={{height:'100vh',color:'var(--text-primary)',background:'var(--bg-primary)'}}><Settings/><Toaster/></div></Tooltip.Provider>);
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
 const shot=async name=>{await delay(200);fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG());};
 const menu=async(scope,label,action)=>{await click('[aria-label="More actions for '+scope+': '+label+'"]');await js('Array.from(document.querySelectorAll("[role=menuitem]")).find(e=>e.textContent==='+JSON.stringify(action)+').click()');await delay(100);};
 try{
  await win.loadURL(process.env.QA_URL);await until('!!document.querySelector(".provider-settings-expand")&&!document.querySelector(".provider-settings-expand").disabled');
  assert.equal(await js('document.querySelector(".provider-runtime").open'),false);
  await shot('providers-light');
  await click('[aria-label="Claude Code: Zhipu AI"]');await shot('providers-claude-editor');
  await text('[aria-label="Base URL"]','');await click('.provider-settings-editor [type=submit]');
  assert.equal(await js('qa.calls.length'),0,'invalid form does not save');
  await text('[aria-label="Base URL"]','https://example.test/anthropic');
  await js('qa.failSave=true');await click('.provider-settings-editor [type=submit]');
  assert(await js('document.querySelector(".provider-settings-editor").textContent.includes("Could not save configuration")'));
  await js('qa.failSave=false');await click('.provider-settings-editor [type=submit]');
  assert.equal(await js('qa.config.providers.zhipu.baseUrl'),'https://example.test/anthropic');
  await click('[aria-label="Bubble: OpenAI"]');
  await text('[aria-label="OpenAI API key for Bubble"]','test-replacement');await delay(700);
  assert.equal(await js('document.querySelector(".provider-key-input input").value'),'test-replacement','async credential load preserves typing');
  await click('[aria-label="Show OpenAI API key for Bubble"]');assert.equal(await js('document.querySelector(".provider-key-input input").type'),'text');
  await shot('providers-key-editor');await click('.provider-settings-editor .provider-secondary-button');
  assert.equal(await js('qa.calls.filter(c=>c.type==="bubble-key").length'),0,'cancel does not save key');
  await menu('Bubble','Zhipu Coding Plan','Make default');assert.equal(await js('qa.bubble.defaultProviderId'),'zhipuai-coding-plan');
  await click('[aria-label="Enable OpenAI for Bubble"]');assert.equal(await js('qa.bubble.providers[0].enabled'),false);
  await click('.provider-add-button');await click('[aria-label="Bubble: DeepSeek"]');await text('[aria-label="DeepSeek API key for Bubble"]','test-new-key');await click('.provider-settings-editor [type=submit]');
  assert(await js('qa.calls.some(c=>c.type==="bubble-key"&&c.id==="deepseek")'));
  await menu('Bubble','DeepSeek','Remove provider');assert.equal(await js('qa.bubble.providers.find(p=>p.id==="deepseek").configured'),false);
  await click('[aria-label="DeepSeek Harness: DeepSeek"]');await text('[aria-label="DeepSeek API key for DeepSeek Harness"]','test-harness-key');await delay(700);
  assert.equal(await js('document.querySelector(".provider-key-input input").value'),'test-harness-key');await click('.provider-settings-editor [type=submit]');
  assert(await js('qa.calls.some(c=>c.type==="deepseek-key"&&c.key==="test-harness-key")'));
  await menu('DeepSeek Harness','DeepSeek','Remove saved key');assert.equal(await js('qa.deep.hasApiKey'),false);
  await click('.provider-runtime summary');await shot('providers-agents');
  await js('qa.store.getState().setTheme("dark");document.querySelector("main").scrollTop=0');await shot('providers-dark');
  await click('[aria-label="More actions for Claude Code: Zhipu AI"]');await shot('providers-menu');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await delay(100);
  win.setContentSize(390,850);await js('document.querySelector("main").scrollTop=0');await shot('providers-narrow');
  assert.equal(await js('document.querySelector("main").scrollWidth>document.querySelector("main").clientWidth'),false);
  await click('[aria-label="Claude Code: Zhipu AI"]');await shot('providers-narrow-editor');
  assert.equal(await js('document.querySelector("main").scrollWidth>document.querySelector("main").clientWidth'),false);
  await js('qa.failLoad=true;qa.store.setState({showSettings:false})');await delay(100);
  await js('qa.store.setState({showSettings:true})');await until('!!document.querySelector(".provider-load-message[role=alert]")');
  assert.equal(await js('document.querySelector(\'[aria-label="Claude Code: Zhipu AI"]\').disabled'),true);
  await js('qa.failLoad=false;Array.from(document.querySelectorAll("button")).find(e=>e.textContent==="Retry").click()');
  await until('!document.querySelector(\'[aria-label="Claude Code: Zhipu AI"]\').disabled');
  await js('qa.saveDelay=600');await click('[aria-label="Enable Zhipu AI for Claude Code"]');
  assert.equal(await js('document.querySelector(\'[aria-label="Claude Code: Zhipu AI"]\').disabled'),true,'disable editing while configuration is saving');
  await until('!document.querySelector(\'[aria-label="Claude Code: Zhipu AI"]\').disabled');
  assert.equal(await js('qa.config.providers.zhipu.enabled'),false);
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
  const env={...process.env,QA_URL:url,QA_CAPTURE:path.join(root,'output/playwright/providers-settings')};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(tmp,'main.cjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',c=>process.stdout.write(c));child.stderr.on('data',c=>process.stderr.write(c));
  const timeout=setTimeout(()=>{child.kill();reject(Error('Providers test timed out'));},60000);
  child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);code===0?resolve():reject(Error('Providers Electron regression failed'));});
 });
}finally{await server?.close();await rm(tmp,{recursive:true,force:true});}

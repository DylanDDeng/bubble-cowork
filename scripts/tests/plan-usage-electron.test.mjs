import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';

const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const tmp = await mkdtemp(path.join(root, '.aegis-design-qa/plan-usage-'));
const harness = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import '/src/ui/index.css';
let clock = Date.now();
Date.now = () => clock;
const pending = {}, calls = {};
const load = id => { calls[id] = (calls[id] || 0) + 1; return new Promise((resolve, reject) => { pending[id] = { resolve, reject }; }); };
window.electron = {
 getKimiModelConfig: async () => ({ availableModels: [], options: [] }),
 getAgentUsageReport: async () => ({ totals: {totalTokens: 0, sessionCount: 1}, daily: [] }),
 getClaudePlanUsage: () => load('claude'), getCodexRateLimits: () => load('codex'),
 getGrokPlanUsage: () => load('grok'), getQoderPlanUsage: () => load('qoder'),
};
const { ClaudeUsageSettingsContent } = await import('/src/ui/components/settings/ClaudeUsageSettings');
window.qa = { calls, advance: () => { clock += 60001; }, fail: id => pending[id].reject(Error('Offline')),
 complete: id => {
 const reports = {
 claude: { source:'claude-agent-sdk', subscriptionType:'pro', rateLimitsAvailable:true, fiveHour:{utilization:25,resetsAt:null}, sevenDay:null, modelScoped:[] },
 grok: { source:'grok-acp', subscriptionTier:'X Premium+', creditUsagePercent:25, currentPeriod:null, onDemandCap:0, onDemandUsed:0, prepaidBalance:12 },
 qoder: { source:'qoder-sdk', userType:'pro', totalUsagePercentage:25, userQuota:null, addOnQuota:null, orgResourcePackage:null, expiresAt:null },
 codex: { source:'codex-app-server', rateLimits:{limitId:'codex', planType:'plus',primary:{usedPercent:25,remainingPercent:75,windowDurationMins:300,resetsAt:null}},rateLimitsByLimitId:{} },
 };
 pending[id].resolve({...reports[id], fetchedAt:clock});
 }};
function Harness() {
 const [shown, setShown] = useState(true);
 qa.show = value => flushSync(() => setShown(value));
 return <main style={{maxWidth:704,margin:'40px auto',padding:16}}>{shown && <ClaudeUsageSettingsContent/>}</main>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main = String.raw`
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1100,height:750,show:false,webPreferences:{contextIsolation:true}});
 const errors=[];
 win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
 const js=code=>win.webContents.executeJavaScript(code);
 const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const until=async(code)=>{for(let i=0;i<100;i++){if(await js(code))return;await delay(30);}throw Error('Timed out: '+code);};
 const select=async(label)=>{
  await js('document.querySelector("[aria-label=\\"Usage provider\\"]").click()');
  await until('Array.from(document.querySelectorAll("[role=menuitemradio], [role=menuitem]")).some(el=>el.textContent.includes('+JSON.stringify(label)+'))');
  await js('Array.from(document.querySelectorAll("[role=menuitemradio], [role=menuitem]")).find(el=>el.textContent.includes('+JSON.stringify(label)+')).click()');
  await delay(40);
 };
 const panel=title=>'document.querySelector('+JSON.stringify('[data-settings-label="'+title+'"]')+').textContent';
 try {
  await win.loadURL(process.env.QA_URL);
  await until('window.qa && qa.calls.claude===1');
  assert.equal(await js('qa.calls.codex || 0'),0,'hidden Codex does not probe');
  for(const [id,label,title] of [['claude','Claude Code','Claude plan limits'],['grok','Grok Build','Grok plan limits'],['qoder','Qoder','Qoder plan limits'],['codex','Codex CLI','Codex limits']]){
   if(id!=='claude')await select(label);
   await until('qa.calls.'+id+'===1');
   await js('qa.show(false)');
   await js('qa.complete('+JSON.stringify(id)+')');
   await delay(30);
   await js('qa.show(true)');
   if(id!=='claude')await select(label);
   await until(panel(title)+'.includes("75%")');
   assert.equal(await js('qa.calls.'+id),1,'remount uses completed '+id+' query');
   await js('qa.advance(); qa.show(false)');
   await js('qa.show(true)');
   if(id!=='claude')await select(label);
   await until('qa.calls.'+id+'===2');
   assert(await js(panel(title)+'.includes("75%")'),'old balance visible during '+id+' refresh');
   assert(await js(panel(title)+'.includes("Refreshing")'));
   if(id==='grok'){
    fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});
    fs.writeFileSync(path.join(process.env.QA_CAPTURE,'grok-refreshing.png'),(await win.webContents.capturePage()).toPNG());
   }
   await js('qa.fail('+JSON.stringify(id)+')');
   await until(panel(title)+'.includes("Update failed")');
   assert(await js(panel(title)+'.includes("75%")'),'offline retains '+id+' balance');
  }
  await select('Grok Build');
  win.setSize(390,750);await delay(100);
  assert(await js('document.documentElement.scrollWidth <= innerWidth'),'no narrow-screen overflow');
  fs.writeFileSync(path.join(process.env.QA_CAPTURE,'grok-narrow.png'),(await win.webContents.capturePage()).toPNG());
  assert.deepEqual(errors,[]);
  console.log('plan-usage-electron: all assertions passed');app.exit(0);
 }catch(error){console.error(error);app.exit(1);}
});
`;
let server;
try {
 await writeFile(path.join(tmp,'index.html'),'<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
 await writeFile(path.join(tmp,'harness.tsx'),harness);
 await writeFile(path.join(tmp,'main.cjs'),main);
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0,watch:{ignored:['**/.aegis-design-qa/**']}}});
 await server.listen();
 const env={...process.env,QA_URL:new URL(path.relative(root,tmp)+'/index.html',server.resolvedUrls.local[0]).href,QA_CAPTURE:path.join(root,'output/plan-usage-qa')};
 delete env.ELECTRON_RUN_AS_NODE;
 await new Promise((resolve,reject)=>{
  const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(tmp,'main.cjs')],{cwd:root,env,stdio:'inherit'});
  const timer=setTimeout(()=>{child.kill();reject(Error('Usage test timed out'));},60000);
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Usage UI regression failed'));});
 });
} finally {await server?.close();await rm(tmp,{recursive:true,force:true});}

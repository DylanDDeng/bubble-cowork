import {createServer} from 'vite';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
const root=process.cwd();
await mkdir('.aegis-design-qa',{recursive:true});
const dir=await mkdtemp(path.join(root,'.aegis-design-qa/profile-usage-'));
let server;
const harness=`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {Toaster} from 'sonner';
import {Sidebar,SidebarHeaderTrigger} from '/src/ui/components/Sidebar';
import {Settings} from '/src/ui/components/settings/Settings';
import {useAppStore} from '/src/ui/store/useAppStore';
import '/src/ui/index.css';

const calls=[];let fail=false,hold=false,resolveClaude;const pending=[];let historyHold=false;const pendingHistory=[];
let profile={displayName:'BubbleBrain',handle:'bubblebrain',customized:true};
const claude=()=>({source:'claude-agent-sdk',fetchedAt:Date.now(),rateLimitsAvailable:true,subscriptionType:'pro',fiveHour:{utilization:28,resetsAt:null},sevenDay:{utilization:62,resetsAt:null},sevenDayOpus:null,sevenDaySonnet:null,modelScoped:[],extraUsage:null});
const counted=(name,load)=>{calls.push(name);const run=()=>fail?Promise.reject(Error('Offline')):Promise.resolve(load());return hold?new Promise((resolve,reject)=>pending.push(()=>run().then(resolve,reject))):run()};
window.electron={
 getUserProfile:async()=>profile,saveUserProfile:async p=>(profile={...profile,...p}),
 getBubbleProvidersConfig:async()=>({providers:[]}),getGitBranch:async()=>({ok:false}),
 getKimiModelConfig:async()=>({defaultModel:null,options:[],availableModels:[]}),
 getClaudePlanUsage:()=>counted('claude',()=>calls.filter(c=>c==='claude').length===1?new Promise(r=>resolveClaude=()=>r(claude())):claude()),
 getCodexRateLimits:()=>counted('codex',()=>({source:'codex-app-server',fetchedAt:Date.now(),rateLimits:null,rateLimitsByLimitId:{codex:{limitId:'codex',limitName:'Codex',primary:{usedPercent:15,remainingPercent:85,windowDurationMins:300,resetsAt:null},secondary:{usedPercent:36,remainingPercent:64,windowDurationMins:10080,resetsAt:null},credits:null,planType:'pro',rateLimitReachedType:null}}})),
 getGrokPlanUsage:()=>counted('grok',()=>({source:'grok-acp',fetchedAt:Date.now(),creditUsagePercent:10,currentPeriod:{type:'USAGE_PERIOD_TYPE_WEEKLY',startsAt:null,endsAt:null},subscriptionTier:'Pro',onDemandCap:null,onDemandUsed:null,prepaidBalance:null})),
 getQoderPlanUsage:()=>counted('qoder',()=>({source:'qoder-sdk',fetchedAt:Date.now(),totalUsagePercentage:40,userQuota:null,addOnQuota:null,orgResourcePackage:null,expiresAt:null,userType:'pro'})),
 getAgentUsageReport:async(provider,days)=>{calls.push(provider+':'+days);if(days===365&&historyHold)await new Promise(resolve=>pendingHistory.push(resolve));if(fail||provider==='deepseek')throw Error('Unavailable');const tokens=provider==='bubble'?(days===365?12000000:1200000):provider==='claude'&&days===365?7800000:0;return {rangeDays:days,totals:{inputTokens:tokens,outputTokens:0,totalTokens:tokens,totalCostUsd:0,sessionCount:provider==='kimi'?2:tokens?1:0,cacheReadTokens:0,cacheHitRate:0},models:[],daily:[{date:new Date().toISOString().slice(0,10),totalTokens:tokens,byModel:{}}]};},
};
useAppStore.setState({sessions:{},sidebarCollapsed:false,sidebarWidth:280,showSettings:false,activeSettingsTab:'profile'});
useAppStore.getState().setTheme('light');
window.qa={store:useAppStore,calls,holdHistory:()=>historyHold=true,settleHistory:value=>{fail=value;historyHold=false;pendingHistory.splice(0).forEach(resolve=>resolve())},resolveClaude:()=>resolveClaude(),expire:()=>window.qaTimeOffset+=61000,fail:()=>fail=true,hold:()=>hold=true,settle:value=>{fail=value;hold=false;pending.splice(0).forEach(run=>run())},refresh:()=>{window.qaTimeOffset+=61000;window.qaRefreshers.forEach(run=>run())}};
function Harness(){const settings=useAppStore(s=>s.showSettings);return <Tooltip.Provider><div style={{height:'100vh',display:'flex',background:'var(--bg-primary)',color:'var(--text-primary)'}}>{settings?<Settings/>:<><Sidebar/><main style={{padding:24,flex:1}}><SidebarHeaderTrigger/><h1>Workspace</h1></main></>}</div><Toaster/></Tooltip.Provider>}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main=String.raw`
const {app,BrowserWindow}=require('electron');
// CI runners have Reduce Motion on; tests expect the default motion preference.
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1050,height:800,show:true});const errors=[];
 win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=s=>win.webContents.executeJavaScript(s,true).catch(e=>{console.error('Failed script:',s);throw e}),delay=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async(s)=>{for(let i=0;i<100;i++){if(await js(s))return;await delay(80)}throw Error('Timeout: '+s)};
 const trigger='[aria-label^="Profile menu:"]';
 const click=async selector=>{await js('document.querySelector('+JSON.stringify(selector)+').click()');await delay(150)};
 const textClick=async text=>{await js('[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent.trim()==='+JSON.stringify(text)+').click()');await delay(150)};
 const key=async keyCode=>{win.webContents.sendInputEvent({type:'keyDown',keyCode});if(keyCode==='Return')win.webContents.sendInputEvent({type:'char',keyCode:'\r'});win.webContents.sendInputEvent({type:'keyUp',keyCode});await delay(150)};
 const shot=async name=>{await delay(250);fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG())};
 const rect=async selector=>js('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right}})()');
 const row=provider=>'[data-usage-provider="'+provider+'"]';
 const rowText=provider=>js('document.querySelector('+JSON.stringify(row(provider))+').textContent');
 const open=async()=>{await click(trigger);const u=await js('[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent.trim()==="Usage").getBoundingClientRect().toJSON()');win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(u.x+30),y:Math.round(u.y+15)});await textClick('Usage');await until('document.querySelectorAll("[data-usage-provider]").length===9')};
 const outside=async()=>{win.webContents.sendInputEvent({type:'mouseMove',x:900,y:100});win.webContents.sendInputEvent({type:'mouseDown',x:900,y:100,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',x:900,y:100,button:'left',clickCount:1});await delay(400)};
 try{
  await win.loadURL(process.env.QA_URL);await until('document.querySelector('+JSON.stringify(trigger)+')?.textContent.includes("BubbleBrain")');
  assert.equal(await js('qa.calls.length'),0,'no usage requests before menu opens');
  await click(trigger);assert.equal(await js('qa.calls.length'),0,'profile menu alone does not fetch usage');
  // Exercise a real hover into the submenu, including the gap between menus.
  const usageTrigger=await js('[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent.trim()==="Usage").getBoundingClientRect().toJSON()');
  win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(usageTrigger.x+30),y:Math.round(usageTrigger.y+15)});
  await until('document.querySelectorAll("[data-usage-provider]").length===9');
  await until('document.querySelector('+JSON.stringify(row('bubble'))+').textContent.includes("1.2M tokens")');
  assert.ok((await rowText('claude')).includes('Loading usage'),'slow provider does not block others');
  assert.ok((await rowText('kimi')).includes('Tokens not reported'));
  assert.ok((await rowText('pi')).includes('No usage in last 30 days'));
  assert.ok((await rowText('deepseek')).includes('Usage unavailable'));
  const initialHeight=await js('document.querySelector("[data-usage-provider]").closest("[role=menu]").getBoundingClientRect().height');
  await js('qa.resolveClaude()');await until('document.querySelector('+JSON.stringify(row('claude'))+').textContent.includes("72%")');
  assert.ok((await rowText('codex')).includes('5h 85% · Weekly 64%'));
  assert.equal(await js('document.querySelector("[data-usage-provider]").closest("[role=menu]").getBoundingClientRect().height'),initialHeight,'initial load preserves menu height');
  const submenu=await rect('[data-usage-provider="claude"]');
  win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(usageTrigger.right+4),y:Math.round(usageTrigger.y+15)});await delay(70);
  win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(submenu.x+30),y:Math.round(submenu.y+15)});await delay(300);
  assert.equal(await js('document.querySelectorAll("[data-usage-provider]").length'),9,'pointer crosses submenu gap');
  const menuBounds=await js('document.querySelector("[data-usage-provider]").closest("[role=menu]").getBoundingClientRect().toJSON()');
  assert.ok(menuBounds.x>=270 && menuBounds.bottom<=768 && menuBounds.y>=0,'submenu opens beside parent inside viewport');
  await shot('usage-light');
  // Sample geometry every animation frame while mounted queries refresh, fail and recover.
  await js('qa.geometry=()=>{const rows=[...document.querySelectorAll("[data-usage-provider]")];const menu=rows[0].closest("[role=menu]").getBoundingClientRect();return [menu.x,menu.y,menu.width,menu.height,rows[0].parentElement.scrollTop,...rows.flatMap(row=>{const r=row.getBoundingClientRect();return [r.y,r.height]})]};qa.layoutSamples=[];qa.sampling=true;const sample=()=>{if(!qa.sampling)return;qa.layoutSamples.push(qa.geometry());requestAnimationFrame(sample)};sample()');
  const stable=await js('qa.geometry()');
  await js('qa.hold();qa.refresh()');
  await until('document.querySelector('+JSON.stringify(row('codex'))+').textContent.includes("Refreshing")');
  assert.ok((await rowText('codex')).includes('85%'),'refresh retains quota');
  await delay(200);assert.deepEqual(await js('qa.geometry()'),stable,'pending refresh preserves geometry');
  await js('qa.settle(true)');
  await until('document.querySelector('+JSON.stringify(row('codex'))+').textContent.includes("Update failed")');
  await delay(150);assert.deepEqual(await js('qa.geometry()'),stable,'failure preserves geometry');
  await shot('usage-refresh-failed');
  await js('qa.hold();qa.refresh()');
  await until('document.querySelector('+JSON.stringify(row('codex'))+').textContent.includes("Refreshing")');
  await js('qa.settle(false)');
  await until('document.querySelector('+JSON.stringify(row('codex'))+').querySelector("[role=status]").textContent===""');
  await delay(150);await js('qa.sampling=false');
  const samples=await js('qa.layoutSamples');assert.ok(samples.length>10);
  for(const sample of samples)assert.deepEqual(sample,stable,'no frame resizes or repositions menu/rows');
  const codexCalls=await js('qa.calls.filter(c=>c==="codex").length');
  const calls=await js('qa.calls.length');await outside();await open();assert.equal(await js('qa.calls.length'),calls,'reopen uses cached reports');
  // Full usage uses the yearly report prefetched by the menu, without a loading frame.
  assert.equal(await js('qa.calls.filter(c=>c==="claude:365").length'),3,'only the selected yearly report was refreshed with the menu');
  assert.equal(await js('qa.calls.filter(c=>c.endsWith(":365")&&!c.startsWith("claude:")).length'),0,'other providers do not gate the selected report');
  await js('qa.detailFrames=[];qa.detailObserver=new MutationObserver(()=>{const main=document.querySelector(".aegis-settings main");if(main)qa.detailFrames.push(main.textContent)});qa.detailObserver.observe(document.getElementById("root"),{subtree:true,childList:true,characterData:true})');
  await textClick('View full usage');await until('document.querySelector("h1")?.textContent==="Usage"');
  assert.equal(await js('document.querySelector(".aegis-settings main").textContent.includes("7.8M")'),true,'first detail paint has prefetched yearly data');
  assert.equal(await js('qa.detailFrames.some(t=>t.includes("Loading usage"))'),false,'full usage does not paint a loading placeholder');
  // A slow refresh may outlive the page. Reopening joins it and keeps the charts.
  await js('qa.holdHistory();qa.refresh()');await until('document.querySelector("[data-usage-report-status]").textContent.includes("Refreshing")');
  const yearlyCalls=await js('qa.calls.filter(c=>c==="claude:365").length');
  await js('qa.store.getState().setShowSettings(false)');await delay(150);await open();await textClick('View full usage');
  assert.equal(await js('qa.calls.filter(c=>c==="claude:365").length'),yearlyCalls,'remount deduplicates the pending yearly request');
  assert.equal(await js('document.querySelector(".aegis-settings main").textContent.includes("7.8M")'),true,'cached charts survive remount during refresh');
  await js('qa.settleHistory(true)');await until('document.querySelector("[data-usage-report-status]").textContent.includes("Update failed")');
  assert.equal(await js('document.querySelector(".aegis-settings main").textContent.includes("7.8M")'),true,'refresh failure retains charts');
  await shot('usage-detail-saved');
  await js('qa.holdHistory();qa.refresh()');await until('document.querySelector("[data-usage-report-status]").textContent.includes("Refreshing")');
  await js('qa.settleHistory(false)');await until('!document.querySelector("[data-usage-report-status]").textContent.includes("Refreshing")');
  assert.equal(await js('qa.detailFrames.some(t=>t.includes("Loading usage"))'),false,'reopen, failure and recovery never replace cached charts with loading');
  await js('qa.detailObserver.disconnect();qa.store.getState().setShowSettings(false)');await delay(150);await open();
  const detailQuotaCalls=await js('qa.calls.filter(c=>c==="codex").length');
  await click(row('codex'));await until('document.querySelector("h1")?.textContent==="Usage"');
  assert.equal(await js('qa.store.getState().usageSettingsProvider'),'codex');
  assert.equal(await js('document.querySelector("[aria-label=\\"Usage provider\\"]").textContent.includes("Codex CLI")'),true);
  assert.equal(await js('qa.calls.filter(c=>c==="codex").length'),detailQuotaCalls,'detail shares quota cache with menu');
  // Every provider routes to its own selection, including providers with no quota API.
  for(const provider of ['claude','opencode','kimi','grok','pi','qoder','bubble','deepseek']){
   await js('qa.store.getState().setShowSettings(false)');await delay(150);await open();await click(row(provider));
   await until('document.querySelector("h1")?.textContent==="Usage"');
   assert.equal(await js('qa.store.getState().usageSettingsProvider'),provider);
   if(provider==='bubble'){await until('document.querySelector(".aegis-settings main").textContent.includes("12M")');assert.equal(await js('document.querySelector(".aegis-settings main").textContent.includes("1.2M")'),false,'30-day totals never stand in for yearly detail');}
  }
  await js('qa.store.getState().setShowSettings(false);qa.store.getState().setTheme("dark");qa.expire();qa.fail()');await delay(150);await open();
  await until('document.querySelector('+JSON.stringify(row('codex'))+').textContent.includes("Update failed")');
  assert.ok((await rowText('codex')).includes('85%'),'failed refresh keeps quota');
  assert.ok((await rowText('bubble')).includes('1.2M'),'failed refresh keeps local usage');
  assert.ok((await rowText('codex')).includes('Saved'),'stale values include timestamp');
  await shot('usage-dark-stale');
  await textClick('View full usage');await until('document.querySelector("h1")?.textContent==="Usage"');
  assert.equal(await js('qa.store.getState().usageSettingsProvider'),'deepseek','full usage preserves last selection');
  await js('qa.store.getState().setShowSettings(false)');await delay(150);
  await click(trigger);await js('[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent.startsWith("Settings")).click()');await delay(150);assert.equal(await js('qa.store.getState().showSettings'),true,'Settings still opens');
  await js('qa.store.getState().setShowSettings(false);qa.store.getState().setSidebarCollapsed(true);qa.store.getState().setSidebarPeek(true)');await delay(350);await open();
  const c=await rect(row('codex'));win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(c.x+20),y:Math.round(c.y+15)});await delay(400);
  assert.equal(await js('qa.store.getState().sidebarPeek'),true,'portal submenu retains sidebar peek');
  await outside();assert.equal(await js('qa.store.getState().sidebarPeek'),false,'outside dismissal releases peek');
  await js('qa.store.getState().setSidebarCollapsed(false)');await delay(250);
  await js('document.querySelector('+JSON.stringify(trigger)+').focus()');await key('Return');await key('Right');await until('document.querySelectorAll("[data-usage-provider]").length===9');
  await key('Escape');assert.equal(await js('document.querySelectorAll("[data-usage-provider]").length'),0);assert.equal(await js('document.querySelectorAll("[role=menu]").length'),1);
  await key('Escape');assert.equal(await js('document.querySelectorAll("[role=menu]").length'),0);
  win.setSize(760,480);await delay(200);await open();
  const small=await js('document.querySelector("[data-usage-provider]").closest("[role=menu]").getBoundingClientRect().toJSON()');
  assert.ok(small.y>=0 && small.bottom<=448,'small window clamps submenu height');
  assert.equal(await js('(()=>{const l=document.querySelector("[data-usage-provider]").parentElement;return l.scrollHeight>l.clientHeight})()'),true,'provider list scrolls');
  await shot('usage-small-window');
  await js('document.querySelector("[data-usage-provider]").parentElement.scrollTop=100');
  const scrolled=await js('qa.geometry()');await js('qa.hold();qa.refresh()');await delay(150);
  assert.deepEqual(await js('qa.geometry()'),scrolled,'refresh preserves scroll position');
  await js('qa.settle(false)');await delay(200);assert.deepEqual(await js('qa.geometry()'),scrolled,'recovery preserves scroll position');
  assert.deepEqual(errors,[]);console.log('PASS: lazy/independent usage, hover and keyboard submenus, 9 provider routes, prefetched/persistent yearly details without loading flashes, shared quotas, cache reopen/failure, stable geometry throughout refresh/failure/recovery, Settings, collapsed peek and small window scrolling');app.exit(0);
 }catch(e){console.error(e,errors);await shot('failure');app.exit(1)}
});
`;
try{
 await mkdir(path.join(root,'output/sidebar-profile-usage'),{recursive:true});
 await writeFile(path.join(dir,'index.html'),'<html><body style="margin:0"><div id="root"></div><script>window.qaTimeOffset=0;const realNow=Date.now;Date.now=()=>realNow()+window.qaTimeOffset;window.qaRefreshers=new Map();const realInterval=window.setInterval,realClear=window.clearInterval;window.setInterval=(fn,ms,...args)=>{const id=realInterval(fn,ms,...args);if(ms===60000)window.qaRefreshers.set(id,()=>fn(...args));return id};window.clearInterval=id=>{window.qaRefreshers.delete(id);realClear(id)};</script><script type="module" src="./probe.tsx"></script></body></html>');
 await writeFile(path.join(dir,'probe.tsx'),harness);await writeFile(path.join(dir,'main.cjs'),main);
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0}});await server.listen();
 const env={...process.env,QA_URL:new URL(path.relative(root,dir)+'/index.html',server.resolvedUrls.local[0]).href,QA_CAPTURE:path.join(root,'output/sidebar-profile-usage')};delete env.ELECTRON_RUN_AS_NODE;
 await new Promise((resolve,reject)=>{const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(dir,'main.cjs')],{env,stdio:'inherit'});const timer=setTimeout(()=>{child.kill();reject(Error('timeout'))},60000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('exit '+code))})});
}finally{await server?.close();await rm(dir,{recursive:true,force:true})}

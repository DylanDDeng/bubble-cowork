import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';

const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const temp = await mkdtemp(path.join(root, '.aegis-design-qa/codex-usage-cost-'));
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import '/src/ui/index.css';
let clock=Date.now();Date.now=()=>clock;
let report=null;
window.electron={getKimiModelConfig:async()=>({availableModels:[],options:[]}),getAgentUsageReport:async()=>report,getCodexRateLimits:async()=>null};
const {useAppStore}=await import('/src/ui/store/useAppStore');
const {prefetchAgentUsageReport}=await import('/src/ui/hooks/useAgentUsageReport');
const {ClaudeUsageSettingsContent}=await import('/src/ui/components/settings/ClaudeUsageSettings');
useAppStore.getState().setUsageSettingsProvider('codex');
useAppStore.getState().setTheme('light');
window.qa={load:async (next,provider='codex')=>{report=next;clock+=60001;await prefetchAgentUsageReport(provider,365);useAppStore.getState().setUsageSettingsProvider(provider);},dark:()=>useAppStore.getState().setTheme('dark')};
createRoot(document.getElementById('root')).render(<main style={{maxWidth:900,margin:'32px auto',padding:16}}><ClaudeUsageSettingsContent/></main>);
`;
const main = String.raw`
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=process.env.QA_ROOT,temp=process.env.QA_TEMP;
app.setPath('userData',path.join(temp,'profile'));fs.mkdirSync(app.getPath('userData'),{recursive:true});
// Isolate both Codex search roots; tests must never read or write personal history.
require('node:os').homedir=()=>path.join(temp,'home');
process.env.CODEX_HOME=path.join(temp,'home','.codex');fs.mkdirSync(process.env.CODEX_HOME,{recursive:true});
app.whenReady().then(async()=>{
 let store,db;
 try{
  const Database=require(path.join(root,'node_modules/better-sqlite3'));
  db=new Database(path.join(process.env.CODEX_HOME,'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,model TEXT,tokens_used INTEGER)');
  const rollout=path.join(temp,'rollout.jsonl');
  db.prepare('INSERT INTO threads VALUES(?,?,?,?)').run('cost-test',rollout,'gpt-5.5',0);
  store=require(path.join(root,'dist-electron/electron/libs/session-store.js'));store.initialize();
  const session=store.createSession({provider:'codex',model:'gpt-5.5',cwd:temp,title:'Usage cost regression'});
  store.updateCodexSessionId(session.id,'cost-test');
  function reportFor(segments){
   const cumulative={input_tokens:0,cached_input_tokens:0,output_tokens:0,cache_write_input_tokens:0,total_tokens:0};const lines=[];
   for(const [model,input,cached,output,age=0,writes=0] of segments){
    const last={input_tokens:input,cached_input_tokens:cached,output_tokens:output,cache_write_input_tokens:writes,total_tokens:input+output};
    for(const key of Object.keys(cumulative))cumulative[key]+=last[key];
    lines.push(JSON.stringify({type:'turn_context',payload:{model}}));
    const event=JSON.stringify({type:'event_msg',timestamp:new Date(Date.now()-age*86400000).toISOString(),payload:{type:'token_count',info:{last_token_usage:last,total_token_usage:{...cumulative}}}});
    lines.push(event,event); // Repeated native snapshots must not inflate coverage or tokens.
   }
   fs.writeFileSync(rollout,lines.join('\n'));
   store.updateSessionModel(session.id,'gpt-5.5'); // Normal store invalidation, not a private test hook.
   return store.getCodexUsageReport(365);
  }
  const known=['gpt-5.5',100000,50000,1000];
  const current=reportFor([known,['gpt-5.6-sol',100000,30000,2000,0,10000],['gpt-5.6-terra',100000,30000,2000,0,10000],['gpt-6-astra',100000,30000,2000,0,10000],['gpt-5.6-luna',100000,30000,2000,0,10000]]);
  assert.equal(current.costMode,'estimated');assert.equal(current.costBasis,'api-standard');
  assert.equal(current.totals.totalTokens,509000);assert(Math.abs(current.totals.totalCostUsd-1.6945)<1e-10);
  assert.deepEqual(current.costCoverage,{pricedTokens:509000,unpricedTokens:0,unpricedModels:[]});
  assert.equal(current.daily.reduce((sum,day)=>sum+day.totalTokens,0),509000);
  assert(Math.abs(current.daily.reduce((sum,day)=>sum+Object.values(day.byModelCostUsd).reduce((a,b)=>a+b,0),0)-1.6945)<1e-10);
  assert.equal(store.getCodexUsageReport(365),current,'cache retains cost basis and coverage');
  const mixed=reportFor([known,['future-unpriced-model',1000000,500000,100]]);
  assert.equal(mixed.costMode,'partial');assert(Math.abs(mixed.totals.totalCostUsd-.305)<1e-10);
  assert.deepEqual(mixed.costCoverage,{pricedTokens:101000,unpricedTokens:1000100,unpricedModels:['future-unpriced-model']});
  assert(!Object.hasOwn(mixed.daily.find(day=>day.totalTokens>0).byModelCostUsd,'future-unpriced-model'));
  const unknown=reportFor([['future-unpriced-model',1000,900,20]]);
  assert.equal(unknown.costMode,'unavailable');assert.equal(unknown.costCoverage.pricedTokens,0);
  const priced=reportFor([known]);assert.equal(priced.costMode,'estimated');assert.equal(priced.costCoverage.unpricedTokens,0);
  const ranged=reportFor([['unknown-older-model',1000,0,10,400],known]);
  assert.equal(ranged.costMode,'estimated');assert.equal(ranged.totals.totalTokens,101000,'out-of-range unknown usage must not affect coverage');
  const empty=reportFor([]);assert.equal(empty.costMode,'estimated');assert.equal(empty.totals.totalTokens,0);
  const zero=reportFor([['unpriced-zero',0,0,0],known]);assert.equal(zero.costMode,'estimated','zero usage needs no price');
  // Agent-reported prices remain authoritative; this change must not replace
  // an SDK amount with a token estimate, including a genuinely reported zero.
  const native=store.createSession({provider:'claude',model:'claude-sonnet-4-6',cwd:temp,title:'Reported cost'});
  store.addMessage(native.id,{type:'result',subtype:'success',duration_ms:1,total_cost_usd:12.34,usage:{input_tokens:1000,output_tokens:100}});
  store.addMessage(native.id,{type:'result',subtype:'success',duration_ms:1,total_cost_usd:0,usage:{input_tokens:1000,output_tokens:100}});
  const reported=store.getAgentUsageReport('claude',365);assert.equal(reported.totals.totalCostUsd,12.34);
  assert(!reported.costMode || reported.costMode==='actual');
  // Codex's adapter emits a placeholder zero, not a reported bill.
  store.addMessage(session.id,{type:'result',subtype:'success',duration_ms:1,total_cost_usd:0,usage:{input_tokens:0,output_tokens:0}});
  assert(Math.abs(store.getCodexUsageReport(365).totals.totalCostUsd-.305)<1e-10);
  const clock=Date.now();
  reportFor([['future-unpriced-model',100000,30000,2000,-1/86400,10000],['gpt-6-astra',100000,30000,2000,-2/86400,10000]]);
  store.addMessage(session.id,{type:'result',subtype:'success',createdAt:clock+1250,duration_ms:1,total_cost_usd:999,
    costSource:'reported',sourceProvider:'claude',parentToolUseId:'delegated',usage:{input_tokens:1,output_tokens:1}});
  store.addMessage(session.id,{type:'result',subtype:'success',createdAt:clock+1500,duration_ms:1,total_cost_usd:42,costSource:'reported',usage:{input_tokens:100000,output_tokens:2000}});
  const combined=store.getCodexUsageReport(365);
  assert(Math.abs(combined.totals.totalCostUsd-42.855)<1e-10,'reported first turn replaces its estimate; next turn uses API fallback');
  assert.equal(combined.costBasis,'reported-and-api');assert.equal(combined.costMode,'estimated');assert.equal(combined.costCoverage.unpricedTokens,0);
  store.addMessage(session.id,{type:'result',subtype:'success',createdAt:clock+2500,duration_ms:1,total_cost_usd:0,costSource:'reported',usage:{input_tokens:100000,output_tokens:2000}});
  const nativeOnly=store.getCodexUsageReport(365);
  assert.equal(nativeOnly.totals.totalCostUsd,42,'explicitly reported zero overrides the fallback');assert.equal(nativeOnly.costMode,'actual');assert.equal(nativeOnly.costBasis,undefined);
  // Other runners must share the same priority rules, including a returned free zero.
  const near=(actual,expected)=>assert(Math.abs(actual-expected)<1e-9,actual+' != '+expected);
  const result=(extra={})=>({type:'result',subtype:'success',duration_ms:1,total_cost_usd:0,
    usage:{input_tokens:1000,output_tokens:100},...extra});
  const costTestSessions={};
  for(const provider of ['kimi','grok','qoder','pi','bubble']){
    const s=store.createSession({provider,model:'gpt-5.5',cwd:temp,title:provider+' cost priority'});costTestSessions[provider]=s.id;
    store.addMessage(s.id,result({total_cost_usd:9,costSource:'reported'}));
    store.addMessage(s.id,result({costSource:'reported'}));
    let r=store.getAgentUsageReport(provider,365);near(r.totals.totalCostUsd,9);assert.equal(r.costMode,'actual');
    store.addMessage(s.id,result({costSource:'unavailable'}));
    r=store.getAgentUsageReport(provider,365);near(r.totals.totalCostUsd,9.008);assert.equal(r.costMode,'estimated');
    store.addMessage(s.id,result({costSource:'unavailable',model:'unpriced-model'}));
    r=store.getAgentUsageReport(provider,365);near(r.totals.totalCostUsd,9.008);assert.equal(r.costMode,'partial');
    assert(r.note.includes('unpriced-model'));
    store.addMessage(s.id,result({total_cost_usd:999,costSource:'reported',sourceProvider:'claude',parentToolUseId:'delegation'}));
    near(store.getAgentUsageReport(provider,365).totals.totalCostUsd,9.008);
  }
  // Real adapter folds: one reported step, one missing step, one returned free step.
  const {emptyCostDetails}=require(path.join(root,'dist-electron/electron/libs/agent-cost.js'));
  const {PiSdkAdapter}=require(path.join(root,'dist-electron/electron/libs/provider/pi-sdk-adapter.js'));
  const {BubbleSdkAdapter}=require(path.join(root,'dist-electron/electron/libs/provider/bubble-sdk-adapter.js'));
  for(const provider of ['pi','bubble']){
    const adapter=provider==='pi'?new PiSdkAdapter():new BubbleSdkAdapter();const emitted=[];
    adapter.events.on('event',e=>{if(e.type==='message'&&e.message.type==='result')emitted.push(e.message)});
    const s={threadId:'cost-fold',model:'gpt-5.5',usage:{input_tokens:0,output_tokens:0},
      costDetails:emptyCostDetails(),session:{model:{provider:'openai',id:'gpt-5.5'}},
      ingestedUsageKeys:new Set(),currentAssistant:null,durationStartMs:Date.now()};
    for(const [i,usd] of [3,undefined,0].entries()){
      if(provider==='pi')adapter.ingestUsage(s,{role:'assistant',model:'gpt-5.5',timestamp:i+1,
        usage:{input:1000,output:100,...(usd===undefined?{}:{cost:{total:usd}})}});
      else adapter.handleBubbleEvent(s,{type:'turn_end',usage:{promptTokens:1000,completionTokens:100},
        ...(usd===undefined?{}:{cost:{currency:'USD',cost:usd}})});
    }
    adapter.emitResult(s);assert.equal(emitted.length,1);near(emitted[0].total_cost_usd,3.008);
    assert.equal(emitted[0].costDetails.reportedCount,2);assert.equal(emitted[0].costDetails.estimatedCount,1);
    const stored=store.createSession({provider,model:'gpt-5.5',cwd:temp,title:'Adapter persistence'});
    store.addMessage(stored.id,emitted[0]);near(store.getAgentUsageReport(provider,365).totals.totalCostUsd,12.016);
  }
  // OpenCode's native database: explicit cost 0 is free; an absent key needs fallback.
  const ocDir=path.join(temp,'home','.local','share','opencode');fs.mkdirSync(ocDir,{recursive:true});
  const oc=new Database(path.join(ocDir,'opencode.db'));
  oc.exec('CREATE TABLE message(session_id TEXT,time_created INTEGER,data TEXT)');
  const os=store.createSession({provider:'opencode',model:'gpt-5.5',cwd:temp,title:'Native cost presence'});
  store.updateOpencodeSessionId(os.id,'oc-cost');
  for(const cost of [0,undefined,7])oc.prepare('INSERT INTO message VALUES(?,?,?)').run('oc-cost',Date.now(),JSON.stringify({
    role:'assistant',modelID:'gpt-5.5',tokens:{input:1000,output:100},...(cost===undefined?{}:{cost})}));
  const or=store.getAgentUsageReport('opencode',365);near(or.totals.totalCostUsd,7.008);assert.equal(or.costMode,'estimated');oc.close();
  store.close();store.initialize();near(store.getAgentUsageReport('bubble',365).totals.totalCostUsd,12.016);
  // DeepSeek's historical double-fold repair and request-time estimates stay intact.
  const {estimateDeepseekUsageCost,DEEPSEEK_COST_ACCOUNTING}=require(path.join(root,'dist-electron/electron/libs/deepseek-pricing.js'));
  const ds=store.createSession({provider:'deepseek',model:'deepseek-v4-flash',cwd:temp,title:'Historical pricing repair'});
  const at=Date.now();
  store.addMessage(ds.id,result({createdAt:at,usage:{input_tokens:200,output_tokens:40,cache_read_input_tokens:10}}));
  const expected=estimateDeepseekUsageCost('deepseek-v4-flash',{inputTokens:100,outputTokens:20,cacheReadTokens:5},at);
  near(store.getAgentUsageReport('deepseek',365).totals.totalCostUsd,expected);
  assert.equal(store.getAgentUsageReport('deepseek',365).costMode,'estimated');
  store.addMessage(ds.id,result({usageAccounting:'deepseek-step-last-wins-v1',total_cost_usd:.003,
    costAccounting:DEEPSEEK_COST_ACCOUNTING,costEstimate:{usd:.003}}));
  near(store.getDeepseekSessionCost(ds.id).usd,expected+.003);
  store.addMessage(ds.id,result({costSource:'reported',total_cost_usd:4}));
  near(store.getDeepseekSessionCost(ds.id).usd,expected+.003+4);
  store.addMessage(ds.id,result({model:'unknown-deepseek',usageAccounting:'deepseek-step-last-wins-v1'}));
  assert.equal(store.getAgentUsageReport('deepseek',365).costMode,'partial');
  near(store.getAgentUsageReport('deepseek',365).totals.totalCostUsd,expected+.003+4);
  store.deleteSession(costTestSessions.kimi);
  const kimi=store.createSession({provider:'kimi',model:'kimi-code/k3',cwd:temp,title:'Kimi subscription API equivalent'});
  for(const model of ['kimi-code/k3','kimi-for-coding/k3','kimi-code/kimi-for-coding','kimi-for-coding/kimi-for-coding-highspeed']){
    store.addMessage(kimi.id,result({model,costSource:'unavailable',usage:{input_tokens:100000,output_tokens:1000,cache_read_input_tokens:50000,cache_creation_input_tokens:10000}}));
  }
  store.addMessage(kimi.id,result({model:'moonshot-cn/kimi-k2.7-code-highspeed',usage:{input_tokens:0,output_tokens:0}}));
  const kimiReport=store.getAgentUsageReport('kimi',365);assert.equal(kimiReport.costMode,'estimated');near(kimiReport.totals.totalCostUsd,1.316);
  store.close();store.initialize();near(store.getAgentUsageReport('kimi',365).totals.totalCostUsd,1.316);
  const win=new BrowserWindow({width:1140,height:900,show:false,webPreferences:{backgroundThrottling:false}});
  const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
  const js=code=>win.webContents.executeJavaScript(code);
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const until=async code=>{for(let i=0;i<80;i++){if(await js(code))return;await wait(40);}throw Error('Timed out: '+code)};
  const load=async (report,provider='codex')=>{await js('qa.load('+JSON.stringify(report)+','+JSON.stringify(provider)+')');await wait(100)};
  const shot=async name=>{fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG())};
  await win.loadURL(process.env.QA_URL);await until('!!window.qa');
  await load(current);await until('document.body.innerText.includes("API equivalent cost")');
  let copy=await js('document.body.innerText');
  assert(copy.includes('API equivalent cost'));assert(copy.includes('≈$1.69'));
  assert(!copy.includes('tokens excluded'));assert(!copy.includes('Standard API rates'));
  assert(!(await js('!!document.querySelector("[data-usage-api-basis], [data-usage-cost-note], [data-usage-cost-coverage]")')));
  await shot('api-equivalent-light');await js('qa.dark()');await wait(100);await shot('api-equivalent-dark');
  win.setContentSize(390,850);await wait(100);
  assert(await js('document.documentElement.scrollWidth<=innerWidth'),'API cost copy wraps on narrow windows');await shot('api-equivalent-narrow');
  await load(mixed);copy=await js('document.body.innerText');
  assert(copy.includes('Priced usage only'));assert(copy.includes('future-unpriced-model'));
  assert(!copy.includes('Cost covers only'));
  await load(unknown);assert((await js('document.body.innerText')).includes('Unavailable'));
  assert(!(await js('document.body.innerText')).includes('$0'),'unknown-only usage never appears free');
  await load(priced);assert((await js('document.body.innerText')).includes('API equivalent cost'));
  assert(!(await js('!!document.querySelector("[data-usage-cost-coverage]")')),'fully priced usage has no missing-price notice');
  await load(combined);assert((await js('document.body.innerText')).includes('Estimated cost'));
  await load(nativeOnly);assert((await js('document.body.innerText')).includes('Total cost'));
  assert(!(await js('document.body.innerText')).includes('≈$42'));
  win.setContentSize(1140,900);await js("window.document.documentElement.classList.remove('dark')");
  await load(kimiReport,'kimi');await until('document.body.innerText.includes("≈$1.32")');
  copy=await js('document.body.innerText');assert(copy.includes('Estimated cost'));assert(!copy.includes('Unavailable'));
  assert(!copy.includes('usage record(s)'));assert(!copy.includes('No reliable USD cost'));
  assert(!(await js('!!document.querySelector("[data-usage-api-basis], [data-usage-cost-note], [data-usage-cost-coverage]")')));
  await shot('kimi-estimated-clean');
  assert.deepEqual(errors,[]);store.close();db.close();
  console.log('codex-usage-cost: persisted rollouts, mixed/unknown/known/empty/range coverage, cache and Electron UI passed');app.exit(0);
 }catch(error){console.error(error);store?.close();db?.close();app.exit(1)}
});
`;
let server;
try {
  await writeFile(path.join(temp,'index.html'),'<html><body style="margin:0;background:var(--bg-primary)"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(temp,'harness.tsx'),harness);
  await writeFile(path.join(temp,'main.cjs'),main);
  server=await createServer({root,configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0,watch:{ignored:['**/.aegis-design-qa/**']}}});await server.listen();
  const env={...process.env,QA_ROOT:root,QA_TEMP:temp,QA_URL:new URL(path.relative(root,temp)+'/index.html',server.resolvedUrls.local[0]).href,QA_CAPTURE:path.join(root,'output/codex-usage-cost')};delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve,reject)=>{
    const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(temp,'main.cjs')],{cwd:root,env,stdio:'inherit'});
    const timer=setTimeout(()=>{child.kill();reject(Error('Codex usage cost test timed out'));},60000);
    child.on('error',error=>{clearTimeout(timer);reject(error)});child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Codex usage cost test failed'))});
  });
} finally {await server?.close();await rm(temp,{recursive:true,force:true});}

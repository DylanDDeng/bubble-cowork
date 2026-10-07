import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';

import { editTraceFixture } from './codex-edit-trace.fixture.cjs';
const messages = editTraceFixture();
const kimiMessages = JSON.parse(await readFile(new URL('./fixtures/kimi-edit-trace.json', import.meta.url), 'utf8'));
const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const tmp = await mkdtemp(path.join(root, '.aegis-design-qa/edit-trace-'));
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ToolExecutionBatch} from '/src/ui/components/ToolExecutionBatch';
import {TurnDiffContext} from '/src/ui/components/TurnDiffContext';
import {buildTurnChangeContext} from '/src/ui/utils/turn-change-records';
import {useAppStore} from '/src/ui/store/useAppStore';
import '/src/ui/index.css';
window.electron={};
useAppStore.getState().setTheme('light');
const messages=${JSON.stringify(messages)};
const kimiMessages=${JSON.stringify(kimiMessages)};
const kimiResult=kimiMessages[1].message.content[0];
const kimiContext=buildTurnChangeContext(kimiMessages);
const blocks=messages.flatMap(m=>m.message?.content||[]);
const results=new Map(blocks.filter(b=>b.type==='tool_result').map(b=>[b.tool_use_id,b]));
const statuses=new Map([...results].map(([id,r])=>[id,r.is_error?'error':'success']));
const context=buildTurnChangeContext(messages);
window.qa={};
const legacy=[{type:'assistant',message:{content:[{type:'tool_use',id:'legacy',name:'Edit',input:{}}]}}];
createRoot(document.getElementById('root')).render(<main style={{maxWidth:780,margin:'40px auto',padding:16}}>
<TurnDiffContext.Provider value={{...context,onOpenDiff:(record,scope)=>{qa.opened={record,scope}}}}>
<section id="trace"><ToolExecutionBatch messages={messages.filter(m=>m.type==='assistant')} toolResultsMap={results} toolStatusMap={statuses} isSessionRunning={false} defaultExpanded durationMs={42000}/></section>
<TurnDiffContext.Provider value={kimiContext}><section id="kimi"><ToolExecutionBatch messages={kimiMessages.filter(m=>m.type==='assistant')} toolResultsMap={new Map([['kimi-edit',kimiResult]])} toolStatusMap={new Map([['kimi-edit','success']])} isSessionRunning={false} defaultExpanded durationMs={25000}/></section></TurnDiffContext.Provider>
<section id="legacy"><ToolExecutionBatch messages={legacy} toolResultsMap={new Map([['legacy',{type:'tool_result',tool_use_id:'legacy',content:'Done'}]])} toolStatusMap={new Map([['legacy','success']])} isSessionRunning={false} defaultExpanded durationMs={1000}/></section>
</TurnDiffContext.Provider></main>);
`;

const main = String.raw`
const {app,BrowserWindow}=require('electron');
// CI runners have Reduce Motion on; tests expect the default motion preference.
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1100,height:850,show:false,webPreferences:{backgroundThrottling:false}});
 const errors=[];
 win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=code=>win.webContents.executeJavaScript(code);
 const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const until=async(code)=>{for(let i=0;i<100;i++){if(await js(code))return;await delay(30);}throw Error('Timed out: '+code);};
 const click=async(selector)=>{await js('document.querySelector('+JSON.stringify(selector)+').click()');await delay(300)};
 const shot=async(name)=>{fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG());};
 try{
  await win.loadURL(process.env.QA_URL);await until('window.qa && document.querySelector("#trace [data-workstream-group]")');
  if (await js('document.querySelector("#trace [data-workstream-group]").getAttribute("aria-expanded") === "false"')) await click('#trace [data-workstream-group]');
  const edit='#trace [data-workstream-stage="stage:edit:edit-one"]';
  const multi='#trace [data-workstream-stage="stage:edit:edit-two"]';
  assert((await js('document.querySelector('+JSON.stringify(edit+' > button')+').textContent')).includes('example.ts'));
  assert.equal(await js('document.querySelectorAll("[data-inline-edit-diff]").length'),0,'patches start collapsed');
  await click(edit+' > button');
  await until('document.querySelectorAll("[data-inline-edit-diff]").length===1');
  assert.equal(await js('document.querySelectorAll("[data-diff-line=addition]").length'),1);
  assert.equal(await js('document.querySelectorAll("[data-diff-line=deletion]").length'),1);
  assert(await js('document.querySelector("[data-inline-edit-diff]").textContent.includes("30")'),'real hunk line numbers');
  assert(await js('!!document.querySelector("[data-inline-edit-diff] .hljs-keyword")'),'syntax highlighting');
  await until('document.querySelector("[data-inline-edit-diff]").getBoundingClientRect().bottom >= document.querySelector("[data-diff-line=addition]").getBoundingClientRect().bottom');
  await delay(400);
  await shot('single-edit-expanded');
  await click(edit+' > button');
  await until('document.querySelectorAll("[data-inline-edit-diff]").length===0');
  assert.equal(await js('document.querySelectorAll("[data-inline-edit-diff]").length'),0,'second click collapses patch');
  await click(multi+' > button');
  await until('document.querySelectorAll("[data-inline-edit-diff]").length===3');
  assert(!(await js('!!document.querySelector("[data-inline-edit-diff] script")')),'source is escaped');
  await click('[data-inline-edit-diff="/project/src/after.ts"] button');
  assert.equal(await js('qa.opened.record.filePath'),'/project/src/after.ts');
  assert.equal(await js('qa.opened.scope.records.length'),3,'detail opens the current edit scope');
  await shot('multi-edit-expanded');
  await click('#legacy [data-workstream-stage] > button');
  assert((await js('document.querySelector("#legacy").textContent')).includes('File change details were not recorded'));
  assert(!(await js('document.querySelector("#legacy").textContent')).includes('Done'));
  win.setSize(390,850);await delay(100);
  assert(await js('document.documentElement.scrollWidth<=innerWidth'),'no viewport overflow');
  await shot('narrow-edit');
  win.setSize(1100,850);
  await click('#kimi [data-workstream-stage] > button');
  await until('!!document.querySelector("#kimi [data-diff-line=addition]")');
  assert((await js('document.querySelector("#kimi").textContent')).includes('Claude · Claude 个人介绍页'));
  assert.equal(await js('document.querySelector("#kimi [data-diff-line=addition] span").textContent'),'7');
  assert.equal(await js('document.querySelector("#kimi [data-diff-line=deletion] span").textContent'),'7');
  assert(!(await js('document.querySelector("#kimi").textContent')).includes('No text diff'));
  await js('document.querySelector("#kimi").scrollIntoView({block:"center"})');
  await delay(500);
  await shot('kimi-observed-edit');
  assert.deepEqual(errors,[]);
  console.log('codex-edit-trace-electron: all assertions passed');app.exit(0);
 }catch(error){console.error(error);await shot('failure');app.exit(1)}
});
`;

let server;
try {
 await writeFile(path.join(tmp,'index.html'),'<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
 await writeFile(path.join(tmp,'harness.tsx'),harness);
 await writeFile(path.join(tmp,'main.cjs'),main);
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0,strictPort:false,watch:{ignored:['**/.aegis-design-qa/**']}}});
 await server.listen();
 const env={...process.env,QA_URL:new URL(path.relative(root,tmp)+'/index.html',server.resolvedUrls.local[0]).href,QA_CAPTURE:path.join(root,'output/edit-trace-qa')};
 delete env.ELECTRON_RUN_AS_NODE;
 await new Promise((resolve,reject)=>{
  const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(tmp,'main.cjs')],{cwd:root,env,stdio:'inherit'});
  const timer=setTimeout(()=>{child.kill();reject(Error('Edit trace test timed out'));},60000);
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Edit trace UI regression failed'));});
 });
} finally {await server?.close();await rm(tmp,{recursive:true,force:true});}

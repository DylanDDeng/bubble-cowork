import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// Search palette rendered with the real component against fixture data:
// sections and their order, highlighting, excerpts, keyboard selection and
// close-then-act. QA_CAPTURE=<dir> saves screenshots.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const qaRoot = path.join(root, 'dev-fixtures');
await mkdir(qaRoot, { recursive: true });
const tmp = await mkdtemp(path.join(qaRoot, 'search-palette-'));
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {SearchPalette} from '/src/ui/components/search/SearchPalette.tsx';
import '/src/ui/index.css';
const now=Date.now();const h=3600000;
const actions=[
 {id:'new-thread',label:'New Task',description:'Start a new conversation',keywords:['create','chat'],shortcut:'⌘N'},
 {id:'open-project',label:'Open Project Folder',description:'Pick a working directory',keywords:['folder']},
 {id:'settings',label:'Settings',description:'Open application settings',keywords:['preferences']},
];
const projects=[
 {id:'/projects/coworker',name:'coworker',cwd:'/projects/coworker',sessionCount:4,lastUpdatedAt:now-h},
 {id:'/projects/retry helper kit',name:'retry helper kit',cwd:'/projects/retry helper kit',sessionCount:1,lastUpdatedAt:now-5*h},
];
const long='We looked at the failing upload first. '.repeat(3)+'The retry helper now backs off exponentially and caps at thirty seconds, which fixed the flaky test.';
const threads=[
 {id:'a',title:'Retry helper',projectName:'coworker',updatedAt:now-2*h,texts:[]},
 {id:'b',title:'Upload debugging',projectName:'coworker',updatedAt:now-h,texts:['why does upload fail?',long,'see the retry helper pr']},
 {id:'c',title:'Release notes',projectName:'coworker',updatedAt:now-30*60000,texts:[]},
];
window.qa={events:[]};
function Harness(){
 const [open,setOpen]=React.useState(true);
 window.qa.open=()=>setOpen(true);
 const log=(kind)=>(id)=>window.qa.events.push(kind+':'+id);
 return <div style={{height:'100vh',background:'var(--bg-primary)'}}><SearchPalette open={open} onOpenChange={(v)=>{setOpen(v);window.qa.events.push('open:'+v)}} actions={actions} projects={projects} threads={threads} onPickAction={log('action')} onPickProject={log('project')} onPickThread={log('thread')}/></div>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main = `
const {app,BrowserWindow,ipcMain}=require('electron');
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));fs.mkdirSync(app.getPath('userData'),{recursive:true});
const root=process.env.QA_ROOT;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 ipcMain.on('get-ui-resume-state-sync',e=>{e.returnValue=null});ipcMain.on('renderer-state:get-all-sync',e=>{e.returnValue={}});ipcMain.on('save-ui-resume-state-sync',e=>{e.returnValue=true});
 ipcMain.on('renderer-state:set',()=>{});ipcMain.handle('set-theme',()=>{});
 const win=new BrowserWindow({width:820,height:720,show:true,webPreferences:{backgroundThrottling:false,preload:path.join(root,'dist-electron/electron/preload.cjs')}});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=code=>win.webContents.executeJavaScript(code,true);
 const screenshot=async name=>{if(!process.env.QA_CAPTURE)return;fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG())};
 const type=async value=>{await js('(()=>{const el=document.querySelector("[cmdk-input]");el.focus();const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;set.call(el,'+JSON.stringify(value)+');el.dispatchEvent(new Event("input",{bubbles:true}))})()');await delay(200)};
 const key=async keyCode=>{win.focus();win.webContents.focus();win.webContents.sendInputEvent({type:'keyDown',keyCode});win.webContents.sendInputEvent({type:'keyUp',keyCode});await delay(200)};
 const headings=()=>js('[...document.querySelectorAll("[cmdk-group-heading]")].map(e=>e.textContent)');
 const values=()=>js('[...document.querySelectorAll("[cmdk-item]")].map(e=>e.getAttribute("data-value"))');
 const selected=()=>js('document.querySelector("[cmdk-item][data-selected=true]")?.getAttribute("data-value")');
 try{
  await win.loadURL(process.env.QA_URL);
  await js('new Promise(r=>{const t=()=>document.querySelector("[cmdk-input]")?r():setTimeout(t,50);t()})');await delay(300);
  assert.equal(await js('!!document.querySelector("[role=dialog]")'),true,'the palette is a dialog, which pauses global shortcuts');

  // Empty query: every action, then the most recent threads; no projects.
  assert.deepEqual(await headings(),['Suggested','Recent']);
  assert.deepEqual(await values(),['action:new-thread','action:open-project','action:settings','thread:c','thread:b','thread:a']);
  assert.equal(await selected(),'action:new-thread','the first row starts highlighted');
  assert.equal(await js('document.body.textContent.includes("⌘N")'),true,'action shortcuts show');
  await screenshot('1-empty');

  // A query ranks threads by evidence and shows a windowed excerpt.
  await type('retry helper');
  assert.deepEqual(await headings(),['Threads','Projects']);
  const found=await values();
  assert.deepEqual(found.slice(0,2),['thread:a','thread:b'],'an exact title outranks the newer message hit');
  assert.deepEqual(found.slice(2),['project:/projects/retry helper kit'],'matching projects follow the threads');
  assert.equal(await js('document.body.textContent.includes("2 chat hits")'),true);
  const excerpt=await js('[...document.querySelectorAll("[cmdk-item][data-value=\\\\"thread:b\\\\"] span")].map(e=>e.textContent).find(t=>t.includes("…"))');
  assert.ok(excerpt&&excerpt.includes('retry helper'),'the excerpt windows the match: '+excerpt);
  const marks=await js('[...document.querySelectorAll("mark")].map(e=>e.textContent.toLowerCase())');
  assert.ok(marks.length>=2&&marks.every(m=>m==='retry'||m==='helper'),'query words are marked: '+marks);
  await screenshot('2-query');

  // Keyboard: arrows move, Enter closes the palette and then acts.
  await key('Down');
  assert.equal(await selected(),'thread:b');
  await key('Return');
  assert.deepEqual(await js('qa.events'),['open:false','thread:b'],'the palette closes before the pick runs');

  // Reopening starts from an empty query.
  await js('qa.open()');await delay(300);
  assert.equal(await js('document.querySelector("[cmdk-input]").value'),'');
  await type('zzzz no such thing');
  assert.equal(await js('document.body.textContent.includes("No matches.")'),true);
  await screenshot('3-empty-result');

  assert.deepEqual(errors.filter(e=>!/No handler registered/.test(e)),[]);
  console.log(JSON.stringify({ok:true,checks:['dialog role','empty query sections','ranked query with excerpt and marks','keyboard pick closes first','reset on reopen','no matches']}));
  app.exit(0);
 }catch(e){console.error(e);console.error(errors);await screenshot('failure');app.exit(1)}
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
    const env = { ...process.env, QA_ROOT: root, QA_URL: url, DEV_SERVER_URL: server.resolvedUrls.local[0] };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.env.QA_ELECTRON_EXECUTABLE || path.join(root, 'node_modules/.bin/electron'), [path.join(tmp, 'main.cjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; process.stdout.write(c); });
    child.stderr.on('data', (c) => { err += c; process.stderr.write(c); });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Timed out\n' + out + '\n' + err)); }, 120000);
    child.on('error', reject);
    child.on('exit', (code) => { clearTimeout(timeout); code === 0 && out.includes('"ok":true') ? resolve() : reject(new Error(out + '\n' + err)); });
  });
  console.log('Search palette Electron regression passed');
} finally { await server?.close(); await rm(tmp, { recursive: true, force: true }); }

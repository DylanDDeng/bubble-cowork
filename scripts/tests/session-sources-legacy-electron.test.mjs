import { createServer } from 'vite';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

// Exercise the real contextBridge and ipcRenderer rejection, with a main
// process that deliberately registers only the pre-Sources attachment APIs.
const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const dir = await mkdtemp(path.join(root, '.aegis-design-qa/sources-legacy-'));
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'coworker-sources-legacy-'));
const harness = String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {useSessionSources} from '/src/ui/hooks/useSessionSources';
import {SessionSourcesPanel} from '/src/ui/components/SessionSourcesPanel';
import {ImageStudioPanel} from '/src/ui/components/ImageStudioPanel';
import {openSessionSource} from '/src/ui/lib/image-studio';
import {useAppStore} from '/src/ui/store/useAppStore';
import '/src/ui/index.css';
const movie={id:'video',path:'/attachments/reference.mp4',name:'reference.mp4',kind:'file',mimeType:'video/mp4',size:10};
const session={id:'legacy',isDraft:false,messages:[{type:'user_prompt',prompt:'',attachments:[movie]}],hasMoreHistory:true,historyCursor:'older'};
useAppStore.setState({sessions:{legacy:{...session,provider:'claude',status:'completed',permissionRequests:[]}}});
function Harness(){
 const state=useSessionSources(session);
 const [selected,setSelected]=React.useState(null);
 const tab=useAppStore(s=>s.activeRightUtilityTab);
 if(tab==='images:legacy')return <div style={{height:'100vh',display:'flex',flexDirection:'column'}}><button onClick={()=>useAppStore.getState().closeRightUtilityTab(tab)}>Close image canvas</button><ImageStudioPanel sessionId="legacy" fullscreen/></div>;
 return <SessionSourcesPanel sessionId={session.id} {...state} onRetry={state.refresh} selectedPath={selected} onSelect={path=>{
  const source=state.sources.find(source=>source.path===path);
  if(source?.kind==='image')openSessionSource(session.id,source);else setSelected(path);
 }}/>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main = String.raw`
const {app,BrowserWindow,ipcMain}=require('electron');
const assert=require('node:assert/strict');const path=require('node:path');
app.setPath('userData',path.join(process.env.QA_DATA_DIR,'profile'));
app.setPath('sessionData',path.join(process.env.QA_DATA_DIR,'session'));
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const reads=[];
ipcMain.handle('set-theme',()=>{});
ipcMain.on('get-ui-resume-state-sync',e=>{e.returnValue=null});
ipcMain.on('renderer-state:get-all-sync',e=>{e.returnValue={}});
ipcMain.handle('load-older-session-history',(_,id,cursor)=>{
 assert.equal(id,'legacy');assert.equal(cursor,'older');reads.push('history');
 return {sessionId:id,messages:[{type:'user_prompt',prompt:'',attachments:[{id:'image',path:'/attachments/参考图.png',name:'参考图.png',kind:'image',mimeType:'image/png',size:10}]}],hasMore:false,cursor:null};
});
ipcMain.handle('read-attachment-preview',(_,file)=>{
 assert.equal(file,'/attachments/参考图.png');reads.push('image');return image;
});
ipcMain.handle('read-project-file-preview',(_,cwd,file)=>{
 assert.equal(cwd,'/attachments/');assert.equal(file,'/attachments/reference.mp4');reads.push('video');
 return {kind:'video',previewUrl:new URL('/scripts/tests/fixtures/video-preview.mp4',process.env.QA_URL).href};
});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:800,height:600,webPreferences:{preload:process.env.QA_PRELOAD,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const run=code=>win.webContents.executeJavaScript(code,true);
 const wait=async code=>{for(let i=0;i<80;i++){if(await run(code))return;await delay(75)}throw Error('Timed out: '+code)};
 const click=async label=>{assert(await run('(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")==='+JSON.stringify(label)+'||b.textContent.trim()==='+JSON.stringify(label)+');b?.click();return !!b})()'),'Missing '+label)};
 try {
  await win.loadURL(process.env.QA_URL);
  await wait('document.body.innerText.includes("参考图.png")');
  assert(await run('typeof window.electron.previewSessionSource==="function"'),'real current preload exposes Sources');
  const rejection=await run('window.electron.getSessionSources("legacy").then(()=>"unexpected",e=>String(e))');
  assert.match(rejection,/No handler registered for 'get-session-sources'/);
  assert.equal(await run('document.body.innerText.includes("Could not load")'),false);
  await click('参考图.png');await wait('document.querySelector("img")?.naturalWidth>0');
  assert(await run('document.querySelector(".image-studio").dataset.fullscreen==="true"'));
  await click('Close image canvas');await click('reference.mp4');
  await wait('document.querySelector("video")?.readyState>=2');
  assert.equal(await run('document.querySelector("video").videoWidth'),160);
  await run('(()=>{const v=document.querySelector("video");v.muted=true;return v.play()})()');await delay(300);
  assert(await run('document.querySelector("video").currentTime>0'));
  await click('All sources');await wait('!document.querySelector("video")');
  assert.deepEqual(reads,['history','image','video']);assert.deepEqual(errors,[]);
  console.log('PASS Sources legacy main: real preload/IPC missing handlers, full-history image canvas, MP4 playback and return to list');
  app.exit(0);
 }catch(error){console.error(error,errors);app.exit(1)}
});
`;
let server;
try {
  await writeFile(path.join(dir, 'index.html'), '<html><body><div id="root"></div><script type="module" src="./probe.tsx"></script></body></html>');
  await writeFile(path.join(dir, 'probe.tsx'), harness);
  await writeFile(path.join(dir, 'main.cjs'), main);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), cacheDir: path.join(dataDir, 'vite-cache'), server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await server.listen();
  const env = { ...process.env, QA_DATA_DIR: dataDir, BUBBLE_HOME: path.join(dataDir, 'agent-home'), AEGIS_USER_DATA_DIR: path.join(dataDir, 'profile'), QA_PRELOAD: path.join(root, 'dist-electron/electron/preload.cjs'), QA_URL: new URL(path.relative(root, dir) + '/index.html', server.resolvedUrls.local[0]).href };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(root, 'node_modules/.bin/electron'), [path.join(dir, 'main.cjs')], { env, stdio: 'inherit' });
    const timeout = setTimeout(() => { child.kill(); reject(Error('Legacy Sources test timed out')); }, 60000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(Error('Electron exited ' + code)); });
  });
} finally {
  await server?.close();
  await rm(dir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
}

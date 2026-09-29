import { createServer } from 'vite';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const dir = await mkdtemp(path.join(root, '.aegis-design-qa/sources-'));
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'bubble-sources-qa-'));
const harness = String.raw`
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useAppStore} from '/src/ui/store/useAppStore';
import {useSessionSources} from '/src/ui/hooks/useSessionSources';
import {EnvironmentHub} from '/src/ui/components/environment/EnvironmentHub';
import {SessionSourcesPanel} from '/src/ui/components/SessionSourcesPanel';
import {sessionSourceTabPath,getRightUtilityTabKind} from '/src/ui/utils/right-utility-tabs';
import {openSessionSource} from '/src/ui/lib/image-studio';
import {ImageStudioPanel} from '/src/ui/components/ImageStudioPanel';
import {ImageStudioComposerHome} from '/src/ui/components/ImageStudioComposerDock';
import {RightUtilityWorkspace} from '/src/ui/App';
import '/src/ui/index.css';
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const file=(name,kind='file')=>({id:name,path:'/Library/Application Support/Uploads/'+name,name,kind,size:10,mimeType:kind==='image'?'image/png':'application/octet-stream'});
const old=file('reference.png','image'),movie=file('movie.mp4'),note=file('notes.txt'),doc=file('document.docx');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
window.qa={opened:[],reads:[]};
window.electron={getUiResumeStateSync:()=>null,getRendererStateAllSync:()=>({}),saveUiResumeState:async()=>{},
 listSessionPullRequests:async()=>[],onSessionPullRequestsChanged:()=>()=>{},
 getSessionSources:async id=>{qa.reads.push(id);await sleep(id==='slow'?400:50);return id==='one'?[old,movie]:id==='slow'?[file('wrong-session.png','image')]:[]},
 previewSessionSource:async(id,path)=>{await sleep(path.endsWith('.png')?150:20);return path.endsWith('.png')?{kind:'image',url:image}:path.endsWith('.mp4')?{kind:'video',url:'/scripts/tests/fixtures/video-preview.mp4'}:path.endsWith('.txt')?{kind:'text',text:'Attachment text content'}:path.endsWith('missing.pdf')?{kind:'error',message:'Attachment is missing or could not be read.'}:{kind:'file'}},
 openPath:async path=>{qa.opened.push(path);return {ok:true}},
};
const draft=useAppStore.getState().createDraftSession('/qa/project');
const base=useAppStore.getState().sessions[draft];
for(const id of ['one','slow','empty'])useAppStore.setState(s=>({sessions:{...s.sessions,[id]:{...base,id,isDraft:false,provider:'claude',status:'completed',messages:[],permissionRequests:[]}}}));
function Harness(){
 const [id,setId]=useState('one');qa.session=id=>{setId(id);useAppStore.setState({rightUtilityTabs:['sources'],activeRightUtilityTab:'sources',rightPanelFullscreen:null})};
 const [extra,setExtra]=useState([]);qa.add=()=>setExtra([file('missing.pdf')]);
 const messages=React.useMemo(()=>id==='one'?[{type:'user_prompt',prompt:'References',attachments:[movie,note,doc,...extra]}]:[],[id,extra]);
 const session={...base,id,isDraft:false,messages};
 const state=useSessionSources(session);
 const tabs=useAppStore(s=>s.rightUtilityTabs);
 const active=useAppStore(s=>s.activeRightUtilityTab);
 const full=useAppStore(s=>s.rightPanelFullscreen);
 const context={paneId:'primary',sessionId:id,session,title:'Sources fixture',projectCwd:'/qa/project',effectiveCwd:'/qa/project',envMode:'local',isRunning:false,isDraft:false,contextKey:id,unavailableReason:null};
 const git={overview:{ok:true,hasRepo:false,error:'not-a-repo'},refresh:async()=>{}};
 const select=path=>openSessionSource(id,state.sources.find(source=>source.path===path)||null);qa.select=select;
 return <div style={{display:'flex',height:'100vh'}}>
  <aside data-sidebar style={{width:120,flexShrink:0}}>Sidebar</aside>
  <main data-workspace style={{display:'flex',flex:1,minWidth:0}}>
   <div data-chat style={{display:full?'none':'flex',flex:1,flexDirection:'column'}}>
    <div style={{display:'flex',justifyContent:'flex-end'}}><EnvironmentHub context={context} git={git} sources={state.sources} sourcesError={state.error} onOpenProjectPanel={()=>{}} onOpenSources={select}/></div>
    <div style={{flex:1}}>Original chat</div>
    <ImageStudioComposerHome sessionId={id}><input aria-label="Chat draft" defaultValue="Keep my draft"/></ImageStudioComposerHome>
   </div>
   {active&&<RightUtilityWorkspace hidden={false} instantReveal activePanel={getRightUtilityTabKind(active)} tabs={tabs.map(tab=>({id:tab,kind:getRightUtilityTabKind(tab),label:tab.startsWith('images:')?'Image canvas':sessionSourceTabPath(tab)?.split('/').pop()||'Sources'}))} activeTab={active} browserAvailable={false} width={full?760:560} resizable={false} fullscreen={!!full} windowControlsInset={false} onWidthChange={()=>{}} onSelectTab={useAppStore.getState().setActiveRightUtilityTab} onCloseTab={useAppStore.getState().closeRightUtilityTab} onOpenTab={useAppStore.getState().openRightUtilityTab} onTogglePanel={useAppStore.getState().closeRightUtilityPanels} onToggleFullscreen={null}>
    {getRightUtilityTabKind(active)==='sources'&&<SessionSourcesPanel key={id} sessionId={id} {...state} onRetry={state.refresh} selectedPath={sessionSourceTabPath(active)} onSelect={select}/>}
    {getRightUtilityTabKind(active)==='images'&&<ImageStudioPanel sessionId={id} fullscreen/>}
   </RightUtilityWorkspace>}
  </main>
 </div>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main = String.raw`
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
app.setPath('userData',path.join(process.env.QA_DATA_DIR,'profile'));app.setPath('sessionData',path.join(process.env.QA_DATA_DIR,'session'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1000,height:740,show:false,webPreferences:{backgroundThrottling:false}});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const run=code=>win.webContents.executeJavaScript(code,true).catch(error=>{console.error('Failed expression:',code);throw error});
 const wait=async code=>{for(let i=0;i<80;i++){if(await run(code))return;await delay(75)}throw Error('Timed out: '+code)};
 const click=async label=>{assert(await run('(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")==='+JSON.stringify(label)+'||b.textContent.trim()==='+JSON.stringify(label)+');b?.click();return !!b})()'),'Missing '+label);await delay(120)};
 try{
  await win.loadURL(process.env.QA_URL);await wait('!!window.qa?.select');await delay(200);
  await click('Open environment panel');
  assert(await run('!!document.querySelector("section[aria-label=Sources]")'),'non-Git tasks expose Sources');
  assert.equal(await run('document.querySelector("section[aria-label=Sources]").querySelectorAll("button").length'),4,'three recent files plus View all');
  await click('View all (4)');await wait('!!document.querySelector("section[aria-label^=Task]")');
  assert(await run('document.body.innerText.includes("reference.png")'),'earlier attachment appears despite paginated messages');
  await run('window.originalDraft=document.querySelector("input")');
  await click('reference.png');await wait('document.querySelector("img[alt]")?.naturalWidth>0');
  assert(await run('document.querySelector("img[alt]").naturalWidth>0'));
  assert(await run('document.querySelector(".image-studio").dataset.fullscreen==="true"'));
  assert(await run('(()=>{const c=document.querySelector(".image-studio").getBoundingClientRect(),w=document.querySelector("[data-workspace]").getBoundingClientRect();return c.width>=w.width-2})()'),'canvas fills the main workspace');
  assert(await run('document.querySelector(".image-studio-footer input")===window.originalDraft'),'same composer moves into canvas');
  assert.equal(await run('window.originalDraft.value'),'Keep my draft');
  assert.equal(await run('getComputedStyle(document.querySelector("[data-chat]")).display'),'none');
  assert(await run('document.querySelector("[data-sidebar]").getBoundingClientRect().width>0'));
  await click('Zoom options');await click('Zoom in');
  await click('Sources');await click('reference.png');await wait('document.querySelector("img[alt]")?.naturalWidth>0');
  assert.equal(await run('document.querySelectorAll("[data-utility-tab]").length'),2,'opening the same source reuses its file tab');
  await click('Close Image canvas');await wait('!!document.querySelector("section h2")');
  assert(await run('document.querySelector("[data-composer-home] input")===window.originalDraft'),'close restores original composer');
  await click('movie.mp4');await wait('document.querySelector("video")?.readyState>=2');
  assert.equal(await run('document.querySelector("video").videoWidth'),160);
  await run('(()=>{const v=document.querySelector("video");v.muted=true;return v.play()})()');await delay(300);
  assert(await run('document.querySelector("video").currentTime>0'),'MP4 playback advances');
  await click('All sources');assert.equal(await run('!!document.querySelector("video")'),false,'leaving preview removes playback');
  await click('notes.txt');await wait('document.body.innerText.includes("Attachment text content")');
  await click('All sources');await click('document.docx');await wait('document.body.innerText.includes("Preview is unavailable")');
  await click('Open attachment in default app');assert.equal((await run('qa.opened')).length,1);
  await click('All sources');await run('qa.add()');await delay(200);await click('missing.pdf');await wait('document.body.innerText.includes("Attachment is missing")');
  await click('All sources');await run('qa.select("/Library/Application Support/Uploads/reference.png")');await delay(10);await run('qa.select("/Library/Application Support/Uploads/notes.txt")');await delay(250);
  assert(await run('document.body.innerText.includes("Attachment text content")'));assert.equal(await run('!!document.querySelector("img[alt]")'),false,'stale preview cannot replace the selected file');
  await run('qa.session("slow")');await delay(30);await run('qa.session("empty")');await delay(550);
  assert(await run('document.body.innerText.includes("Attachments sent in this task will appear here")'));
  assert.equal(await run('document.body.innerText.includes("wrong-session")'),false,'late old-session reply is ignored');
  assert.equal(await run('!!document.querySelector("button[title=Environment]")'),false,'empty non-Git task has no card');
  await run('qa.session("one")');await delay(200);await click('Open environment panel');await click('View all (5)');
  fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,'sources.png'),(await win.webContents.capturePage()).toPNG());
  assert.deepEqual(errors,[]);console.log('PASS Sources UI: full-workspace image canvas, preserved composer, zoom, close, provider-independent viewing, non-Git card, historical/live dedupe, View all, image, MP4, text, fallback, missing file, stale replies, task switching');app.exit(0);
 }catch(error){console.error(error,errors);app.exit(1)}
});
`;
let server;
try {
  await writeFile(path.join(dir, 'index.html'), '<html><body style="margin:0;background:var(--bg-primary)"><div id="root"></div><script type="module" src="./probe.tsx"></script></body></html>');
  await writeFile(path.join(dir, 'probe.tsx'), harness);
  await writeFile(path.join(dir, 'main.cjs'), main);
  server = await createServer({ root, configFile:path.join(root,'vite.config.ts'), plugins:[{name:'sources-canvas-qa',enforce:'pre',transform(source,id){if(id.endsWith('/src/ui/App.tsx'))return source+'\nexport { RightUtilityWorkspace };'}}], cacheDir:path.join(dataDir,'vite-cache'), server:{host:'127.0.0.1',port:0,strictPort:false} });
  await server.listen();
  const env={...process.env,QA_DATA_DIR:dataDir,BUBBLE_HOME:path.join(dataDir,'agent-home'),BUBBLE_DESKTOP_PROFILE:'qa',BUBBLE_DESKTOP_USER_DATA:path.join(dataDir,'profile'),QA_URL:new URL(path.relative(root,dir)+'/index.html',server.resolvedUrls.local[0]).href,QA_CAPTURE:path.join(root,'output/session-sources-qa')};
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve,reject)=>{
    const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(dir,'main.cjs')],{env,stdio:'inherit'});
    const timeout=setTimeout(()=>{child.kill();reject(Error('Sources test timed out'))},60000);
    child.once('error',reject);child.once('exit',code=>{clearTimeout(timeout);code===0?resolve():reject(Error('Electron exited '+code))});
  });
} finally { await server?.close();await rm(dir,{recursive:true,force:true});await rm(dataDir,{recursive:true,force:true}); }

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const root = process.cwd();
// Keep the harness connected to the application's actual navigation boundary.
const source = await readFile(path.join(root, 'src/ui/App.tsx'), 'utf8');
assert.match(source, /<SessionRightPanelPresence sessionId=\{activeSessionId\}>/);
assert.match(source, /instantReveal=\{rightUtilityInstantRevealPending \|\| sessionChanged\}/);
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const tmp = await mkdtemp(path.join(root, '.aegis-design-qa/session-panel-'));
const profile = await mkdtemp(path.join(os.tmpdir(), 'aegis-session-panel-'));
const harness = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {SessionRightPanelPresence} from '/src/ui/components/SessionRightPanelPresence';
import {RightUtilityWorkspace} from '/src/ui/App';
import {BrowserPanel} from '/src/ui/components/browser/BrowserPanel';
import '/src/ui/index.css';
window.qa={events:[]};
window.electron={designMode:{onEvent:()=>()=>{}},browser:{
 open:async({sessionId})=>({sessionId,open:true,page:{id:sessionId,url:'https://example.com/'+sessionId,title:sessionId,phase:'live',loading:false,canBack:false,canForward:false,favicon:null,committedUrl:null,error:null},lastError:null,agentActive:false}),
 onState:()=>()=>{},onSendSelection:()=>()=>{},onCommand:()=>()=>{},onFindResult:()=>()=>{},setChromeFocus:async()=>{},
 hide:p=>{qa.events.push({kind:'hide',id:p.sessionId});return window.qaNative.hide(p);},
 setPanelBounds:p=>{qa.events.push({kind:'bounds',id:p.sessionId});return window.qaNative.bounds(p);},
}};
function Harness(){
 const [id,setId]=useState('A'),[hidden,setHidden]=useState(false),[removed,setRemoved]=useState(false);
 Object.assign(qa,{select:next=>flushSync(()=>{setId(next);setHidden(next==='H');setRemoved(false);}),hide:value=>flushSync(()=>setHidden(value)),remove:()=>flushSync(()=>setRemoved(true))});
 const hasPanel=id==='A'||id==='C'||id==='H';
 return <Tooltip.Provider><div style={{display:'flex',height:600,width:1100}}><main style={{flex:1,minWidth:0}}>Session {id??'new'}</main>
 <SessionRightPanelPresence sessionId={id}>{changed=>hasPanel&&!removed?<RightUtilityWorkspace key="pane" hidden={hidden} instantReveal={changed} activePanel={hidden?null:'browser'} tabs={[{id:'browser',kind:'browser',label:'Browser'}]} activeTab="browser" browserAvailable width={560} maximumWidth={748} resizable fullscreen={false} onWidthChange={()=>{}} onSelectTab={()=>{}} onCloseTab={()=>{}} onOpenTab={()=>{}} onTogglePanel={()=>{}} onToggleFullscreen={null}>
 <div data-session={id}/><BrowserPanel key={id} embedded sessionId={id} collapsed={hidden} width={560} onWidthChange={()=>{}} isFullscreen={false} onToggleFullscreen={()=>{}}/>
 </RightUtilityWorkspace>:null}</SessionRightPanelPresence></div></Tooltip.Provider>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><Harness/></React.StrictMode>);
`;
const main = String.raw`
const {app,BrowserWindow,WebContentsView,ipcMain}=require('electron');
// CI runners have Reduce Motion on; tests expect the default motion preference.
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
const assert=require('node:assert/strict');
const path=require('node:path');
app.setPath('userData',process.env.QA_PROFILE);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1200,height:800,webPreferences:{backgroundThrottling:false,preload:path.join(__dirname,'preload.cjs')}});
 const view=new WebContentsView();win.contentView.addChildView(view);view.setVisible(false);
 let owner=null;const nativeEvents=[];
 ipcMain.handle('qa:bounds',(_,p)=>{owner=p.sessionId;view.setBounds(p.viewport);view.setVisible(p.viewport.width>0&&p.viewport.height>0);nativeEvents.push(['bounds',owner]);});
 ipcMain.handle('qa:hide',(_,p)=>{if(owner===p.sessionId){owner=null;view.setVisible(false);}nativeEvents.push(['hide',p.sessionId]);});
 ipcMain.handle('qa:snapshot',()=>({owner,visible:view.getVisible()}));
 const js=s=>win.webContents.executeJavaScript(s,true);
 const delay=ms=>new Promise(r=>setTimeout(r,ms));
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
 const sample='({session:document.querySelector("[data-session]")?.dataset.session??null,width:document.querySelector("[data-right-utility-workspace]")?.getBoundingClientRect().width??0})';
 const select=async(id)=>js('qa.events=[];qa.select('+JSON.stringify(id)+');'+sample);
 const frames=()=>js('new Promise(resolve=>{const samples=[];const tick=()=>{samples.push('+sample+');if(samples.length<5)requestAnimationFrame(tick);else resolve(samples);};requestAnimationFrame(tick);})');
 const native=()=>js('window.qaNative.snapshot()');
 try{
  await win.loadURL(process.env.QA_URL);
  for(let i=0;i<150;i++){if(await js('!!window.qa?.select'))break;await delay(40);}
  await delay(450);
  assert.equal((await native()).owner,'A');
  const gone=await select('B');
  assert.deepEqual(gone,{session:null,width:0},'old Browser must be gone in the navigation commit, before an exit animation');
  assert.deepEqual(await native(),{owner:null,visible:false});
  assert.ok((await frames()).every(s=>s.session===null&&s.width===0),'no stale Browser in following frames');
  let restored=await select('A');
  assert.deepEqual(restored,{session:'A',width:560},'restore at full width without a new opening animation');
  await frames();assert.equal((await native()).owner,'A');
  restored=await select('C');assert.deepEqual(restored,{session:'C',width:560});
  assert.equal((await native()).owner,'C','old layout cleanup must not hide the target Browser');
  assert.ok((await frames()).every(s=>s.session==='C'&&s.width===560));
  const events=await js('qa.events');
  assert.ok(events.findIndex(e=>e.kind==='hide'&&e.id==='A')<events.findIndex(e=>e.kind==='bounds'&&e.id==='C'));
  for(const id of ['A','B','A','C','A',null,'A','H']){
   const state=await select(id);assert.equal(state.width,id==='A'||id==='C'?560:0);
   await frames();assert.equal((await native()).visible,id==='A'||id==='C');
  }
  await select('A');await frames();
  await js('qa.hide(true)');await delay(450);assert.equal((await js(sample)).width,0);
  await js('qa.hide(false)');await delay(450);assert.equal((await js(sample)).width,560);
  // Closing within one session still animates. Navigating during that exit
  // must synchronously discard the old subtree and detach its native view.
  await js('qa.remove()');assert.equal((await js(sample)).session,'A');
  assert.deepEqual(await select('B'),{session:null,width:0});
  assert.deepEqual(await native(),{owner:null,visible:false});
  await frames();assert.deepEqual(errors,[]);
  console.log('session right panel Electron: same-commit removal, immediate restore, native ownership, A/B/A, new/hidden sessions and navigation during exit passed');
  app.exit(0);
 }catch(e){console.error(e);console.error(nativeEvents);app.exit(1);}
});
`;
let server;
try {
 await writeFile(path.join(tmp,'index.html'),'<html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
 await writeFile(path.join(tmp,'harness.tsx'),harness);
 await writeFile(path.join(tmp,'main.cjs'),main);
 await writeFile(path.join(tmp,'preload.cjs'),`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('qaNative',{bounds:p=>ipcRenderer.invoke('qa:bounds',p),hide:p=>ipcRenderer.invoke('qa:hide',p),snapshot:()=>ipcRenderer.invoke('qa:snapshot')});`);
 // Own dep cache: sharing node_modules/.vite breaks a running dev server.
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),cacheDir:path.join(tmp,'vite-cache'),plugins:[{name:'session-panel-qa',enforce:'pre',transform(source,id){
  if(id.endsWith('/src/ui/App.tsx'))return source+'\nexport {RightUtilityWorkspace};';
  // Negative control: reproduce the original global presence boundary.
  if(process.env.QA_OLD_PRESENCE==='1'&&id.endsWith('/SessionRightPanelPresence.tsx'))return source.replace("key={sessionId ?? '__new-session__'}",'').replace('{children(sessionChanged)}','{children(false)}');
 }}],server:{host:'127.0.0.1',port:0,hmr:false,watch:{ignored:['**/.aegis-design-qa/**']}}});
 await server.listen();
 const env={...process.env,QA_PROFILE:profile,QA_URL:new URL(path.relative(root,tmp)+'/index.html',server.resolvedUrls.local[0]).href};delete env.ELECTRON_RUN_AS_NODE;
 await new Promise((resolve,reject)=>{
  const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(tmp,'main.cjs')],{env,stdio:'inherit'});
  const timer=setTimeout(()=>{child.kill();reject(Error('Session panel QA timed out'));},90000);
  child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Session panel QA failed: '+code));});
 });
}finally{await server?.close();await rm(tmp,{recursive:true,force:true});await rm(profile,{recursive:true,force:true});}

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
await mkdir(path.join(root,'.aegis-design-qa'),{recursive:true});
const tmp=await mkdtemp(path.join(root,'.aegis-design-qa/video-attachments-'));
const harness=`
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {Toaster} from 'sonner';
import {PromptInput} from '/src/ui/components/PromptInput.tsx';
import {NewSessionView} from '/src/ui/components/NewSessionView.tsx';
import {MessageCard} from '/src/ui/components/MessageCard.tsx';
import {useAppStore} from '/src/ui/store/useAppStore.ts';
import '/src/ui/index.css';
const a=useAppStore.getState();
const id=a.createDraftSession('/projects/coworker');
useAppStore.setState(s=>({connected:true,projectCwd:'/projects/coworker',sessions:{...s.sessions,[id]:{...s.sessions[id],isDraft:false,provider:'codex',model:'gpt-5.6-sol',status:'idle',messages:[]}}}));
a.setActiveSession(id);
window.electron.onServerEvent(e=>a.handleServerEvent(e));
window.qa={store:useAppStore,id,editor:()=>document.querySelector('[role=textbox]'),cards:()=>document.querySelectorAll('[data-file-attachment="composer"]'),messages:()=>document.querySelectorAll('[data-file-attachment="message"]')};
function Harness(){
 const [fresh,setFresh]=useState(false); window.qa.fresh=setFresh;
 const s=useAppStore();const session=s.sessions[id];
 return <Tooltip.Provider><div style={{height:'100vh',display:'flex',flexDirection:'column',background:'var(--bg-primary)',color:'var(--text-primary)',padding:24}}>
 <header style={{fontSize:14}}>Video attachment interaction</header>
 {fresh?<NewSessionView/>:<><div style={{flex:1,overflow:'auto',padding:'24px 0'}}>{session.messages.map((message,i)=><MessageCard key={i} message={message} sessionId={id} toolStatusMap={new Map()} toolResultsMap={new Map()}/>)}</div><PromptInput sessionId={id}/></>}
 <Toaster/></div></Tooltip.Provider>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main=`
const {app,BrowserWindow,ipcMain,clipboard,dialog,nativeImage}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
app.setPath('userData',path.join(__dirname,'profile'));fs.mkdirSync(app.getPath('userData'),{recursive:true});
const root=process.env.QA_ROOT;
const {setupAttachmentIPC}=require(path.join(root,'dist-electron/electron/ipc/attachments.js'));
const {importAttachmentPaths,clipboardFilePaths}=require(path.join(root,'dist-electron/electron/libs/file-attachments.js'));
const {CodexAppServerManager}=require(path.join(root,'dist-electron/electron/libs/provider/codex-app-server-manager.js'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let copyDelay=0;const copyFile=fs.promises.copyFile;fs.promises.copyFile=async(...args)=>{if(copyDelay)await delay(copyDelay);return copyFile(...args);};
const originalClipboard={text:clipboard.readText(),html:clipboard.readHTML(),rtf:clipboard.readRTF(),image:clipboard.readImage()};
const originalFileURL=clipboard.availableFormats().includes('public.file-url')?clipboard.readBuffer('public.file-url'):null;
function restoreClipboard(){clipboard.write(originalClipboard);if(originalFileURL)clipboard.writeBuffer('public.file-url',originalFileURL);}
const video=path.join(__dirname,'CleanShot 2026-09-06 at 13.20.25.mp4');
fs.writeFileSync(video,Buffer.from('00000020ftypmp42video-attachment-fixture'));
const large=path.join(__dirname,'Large clip.MOV');fs.writeFileSync(large,'video');fs.truncateSync(large,24*1024*1024);
const tooLarge=path.join(__dirname,'Too large.mp4');fs.writeFileSync(tooLarge,'video');fs.truncateSync(tooLarge,513*1024*1024);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1040,height:760,show:true,webPreferences:{preload:path.join(root,'dist-electron/electron/preload.cjs')}});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error'){errors.push(e.message);console.error(e.message);}});
 setupAttachmentIPC(win);
 for(const [channel,value] of [['get-ui-resume-state-sync',null],['renderer-state:get-all-sync',{}],['save-ui-resume-state-sync',true]])ipcMain.on(channel,e=>{e.returnValue=value;});
 for(const provider of ['claude','codex','kimi','grok','opencode','pi','bubble','qoder','deepseek'])ipcMain.handle('get-'+provider+'-model-config',()=>({defaultModel:'gpt-5.6-sol',options:['gpt-5.6-sol'],availableModels:[{name:'gpt-5.6-sol',enabled:true,isDefault:true}]}));
 for(const [channel,value] of [['get-git-branches',{branches:[],currentBranch:null}],['get-agent-runtime-directory',null],['codex-list-plugins',{plugins:[]}],['get-project-tree',[]],['set-theme',null],['get-claude-compatible-provider-config',{}],['get-recent-cwds',[]],['get-session-user-prompts',[]],['codex-list-skills',{skills:[]}],['get-bubble-providers-config',{providers:[]}],['get-provider-composer-capabilities',{}]])ipcMain.handle(channel,()=>value);
 ipcMain.handle('read-attachment-preview',(_e,p)=>'data:image/png;base64,'+fs.readFileSync(p).toString('base64'));
 let sent=[];ipcMain.on('client-event',(_e,json)=>{const event=JSON.parse(json);if(event.type==='session.continue'){sent.push(event.payload);win.webContents.send('server-event',JSON.stringify({type:'stream.user_prompt',payload:{sessionId:event.payload.sessionId,prompt:event.payload.prompt,attachments:event.payload.attachments,createdAt:Date.now()}}));}});
 let picked=[video];let pickerFilters;
 dialog.showOpenDialog=async(_win,options)=>{pickerFilters=options.filters;return {canceled:!picked.length,filePaths:picked};};
 const js=code=>win.webContents.executeJavaScript(code,true);
 const until=async(code,label)=>{for(let i=0;i<100;i++){if(await js(code))return;await delay(60);}throw new Error('Timed out: '+label);};
 const snap=async name=>{if(process.env.QA_CAPTURE){fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG());}};
 const pasteFile=async file=>{clipboard.writeBuffer('public.file-url',Buffer.from(pathToFileURL(file).href));await js('qa.editor().focus()');win.webContents.paste();};
 try {
  await win.loadURL(process.env.QA_URL);await until('!!window.qa && !!qa.editor()','composer ready');win.focus();
  // Native macOS file reference, not a fabricated DOM File: runs the real preload and IPC.
  assert.deepEqual(clipboardFilePaths().filter(p=>p===video),[]);
  await pasteFile(video);await until('qa.cards().length===1','native video paste');
  assert.equal(await js('qa.cards()[0].textContent.includes("MP4")'),true);
  await snap('composer-video');
  await pasteFile(video);await delay(180);assert.equal(await js('qa.cards().length'),1,'deduplicate repeated paste');
  // Normal text must remain text when the clipboard has no file references.
  clipboard.writeText('我录了个交互操作视频，你来做一个这样的交互功能');await js('qa.editor().focus()');win.webContents.paste();
  await until('qa.editor().textContent.includes("交互操作视频")','text paste');
  await js('document.querySelector("[aria-label=Send]").click()');
  await until('qa.messages().length===1','sent video pill');
  assert.equal(sent.length,1);assert.equal(sent[0].attachments[0].kind,'file');assert.equal(sent[0].attachments[0].mimeType,'video/mp4');
  const attached=sent[0].attachments[0];assert.ok(attached.path.startsWith(app.getPath('userData')));assert.notEqual(attached.path,video);
  assert.deepEqual(fs.readFileSync(attached.path),fs.readFileSync(video));
  assert.equal(await js('qa.cards().length'),0);await snap('sent-video');
  // Exercise production Codex serialization while replacing only the network transport.
  const manager=Object.create(CodexAppServerManager.prototype);manager.generation=0;manager.sessions=new Map([['test',{generation:0,status:'idle',providerThreadId:'provider',cwd:__dirname}]]);
  manager.resolveComputerUsePolicy=()=> 'full-access';manager.buildCollaborationModeOptions=()=>({});manager.buildTurnPermissionOptions=()=>({});manager.resolveServiceTierParam=async()=>({});
  let request;manager.sendRequest=async(method,payload)=>{request={method,payload};return {turn:{id:'turn'}};};
  await manager.sendTurn('test','Inspect the video',[attached]);assert.equal(request.method,'turn/start');
  assert.ok(request.payload.input.some(item=>item.type==='text' && item.text.includes(attached.path)));
  assert.ok(!request.payload.input.some(item=>item.type==='localImage'));
  // Clipboard-only blob and drop routes. The browser constructs actual File objects.
  await js('(()=>{const dt=new DataTransfer();dt.items.add(new File(["webm bytes"],"dragged.webm",{type:"video/webm"}));document.querySelector("[data-composer-drop-zone]").dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:dt}));})()');
  await until('qa.cards().length===1','video drop');assert.equal(await js('qa.cards()[0].textContent.includes("WEBM")'),true);
  await js('Array.from(document.querySelectorAll("button")).find(b=>b.ariaLabel?.startsWith("Remove attachment:")).click()');assert.equal(await js('qa.cards().length'),0);
  // Picker accepts >10 MB videos and all three extensions.
  clipboard.writeText('Wait for the video');await js('qa.editor().focus()');win.webContents.paste();await until('qa.editor().textContent.includes("Wait")','pending test text');
  copyDelay=400;picked=[large];await js('Array.from(document.querySelectorAll("button")).find(b=>b.ariaLabel==="Add files or photos").click()');
  await until('document.querySelector("[aria-label=Send]").disabled','send disabled during import');
  await js('qa.editor().dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))');assert.equal(sent.length,1,'Enter cannot send while import is pending');
  await until('qa.cards().length===1','large video picker');copyDelay=0;
  await js('qa.editor().focus();document.execCommand("selectAll");document.execCommand("delete")');
  assert.ok(['mp4','mov','webm'].every(ext=>pickerFilters[0].extensions.includes(ext)));
  assert.equal(await js('qa.cards()[0].textContent.includes("MOV")'),true);
  await js('Array.from(document.querySelectorAll("button")).find(b=>b.ariaLabel?.startsWith("Remove attachment:")).click()');
  const concurrent=await Promise.all([importAttachmentPaths([large]),importAttachmentPaths([large])]);assert.equal(concurrent[0].attachments[0].path,concurrent[1].attachments[0].path);assert.equal(fs.statSync(concurrent[0].attachments[0].path).size,24*1024*1024);
  const rejected=await importAttachmentPaths([tooLarge,path.join(__dirname,'missing.mp4')]);assert.equal(rejected.attachments.length,0);assert.equal(rejected.errors.length,2);
  // Mixed clipboard files preserve both an image thumbnail and a video card.
  await js('(()=>{const dt=new DataTransfer();dt.items.add(new File(["webm"],"mixed.webm",{type:"video/webm"}));dt.items.add(new File([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII="),c=>c.charCodeAt(0))],"image.png",{type:"image/png"}));qa.editor().dispatchEvent(new ClipboardEvent("paste",{bubbles:true,cancelable:true,clipboardData:dt}));})()');
  await until('qa.cards().length===1 && Array.from(document.querySelectorAll("img")).some(img=>img.complete && img.naturalWidth>0)','mixed clipboard');
  win.setSize(420,760);await delay(150);assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true,'narrow composer and sent pill fit');await snap('narrow-video');win.setSize(1040,760);
  // First-message composer uses the same import path and design.
  await js('qa.fresh(true)');await until('!!qa.editor()','new conversation');await pasteFile(video);await until('qa.cards().length===1','new conversation paste');
  await snap('new-conversation-video');
  fs.unlinkSync(video);assert.ok(fs.existsSync(attached.path),'temporary source can disappear without losing the attachment');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,sent:sent.length,largeVideoBytes:24*1024*1024,videoInput:'local file path',persistent:true}));
  restoreClipboard();app.exit(0);
 }catch(e){console.error(e);await snap('failure');restoreClipboard();app.exit(1);}
});
`;
let server;
try {
 await writeFile(path.join(tmp,'index.html'),'<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
 await writeFile(path.join(tmp,'harness.tsx'),harness);await writeFile(path.join(tmp,'main.cjs'),main);
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0,strictPort:false}});await server.listen();
 const url=new URL(path.relative(root,tmp)+'/index.html',server.resolvedUrls.local[0]).href;
 await new Promise((resolve,reject)=>{
  const env={...process.env,QA_ROOT:root,QA_URL:url,DEV_SERVER_URL:server.resolvedUrls.local[0]};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(tmp,'main.cjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',c=>{out+=c;process.stdout.write(c);});child.stderr.on('data',c=>{err+=c;process.stderr.write(c);});
  const timer=setTimeout(()=>{child.kill();reject(new Error('Timed out\n'+out+'\n'+err));},90000);
  child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);if(code===0&&out.includes('"ok":true'))resolve();else reject(new Error(out+'\n'+err));});
 });
}finally{await server?.close();await rm(tmp,{recursive:true,force:true});}

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const qaRoot = path.join(root, '.aegis-design-qa');
await mkdir(qaRoot, { recursive: true });
const tmp = await mkdtemp(path.join(qaRoot, 'session-links-'));
const harness = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {Toaster} from 'sonner';
import {SessionActionsMenu} from '/src/ui/components/SessionActionsMenu.tsx';
import {FolderTreeView} from '/src/ui/components/FolderTreeView.tsx';
import {ComposerPromptEditor} from '/src/ui/components/ComposerPromptEditor.tsx';
import {useAppStore} from '/src/ui/store/useAppStore.ts';
import '/src/ui/index.css';
const ids=new URLSearchParams(location.search).get('ids').split(',');
const a=useAppStore.getState();const draft=a.createDraftSession('/projects/test');const base=useAppStore.getState().sessions[draft];
useAppStore.setState({sessions:Object.fromEntries(ids.map((id,i)=>[id,{...base,id,isDraft:false,title:i?'Target conversation':'Source conversation',cwd:'/projects/test',status:'idle',messages:[]}]))});
a.setActiveSession(ids[1]);window.electron.onServerEvent(e=>a.handleServerEvent(e));
window.qa={store:useAppStore,ids};
function Harness(){
 const s=useAppStore();const active=s.sessions[s.activeSessionId];
 const [value,setValue]=useState('');const [cursor,setCursor]=useState(0);
 window.qa.value=value;window.qa.setValue=text=>{setValue(text);setCursor(text.length)};
 return <Tooltip.Provider><div style={{display:'flex',height:'100vh',background:'var(--bg-primary)'}}>
 <aside style={{width:260,padding:12,background:'var(--sidebar-bg)'}}><h3>Aegis</h3><FolderTreeView projectCwd="/projects/test" onSessionClick={s.setActiveSession} onSelectProjectFolder={()=>{}} onNewSessionForProject={()=>{}} /></aside>
 <main style={{flex:1,padding:24}}><header style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}><span>{active.title}</span><SessionActionsMenu session={active}/></header>
 <div style={{marginTop:180,border:'1px solid var(--border)',borderRadius:16,padding:20}}><ComposerPromptEditor value={value} cursorIndex={cursor} onChange={(v,c)=>{setValue(v);setCursor(c)}} placeholder="Paste a conversation link" /></div>
 <button id="outside">Outside</button></main><Toaster/></div></Tooltip.Provider>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main = `
const {app,BrowserWindow,ipcMain,clipboard,Menu}=require('electron');
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {createServer}=require('node:http');
app.setPath('userData',path.join(__dirname,'profile'));fs.mkdirSync(app.getPath('userData'),{recursive:true});
const root=process.env.QA_ROOT;
// Keep automated runs off the user's system clipboard. The QA_NATIVE preview
// retains the real OS clipboard for manual native-menu copy/paste validation.
if(!process.env.QA_NATIVE){let clipboardText='';clipboard.writeText=text=>{clipboardText=text};clipboard.readText=()=>clipboardText;}
const sessions=require(path.join(root,'dist-electron/electron/libs/session-store.js'));
const links=require(path.join(root,'dist-electron/shared/session-links.js'));
const refs=require(path.join(root,'dist-electron/electron/libs/session-reference.js'));
const ipc=require(path.join(root,'dist-electron/electron/ipc/session-links.js'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 sessions.initialize();
 const source=sessions.createSession({title:'Source conversation',cwd:'/projects/test/worktree',provider:'claude'});
 const target=sessions.createSession({title:'Target conversation',cwd:'/projects/test',provider:'codex'});
 const url=links.createSessionLink(source.id);
 const win=new BrowserWindow({width:1060,height:700,show:true,webPreferences:{preload:path.join(root,'dist-electron/electron/preload.cjs')}});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 ipc.setupSessionLinksIPC(e=>win.webContents.send('server-event',JSON.stringify(e)));
 ipcMain.on('get-ui-resume-state-sync',e=>{e.returnValue=null});ipcMain.on('renderer-state:get-all-sync',e=>{e.returnValue={}});ipcMain.on('save-ui-resume-state-sync',e=>{e.returnValue=true});ipcMain.handle('set-theme',()=>{});
 const js=code=>win.webContents.executeJavaScript(code,true);
 const click=async(selector,button='left')=>{const p=await js('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');if(!e)throw Error("Missing selector");const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');win.webContents.sendInputEvent({type:'mouseDown',button,clickCount:1,...p});win.webContents.sendInputEvent({type:'mouseUp',button,clickCount:1,...p});await delay(150)};
 const originalPopup=Menu.prototype.popup;
 let openedMenu=null;let popupOptions=null;
 Menu.prototype.popup=function(options){openedMenu=this;popupOptions=options;if(process.env.QA_NATIVE)return originalPopup.call(this,options)};
 const dismiss=async()=>{const callback=popupOptions?.callback;openedMenu=null;popupOptions=null;callback?.();await delay(120)};
 const key=async keyCode=>{win.webContents.sendInputEvent({type:'keyDown',keyCode});win.webContents.sendInputEvent({type:'keyUp',keyCode});await delay(120);if(keyCode==='Escape')await dismiss()};
 const flatten=menu=>menu.items.flatMap(item=>[item,...item.submenu?flatten(item.submenu):[]]);
 const select=async label=>{const item=flatten(openedMenu).find(item=>item.label===label);assert.ok(item,'Missing native menu item: '+label);assert.equal(item.enabled,true);item.click();await dismiss();await delay(170)};
 const shape=menu=>menu.items.map(item=>({label:item.label,type:item.type,enabled:item.enabled,submenu:item.submenu?shape(item.submenu):undefined}));
 const screenshot=async name=>{if(process.env.QA_CAPTURE){fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG())}};
 let http;
 try {
  // URI roundtrips, malformed links and prompt metadata boundaries.
  assert.equal(links.parseSessionLink(url),source.id);
  for(const suffix of ['?x=1','#x','/extra'])assert.equal(links.parseSessionLink(url+suffix),null);
  assert.equal(links.parseSessionLink('aegis://evil@sessions/'+source.id),null);
  assert.equal(links.extractSessionLinks('继续 '+url+'。 '+url).length,2);
  const augmented=refs.appendSessionReferences('continue',url+' '+url,target.id);
  assert.ok(augmented.includes('read_session'));assert.equal(augmented.split(source.id).length-1,1);
  assert.equal(refs.appendSessionReferences('continue',url,source.id),'continue');
  assert.throws(()=>refs.appendSessionReferences('continue','aegis://sessions/00000000-0000-0000-0000-000000000000'),/no longer available/);
  for(let i=0;i<26;i++)sessions.addMessage(source.id,{type:'user_prompt',prompt:'message-'+i,createdAt:10000+i});
  const first=refs.readReferencedSession(source.id,undefined,5);assert.equal(first.messages[0].text,'message-25');
  assert.equal(first.session.cwd,'/projects/test/worktree');
  sessions.addMessage(source.id,{type:'user_prompt',prompt:'new arrival',createdAt:20000});
  let cursor=first.page.nextCursor;const seen=first.messages.map(m=>m.text);
  while(cursor){const p=refs.readReferencedSession(source.id,cursor,5);seen.push(...p.messages.map(m=>m.text));cursor=p.page.nextCursor}
  assert.equal(seen.length,26);assert.equal(new Set(seen).size,26);assert.equal(seen.at(-1),'message-0');
  assert.throws(()=>refs.readReferencedSession(target.id,first.page.nextCursor,5),/cursor/);
  sessions.addMessage(source.id,{type:'assistant',uuid:'bounded',message:{role:'assistant',content:[{type:'text',text:'x'.repeat(10000)}]},createdAt:30000});
  assert.equal(refs.readReferencedSession(source.id,undefined,1).messages[0].truncated,true);
  assert.equal(refs.readReferencedSession(source.id,undefined,1,12000).messages[0].text.length,10000);
  // Exercise the actual MCP tool registration and transport against the real test DB.
  const {handleSessionMcpRequest}=require(path.join(root,'dist-electron/electron/libs/session-http-server.js'));
  const bubbleReader=require(path.join(root,'dist-electron/electron/libs/bubble-session-reader.js'));
  const token='isolated-session-reader-test-token';

  http=createServer((req,res)=>{void handleSessionMcpRequest(req,res,token).catch(e=>{console.error(e);res.writeHead(500).end()})});
  await new Promise(r=>http.listen(0,'127.0.0.1',r));
  const rpc=async(method,params)=>{const r=await fetch('http://127.0.0.1:'+http.address().port+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});assert.equal(r.status,200);return r.json()};
  assert.deepEqual((await rpc('tools/list',{})).result.tools.map(t=>t.name),['read_session']);
  const result=await rpc('tools/call',{name:'read_session',arguments:{sessionId:source.id,limit:2}});
  assert.equal(JSON.parse(result.result.content[0].text).session.id,source.id);
  const missing=await rpc('tools/call',{name:'read_session',arguments:{sessionId:'missing'}});assert.equal(missing.result.isError,true);
  // Claude SDK catalog is independent of delegation, with read-only annotations.
  const {createSessionSdkMcpServer}=require(path.join(root,'dist-electron/electron/libs/session-mcp.js'));
  const claudeReader=await createSessionSdkMcpServer();
  const {InMemoryTransport}=require(path.join(root,'node_modules/@modelcontextprotocol/sdk/dist/cjs/inMemory.js'));
  const {Client}=require(path.join(root,'node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js'));
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  const client=new Client({name:'session-reader-qa',version:'1'});
  await claudeReader.instance.connect(serverTransport);await client.connect(clientTransport);
  const claudeTools=await client.listTools();assert.deepEqual(claudeTools.tools.map(t=>t.name),['read_session']);
  assert.equal(claudeTools.tools[0].annotations.readOnlyHint,true);
  const claudeRead=await client.callTool({name:'read_session',arguments:{sessionId:source.id}});
  assert.equal(JSON.parse(claudeRead.content[0].text).session.id,source.id);
  await client.close();await claudeReader.instance.close();
  // Native Bubble tool assembly: real SDK and agent loop, deterministic model
  // transport only. No global MCP registration or paid model requests.
  process.env.BUBBLE_HOME=path.join(__dirname,'bubble-home');
  fs.mkdirSync(process.env.BUBBLE_HOME,{recursive:true});
  const bubbleSettings=path.join(process.env.BUBBLE_HOME,'settings.json');
  const originalSettings=JSON.stringify({theme:'dark',mcpServers:{}});
  fs.writeFileSync(bubbleSettings,originalSettings);
  const {BubbleSdk}=await import('@bubblebrain-ai/bubble');
  const cwd=path.join(__dirname,'bubble-cwd');fs.mkdirSync(cwd,{recursive:true});
  const sdk=new BubbleSdk({defaultCwd:cwd,mcp:false});
  bubbleReader.installBubbleSessionReader(sdk);bubbleReader.installBubbleSessionReader(sdk);
  let steps=0;let olderRead=false;
  const fakeProvider={async *streamChat(messages,options){
    assert.ok(options.tools.some(t=>t.name==='read_session'));
    steps++;
    if(steps<=2){
      const args={sessionId:source.id,limit:1};
      if(steps===2){
        const result=JSON.parse(messages.filter(m=>m.role==='tool').at(-1).content);
        assert.equal(result.session.id,source.id);assert.ok(result.page.nextCursor);
        args.cursor=result.page.nextCursor;olderRead=true;
      }
      yield {type:'tool_call',id:'read-'+steps,name:'read_session',arguments:JSON.stringify(args),isStart:true,isEnd:true};
    }else{yield {type:'text',content:'Read referenced conversation successfully.'}}
    yield {type:'done'};
  }};
  sdk.resolveProvider=()=>({provider:fakeProvider,providerId:'test',model:'test:fixture'});
  const id=sdk.createSession({cwd}).id;let catalog;const events=[];
  for await(const e of sdk.runTurn(id,{prompt:refs.appendSessionReferences('',url,target.id,'bubble'),onStart:info=>{
    catalog=info.tools;bubbleReader.assertBubbleSessionReader(url,info.tools,target.id);
  }}))events.push(e);
  assert.equal(catalog.filter(t=>t==='read_session').length,1);assert.equal(steps,3);assert.equal(olderRead,true);
  assert.equal(events.filter(e=>e.type==='tool_end').length,2);
  assert.equal(events.some(e=>e.type==='tool_start'&&e.name==='bash'),false);
  assert.equal(fs.readFileSync(bubbleSettings,'utf8'),originalSettings);
  assert.throws(()=>bubbleReader.assertBubbleSessionReader(url,[],target.id),/Conversation reader is unavailable/);
  bubbleReader.assertBubbleSessionReader(url,[],source.id);
  bubbleReader.assertBubbleSessionReader('ordinary prompt',[],target.id);
  assert.throws(()=>bubbleReader.installBubbleSessionReader({}),/cannot register/);
  // Pi's explicit allowlist must include the custom tool as well as registering it.
  const pi=await import('@earendil-works/pi-coding-agent');
  const {createPiSessionReader}=require(path.join(root,'dist-electron/electron/libs/session-native-tool.js'));
  const piReader=createPiSessionReader();
  const {session:piSession}=await pi.createAgentSession({cwd,agentDir:path.join(__dirname,'pi-home'),sessionManager:pi.SessionManager.inMemory(cwd),tools:['read_session'],customTools:[piReader]});
  assert.ok(piSession.getActiveToolNames().includes('read_session'));
  const piRead=await piReader.execute('qa',{sessionId:source.id});
  assert.equal(JSON.parse(piRead.content[0].text).session.id,source.id);piSession.dispose();
  // Runtime descriptor / CLI arguments do not call config persistence helpers.
  const sessionHttp=require(path.join(root,'dist-electron/electron/libs/session-http-server.js'));
  const codexConfig=require(path.join(root,'dist-electron/electron/libs/codex-mcp-settings.js'));
  const kimiConfig=require(path.join(root,'dist-electron/electron/libs/kimi-mcp-settings.js'));
  const originalCodex=codexConfig.upsertCodexMcpServer,originalKimi=kimiConfig.upsertKimiMcpServerRaw;
  codexConfig.upsertCodexMcpServer=()=>{throw Error('Unexpected user config write')};
  kimiConfig.upsertKimiMcpServerRaw=()=>{throw Error('Unexpected user config write')};
  try {
    const args=await sessionHttp.getSessionReaderCodexArgs();
    assert.equal(args[0],'-c');assert.ok(args[1].startsWith('mcp_servers.aegis-sessions='));
    const config=await sessionHttp.getSessionReaderHttpConfig();
    assert.equal(config.type,'http');assert.ok(config.url.startsWith('http://127.0.0.1:'));
    const denied=await fetch(config.url,{method:'POST'});assert.equal(denied.status,401);
  } finally {
    codexConfig.upsertCodexMcpServer=originalCodex;kimiConfig.upsertKimiMcpServerRaw=originalKimi;
    sessionHttp.disposeSessionHttpServer();
  }
  for(const provider of ['claude','codex','bubble','opencode','grok','pi','qoder','deepseek']){
    const context=refs.appendSessionReferences('',url,target.id,provider);
    assert.ok(context.includes('read_session'));assert.ok(!context.includes('delegate'));assert.ok(!context.includes('xxxxxxxx'));
  }
  assert.throws(()=>refs.appendSessionReferences('',url,target.id,'kimi'),/not available/);
  assert.equal(refs.appendSessionReferences('ordinary prompt','ordinary prompt',target.id,'kimi'),'ordinary prompt');
  await win.loadURL(process.env.QA_URL+'?ids='+source.id+','+target.id);
  for(let i=0;i<100;i++){if(await js('!!window.qa && !!document.querySelector("[aria-label=\\\\"Conversation actions\\\\"]")'))break;await delay(100)}
  win.focus();
  if(process.env.QA_NATIVE){
    console.log('Native menu preview ready');
    await new Promise(r=>setTimeout(r,process.env.QA_NATIVE==='1'?90000:Number(process.env.QA_NATIVE)));
    console.log(JSON.stringify({ok:true,preview:true}));http.close();sessions.close();app.exit(0);return;
  }
  await click('[aria-label="Conversation actions"]');const headerShape=shape(openedMenu);assert.equal(openedMenu.items.filter(i=>i.type==='separator').length,2);assert.ok(openedMenu.items.find(i=>i.label==='Copy')?.submenu);for(const item of flatten(openedMenu).filter(i=>i.type!=='separator')){if(process.platform==='darwin')assert.equal(item.icon.isEmpty(),false,item.label+' missing icon')}
  await select('Conversation link');assert.equal(clipboard.readText(),links.createSessionLink(target.id));
  // Right click the source while a different conversation is active.
  await js('(()=>{const e=[...document.querySelectorAll("[data-session-id]")].find(e=>e.dataset.sessionId===qa.ids[0]);if(!e)throw Error("Source row missing");e.dataset.qaSource="true"})()');
  await click('[data-qa-source]','right');assert.deepEqual(shape(openedMenu),headerShape);await select('Conversation link');assert.equal(clipboard.readText(),url);
  assert.equal(await js('qa.store.getState().activeSessionId'),target.id);
  await click('[data-qa-source]','right');await select('Working directory');assert.equal(clipboard.readText(),'/projects/test/worktree');
  await click('[aria-label="Conversation actions"]');await key('Escape');assert.equal(openedMenu,null);assert.equal(await js('[...document.querySelectorAll("button")].find(e=>e.title==="Conversation actions").getAttribute("aria-expanded")'),'false');
  await click('[aria-label="Conversation actions"]');await click('#outside');await dismiss();assert.equal(openedMenu,null);assert.equal(await js('[...document.querySelectorAll("button")].find(e=>e.title==="Conversation actions").getAttribute("aria-expanded")'),'false');
  clipboard.writeText(url);await click('[contenteditable=true]');
  await js('(()=>{const data=new DataTransfer();data.setData("text/plain",'+JSON.stringify(clipboard.readText())+');document.querySelector("[contenteditable=true]").dispatchEvent(new ClipboardEvent("paste",{clipboardData:data,bubbles:true,cancelable:true}))})()');await delay(300);
  assert.equal(await js('qa.value'),url);assert.equal(await js('document.querySelector("[data-session-reference]")?.textContent.includes("Source conversation")'),true);
  assert.equal(await js('document.querySelector("[data-session-reference] img")'),null,'local reference must not request a favicon');
  await screenshot('pasted-reference');await key('Backspace');assert.equal(await js('qa.value'),'');
  ipc.queueSessionLink(url);ipc.flushSessionLink();await delay(150);assert.equal(await js('qa.store.getState().activeSessionId'),source.id);
  // Provider/running guards are shared; no real worktree is mutated.
  await js('qa.store.setState(s=>({sessions:{...s.sessions,[qa.ids[0]]:{...s.sessions[qa.ids[0]],provider:"kimi",status:"running"}}}))');
  await click('[aria-label="Conversation actions"]');
  assert.equal(flatten(openedMenu).find(i=>i.id==='fork').enabled,false);
  assert.equal(flatten(openedMenu).find(i=>i.id==='move-worktree').enabled,false);await dismiss();
  await js('qa.store.setState(s=>({sessions:{...s.sessions,[qa.ids[0]]:{...s.sessions[qa.ids[0]],provider:"bubble",status:"idle"}}}))');
  await click('[aria-label="Conversation actions"]');assert.equal(flatten(openedMenu).some(i=>i.id==='fork'),false);await dismiss();
  // Drafts have no stable persisted link.
  await js('qa.store.setState(s=>({sessions:{...s.sessions,[qa.ids[0]]:{...s.sessions[qa.ids[0]],isDraft:true}}}))');
  await click('[aria-label="Conversation actions"]');assert.equal(flatten(openedMenu).find(i=>i.id==='copy-link').enabled,false);await key('Escape');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,checks:['identical native menu entry points and SF icons','clipboard identity and cwd','menu dismissal','paste chip and deletion','reference validation','keyset pagination during writes','bounded content','real MCP read_session','Bubble actual native tool loop and older history','Pi native tool catalog','no user config writes','all provider prompt contracts','deep-link navigation','draft disabled']}));
  http.close();sessions.close();app.exit(0);
 }catch(e){console.error(e);console.error(errors);await screenshot('failure');http?.close();app.exit(1)}
});
`;
let server;
try {
  await writeFile(path.join(tmp,'index.html'),'<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(tmp,'harness.tsx'),harness);
  await writeFile(path.join(tmp,'main.cjs'),main);
  server=await createServer({root,configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0,strictPort:false}});
  await server.listen();
  const url=new URL(path.relative(root,tmp)+'/index.html',server.resolvedUrls.local[0]).href;
  await new Promise((resolve,reject)=>{
    const env={...process.env,QA_ROOT:root,QA_URL:url,DEV_SERVER_URL:server.resolvedUrls.local[0]};delete env.ELECTRON_RUN_AS_NODE;
    const child=spawn(process.env.QA_ELECTRON_EXECUTABLE || path.join(root,'node_modules/.bin/electron'),[path.join(tmp,'main.cjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
    let out='',err='';child.stdout.on('data',c=>{out+=c;process.stdout.write(c);});child.stderr.on('data',c=>{err+=c;process.stderr.write(c);});
    const timeout=setTimeout(()=>{child.kill();reject(new Error('Timed out\n'+out+'\n'+err));},process.env.QA_NATIVE ? 300000 : 120000);
    child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);if(code===0 && out.includes('\"ok\":true')){resolve();}else reject(new Error(out+'\n'+err));});
  });
  console.log('Session links Electron regression passed');
} finally {await server?.close();await rm(tmp,{recursive:true,force:true});}

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// The embedded terminal UI (TerminalChrome + terminal host) against a fake
// backend: one replay per start, held output keeps its order, large pastes
// are split, exit stops input, and one event subscription serves all tabs.
// QA_CAPTURE=<dir> saves screenshots.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const qaRoot = path.join(root, 'dev-fixtures');
await mkdir(qaRoot, { recursive: true });
const tmp = await mkdtemp(path.join(qaRoot, 'terminal-host-'));
const harness = `
// Text is read from the DOM renderer, so keep WebGL out of the picture.
const realGetContext=HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext=function(kind,...rest){return /webgl/.test(kind)?null:realGetContext.call(this,kind,...rest)};
const listeners=new Set();const calls=[];
const snapshot=(history,status='running')=>({threadId:'scope',terminalId:'',cwd:'/tmp',status,pid:1,history,exitCode:null,exitSignal:null,updatedAt:'',cols:80,rows:24,agentKind:'shell'});
const emit=e=>{for(const l of [...listeners])l({createdAt:'',threadId:'scope',...e})};
window.qa={calls,emit,listeners,openPlan:{}};
window.electron={terminal:{
 open:async input=>{calls.push(['open',input]);const plan=window.qa.openPlan[input.terminalId]||{};
  if(plan.fail)return{ok:false,message:plan.fail};
  const snap={...snapshot(plan.history||''),terminalId:input.terminalId};
  if(plan.started)emit({type:'started',terminalId:input.terminalId,snapshot:snap});
  return{ok:true,snapshot:snap,...(plan.launch?{launchCommand:plan.launch}:{})}},
 write:async input=>{calls.push(['write',input]);return{ok:true}},
 resize:async input=>{calls.push(['resize',input]);return{ok:true}},
 clear:async input=>{calls.push(['clear',input]);return{ok:true}},
 close:async input=>{calls.push(['close',input]);return{ok:true}},
 onEvent:cb=>{listeners.add(cb);return()=>listeners.delete(cb)},
}};
const React=await import('react');const {createRoot}=await import('react-dom/client');
const {TerminalChrome}=await import('/src/ui/terminal/TerminalChrome.tsx');
await import('/src/ui/index.css');
const tab=(id,extra={})=>({id,label:id,agent:'shell',activity:null,initialCommand:null,initialNotice:null,...extra});
function Harness(){
 const [state,setState]=React.useState({tabs:[tab('a',{initialCommand:'claude'}),tab('b')],active:'a',visible:true});
 window.qa.set=patch=>setState(s=>({...s,...patch}));
 window.qa.hooks=[];
 const hooksForTab=React.useCallback(t=>({onError:m=>window.qa.hooks.push('error:'+t.id+':'+m),onExit:c=>window.qa.hooks.push('exit:'+t.id+':'+c),onActivity:e=>window.qa.hooks.push('activity:'+t.id)}),[]);
 return <div style={{height:'100vh',width:state.width||'100vw'}}><TerminalChrome threadId="scope" cwd="/tmp" visible={state.visible} tabs={state.tabs} activeTabId={state.active} onActiveTabChange={id=>setState(s=>({...s,active:id}))} onCloseTab={()=>{}} onAddTab={()=>{}} hooksForTab={hooksForTab}/></div>;
}
window.qa.render=()=>createRoot(document.getElementById('root')).render(<Harness/>);
window.qa.screen=id=>[...document.querySelectorAll('[data-terminal-runtime-key="scope::'+id+'"] .xterm-rows > div')].map(r=>r.textContent.replace(/\\u00a0/g,' ').trimEnd()).join('\\n');
window.qa.ready=true;
`;
const main = `
const {app,BrowserWindow}=require('electron');
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));fs.mkdirSync(app.getPath('userData'),{recursive:true});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:900,height:600,show:true,webPreferences:{backgroundThrottling:false}});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=code=>win.webContents.executeJavaScript(code,true);
 const until=async(code,label,ms=4000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await js(code))return;await delay(50)}throw new Error('timed out: '+label)};
 const screenshot=async name=>{if(!process.env.QA_CAPTURE)return;fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG())};
 const calls=kind=>js('qa.calls.filter(c=>c[0]==='+JSON.stringify(kind)+').map(c=>c[1])');
 const screen=id=>js('qa.screen('+JSON.stringify(id)+')');
 const emit=e=>js('qa.emit('+JSON.stringify(e)+')').then(()=>delay(120));
 try{
  await win.loadURL(process.env.QA_URL);
  await until('window.qa&&qa.ready','harness');
  // Tab a: a fresh shell whose started event and open result carry the same history.
  await js('qa.openPlan={a:{history:"HISTORY-A\\\\r\\\\n",started:true},b:{history:"HISTORY-B\\\\r\\\\n"}}');
  await js('qa.render()');
  await until('qa.screen("a").includes("HISTORY-A")','history replayed');
  await delay(400);
  const opens=await calls('open');
  assert.deepEqual(opens.map(o=>o.terminalId).sort(),['a','b'],'every mounted tab connects once');
  assert.deepEqual({cwd:opens[0].cwd,agentKind:opens[0].agentKind,threadId:opens[0].threadId},{cwd:'/tmp',agentKind:'shell',threadId:'scope'});
  assert.ok(opens[0].cols>=20&&opens[0].rows>=5,'open carries the fitted grid size');
  assert.equal((await screen('a')).split('HISTORY-A').length-1,1,'the history is replayed once, not twice');
  assert.equal(await js('qa.listeners.size'),1,'one event subscription for the whole app');
  await until('qa.calls.some(c=>c[0]==="write"&&c[1].data==="claude\\\\r")','launch command');
  assert.equal((await calls('write')).filter(w=>w.data==='claude\\r').length,1,'the launch command is typed once');

  // Live output shows up; a resize reaches the backend once per size.
  await emit({type:'output',terminalId:'a',data:'LIVE-1\\r\\n'});
  assert.ok((await screen('a')).includes('LIVE-1'));
  const resizesBefore=(await calls('resize')).length;
  await js('qa.set({width:"600px"})');await delay(700);
  const resizes=(await calls('resize')).slice(resizesBefore);
  assert.equal(resizes.length,1,'one resize for one new size: '+JSON.stringify(resizes));
  await js('qa.set({width:"100vw"})');await delay(700);
  await screenshot('1-live');

  // Output for a tab nobody is looking at is held, in order, until it is shown.
  await js('qa.set({active:"b"})');
  await until('qa.screen("b").includes("HISTORY-B")','second tab shows its history');
  await emit({type:'output',terminalId:'a',data:'HELD-1\\r\\n'});
  await js('qa.set({visible:false})');await delay(100);
  await emit({type:'output',terminalId:'a',data:'HELD-2\\r\\n'});
  await js('qa.set({visible:true})');await delay(100);
  await emit({type:'output',terminalId:'a',data:'HELD-3\\r\\n'});
  assert.equal((await screen('a')).includes('HELD-1'),false,'nothing is drawn into a hidden tab');
  await js('qa.set({active:"a"})');await delay(300);
  const shown=await screen('a');
  const order=['HELD-1','HELD-2','HELD-3'].map(t=>shown.indexOf(t));
  assert.ok(order.every(i=>i>=0)&&order[0]<order[1]&&order[1]<order[2],'held output keeps arrival order: '+order);

  // A paste larger than one backend write is split, in order, without loss.
  const before=(await calls('write')).length;
  await js('(()=>{const dt=new DataTransfer();dt.setData("text/plain","x".repeat(150000));const ta=document.querySelector("[data-terminal-runtime-key=\\\\"scope::a\\\\"] textarea");ta.focus();ta.dispatchEvent(new ClipboardEvent("paste",{clipboardData:dt,bubbles:true,cancelable:true}))})()');
  await delay(400);
  const pieces=(await calls('write')).slice(before).map(w=>w.data);
  assert.ok(pieces.length>=3,'split into several writes: '+pieces.length);
  assert.ok(pieces.every(p=>p.length<=65536),'every piece fits the backend limit');
  assert.equal(pieces.join('').replace(/\\x1b\\[20[01]~/g,'').length,150000,'nothing is lost');

  // Typing reaches the backend; terminal reports do not.
  const typed=(await calls('write')).length;
  win.webContents.sendInputEvent({type:'char',keyCode:'q'});await delay(200);
  assert.deepEqual((await calls('write')).slice(typed).map(w=>w.data),['q']);

  // Exit: the hook fires, a grey line is shown, typing stops.
  await emit({type:'exited',terminalId:'a',exitCode:0,exitSignal:null});
  assert.ok((await screen('a')).includes('[Process exited: 0]'));
  assert.ok((await js('qa.hooks')).includes('exit:a:0'));
  const afterExit=(await calls('write')).length;
  win.webContents.sendInputEvent({type:'char',keyCode:'z'});await delay(200);
  assert.equal((await calls('write')).length,afterExit,'no input after the shell exited');
  await screenshot('2-exited');

  // Clear empties the screen and tells the backend.
  await js('document.querySelector("[aria-label=\\\\"Clear terminal\\\\"]").click()');await delay(200);
  assert.equal((await screen('a')).trim(),'');
  assert.equal((await calls('clear')).length,1);

  assert.deepEqual(errors.filter(e=>!/No handler registered/.test(e)),[]);
  console.log(JSON.stringify({ok:true,checks:['single replay per start','one event subscription','launch once','one resize per size','held output order','paste split','report filtering','exit stops input','clear']}));
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
    const env = { ...process.env, QA_URL: url };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.env.QA_ELECTRON_EXECUTABLE || path.join(root, 'node_modules/.bin/electron'), [path.join(tmp, 'main.cjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; process.stdout.write(c); });
    child.stderr.on('data', (c) => { err += c; process.stderr.write(c); });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Timed out\n' + out + '\n' + err)); }, 120000);
    child.on('error', reject);
    child.on('exit', (code) => { clearTimeout(timeout); code === 0 && out.includes('"ok":true') ? resolve() : reject(new Error(out + '\n' + err)); });
  });
  console.log('Terminal host Electron regression passed');
} finally { await server?.close(); await rm(tmp, { recursive: true, force: true }); }

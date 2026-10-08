import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// The embedded terminal UI wired to the real terminal IPC and pty backend:
// typed commands run in the requested cwd, output produced while the panel
// is hidden appears when it is shown, and exit is reported.
// QA_CAPTURE=<dir> saves screenshots.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const qaRoot = path.join(root, 'dev-fixtures');
await mkdir(qaRoot, { recursive: true });
const tmp = await mkdtemp(path.join(qaRoot, 'terminal-pty-'));
const harness = `
const HTMLCanvas=HTMLCanvasElement.prototype;const realGetContext=HTMLCanvas.getContext;
HTMLCanvas.getContext=function(kind,...rest){return /webgl/.test(kind)?null:realGetContext.call(this,kind,...rest)};
const React=await import('react');const {createRoot}=await import('react-dom/client');
const {TerminalChrome}=await import('/src/ui/terminal/TerminalChrome.tsx');
await import('/src/ui/index.css');
const tab=id=>({id,label:id,agent:'shell',activity:null,initialCommand:null,initialNotice:null});
window.qa={hooks:[]};
function Harness(){
 const [state,setState]=React.useState({tabs:[tab('live')],active:'live',visible:true});
 window.qa.set=patch=>setState(s=>({...s,...patch}));
 const hooksForTab=React.useCallback(t=>({onExit:c=>window.qa.hooks.push('exit:'+c),onError:m=>window.qa.hooks.push('error:'+m)}),[]);
 return <div style={{height:'100vh'}}><TerminalChrome threadId="live-scope" cwd={window.qa.cwd} visible={state.visible} tabs={state.tabs} activeTabId={state.active} onActiveTabChange={()=>{}} onCloseTab={()=>{}} onAddTab={()=>{}} hooksForTab={hooksForTab}/></div>;
}
window.qa.render=cwd=>{window.qa.cwd=cwd;createRoot(document.getElementById('root')).render(<Harness/>)};
window.qa.screen=()=>[...document.querySelectorAll('.xterm-rows > div')].map(r=>r.textContent.replace(/\\u00a0/g,' ').trimEnd()).join('\\n');
window.qa.ready=true;
`;
const main = `
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));fs.mkdirSync(app.getPath('userData'),{recursive:true});
process.env.AEGIS_TERMINAL_HISTORY_DIR=path.join(__dirname,'history');
const root=process.env.QA_ROOT;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:900,height:600,show:true,webPreferences:{backgroundThrottling:false,preload:path.join(root,'dist-electron/electron/preload.cjs')}});
 require(path.join(root,'dist-electron/electron/ipc/terminal.js')).register({mainWindow:win});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=code=>win.webContents.executeJavaScript(code,true);
 const until=async(code,label,ms=8000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await js(code))return;await delay(80)}throw new Error('timed out: '+label+'\\n'+await js('qa.screen()'))};
 const screenshot=async name=>{if(!process.env.QA_CAPTURE)return;fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG())};
 const type=async text=>{win.focus();win.webContents.focus();for(const ch of text){if(ch==='\\r'){win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'})}else win.webContents.sendInputEvent({type:'char',keyCode:ch})}await delay(150)};
 try{
  await win.loadURL(process.env.QA_URL);
  await until('window.qa&&qa.ready','harness');
  await js('qa.render('+JSON.stringify(fs.realpathSync(os.tmpdir()))+')');
  await delay(1500);
  await type('echo AEGIS_$((40+2))\\r');
  await until('qa.screen().includes("AEGIS_42")','shell echoes typed command output');
  // Let the prompt redraw settle: some prompts drop typeahead while they repaint.
  await delay(800);
  await type('pwd\\r');
  await until('qa.screen().includes('+JSON.stringify(fs.realpathSync(os.tmpdir()))+')','shell runs in the requested cwd');
  // A hidden panel holds output and shows it when it comes back.
  await delay(800);
  await js('qa.set({visible:false})');await delay(150);
  await type('echo HIDDEN_$((1+1))\\r');
  await delay(500);
  await js('qa.set({visible:true})');
  await until('qa.screen().includes("HIDDEN_2")','output produced while hidden appears when shown');
  await screenshot('1-live-shell');
  await delay(800);
  await type('exit\\r');
  await until('qa.screen().includes("[Process exited: 0]")','exit line');
  assert.ok((await js('qa.hooks')).includes('exit:0'));
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,checks:['real pty echo','cwd','hidden output delivered on show','exit']}));
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
  console.log('Terminal live pty Electron check passed');
} finally { await server?.close(); await rm(tmp, { recursive: true, force: true }); }

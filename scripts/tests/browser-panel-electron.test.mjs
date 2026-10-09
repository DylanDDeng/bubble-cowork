import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// The real BrowserPanel wired to the real browser IPC and page manager: type
// an address, follow the page in the toolbar, see failures in the status
// line, and take the native page off screen when the panel collapses.
// QA_CAPTURE=<dir> saves screenshots.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const qaRoot = path.join(root, 'dev-fixtures');
await mkdir(qaRoot, { recursive: true });
const tmp = await mkdtemp(path.join(qaRoot, 'browser-panel-'));
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserPanel} from '/src/ui/components/browser/BrowserPanel.tsx';
import '/src/ui/index.css';
function Harness(){
 const [collapsed,setCollapsed]=React.useState(false);
 window.qa={setCollapsed};
 return <div style={{position:'relative',width:'100vw',height:'100vh'}}><BrowserPanel sessionId={null} browserSessionId="panel-qa" collapsed={collapsed} width={800} onWidthChange={()=>{}} isFullscreen={false} onToggleFullscreen={()=>{}} embedded/></div>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main = `
const {app,BrowserWindow,ipcMain}=require('electron');
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
const assert=require('node:assert/strict');const fs=require('node:fs');const http=require('node:http');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));fs.mkdirSync(app.getPath('userData'),{recursive:true});
const root=process.env.QA_ROOT;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 ipcMain.on('get-ui-resume-state-sync',e=>{e.returnValue=null});ipcMain.on('renderer-state:get-all-sync',e=>{e.returnValue={}});ipcMain.on('save-ui-resume-state-sync',e=>{e.returnValue=true});
 ipcMain.on('renderer-state:set',()=>{});ipcMain.handle('set-theme',()=>{});
 const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<!doctype html><title>QA '+req.url+'</title><body style="background:#e8f4ff"><h1>'+req.url+'</h1>')});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const closed=http.createServer();await new Promise(r=>closed.listen(0,'127.0.0.1',r));const refused='127.0.0.1:'+closed.address().port;await new Promise(r=>closed.close(r));
 const win=new BrowserWindow({width:900,height:640,show:true,webPreferences:{backgroundThrottling:false,preload:path.join(root,'dist-electron/electron/preload.cjs')}});
 require(path.join(root,'dist-electron/electron/browser-ipc.js')).registerBrowserIpc(win);
 const {browserManager}=require(path.join(root,'dist-electron/electron/browserManager.js'));
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=code=>win.webContents.executeJavaScript(code,true);
 const until=async(code,label,ms=8000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await js(code))return;await delay(60)}throw new Error('timed out: '+label)};
 const screenshot=async name=>{if(!process.env.QA_CAPTURE)return;fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG())};
 const address='document.querySelector("input[aria-label=Address]")';
 const go=async text=>{await js('(()=>{const el='+address+';el.focus();const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;set.call(el,'+JSON.stringify(text)+');el.dispatchEvent(new Event("input",{bubbles:true}))})()');await delay(80);await js(address+'.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');await delay(200)};
 const page=()=>browserManager.getState({sessionId:'panel-qa'}).page;
 try{
  await win.loadURL(process.env.QA_URL);
  await until('!!'+address,'panel');
  await until('true',''); await delay(500);
  assert.equal(await js(address+'.value'),'','a blank page shows an empty address');
  await until('document.body.textContent.includes("Start browsing")','a blank page shows the start view');
  assert.equal(win.contentView.children.length,0,'the start view takes the native page off screen');
  await screenshot('0-start');

  await go(base.replace('http://','')+'/first');
  await until(address+'.value==='+JSON.stringify(base+'/first'),'address shows the resolved URL');
  await delay(400);
  assert.equal(page().title,'QA /first');
  assert.equal(win.contentView.children.length,1,'a loaded page is placed over the panel');
  await go(base+'/second');
  await until('!document.querySelector("[aria-label=Back]").disabled','back enabled after a second page');
  await screenshot('1-loaded');
  await js('document.querySelector("[aria-label=Back]").click()');
  await until(address+'.value==='+JSON.stringify(base+'/first'),'back returns to the first page');

  await go(refused);
  await until('document.body.textContent.includes("be opened")','the error view explains the failure');
  await delay(500);
  assert.ok(await js('document.body.textContent.includes("Connection refused.")'),'the reason stays after loading stops');
  assert.equal(win.contentView.children.length,0,'the error view takes the native page off screen');
  await screenshot('2-refused');
  // Try again on a failing address keeps explaining; a good address recovers.
  await js('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("Try again")).click()');
  await until('document.body.textContent.includes("Connection refused.")','retry fails the same way');
  await go(base+'/second');
  await until(address+'.value==='+JSON.stringify(base+'/second'),'recovers on a good address');
  await delay(400);
  assert.equal(win.contentView.children.length,1,'the page is back over the panel');

  // ⌘F in the panel opens find; matches are counted.
  const mod=process.platform==='darwin'?'metaKey':'ctrlKey';
  await js(address+'.dispatchEvent(new KeyboardEvent("keydown",{key:"f",code:"KeyF",'+mod+':true,bubbles:true}))');
  await until('!!document.querySelector("input[data-browser-find]")','find bar opens');
  await js('(()=>{const el=document.querySelector("input[data-browser-find]");const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;set.call(el,"second");el.dispatchEvent(new Event("input",{bubbles:true}))})()');
  await until('document.body.textContent.includes("1/1")','find counts the match');
  await screenshot('3-find');
  await js('document.querySelector("input[data-browser-find]").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await until('!document.querySelector("input[data-browser-find]")','Escape closes find');

  await js('qa.setCollapsed(true)');await delay(300);
  assert.equal(win.contentView.children.length,0,'collapsing takes the page off the window');
  await js('qa.setCollapsed(false)');
  await until('document.querySelector("input")',''); await delay(600);
  assert.equal(win.contentView.children.length,1,'expanding shows it again');

  // An app restart leaves the main process with no page: the panel opens the
  // page it remembers instead of a blank one.
  await go(base+'/restored');
  await until(address+'.value==='+JSON.stringify(base+'/restored'),'restored page loads');
  await delay(300);
  await js('qa.setCollapsed(true)');await delay(300);
  browserManager.close({sessionId:'panel-qa'});
  assert.equal(page(),null,'the main process forgot the page');
  await js('qa.setCollapsed(false)');
  const end=Date.now()+8000;while(Date.now()<end&&!(page()&&page().title==='QA /restored'))await delay(60);
  assert.equal(page()&&page().url,base+'/restored','the remembered page is opened again');
  await until(address+'.value==='+JSON.stringify(base+'/restored'),'address shows the restored page');

  assert.deepEqual(errors.filter(e=>!/No handler registered/.test(e)),[]);
  console.log(JSON.stringify({ok:true,checks:['start view','typed host resolves and loads','back','error view + retry','find','collapse hides native view','restores the remembered page']}));
  app.exit(0);
 }catch(e){console.error(e);console.error(errors);console.error('state at failure: page',JSON.stringify(page()),'input',await js(address+'.value'),'body',await js('document.body.innerText.slice(0,300)'));await screenshot('failure');app.exit(1)}
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
  console.log('Browser panel Electron regression passed');
} finally { await server?.close(); await rm(tmp, { recursive: true, force: true }); }

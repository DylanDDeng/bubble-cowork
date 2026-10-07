// Drives the real screenshot IPC + editor window: capture the host window,
// select/cancel an area, style it, redact, crop, undo, copy, reopen and attach.
import { createServer } from 'vite';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const dir = await mkdtemp(path.join(root, '.aegis-design-qa/screenshot-editor-'));
let server;

const main = String.raw`
const {app,BrowserWindow,clipboard,ipcMain}=require('electron');
// CI runners have Reduce Motion on; tests expect the default motion preference.
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
let copiedImage;clipboard.clear=()=>{copiedImage=null};clipboard.writeImage=image=>{copiedImage=image};clipboard.readImage=()=>copiedImage;
ipcMain.on('get-ui-resume-state-sync',e=>{e.returnValue=null});ipcMain.on('renderer-state:get-all-sync',e=>{e.returnValue={}});ipcMain.handle('set-theme',()=>{});ipcMain.handle('get-app-preferences',()=>({}));const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',path.join(__dirname,'profile'));
const root=process.env.QA_ROOT;
const {setupScreenshotIPC}=require(path.join(root,'dist-electron/electron/ipc/screenshot.js'));
const shots=require(path.join(root,'dist-electron/electron/libs/screenshot.js'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const host=new BrowserWindow({width:900,height:560,show:true,webPreferences:{backgroundThrottling:false,preload:path.join(root,'dist-electron/electron/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 await host.loadURL(process.env.QA_HOST_URL);
 setupScreenshotIPC(host);
 const errors=[];
 const editor=()=>BrowserWindow.getAllWindows().find(w=>w!==host&&!w.isDestroyed());
 const js=(s)=>editor().webContents.executeJavaScript(s,true);
 const until=async(test,label)=>{for(let i=0;i<150;i++){try{if(await test())return}catch{}await delay(80)}throw Error('Timed out: '+label)};
 const shot=async name=>{await delay(250);fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await editor().webContents.capturePage()).toPNG())};
 const click=async sel=>{await js('document.querySelector('+JSON.stringify(sel)+').click()');await delay(120)};
 const button=async text=>{await js('[...document.querySelectorAll("button")].find(b=>b.textContent.trim().startsWith('+JSON.stringify(text)+')).click()');await delay(120)};
 const footer=()=>js('document.querySelector("[data-screenshot-output]").textContent');
 const key=async(keyCode,modifiers=[])=>{const wc=editor().webContents;wc.sendInputEvent({type:'keyDown',keyCode,modifiers});wc.sendInputEvent({type:'keyUp',keyCode,modifiers});await delay(150)};
 const drag=async(sel,fx1,fy1,fx2,fy2)=>{
  const r=await js('(()=>{const b=document.querySelector('+JSON.stringify(sel)+').getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height}})()');
  const wc=editor().webContents;const p=(fx,fy)=>({x:Math.round(r.x+r.w*fx),y:Math.round(r.y+r.h*fy)});
  const a=p(fx1,fy1),b=p(fx2,fy2);
  wc.sendInputEvent({type:'mouseDown',...a,button:'left',clickCount:1});
  for(let i=1;i<=6;i++)wc.sendInputEvent({type:'mouseMove',x:Math.round(a.x+(b.x-a.x)*i/6),y:Math.round(a.y+(b.y-a.y)*i/6),button:'left'});
  wc.sendInputEvent({type:'mouseUp',...b,button:'left',clickCount:1});await delay(200);
 };
 const waitEditor=async()=>{await until(()=>!!editor(),'editor window');editor().webContents.on('console-message',e=>{if(e.level==='error'&&/screenshot/i.test(e.message))errors.push(e.message)});await until(()=>js('(()=>{const c=document.querySelector("canvas");return !!c&&c.width>1})()'),'editor canvas')};
 try{
  assert.deepEqual(await shots.openLastScreenshot(),{status:'error',message:'No screenshot yet.'});
  const hostJs=s=>host.webContents.executeJavaScript(s,true);
  await until(()=>hostJs('!!window.qaReady'),'host selection listener');
  const selected=()=>hostJs('!!document.querySelector("[data-screenshot-area-selector]")');
  const cancel=()=>{host.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});host.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'})};
  let pending=shots.captureScreenshot('app');
  await until(selected,'area selector');
  assert.equal(!!editor(),false,'app capture waits for user selection');
  assert.deepEqual(await shots.captureScreenshot('app'),{status:'busy'});
  host.webContents.sendInputEvent({type:'mouseDown',x:250,y:150,button:'left',clickCount:1});
  host.webContents.sendInputEvent({type:'mouseUp',x:250,y:150,button:'left',clickCount:1});
  await delay(100);assert.equal(await selected(),true,'a click alone does not capture the whole app');
  cancel();assert.deepEqual(await pending,{status:'cancelled'});
  assert.equal(await shots.loadScreenshotEditorPayload(),null,'cancel creates no screenshot');
  host.webContents.setZoomFactor(1.25);await delay(150);
  const rect={x:220,y:80,width:560,height:350};
  const expected=await host.webContents.capturePage(rect);
  pending=shots.captureScreenshot('app');await until(selected,'area selector again');
  host.webContents.sendInputEvent({type:'mouseDown',x:780,y:430,button:'left',clickCount:1});
  host.webContents.sendInputEvent({type:'mouseMove',x:220,y:80,button:'left'});
  await delay(80);
  fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,'00-select-area.png'),(await host.webContents.capturePage()).toPNG());
  host.webContents.sendInputEvent({type:'mouseUp',x:220,y:80,button:'left',clickCount:1});
  assert.deepEqual(await pending,{status:'opened'});
  const payload=await shots.loadScreenshotEditorPayload();
  const actual=require('electron').nativeImage.createFromBuffer(Buffer.from(payload.data));
  assert.deepEqual(actual.getSize(),expected.getSize(),'only the selected rectangle is captured at native resolution');
  assert.deepEqual(actual.toBitmap(),expected.toBitmap(),'selection overlay and hint are absent from captured pixels');
  assert.equal(await selected(),false,'selection layer removed');
  host.webContents.setZoomFactor(1);
  await waitEditor();
  pending=shots.retakeScreenshot();await until(selected,'retake requests a fresh selection');cancel();
  assert.deepEqual(await pending,{status:'cancelled'});
  assert.equal((await shots.loadScreenshotEditorPayload()).info.id,payload.info.id,'cancel retake preserves previous capture');
  assert.deepEqual(await shots.openLastScreenshot(),{status:'opened'});
  await waitEditor();
  const hostSize=await js('document.querySelector("[data-screenshot-output]").textContent');
  assert.match(hostSize,/^\d+ × \d+ · PNG/);
  await shot('01-default');

  await click('[aria-label="Graphite"]');
  await button('16:9');
  const wide=(await footer()).match(/(\d+) × (\d+)/);
  assert.ok(Math.abs(Number(wide[1])/Number(wide[2])-16/9)<0.01,'16:9 output');
  await shot('02-graphite-16x9');

  // Blur is disabled for flat gradients, enabled for mesh/backdrop.
  assert.equal(await js('document.querySelector("[aria-label=Blur]").disabled'),true);
  await click('[aria-label="Backdrop"]');
  assert.equal(await js('document.querySelector("[aria-label=Blur]").disabled'),false);
  await shot('03-backdrop');
  await click('[aria-label="Graphite"]');

  await click('[aria-label="Redact"]');
  await drag('canvas + div',0.26,0.21,0.6,0.29);
  assert.equal(await js('document.querySelectorAll("[aria-label=\\"Select redaction\\"]").length'),1,'redaction drawn');
  await shot('04-redact');
  await key('Escape');await key('Escape');
  assert.equal(await js('document.querySelectorAll("[aria-label=\\"Select redaction\\"]").length'),0,'redact tool closed');

  const beforeCrop=await footer();
  await click('[aria-label="Crop"]');
  await drag('canvas + div',0.1,0.1,0.6,0.7);
  await shot('05-crop-draft');
  await button('Done');
  const cropped=await footer();
  assert.notEqual(cropped,beforeCrop,'crop changes output size');
  await shot('06-cropped');
  await key('z',['meta']);
  assert.equal(await footer(),beforeCrop,'undo restores the crop');
  await key('z',['meta','shift']);
  assert.equal(await footer(),cropped,'redo reapplies the crop');

  clipboard.clear();
  await button('Copy');
  await until(()=>!editor(),'editor closes after copy');
  const copied=clipboard.readImage().getSize();
  const [w,h]=cropped.match(/(\d+) × (\d+)/).slice(1).map(Number);
  assert.deepEqual([copied.width,copied.height],[w,h],'clipboard holds the full-resolution export');

  assert.deepEqual(await shots.openLastScreenshot(),{status:'opened'});
  await waitEditor();
  assert.equal(await js('document.querySelector("[aria-label=Graphite]").getAttribute("aria-pressed")'),'true','style is remembered');
  assert.equal(await js('[...document.querySelectorAll("button")].find(b=>b.textContent==="16:9").className.includes("popover-bg")'),true,'ratio is remembered');
  await key('Enter');
  await until(()=>!editor(),'editor closes after attach');
  const files=path.join(__dirname,'profile','attachments','files');
  const attached=fs.readdirSync(files).flatMap(d=>fs.readdirSync(path.join(files,d)));
  assert.equal(attached.length,1);
  assert.match(attached[0],/^Screenshot \d{4}-\d{2}-\d{2} at \d{2}\.\d{2}\.\d{2}\.png$/);
  pending=shots.captureScreenshot('app');await until(selected,'selector before host close');host.destroy();
  assert.deepEqual(await pending,{status:'cancelled'},'closing the host settles the pending capture');
  assert.deepEqual(errors,[]);
  console.log('Screenshot editor Electron: area selection, cancel, retake, exact captured pixels, style, blur gating, redact, crop, undo/redo, copy, style memory and attach passed');
  app.exit(0);
 }catch(error){console.error(error,errors);try{await shot('failure')}catch{}app.exit(1)}
});
`;

try {
  await writeFile(path.join(dir, 'main.cjs'), main);
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><html><body style="margin:0;background:#fcfcfc"><div id="root"></div><script type="module" src="./host.tsx"></script></body></html>');
  await writeFile(path.join(dir, 'host.tsx'), "import React,{useEffect} from 'react';\nimport {createRoot} from 'react-dom/client';\nimport {ScreenshotHost} from '/src/ui/components/screenshot/ScreenshotHost';\nimport '/src/ui/index.css';\nfunction Harness(){useEffect(()=>{window.qaReady=true},[]);return <><div dangerouslySetInnerHTML={{__html:\"<div style=\\\"display:flex;height:100vh\\\"><div style=\\\"width:180px;background:#f4f4f4;padding:16px\\\"><b>Aegis</b><p>New Task</p><p>KanBan</p></div><div style=\\\"padding:28px 40px;flex:1\\\"><p style=\\\"background:#ebebeb;border-radius:12px;padding:8px 12px;margin-left:auto;width:max-content\\\">What does this project do?</p><p>Podcast production turns the weekly AI news CSV into a two-host script.</p><p id=\\\"secret\\\">Deploy key: sk-live-8f2a91c0b7e44d19a6</p><p>So it is closer to a workspace than a finished app.</p></div></div>\"}}/><ScreenshotHost/></>;}\ncreateRoot(document.getElementById('root')).render(<Harness/>);");
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await server.listen();
  const origin = new URL(server.resolvedUrls.local[0]).origin;
  const env = { ...process.env, DEV_SERVER_URL: origin, QA_HOST_URL: origin + '/' + path.relative(root,dir) + '/index.html', QA_ROOT: root, QA_CAPTURE: path.join(root, 'output/playwright/screenshot-editor') };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(root, 'node_modules/.bin/electron'), [path.join(dir, 'main.cjs')], { env, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(Error('Screenshot editor test timed out')); }, 90000);
    child.on('error', reject);
    child.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('Screenshot editor test failed: ' + code)); });
  });
} finally {
  await server?.close();
  await rm(dir, { recursive: true, force: true });
}

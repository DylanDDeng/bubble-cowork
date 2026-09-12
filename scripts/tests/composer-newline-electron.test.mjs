import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';

const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const tmp = await mkdtemp(path.join(root, '.aegis-design-qa/newline-'));
const harness = `
import React, {useState, useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {ComposerPromptEditor} from '/src/ui/components/ComposerPromptEditor';
import {composerEnterAction} from '/src/shared/app-preferences';
import '/src/ui/index.css';
function Harness() {
 const [draft, setDraft] = useState({value:'', cursor:0});
 const ref = useRef(null);
 window.qa = {draft, setDraft, ref, sends: window.qa?.sends ?? []};
 return <div style={{width:500, padding:40}}><ComposerPromptEditor ref={ref}
  value={draft.value} cursorIndex={draft.cursor} autoFocus
  onChange={(value,cursor)=>setDraft({value,cursor})}
  onKeyDown={e=>{if(composerEnterAction(e,draft.value,'modifier').send){e.preventDefault();qa.sends.push(draft.value);}}}
  className="whitespace-pre-wrap text-[14px] leading-6 outline-none"/></div>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main = String.raw`
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:700,height:450,show:true});
 const js=c=>win.webContents.executeJavaScript(c,true);
 const key=async(keyCode,modifiers=[])=>{
  win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});
  win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await delay(100);
 };
 const type=async text=>{win.webContents.insertText(text);await delay(100);};
 const caret=()=>js('({info:qa.ref.current.getCaretInfo(),draft:qa.draft,rect:(()=>{const r=getSelection().getRangeAt(0); const rect=r.getBoundingClientRect(); if(rect.height)return rect.toJSON(); const node=r.startContainer.childNodes[r.startOffset]; return node.getBoundingClientRect().toJSON()})()})');
 try {
  await win.loadURL(process.env.QA_URL);
  for(let i=0;i<100&&!await js('!!window.qa?.ref.current');i++)await delay(50);
  await js('document.querySelector("[role=textbox]").focus()');
  assert.equal(await js('!!document.querySelector(".composer-fake-caret")'),false,'uses a single native caret');
  for(const theme of ['light','dark']) {
   await js('document.documentElement.classList.toggle("dark",'+(theme==='dark')+')');
   const normal=await js('getComputedStyle(document.querySelector("[role=textbox]")).caretColor');
   await js('document.getElementById("root").classList.add("aegis-new-thread-composer")');
   assert.equal(await js('getComputedStyle(document.querySelector("[role=textbox]")).caretColor'),normal,'same caret color on new and existing sessions');
   assert.notEqual(normal,'rgba(0, 0, 0, 0)');
   await js('document.getElementById("root").classList.remove("aegis-new-thread-composer")');
  }
  await js('document.documentElement.classList.remove("dark")');
  await type('第一行');const first=await caret();
  await key('Return');const second=await caret();
  console.log(JSON.stringify({first,second}));
  assert.equal(second.draft.value,'第一行\n');
  assert.equal(second.info.index,4);
  assert(second.rect.y > first.rect.y+15,'Enter moves the visible caret to the next line');
  assert.equal(second.info.onFirstVisualLine,false);
  await key('Return');const third=await caret();
  assert.equal(third.draft.value,'第一行\n\n');
  assert(third.rect.y > second.rect.y+15,'consecutive Enter moves down another line');
  await type('第三行');assert.equal((await caret()).draft.value,'第一行\n\n第三行');
  await key('Backspace');assert.equal((await caret()).draft.value,'第一行\n\n第三');
  await key('Return',['shift']);const fourth=await caret();
  assert.equal(fourth.draft.value,'第一行\n\n第三\n');
  assert(fourth.rect.y > third.rect.y+15,'Shift+Enter also positions the visible caret');
  await type('第四行');await key('Return',['meta']);
  assert.deepEqual(await js('qa.sends'),['第一行\n\n第三\n第四行']);
  await key('Return');await key('Backspace');
  assert.equal((await caret()).draft.value,'第一行\n\n第三\n第四行','deleting an empty last line adds no phantom newline');
  await key('Left');await key('Return');
  assert.equal((await caret()).draft.value,'第一行\n\n第三\n第四\n行','Enter splits text at the caret');
  await type('新');
  assert.equal((await caret()).draft.value,'第一行\n\n第三\n第四\n新行','typing continues at the split');
  fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});
  fs.writeFileSync(path.join(process.env.QA_CAPTURE,'composer-newline.png'),(await win.webContents.capturePage()).toPNG());
  console.log('NEWLINE_QA_OK');app.exit(0);
 } catch(error) {console.error(error);app.exit(1);}
});
`;
let server;
try {
  await writeFile(path.join(tmp, 'index.html'), '<html><body><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(tmp, 'harness.tsx'), harness);
  await writeFile(path.join(tmp, 'main.cjs'), main);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const env = { ...process.env, QA_URL: new URL(path.relative(root, tmp) + '/index.html', server.resolvedUrls.local[0]).href, QA_CAPTURE: path.join(root, 'output/playwright/composer-newline') };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(root, 'node_modules/.bin/electron'), [path.join(tmp, 'main.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; process.stdout.write(data); });
    child.stderr.on('data', data => process.stderr.write(data));
    const timeout = setTimeout(() => { child.kill(); reject(Error('Composer newline test timed out')); }, 30000);
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timeout); try { assert.equal(code, 0); assert(output.includes('NEWLINE_QA_OK')); resolve(); } catch(error) { reject(error); } });
  });
} finally {
  await server?.close();
  await rm(tmp, { recursive: true, force: true });
}

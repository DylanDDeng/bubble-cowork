import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// Obsidian-style live preview in the real ProjectMarkdownEditor: highlights,
// wiki links, bullets, task markers, nested quotes, callouts, aligned tables
// that turn into source on click, heading markers on the active line, and
// note links that open in the Files panel or jump to a heading.
// QA_CAPTURE=<dir> saves screenshots.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const qaRoot = path.join(root, 'dev-fixtures');
await mkdir(qaRoot, { recursive: true });
const tmp = await mkdtemp(path.join(qaRoot, 'markdown-obsidian-'));

const markdown = [
  '# Title',
  '',
  'Some ==highlighted== text, [[Other Note|alias link]], [[Missing]], [rel](./guide.md#setup) and [anchor](#section-two).',
  '',
  '- bullet one',
  '- [ ] task one',
  '',
  '> quote level one',
  '> > nested level two',
  '',
  '> [!warning] Be careful',
  '> Body line',
  '',
  '> [!tip]',
  '> Untitled tip',
  '',
  '| Name | Value |',
  '| :--- | ---: |',
  '| **A** | 1 |',
  '',
  'Filler paragraph.',
  '',
  '## Section Two',
  '',
  'End.',
  '',
  '![[clip.mp4]]',
].join('\n');

const harness = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {EditorView} from '@codemirror/view';
import {EditorSelection} from '@codemirror/state';
import {ProjectMarkdownEditor} from '/src/ui/components/ProjectMarkdownEditor.tsx';
import {useAppStore} from '/src/ui/store/useAppStore.ts';
import '/src/ui/index.css';
useAppStore.setState({projectTreeCwd:'/proj',projectTree:{name:'proj',path:'/proj',kind:'dir',children:[
  {name:'docs',path:'/proj/docs',kind:'dir',children:[{name:'current.md',path:'/proj/docs/current.md',kind:'file'}]},
  {name:'notes',path:'/proj/notes',kind:'dir',children:[{name:'Other Note.md',path:'/proj/notes/Other Note.md',kind:'file'}]},
]}});
window.qa={
  view:()=>EditorView.findFromDOM(document.querySelector('.cm-editor')),
  opened:()=>useAppStore.getState().pendingProjectFileOpen,
  caretAt:(pos)=>{const v=qa.view();v.focus();v.dispatch({selection:EditorSelection.cursor(pos)})},
  blur:()=>qa.view().contentDOM.blur(),
  lineText:(needle)=>[...document.querySelectorAll('.cm-line')].find(l=>l.textContent.includes(needle))?.textContent ?? null,
  line:(needle)=>[...document.querySelectorAll('.cm-line')].find(l=>l.textContent.includes(needle)) ?? null,
  caretLine:()=>{const v=qa.view();return v.state.doc.lineAt(v.state.selection.main.head).text},
};
function Harness(){
  const [value,setValue]=useState(${JSON.stringify(markdown)});
  return <div style={{height:'100vh'}}><ProjectMarkdownEditor value={value} cwd="/proj" filePath="/proj/docs/current.md" fileName="current.md" hideTitleBar saveState="idle" saveError={null} onChange={setValue} onSave={()=>{}}/></div>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;

const main = `
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
app.setPath('userData',path.join(__dirname,'profile'));fs.mkdirSync(app.getPath('userData'),{recursive:true});
const root=process.env.QA_ROOT;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 ipcMain.on('get-ui-resume-state-sync',e=>{e.returnValue=null});ipcMain.on('renderer-state:get-all-sync',e=>{e.returnValue={}});
 ipcMain.on('save-ui-resume-state-sync',e=>{e.returnValue=true});ipcMain.on('renderer-state:set',()=>{});
 // The note's folder has no clip.mp4; the vault has one in attachments/.
 const clipUrl='data:video/mp4;base64,AAAA';const lookups=[];
 ipcMain.handle('read-project-file-preview',(_e,cwd,file)=>file==='/proj/attachments/clip.mp4'?{kind:'video',path:file,name:'clip.mp4',ext:'.mp4',previewUrl:clipUrl}:{kind:'error',path:file,name:'',ext:'',message:'File not found'});
 ipcMain.handle('find-project-file-by-name',(_e,cwd,name)=>{lookups.push([cwd,name]);return name==='clip.mp4'?'/proj/attachments/clip.mp4':null});
 const win=new BrowserWindow({width:900,height:1100,show:true,webPreferences:{preload:path.join(root,'dist-electron/electron/preload.cjs')}});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=code=>win.webContents.executeJavaScript(code,true);
 const waitFor=async(cond,label)=>{for(let i=0;i<80;i++){if(await js(cond))return;await delay(100)}throw Error('Timed out waiting for '+label)};
 const screenshot=async name=>{if(!process.env.QA_CAPTURE)return;fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG())};
 // Real pointer input, so CodeMirror sees the same events as a user click.
 const clickAt=async selector=>{
  const r=await js('(()=>{const e='+selector+';if(!e)return null;const b=e.getBoundingClientRect();return {x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)}})()');
  if(!r)throw Error('Missing click target: '+selector);
  await focusWindow();
  win.webContents.sendInputEvent({type:'mouseDown',x:r.x,y:r.y,button:'left',clickCount:1});
  win.webContents.sendInputEvent({type:'mouseUp',x:r.x,y:r.y,button:'left',clickCount:1});
  await delay(200);
 };
 // A user click always lands in an active window. Launched from a terminal the
 // app may stay inactive, and then the page never receives focus events.
 const focusWindow=async()=>{if(process.platform==='darwin')app.focus({steal:true});win.focus();win.webContents.focus();await waitFor('document.hasFocus()','window focus')};
 const caretAt=async pos=>{await focusWindow();await js('qa.caretAt('+pos+')')};
 try{
  await win.loadURL(process.env.QA_URL);
  await waitFor('!!document.querySelector(".cm-editor") && !!document.querySelector(".aegis-cm-table-widget")','editor');
  await js('qa.blur()');await delay(150);
  await screenshot('1-rendered');

  // Inline syntax renders with its markers hidden.
  const prose=await js('qa.lineText("Some ")');
  assert.ok(!prose.includes('==')&&!prose.includes('[['),'highlight and wiki markers are hidden: '+prose);
  assert.equal(await js('document.querySelector(".bubble-md-highlight").textContent'),'highlighted');
  assert.deepEqual(await js('[...document.querySelectorAll(".bubble-md-wikilink")].map(e=>e.textContent)'),['alias link','Missing'],'wiki links show their alias or target');
  assert.equal(await js('qa.lineText("# Title")'),null,'heading marker hidden away from the caret');

  // Lists: dots for bullets, checkbox only for tasks.
  assert.equal(await js('document.querySelectorAll(".bubble-md-bullet").length'),1);
  assert.equal(await js('qa.lineText("bullet one").trim()'),'bullet one');
  assert.equal(await js('qa.lineText("task one").trim()'),'task one','task line drops the dash');
  assert.equal(await js('!!qa.line("task one").querySelector("input[type=checkbox]")'),true);

  // Quotes: every level hides its marker; nesting draws an extra bar.
  assert.ok(!(await js('qa.lineText("nested level two")')).includes('>'),'nested quote markers hidden');
  assert.equal(await js('qa.line("nested level two").style.getPropertyValue("--quote-depth").trim()'),'2');
  assert.equal(await js('qa.line("nested level two").classList.contains("aegis-cm-blockquote-nested")'),true);

  // Callouts: titled and untitled.
  const warning=await js('(()=>{const l=document.querySelector("[data-callout=warning].is-callout-title");return l&&l.textContent})()');
  assert.equal(warning.trim(),'Be careful','callout marker hidden behind its title');
  assert.equal(await js('document.querySelector("[data-callout=warning].is-callout-last").textContent.trim()'),'Body line');
  assert.equal(await js('document.querySelector("[data-callout=tip] .bubble-md-callout-label").textContent'),'Tip','untitled callout shows its type');

  // Tables: aligned widget with inline markers stripped and column alignment.
  assert.deepEqual(await js('[...document.querySelectorAll(".aegis-cm-table-widget th")].map(e=>e.textContent)'),['Name','Value']);
  assert.deepEqual(await js('[...document.querySelectorAll(".aegis-cm-table-widget td")].map(e=>[e.textContent,e.style.textAlign])'),[['A','left'],['1','right']]);
  await clickAt('[...document.querySelectorAll(".aegis-cm-table-widget td")][0]');
  assert.equal(await js('qa.caretLine()'),'| **A** | 1 |','clicking a cell puts the caret on its row');
  await waitFor('!document.querySelector(".aegis-cm-table-widget")','table source while edited');
  assert.equal(await js('document.querySelectorAll(".bubble-md-table-source").length'),3);
  await screenshot('2-table-source');

  // Heading and bullet markers return under the caret.
  await caretAt(3);
  await waitFor('qa.lineText("Title")==="# Title"','heading shows # on its line');
  await waitFor('!!document.querySelector(".aegis-cm-table-widget")','table renders again once the caret leaves');
  const bulletPos=await js('qa.view().state.doc.toString().indexOf("- bullet")');
  await caretAt(bulletPos);
  await waitFor('qa.lineText("bullet one")==="- bullet one"','bullet marker under the caret');
  await js('qa.blur()');await delay(150);

  // Links: wiki names resolve through the project tree; relative links use the note's folder.
  await clickAt('document.querySelector(".bubble-md-wikilink")');
  assert.equal(await js('qa.opened()?.path'),'/proj/notes/Other Note.md');
  await js('qa.blur()');await delay(150);
  await clickAt('[...document.querySelectorAll(".bubble-md-wikilink")].find(e=>e.textContent==="Missing")');
  assert.equal(await js('qa.opened()?.path'),'/proj/docs/Missing.md','unknown wiki targets fall back to the note folder');
  await js('qa.blur()');await delay(150);
  await clickAt('[...document.querySelectorAll(".aegis-cm-link")].find(e=>e.textContent==="rel")');
  assert.equal(await js('qa.opened()?.path'),'/proj/docs/guide.md');
  await js('qa.blur()');await delay(150);
  const before=await js('qa.opened()?.id');
  await clickAt('[...document.querySelectorAll(".aegis-cm-link")].find(e=>e.textContent==="anchor")');
  await waitFor('qa.caretLine()==="## Section Two"','anchor links jump to the heading');
  assert.equal(await js('qa.opened()?.id'),before,'anchor links stay in this note');

  // Bare embed names fall back to a vault-wide lookup, like Obsidian.
  await js('qa.blur()');
  await js('document.querySelector(".aegis-md-main").scrollTop=1e6');
  await waitFor('document.querySelector(".bubble-md-video-widget source")?.getAttribute("src")==='+JSON.stringify(clipUrl),'embedded video found elsewhere in the vault');
  assert.deepEqual(lookups,[['/proj','clip.mp4']]);
  assert.doesNotMatch(await js('document.querySelector(".bubble-md-video-status").textContent'),/could not be loaded/);

  assert.deepEqual(errors.filter(e=>!/No handler registered/.test(e)),[]);
  console.log(JSON.stringify({ok:true}));
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
  console.log('Markdown Obsidian live preview Electron regression passed');
} finally { await server?.close(); await rm(tmp, { recursive: true, force: true }); }

import { createServer } from 'vite';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const dir = await mkdtemp(path.join(root, '.aegis-design-qa/outline-'));
let server;
const harness = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ChatOutlineRail} from '/src/ui/components/ChatOutlineRail';
import {useAppPreferences} from '/src/ui/store/useAppPreferences';
import {applyThemePreferences,DEFAULT_THEME_STATE} from '/src/ui/theme/themes';
import '/src/ui/index.css';
window.electron={getSessionUserPrompts:async()=>[]};
const theme=mode=>applyThemePreferences({themeMode:mode,themeState:DEFAULT_THEME_STATE,uiFontFamily:'system-ui',chatCodeFontFamily:'monospace'});
theme('light');
const prompts=Array.from({length:24},(_,i)=>({createdAt:1000+i,text:i===0?'Short prompt':i===23?'Attachment changes':'Review the outline interaction — turn '+(i+1),
 replyText:i===0?'Done.':'The preview stays attached to the selected message while the nearby ticks expand smoothly. Move between messages to explore the conversation.',
 changedFiles:i===23?['ChatOutlineRail.tsx','chat-outline.css','navigation.ts','extra.ts']:[],attachmentNames:[]}));
function App(){
 const [session,setSession]=useState('first');
 const [count,setCount]=useState(24);
 window.qa={theme,switch:()=>setSession('second'),count:setCount,reduced:on=>useAppPreferences.setState({reduceMotion:on?'on':'off'})};
 return <div style={{height:'100vh',display:'flex',flexDirection:'column',color:'var(--text-primary)',background:'var(--bg-primary)'}}>
 <header style={{padding:24,borderBottom:'1px solid var(--border)'}}>Conversation outline · motion preview</header>
 <div id="pane" className="@container" style={{position:'relative',flex:1,minHeight:0}}>
 <ChatOutlineRail sessionId={session} livePrompts={prompts.slice(0,count)} onNavigate={at=>window.lastNavigation=at}/>
 <main style={{maxWidth:640,margin:'100px auto',fontSize:14,lineHeight:1.8}}><p style={{color:'var(--text-muted)'}}>Worked for 2m 14s</p><p>The conversation outline provides quick access to earlier prompts.</p><p>Hover the rail to preview a turn, then click to navigate.</p></main>
 </div><footer style={{padding:24,margin:'0 auto',width:640,border:'1px solid var(--border)',borderRadius:20,marginBottom:24,color:'var(--text-muted)'}}>Message to agent…</footer></div>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;
const main = String.raw`
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',path.join(__dirname,'profile'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1120,height:900,show:true,webPreferences:{backgroundThrottling:false}});
 const errors=[];w.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=s=>w.webContents.executeJavaScript(s,true);
 const until=async(s,label)=>{for(let i=0;i<60;i++){if(await js(s))return;await delay(50)}throw Error('Timed out: '+label)};
 const move=async(i)=>{
  const p=await js('(()=>{const r=document.querySelector(".chat-outline-rail").getBoundingClientRect();return {x:Math.round(r.left+10),y:Math.round(r.top+r.height*'+i+'/23)}})()');
  w.webContents.sendInputEvent({type:'mouseMove',...p});
 };
 const state=()=>js('document.querySelector("[data-outline-preview]")?.dataset.state');
 const rect=()=>js('(()=>{const r=document.querySelector(".chat-outline-card").getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height}})()');
 const shot=async name=>{fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 const checkBounds=async()=>assert(await js('(()=>{const c=document.querySelector(".chat-outline-card").getBoundingClientRect(),p=document.querySelector("#pane").getBoundingClientRect();return c.top>=p.top+10&&c.bottom<=p.bottom-10})()'),'preview remains within chat pane');
 try{
  await w.loadURL(process.env.QA_URL);w.focus();await until('document.querySelectorAll("[data-outline-tick]").length===24','outline');await delay(250);
  // Fast pass-through should not flash a preview after the pointer leaves.
  await move(10);await delay(30);w.webContents.sendInputEvent({type:'mouseMove',x:650,y:200});await delay(300);
  assert.equal(await state(),'closed');
  await move(10);await until('document.querySelector("[data-outline-preview]").dataset.state==="open"','open');await delay(240);
  await js('window.previewIdentity=document.querySelector("[data-outline-preview]")');
  const scales=await js('[...document.querySelectorAll(".chat-outline-tick")].map(e=>new DOMMatrix(getComputedStyle(e).transform).a)');
  assert(scales[10]>3.5&&scales[9]>scales[8]&&scales[8]>scales[7],'continuous tick falloff');
  await shot('light');
  for(const i of [2,19,4,22,5,1,20,10]){await move(i);await delay(20)}
  await delay(300);
  assert(await js('previewIdentity===document.querySelector("[data-outline-preview]")'),'scrubbing keeps one floating surface');
  assert((await js('document.querySelector(".chat-outline-title").textContent')).includes('turn 11'),'rapid reversal ends on latest item');
  // Height changes interpolate instead of snapping. Text is never scaled.
  const before=await rect();await move(0);await delay(45);const during=await rect();await delay(250);const after=await rect();
  assert(during.height<before.height&&during.height>after.height,'card height interpolates '+JSON.stringify({before,during,after}));
  assert.equal(await js('getComputedStyle(document.querySelector(".chat-outline-content")).transform'),'none');
  // Old 20% alignment boundary must now move by only one tick pitch.
  await move(4);await delay(250);const a=await rect();await move(5);await delay(250);const b=await rect();
  assert(Math.abs(b.top-a.top-12)<2,'no jump across old alignment boundary');
  // Cross the bridge to the card and remain there, beyond close grace.
  const cp=await js('(()=>{const r=document.querySelector(".chat-outline-card").getBoundingClientRect();return {x:Math.round(r.left+20),y:Math.round(r.top+20)}})()');
  w.webContents.sendInputEvent({type:'mouseMove',...cp});await delay(300);assert.equal(await state(),'open');
  w.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...cp});w.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...cp});
  await until('window.lastNavigation===1005','preview navigates to selected prompt');
  w.webContents.sendInputEvent({type:'mouseMove',x:650,y:100});await delay(50);assert.equal(await state(),'open','close grace');
  await delay(250);assert.equal(await state(),'closed');
  assert(await js('document.querySelector("[data-outline-preview]").inert'),'closed preview cannot receive focus');
  // Keyboard entry, Escape and session replacement do not leave stale timers.
  await js('document.activeElement.blur()');
  w.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});w.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
  await until('document.querySelector("[data-outline-preview]").dataset.state==="open"','keyboard preview');
  w.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});w.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await delay(50);assert.equal(await state(),'closed');
  await move(12);await delay(30);await js('qa.switch()');await delay(250);
  assert.equal(await js('!!document.querySelector("[data-outline-preview]")'),false,'session switch cancels pending preview');
  // Very long histories and short panes still keep first/last cards in bounds.
  w.setContentSize(1120,390);await delay(200);
  await move(0);await delay(350);await checkBounds();await shot('short-top');
  await move(23);await delay(350);await checkBounds();await shot('short-bottom');
  assert.equal(await js('document.querySelector(".chat-outline-card-button").scrollHeight>document.querySelector(".chat-outline-card-button").clientHeight'),false,'normal card does not gain a spurious scrollbar');
  w.setContentSize(1120,900);await js('qa.theme("dark")');await delay(200);await move(23);await delay(350);await shot('dark');
  await js('qa.reduced(true)');await move(6);await delay(50);
  assert.equal(await js('getComputedStyle(document.querySelector(".chat-outline-copy")).animationName'),'none');
  const r1=await rect();await delay(100);const r2=await rect();assert(Math.abs(r1.top-r2.top)<1,'reduced motion settles immediately');
  w.setContentSize(700,900);await delay(200);
  assert.equal(await js('getComputedStyle(document.querySelector(".chat-outline-pane")).display'),'none','rail stays out of narrow chat panes');
  assert.equal(await js('document.documentElement.scrollWidth>innerWidth'),false);
  await js('qa.count(1)');await delay(100);assert.equal(await js('!!document.querySelector(".chat-outline-rail")'),false,'one prompt hides outline');
  assert.deepEqual(errors,[],'no renderer errors');
  console.log('Outline: pointer scrubbing, transitions, bounds, navigation, keyboard, session cleanup, themes and reduced motion passed');app.exit(0);
 }catch(e){console.error(e);await shot('failure');app.exit(1)}
});
`;
try {
 await writeFile(path.join(dir,'index.html'),'<html><body style="margin:0"><div id="root"></div><script type="module" src="./probe.tsx"></script></body></html>');
 await writeFile(path.join(dir,'probe.tsx'),harness);
 await writeFile(path.join(dir,'main.cjs'),main);
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0,strictPort:false}});
 await server.listen();
 const env={...process.env,QA_URL:new URL(path.relative(root,dir)+'/index.html',server.resolvedUrls.local[0]).href,QA_CAPTURE:path.join(root,'output/playwright/chat-outline')};
 delete env.ELECTRON_RUN_AS_NODE;
 await new Promise((resolve,reject)=>{
  const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(dir,'main.cjs')],{env,stdio:'inherit'});
  const timeout=setTimeout(()=>{child.kill();reject(Error('Outline Electron test timed out'))},60000);
  child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);code===0?resolve():reject(Error('Outline Electron test failed: '+code))});
 });
} finally {await server?.close();await rm(dir,{recursive:true,force:true});}

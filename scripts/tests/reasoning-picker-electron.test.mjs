import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const qaRoot = path.join(root, '.aegis-design-qa');
await mkdir(qaRoot, { recursive: true });
const tmp = await mkdtemp(path.join(qaRoot, 'reasoning-picker-'));
const harness = `
import React, {useState} from 'react';
import { createRoot } from 'react-dom/client';
import { ComposerAgentModelPicker, ComposerModelPicker } from '/src/ui/components/ComposerAgentControls';
import '/src/ui/index.css';
import { useAppStore } from '/src/ui/store/useAppStore';
window.electron = { getAgentRuntimeDirectory: async () => ({checkedAt:Date.now(),entries:[]}) };
const names = ['claude','codex','grok','kimi','bubble','deepseek','pi','opencode','qoder'];
const choices = Object.fromEntries(names.map(p=>[p, Array.from({length:10},(_,i)=>({key:p+i,value:p+i,label:p+' model '+i,description:'Model description '+i}))]));
const codexModels=choices.codex.map((m,i)=>({name:m.value,label:i===0?'GPT-6 Astra':m.label,defaultReasoningEffort:'high',supportsFastMode:i===0,supportedReasoningLevels:(i===1?['low','high']:i===2?[]:i===3?['high']:i===4?['high','turbo','low']:['low','medium','high','xhigh']).map(effort=>({effort}))}));
function Harness(){
 const [provider,setProvider]=useState('codex');
 const [models,setModels]=useState(Object.fromEntries(names.map(p=>[p,p+'0'])));
 const [efforts,setEfforts]=useState(Object.fromEntries(names.map(p=>[p,'high'])));
 const [fast,setFast]=useState(false);
 const [side,setSide]=useState('bottom');
 const [unknown,setUnknown]=useState(false);
 window.qa={provider,models,efforts,fast,setSide,setUnknown,setEfforts,setTheme:useAppStore.getState().setTheme,setAccent:(variant,accent)=>useAppStore.getState().updateThemeVariant(variant,{accent})};
 const change=(p,v)=>{setProvider(p);setEfforts(s=>({...s,[p]:v}));};
 return <div style={{padding:40,paddingTop:side==='top'?500:40}}>
 <div style={{display:"flex",justifyContent:"flex-end",alignItems:"center",gap:12}}><ComposerAgentModelPicker agentProvider={provider} modelLabel={models[provider]==='codex0'?'GPT-6 Astra':models[provider]} modelValue={models[provider]}
 modelValueByProvider={models} allAgentModelOptions={choices} menuSide={side}
 onAgentChange={setProvider} onModelChange={(o,p=provider)=>{setProvider(p);setModels(s=>({...s,[p]:o.value}));}}
 codexModels={codexModels} grokModels={[{name:'grok0',reasoningEfforts:['high','low']}]}
 bubbleModels={unknown?[]:[{name:'bubble0',reasoningLevels:['off','low','high']}]}
 claudeReasoningEffort={efforts.claude} onClaudeReasoningEffortChange={v=>change('claude',v)}
 codexReasoningEffort={efforts.codex} onCodexReasoningEffortChange={v=>change('codex',v)}
 grokReasoningEffort={efforts.grok} onGrokReasoningEffortChange={v=>change('grok',v)}
 deepseekReasoningEffort={efforts.deepseek} onDeepseekReasoningEffortChange={v=>change('deepseek',v)}
 bubbleThinkingLevel={efforts.bubble} onBubbleThinkingLevelChange={v=>change('bubble',v)}
 kimiThinkingOptions={['off','on','max']} kimiThinkingChecked={efforts.kimi}
 onKimiThinkingChange={v=>change('kimi',v)} codexFastMode={fast} onCodexFastModeChange={setFast}/><button data-qa="neighbor">Send</button></div>
 <div style={{position:'absolute',bottom:20,left:40}}><ComposerModelPicker value={models.codex} label={models.codex} options={choices.codex} onChange={o=>setModels(s=>({...s,codex:o.value}))} codexModelConfig={{}} codexModels={codexModels} codexReasoningEffort={efforts.codex} onCodexReasoningEffortChange={v=>change('codex',v)} /></div>
 </div>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main = String.raw`
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
if(process.env.QA_REDUCED==='1')app.commandLine.appendSwitch('force-prefers-reduced-motion');
const delay = ms => new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1000,height:800,show:false});
 const errors=[];
 win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
 const js=async code=>{try{return await win.webContents.executeJavaScript(code,true);}catch(e){throw new Error(code+' :: '+e.message);}};
 const click=async selector=>{const rect=await js('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()');win.webContents.sendInputEvent({type:'mouseDown',x:Math.round(rect.x),y:Math.round(rect.y),button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',x:Math.round(rect.x),y:Math.round(rect.y),button:'left',clickCount:1});await delay(150);};
 const key=async keyCode=>{win.webContents.sendInputEvent({type:'keyDown',keyCode});win.webContents.sendInputEvent({type:'keyUp',keyCode});await delay(80);};
 const slider='.effort-model-view:not([inert]) input[type=range]';
 const triggerRect=async(selector='[aria-label="Select agent and model"]')=>js('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');const r=e.getBoundingClientRect();return {text:e.innerText,x:r.x,width:r.width,neighborX:document.querySelector("[data-qa=neighbor]").getBoundingClientRect().x};})()');
 const assertStable=async(before,selector)=>{
  const after=await triggerRect(selector);
  assert.equal(after.text,'Select effort','open trigger shows placeholder instead of changing effort');
  for(const dimension of ['x','width','neighborX'])assert.ok(Math.abs(after[dimension]-before[dimension])<0.5,'stable '+dimension);
 };
 const open=async provider=>{
  await js('document.querySelector(\'[aria-label="Select agent and model"]\').click()');await delay(150);
  await js('Array.from(document.querySelectorAll(\'[role="menuitem"][aria-haspopup="menu"]\')).find(e=>e.textContent.includes('+JSON.stringify(provider)+')).click()');await delay(250);
 };
 const close=async()=>{await key('Escape');await key('Escape');await delay(100);};
 try {
  await win.loadURL(process.env.QA_URL);await delay(900);
  assert.equal(await js('getComputedStyle(document.querySelector(\'[aria-label="Select agent and model"] [aria-hidden="true"]\')).position'),'absolute','placeholder measurement must not occupy layout space');
  const closedTrigger=await triggerRect();
  if(process.env.QA_CAPTURE){fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});const r=await js('(()=>{const r=document.querySelector(\'[aria-label="Select agent and model"]\').getBoundingClientRect();return {x:Math.floor(r.x)-8,y:Math.floor(r.y)-8,width:Math.ceil(r.width)+16,height:Math.ceil(r.height)+16};})()');fs.writeFileSync(path.join(process.env.QA_CAPTURE,'trigger-typography.png'),(await win.webContents.capturePage(r)).toPNG());}

  await open('Codex');
  await assertStable(closedTrigger);
  const compactBounds=await js('(()=>{const r=document.querySelector(".effort-model-views").closest("[role=menu]").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()');
  assert.ok(compactBounds.height<=100,'compact effort popup stays under 100px tall');
  assert.equal(await js('getComputedStyle(document.querySelector(".effort-picker-rail")).height'),'24px');
  assert.equal(await js('!!document.querySelector(".effort-picker-endpoints")'),false);
  if(process.env.QA_CAPTURE){fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,'compact-picker.png'),(await win.webContents.capturePage({x:Math.floor(compactBounds.x)-5,y:Math.floor(compactBounds.y)-5,width:Math.ceil(compactBounds.width)+10,height:Math.ceil(compactBounds.height)+10})).toPNG());}
  assert.ok(await js('!!document.querySelector('+JSON.stringify(slider)+')'));
  await click(slider);await key('Home');
  assert.equal(await js('qa.efforts.codex'),'low','Home selects minimum from the provider catalog');
  await key('Right');assert.equal(await js('qa.efforts.codex'),'medium');
  await key('End');assert.equal(await js('qa.efforts.codex'),'xhigh');
  await assertStable(closedTrigger);
  assert.equal(await js('document.querySelector(".effort-picker-selected-effort").textContent'),'Extra High','toolbar effort follows keyboard selection');
  assert.equal(await js('document.querySelector('+JSON.stringify(slider)+').getAttribute("aria-valuetext")'),'Extra High');
  // Real mouse drag previews while held and commits on release.
  const r=await js('(()=>{const r=document.querySelector('+JSON.stringify(slider)+').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()');
  win.webContents.sendInputEvent({type:'mouseDown',x:Math.round(r.x+r.w-14),y:Math.round(r.y+r.h/2),button:'left',clickCount:1});
  win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(r.x+14),y:Math.round(r.y+r.h/2),movementX:-r.w,movementY:0});await delay(200);
  assert.equal(await js('qa.efforts.codex'),'xhigh','drag preview does not write configuration');
  win.webContents.sendInputEvent({type:'mouseUp',x:Math.round(r.x+14),y:Math.round(r.y+r.h/2),button:'left',clickCount:1});await delay(200);
  assert.equal(await js('qa.efforts.codex'),'low','drag release commits');
  await key('End');
  assert.equal(await js('qa.efforts.codex'),'xhigh','keyboard remains on slider after dragging');
  await js('document.querySelector('+JSON.stringify(slider)+').dispatchEvent(new WheelEvent("wheel",{deltaY:30,cancelable:true,bubbles:true}))');await delay(100);
  assert.equal(await js('qa.efforts.codex'),'high','focused wheel advances one discrete tier');
  win.webContents.sendInputEvent({type:'mouseDown',x:Math.round(r.x+r.w-14),y:Math.round(r.y+r.h/2),button:'left',clickCount:1});
  win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(r.x+14),y:Math.round(r.y+r.h/2),movementX:-r.w,movementY:0});await delay(150);
  assert.equal(await js('document.querySelector('+JSON.stringify(slider)+').getAttribute("aria-valuetext")'),'Low');
  assert.equal(await js('document.querySelector(".effort-picker-selected-effort").textContent'),'Low','toolbar follows drag preview before commit');
  await js('document.querySelector('+JSON.stringify(slider)+').dispatchEvent(new PointerEvent("pointercancel",{pointerId:1,bubbles:true}))');await delay(100);
  assert.equal(await js('qa.efforts.codex'),'high','pointer cancel discards preview');
  assert.equal(await js('document.querySelector('+JSON.stringify(slider)+').getAttribute("aria-valuetext")'),'High');
  win.webContents.sendInputEvent({type:'mouseUp',x:Math.round(r.x+14),y:Math.round(r.y+r.h/2),button:'left',clickCount:1});await delay(100);
  await click(slider);await key('Home');assert.equal(await js('qa.efforts.codex'),'low');
  await click('[aria-label="Reset reasoning to default"]');assert.equal(await js('qa.efforts.codex'),'high');
  await click('[aria-label="Fast mode"]');assert.equal(await js('qa.fast'),true);
  assert.equal(await js('document.querySelector(\'[aria-label="Fast mode"]\').getAttribute("aria-checked")'),'true');
  await assertStable(closedTrigger);
  const initialHeight=await js('document.querySelector(".effort-model-views").getBoundingClientRect().height');
  await js('document.querySelector(\'[aria-label="Choose model"]\').click()');await delay(70);
  const intermediateHeight=await js('document.querySelector(".effort-model-views").getBoundingClientRect().height');
  await delay(400);
  const finalHeight=await js('document.querySelector(".effort-model-views").getBoundingClientRect().height');
  if(process.env.QA_REDUCED!=='1') {
   assert.equal(await js('matchMedia("(prefers-reduced-motion: reduce)").matches'),false);
   assert.ok(intermediateHeight>initialHeight && intermediateHeight<finalHeight,'height animates through intermediate frames');
  }
  assert.ok(await js('document.querySelector(".effort-model-views").getBoundingClientRect().height')>initialHeight);
  assert.equal(await js('document.activeElement.getAttribute("aria-label")'),'Back to reasoning');
  assert.equal(await js('document.querySelector(".effort-model-view[data-view=compact]").inert'),true);
  // Search remains usable inside the menu; select a model with fewer efforts.
  await click('input[placeholder="Search models"]');await js('document.execCommand("insertText",false,"model 1")');await delay(150);
  await js('Array.from(document.querySelectorAll(".effort-model-view[data-view=models] [role=menuitem]")).find(e=>e.textContent.includes("codex model 1")).click()');await delay(400);
  assert.equal(await js('qa.models.codex'),'codex1');
  await assertStable(closedTrigger);
  assert.equal(await js('document.querySelector('+JSON.stringify(slider)+').max'),'1');
  assert.equal(await js('!!document.querySelector("[aria-label=\\"Fast mode\\"]")'),false,'unsupported Fast mode hidden');
  assert.equal(await js('document.activeElement.getAttribute("aria-label")'),'Choose model');
  await click(slider);await key('Home');assert.equal(await js('qa.efforts.codex'),'low');
  await close();
  assert.equal(await js('document.activeElement.getAttribute("aria-label")'),'Select agent and model');
  assert.match((await triggerRect()).text,/codex1 Low/,'closing restores the latest model and effort');
  for (const [name,id,max] of [['Claude Code','claude','max'],['Grok Build','grok','high'],['Kimi Code','kimi','max'],['DeepSeek Harness','deepseek','max'],['Bubble','bubble','high']]) {
   await open(name);const providerTrigger=await triggerRect();await click(slider);await key('End');assert.equal(await js('qa.efforts.'+id),max,name);await assertStable(providerTrigger);
   if(id==='kimi'){await js('document.querySelector(\'[aria-label="Reset reasoning to default"]\').click()');await delay(150);assert.equal(await js('qa.efforts.kimi'),null);}
   await close();
  }
  await js('qa.setUnknown(true)');await open('Bubble');
  assert.equal(await js('!!document.querySelector('+JSON.stringify(slider)+')'),false,'unknown Bubble model offers no invented tiers');await close();
  await js('qa.setSide("top");qa.setTheme("dark")');await delay(100);
  await open('Codex');await click(slider);await key('End');await delay(400);
  assert.equal(await js('document.documentElement.classList.contains("dark")'),true);
  let previousFlow;
  for(const [mode,accent,expected] of [['light','#067a64','rgb(6, 122, 100)'],['dark','#e4a85c','rgb(228, 168, 92)']]) {
   await js('qa.setAccent('+JSON.stringify(mode)+','+JSON.stringify(accent)+');qa.setTheme('+JSON.stringify(mode)+')');await delay(150);
   const colors=await js('({title:getComputedStyle(document.querySelector(".effort-picker-selected-effort")).color,fill:getComputedStyle(document.querySelector(".effort-picker-fill")).backgroundColor,flow:getComputedStyle(document.querySelector(".effort-picker-flow")).backgroundImage})');
   assert.equal(colors.title,expected,'effort title follows '+mode+' accent');
   assert.equal(colors.fill,expected,'slider follows '+mode+' accent');
   if(previousFlow)assert.notEqual(colors.flow,previousFlow,'maximum-effort glow follows accent changes');
   previousFlow=colors.flow;
   if(process.env.QA_CAPTURE){const r=await js('(()=>{const r=document.querySelector(".effort-model-views").closest("[role=menu]").getBoundingClientRect();return {x:Math.floor(r.x)-5,y:Math.floor(r.y)-5,width:Math.ceil(r.width)+10,height:Math.ceil(r.height)+10};})()');fs.writeFileSync(path.join(process.env.QA_CAPTURE,'theme-'+mode+'.png'),(await win.webContents.capturePage(r)).toPNG());}
  }

  if(process.env.QA_CAPTURE){fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,'reasoning-picker'+(process.env.QA_REDUCED==='1'?'-reduced':'')+'.png'),(await win.webContents.capturePage()).toPNG());}
  if(process.env.QA_REDUCED==='1')assert.equal(await js('getComputedStyle(document.querySelector(".effort-model-views")).transitionDuration'),'0s');
  await close();const standaloneClosed=await triggerRect('[aria-label="Select model"]');await click('[aria-label="Select model"]');const standaloneTrigger=await triggerRect('[aria-label="Select model"]');assert.ok(standaloneTrigger.width>=standaloneClosed.width,'short labels reserve enough room for the placeholder on open');await assertStable(standaloneTrigger,'[aria-label="Select model"]');assert.ok(await js('!!document.querySelector('+JSON.stringify(slider)+')'));
  await click(slider);await key('Home');await assertStable(standaloneTrigger,'[aria-label="Select model"]');
  await key('End');await assertStable(standaloneTrigger,'[aria-label="Select model"]');
  // Explicitly empty and single-tier catalogs must not offer fallback choices.
  for (const model of ['codex model 2','codex model 3']) {
   await click('[aria-label="Choose model"]');await delay(250);
   await js('Array.from(document.querySelectorAll(".effort-model-view[data-view=models] [role=menuitem]")).find(e=>e.textContent==='+JSON.stringify(model)+').click()');await delay(350);
   if(model.endsWith('2'))assert.equal(await js('!!document.querySelector('+JSON.stringify(slider)+')'),false);
   else assert.equal(await js('document.querySelector('+JSON.stringify(slider)+').disabled'),true);
  }
  await click('[aria-label="Choose model"]');await delay(250);
  await js('Array.from(document.querySelectorAll(".effort-model-view[data-view=models] [role=menuitem]")).find(e=>e.textContent==="codex model 4").click()');await delay(350);
  await click(slider);await key('Home');assert.equal(await js('qa.efforts.codex'),'high','Codex retains provider order instead of sorting tiers');
  await key('Right');assert.equal(await js('qa.efforts.codex'),'turbo','new provider tiers pass through unchanged');
  await key('End');assert.equal(await js('qa.efforts.codex'),'low');
  await key('Escape');
  assert.deepEqual(errors,[]);
  console.log('Reasoning picker: stable trigger labels/geometry, pointer, keyboard, model view/search, six providers, unsupported tiers, popup directions and focus passed');app.exit(0);
 }catch(e){console.error(e);console.error(await js('document.body.innerText'));app.exit(1);}
});
`;
let server;
try {
  await writeFile(path.join(tmp, 'index.html'), '<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(tmp, 'harness.tsx'), harness);
  await writeFile(path.join(tmp, 'main.cjs'), main);
  server = await createServer({root, configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0,strictPort:false}});
  await server.listen();
  const url = new URL(path.relative(root,tmp)+'/index.html',server.resolvedUrls.local[0]).href;
  await new Promise((resolve,reject)=>{
    const env={...process.env,QA_URL:url,QA_CAPTURE:process.env.QA_CAPTURE || ''};
    delete env.ELECTRON_RUN_AS_NODE;
    const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(tmp,'main.cjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
    let out='';let err='';
    child.stdout.on('data',c=>{out+=c;process.stdout.write(c);});child.stderr.on('data',c=>{err+=c;process.stderr.write(c);});
    const timeout=setTimeout(()=>{child.kill();reject(new Error('Timed out\n'+out+'\n'+err));},120000);
    child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);if(code===0){resolve();}else reject(new Error(out+'\n'+err));});
  });
  console.log('reasoning picker Electron regression passed');
} finally {
  await server?.close();
  await rm(tmp,{recursive:true,force:true});
}

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const tmp = await mkdtemp(path.join(root, '.aegis-design-qa/shortcuts-'));
const harness = `
import React,{useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {Toaster} from 'sonner';
import {Settings} from '/src/ui/components/settings/Settings';
import {ConfirmDialogHost,confirmDialog} from '/src/ui/components/ui/confirm-dialog';
import {AppearancePreferences} from '/src/ui/components/AppearancePreferences';
import {AppTabBar} from '/src/ui/components/AppTabBar';
import {useKeyboardShortcuts} from '/src/ui/hooks/useKeyboardShortcuts';
import {useAppStore} from '/src/ui/store/useAppStore';
import {useTabsStore} from '/src/ui/store/useTabsStore';
import {useAppPreferences,subscribeAppPreferences} from '/src/ui/store/useAppPreferences';
import '/src/ui/index.css';
window.electron={...window.preferenceBridge, getBubbleProvidersConfig:async()=>({providers:[]}),sendClientEvent:()=>{},getSystemFonts:async()=>[],getSystemFontFamilies:async()=>[]};
window.qa={store:useAppStore,tabs:useTabsStore,prefs:useAppPreferences,dialog:()=>confirmDialog({title:'Test dialog'})};
useAppStore.setState({showSettings:true,activeSettingsTab:'shortcuts',sidebarCollapsed:false});
function Harness(){
 useKeyboardShortcuts();useEffect(subscribeAppPreferences,[]);
 const settings=useAppStore(s=>s.showSettings);
 return <AppearancePreferences><Tooltip.Provider><div style={{height:'100vh',background:'var(--bg-primary)',color:'var(--text-primary)'}}>{settings?<Settings/>:<><AppTabBar/><textarea aria-label="Composer probe"/><div className="xterm"><textarea aria-label="Terminal probe"/></div><div contentEditable role="textbox" aria-label="Rich editor probe"/></>}<ConfirmDialogHost/><Toaster/></div></Tooltip.Provider></AppearancePreferences>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const preload = String.raw`
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('preferenceBridge',{
 getAppPreferences:()=>ipcRenderer.invoke('prefs:get'),setAppPreferences:p=>ipcRenderer.invoke('prefs:set',p),
 setShortcutCaptureActive:active=>ipcRenderer.invoke('capture',active),
 onAppPreferencesChanged:fn=>{const listener=(_,p)=>fn(p);ipcRenderer.on('app-preferences-changed',listener);return()=>ipcRenderer.removeListener('app-preferences-changed',listener);},
});
`;
const main = String.raw`
const {app,BrowserWindow,ipcMain,Menu}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
const prefs=require(path.join(process.cwd(),'dist-electron/electron/libs/app-preferences.js'));
const {setShortcutCaptureActive}=require(path.join(process.cwd(),'dist-electron/electron/libs/keyboard-shortcuts.js'));
let failWrite=false, nativeCalls=0;
ipcMain.handle('prefs:get',()=>prefs.getAppPreferences());
ipcMain.handle('prefs:set',(_,p)=>{if(failWrite)throw Error('Test write failure');return prefs.setAppPreferences(p);});
ipcMain.handle('capture',(e,active)=>setShortcutCaptureActive(e.sender,active));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Test',submenu:[{label:'Reserved',accelerator:'CommandOrControl+Q',click:()=>nativeCalls++}]}]));
 const win=new BrowserWindow({width:1124,height:900,show:true,webPreferences:{preload:path.join(__dirname,'preload.cjs')}});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
 const js=c=>win.webContents.executeJavaScript(c,true);
 const until=async(c,label)=>{for(let i=0;i<80;i++){if(await js(c))return;await delay(100);}throw Error('Timed out: '+label);};
 const click=async s=>{await js('document.querySelector('+JSON.stringify(s)+').click()');await delay(120);};
 const focus=async s=>{await js('document.querySelector('+JSON.stringify(s)+').focus()');await delay(100);};
 const key=async(keyCode,modifiers=[])=>{win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await delay(160);};
 const text=async(s,value)=>{await js('var el=document.querySelector('+JSON.stringify(s)+');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,'+JSON.stringify(value)+');el.dispatchEvent(new Event("input",{bubbles:true}))');await delay(120);};
 const button=async label=>{await js('Array.from(document.querySelectorAll("button")).find(e=>e.textContent.trim()==='+JSON.stringify(label)+').click()');await delay(140);};
 const shot=async name=>{await delay(200);fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG());};
 const rowCount=()=>js('document.querySelectorAll(".shortcut-row").length');
 const mod=process.platform==='darwin'?'meta':'control';
 try{
  await win.loadURL(process.env.QA_URL);
  await until('!!document.querySelector(".shortcut-row")','shortcut settings');
  assert.equal(await js('document.querySelector("h1").textContent'),'Keyboard shortcuts');
  assert.equal(await rowCount(),29);
  await shot('shortcuts-light');
  await text('[aria-label="Search shortcuts"]','new tab');assert.equal(await rowCount(),1);
  await text('[aria-label="Search shortcuts"]','cmd t');assert((await rowCount())>0);
  await click('[aria-label="Search by keystrokes"]');
  await key('T',[mod]);assert.equal(await rowCount(),1);
  assert.equal(await js('document.querySelector(".shortcut-row").dataset.settingsId'),'shortcut:newTab');
  await key('Enter',['shift']);assert.equal(await rowCount(),1);
  assert.equal(await js('document.querySelector(".shortcut-row").dataset.settingsLabel'),'Insert line break');
  await key('Escape');await key('Escape');assert.equal(await rowCount(),29);
  await click('[aria-label="Edit shortcut for New tab"]');
  const before=await js('qa.tabs.getState().tabs.length');
  await key('T',[mod]);assert.equal(await js('qa.tabs.getState().tabs.length'),before,'recording does not open tab');
  await key('K',[mod]);assert((await js('document.querySelector(".shortcut-capture [role=alert]").textContent')).includes('Search tasks'));
  assert.equal(await js('Array.from(document.querySelectorAll(".shortcut-capture button")).find(e=>e.textContent==="Save").disabled'),true);
  await key('Q',[mod]);assert.equal(nativeCalls,0,'capture suppresses native menu accelerators');
  assert((await js('document.querySelector(".shortcut-capture [role=alert]").textContent')).includes('Quit'));
  await key('J',[mod,'shift']);await shot('shortcuts-capture');
  await key('Enter');await until('qa.prefs.getState().keyboardShortcuts.newTab?.[0]==="Mod+Shift+KeyJ"','binding saved');
  assert.deepEqual(prefs.getAppPreferences().keyboardShortcuts.newTab,['Mod+Shift+KeyJ']);
  await win.reload();await until('!!document.querySelector(".shortcut-row")','reload');
  await until('qa.prefs.getState().keyboardShortcuts.newTab?.[0]==="Mod+Shift+KeyJ"','binding reloaded');
  await click('[aria-label="Add shortcut for New tab"]');await key('L',[mod,'shift']);await key('Enter');
  await until('qa.prefs.getState().keyboardShortcuts.newTab?.length===2','additional binding');
  await click('[aria-label="Edit shortcut for New tab"]');await key('I',[mod,'shift']);await key('Escape');
  assert.deepEqual(prefs.getAppPreferences().keyboardShortcuts.newTab,['Mod+Shift+KeyJ','Mod+Shift+KeyL']);
  failWrite=true;
  await click('[aria-label="Edit shortcut for New tab"]');await key('I',[mod,'shift']);await key('Enter');
  await until('document.querySelector(".shortcut-error")?.textContent.includes("Could not save")','save error');
  assert.deepEqual(prefs.getAppPreferences().keyboardShortcuts.newTab,['Mod+Shift+KeyJ','Mod+Shift+KeyL']);
  failWrite=false;await key('Escape');
  // Settings search lands on the real shortcut row.
  await text('[aria-label="Search settings"]','Go forward');
  await button('Go forwardKeyboard shortcuts');
  assert.equal(await js('document.activeElement.dataset.settingsId'),'shortcut:forward');
  await js('qa.store.getState().setTheme("dark");document.querySelector("main").scrollTop=0');await shot('shortcuts-dark');
  win.setContentSize(390,740);await delay(150);await shot('shortcuts-narrow');
  assert.equal(await js('document.querySelector("main").scrollWidth>document.querySelector("main").clientWidth'),false);
  win.setContentSize(1124,900);
  await js('qa.store.getState().setShowSettings(false)');await delay(150);
  await focus('[aria-label="Composer probe"]');await key('T',[mod]);
  assert.equal(await js('qa.tabs.getState().tabs.length'),before,'old chord removed');
  await key('J',[mod,'shift']);assert.equal(await js('qa.tabs.getState().tabs.length'),before+1);
  await js('qa.tabs.getState().setActiveTabView({kind:"automations"})');
  await key('L',[mod,'shift']);assert.equal(await js('qa.tabs.getState().tabs.length'),before+2);
  assert((await js('document.querySelector("[aria-label=\\"New tab\\"]").title')).includes('J'),'tooltip follows preference');
  const current=await js('qa.tabs.getState().activeTabId');await key('Tab',['control','shift']);assert.notEqual(await js('qa.tabs.getState().activeTabId'),current);
  await key('9',[mod]);assert.equal(await js('qa.tabs.getState().activeTabId'),await js('qa.tabs.getState().tabs.at(-1).id'));
  await key('W',[mod]);assert.equal(await js('qa.tabs.getState().tabs.length'),before+1);
  await js('qa.tabs.getState().setActiveTabView({kind:"skills"});document.activeElement.blur()');
  await key('[',[mod]);assert.notEqual(await js('qa.tabs.getState().tabs.find(t=>t.id===qa.tabs.getState().activeTabId).view.kind'),'skills');
  await key(']',[mod]);assert.equal(await js('qa.tabs.getState().tabs.find(t=>t.id===qa.tabs.getState().activeTabId).view.kind'),'skills');
  await js('qa.store.setState({activeWorkspace:"chat",activeSessionId:"test-session",inSessionSearchOpen:false})');await key('F',[mod]);assert.equal(await js('qa.store.getState().inSessionSearchOpen'),true);await key('Escape');
  await js('qa.store.setState({searchPaletteOpen:false});window.dispatchEvent(new KeyboardEvent("keydown",{key:"k",code:"KeyK",metaKey:true,isComposing:true,bubbles:true}))');assert.equal(await js('qa.store.getState().searchPaletteOpen'),false);
  await js('var consumed=new KeyboardEvent("keydown",{key:"k",code:"KeyK",metaKey:true,cancelable:true});consumed.preventDefault();window.dispatchEvent(consumed)');assert.equal(await js('qa.store.getState().searchPaletteOpen'),false);
  await focus('[aria-label="Composer probe"]');
  const collapsed=await js('qa.store.getState().sidebarCollapsed');await key('B',[mod]);assert.equal(await js('qa.store.getState().sidebarCollapsed'),collapsed,'text formatting is not swallowed');
  await js('document.activeElement.blur()');await key('B',[mod,'shift']);assert.equal(await js('qa.store.getState().sidebarCollapsed'),collapsed,'exact modifiers');
  await key('B',[mod]);assert.equal(await js('qa.store.getState().sidebarCollapsed'),!collapsed);
  await focus('[aria-label="Terminal probe"]');await key('J',[mod,'shift']);assert.equal(await js('qa.tabs.getState().tabs.length'),before+1,'terminal owns keys');
  await js('document.activeElement.blur();void qa.dialog()');await delay(150);await key('J',[mod,'shift']);assert.equal(await js('qa.tabs.getState().tabs.length'),before+1,'dialog owns keys');await key('Escape');
  await js('document.activeElement.blur();qa.store.getState().setShowSettings(true)');await delay(150);
  await key('J',[mod,'shift']);assert.equal(await js('qa.tabs.getState().tabs.length'),before+1,'settings blocks hidden navigation');
  await button('Reset all to defaults');await until('!!document.querySelector("[role=dialog]")','reset dialog');await button('Cancel');
  assert(prefs.getAppPreferences().keyboardShortcuts.newTab);
  await button('Reset all to defaults');await button('Reset all');await until('Object.keys(qa.prefs.getState().keyboardShortcuts).length===0','reset all');
  await click('[aria-label="Edit shortcut for New tab"]');await key('T',[mod,'shift']);await key('Enter');await delay(120);
  await click('[aria-label="Reset New tab"]');assert.deepEqual(prefs.getAppPreferences().keyboardShortcuts,{});
  // Removing the final binding persists an explicit unassigned action.
  await js('document.querySelector("[data-settings-id=\\"shortcut:newTab\\"] button[aria-label^=Remove]").click()');await delay(180);
  assert.deepEqual(prefs.getAppPreferences().keyboardShortcuts.newTab,[]);
  await js('qa.store.getState().setShowSettings(false)');await delay(120);await key('T',[mod]);assert.equal(await js('qa.tabs.getState().tabs.length'),before+1);
  assert.deepEqual(errors.filter(e=>!e.includes('Test write failure')),[]);
  console.log(JSON.stringify({ok:true,captures:process.env.QA_CAPTURE}));app.exit(0);
 }catch(error){console.error(error);await shot('failure');app.exit(1);}
});
`;
let server;
try {
 await writeFile(path.join(tmp,'index.html'),'<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
 await writeFile(path.join(tmp,'harness.tsx'),harness);await writeFile(path.join(tmp,'preload.cjs'),preload);await writeFile(path.join(tmp,'main.cjs'),main);
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0,strictPort:false,watch:{ignored:['**/.aegis-design-qa/**']}}});await server.listen();
 const env={...process.env,QA_URL:new URL(path.relative(root,tmp)+'/index.html',server.resolvedUrls.local[0]).href,QA_CAPTURE:path.join(root,'output/playwright/keyboard-shortcuts')};delete env.ELECTRON_RUN_AS_NODE;
 await new Promise((resolve,reject)=>{
  const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(tmp,'main.cjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});let out='';
  child.stdout.on('data',c=>{out+=c;process.stdout.write(c);});child.stderr.on('data',c=>process.stderr.write(c));
  const timeout=setTimeout(()=>{child.kill();reject(Error('Keyboard shortcut test timed out'));},90000);
  child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);code===0&&out.includes('"ok":true')?resolve():reject(Error('Keyboard shortcut Electron test failed'));});
 });
} finally {await server?.close();await rm(tmp,{recursive:true,force:true});}

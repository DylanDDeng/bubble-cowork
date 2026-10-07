import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// First-run agent onboarding panel, rendered with the real component and
// preload against stubbed runtime IPC. Two scenarios:
//  - some agents ready: summary tiles, "Needs setup" rows (one-click install,
//    inline sign-in, npm-missing and not-on-PATH fallbacks, Bubble Add key),
//    the full list, default-agent choice and Enter to start;
//  - nothing ready: straight into the built-in Bubble setup (search and pick a
//    provider, paste a key with show/hide, save, start with Bubble).
// QA_CAPTURE=<dir> saves screenshots.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const qaRoot = path.join(root, 'dev-fixtures');
await mkdir(qaRoot, { recursive: true });
const tmp = await mkdtemp(path.join(qaRoot, 'agent-onboarding-'));
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {AgentOnboardingView} from '/src/ui/components/onboarding/AgentOnboardingView.tsx';
import '/src/ui/index.css';
window.qaCompleted=false;window.qaPreferred=null;
window.addEventListener('aegis:preferred-provider-changed',e=>{window.qaPreferred=e.detail});
createRoot(document.getElementById('root')).render(<div style={{height:'100vh',background:'var(--app-chrome-bg)'}}><AgentOnboardingView onComplete={()=>{window.qaCompleted=true}}/></div>);
`;
const main = `
const {app,BrowserWindow,ipcMain}=require('electron');
// CI runners have Reduce Motion on; tests expect the default motion preference.
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));fs.mkdirSync(app.getPath('userData'),{recursive:true});
const root=process.env.QA_ROOT;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const meta={claude:['Claude Code','@anthropic-ai/claude-code'],codex:['Codex CLI','@openai/codex'],opencode:['OpenCode','opencode-ai'],kimi:['Kimi',null],grok:['Grok',null],pi:['Pi',null],qoder:['Qoder',null],bubble:['Bubble',null],deepseek:['DeepSeek Harness',null]};
const docs={grok:'https://example.test/grok'};
const states={claude:'not_installed',codex:'not_installed',opencode:'ready',kimi:'login_required',grok:'ready',pi:'not_installed',qoder:'not_installed',bubble:'login_required',deepseek:'not_installed'};
const loginCommands={claude:'claude login',kimi:'kimi login'};
const report=()=>{const entries=Object.keys(meta).map(provider=>{const [title,pkg]=meta[provider];const state=states[provider];return{provider,title,state,version:state==='ready'?'0.15.2':null,summary:title+(state==='ready'?' is ready.':state==='login_required'?' is installed but not signed in.':' is not installed.'),detail:null,installCommand:pkg?'npm install -g '+pkg:null,canAutoInstall:!!pkg,loginCommand:state==='login_required'?loginCommands[provider]||null:null,docsUrl:docs[provider]||null,checkedAt:Date.now()}});return{entries,readyCount:entries.filter(e=>e.state==='ready').length,checkedAt:Date.now()}};
const installs=[];const bubbleCalls=[];
const bubbleProviders=[['openrouter','OpenRouter'],['anthropic','Anthropic'],['moonshot-intl','Moonshot (International)']].map(([id,name])=>({id,name,hasApiKey:false,enabled:false,isDefault:false,configured:false}));
app.whenReady().then(async()=>{
 ipcMain.on('get-ui-resume-state-sync',e=>{e.returnValue=null});ipcMain.on('renderer-state:get-all-sync',e=>{e.returnValue={}});ipcMain.on('save-ui-resume-state-sync',e=>{e.returnValue=true});
 ipcMain.on('renderer-state:set',()=>{});ipcMain.handle('set-theme',()=>{});
 ipcMain.handle('get-agent-runtime-directory',()=>report());
 ipcMain.handle('install-agent-runtime',async(_e,provider)=>{installs.push(provider);await delay(600);
  if(provider==='claude'){states.claude='login_required';return{ok:true}}
  if(provider==='codex'&&installs.filter(p=>p==='codex').length>1)return{ok:true};
  return{ok:false,reason:'npm_missing',message:"Node.js isn\\'t installed, so npm can\\'t run."}});
 ipcMain.handle('get-bubble-providers-config',()=>({providers:bubbleProviders,defaultProviderId:null}));
 ipcMain.handle('set-bubble-provider-key',(_e,id,key)=>{bubbleCalls.push(['key',id,key]);states.bubble='ready';return{providers:bubbleProviders,defaultProviderId:null}});
 ipcMain.handle('set-bubble-default-provider',(_e,id)=>{bubbleCalls.push(['default',id]);return{providers:bubbleProviders,defaultProviderId:id}});
 const win=new BrowserWindow({width:760,height:860,show:true,webPreferences:{preload:path.join(root,'dist-electron/electron/preload.cjs')}});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=code=>win.webContents.executeJavaScript(code,true);
 const byText=text=>'[...document.querySelectorAll("button")].find(e=>e.textContent.trim().startsWith('+JSON.stringify(text)+'))';
 const click=selector=>js('('+selector+').click()').then(()=>delay(150));
 const text=()=>js('document.body.innerText');
 const waitFor=async(cond,label)=>{for(let i=0;i<60;i++){if(await js(cond))return;await delay(100)}throw Error('Timed out waiting for '+label)};
 const screenshot=async name=>{if(!process.env.QA_CAPTURE)return;fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG())};
 try{
  await win.loadURL(process.env.QA_URL);
  await waitFor('!!document.querySelector("[data-ready-agents]")','overview');await delay(300);
  const rows=scope=>js('[...document.querySelectorAll("'+scope+' [data-agent-row]")].map(e=>e.dataset.agentRow)');
  const row=provider=>'document.querySelector("[data-agent-row='+provider+']")';
  const rowButton=(provider,label)=>'[...'+row(provider)+'.querySelectorAll("button")].find(e=>e.textContent.trim()==='+JSON.stringify(label)+')';
  const byLabel=label=>'document.querySelector("[aria-label=\\\\"'+label+'\\\\"]")';
  const typeInto=(selector,value)=>js('(()=>{const el='+selector+';el.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,'+JSON.stringify(value)+');el.dispatchEvent(new Event("input",{bubbles:true}))})()').then(()=>delay(150));
  const pressKey=(selector,key)=>js('('+selector+').dispatchEvent(new KeyboardEvent("keydown",{key:'+JSON.stringify(key)+',bubbles:true}))').then(()=>delay(200));

  // ── Some agents ready ─────────────────────────────────────────────
  let body=await text();
  assert.ok(body.includes('2 agents ready'));
  assert.equal(await js('document.querySelectorAll("[data-ready-agents] > *").length'),2,'one tile per ready agent');
  assert.deepEqual((await rows('[role=dialog]')).filter(p=>p==='opencode'||p==='grok'),[],'ready agents are not listed as rows');
  // Only agents with a step in the panel; Claude first, sign-ins before installs.
  assert.deepEqual(await rows('[data-needs-setup]'),['claude','kimi','bubble','codex']);
  assert.equal(await js(rowButton('bubble','Add key')+'!==undefined'),true,'built-in Bubble offers Add key');
  assert.equal(await js('document.querySelector("#agent-onboarding-default").dataset.defaultAgent'),'opencode','default falls back to the first ready agent');
  assert.equal(await js('!!document.querySelector("#agent-onboarding-default img, #agent-onboarding-default svg")'),true,'the picker shows the agent logo');
  assert.equal(await js('!!document.querySelector("[class*=\\\\"var(--accent)\\\\"]")'),false,'no accent colour anywhere');
  await screenshot('1-some-ready');

  // Sign in opens the command inline.
  await click(rowButton('kimi','Sign in'));
  assert.ok((await text()).includes('kimi login'));

  // Coming back from Terminal re-checks: Kimi signed in meanwhile.
  states.kimi='ready';
  await js('window.dispatchEvent(new Event("focus"))');
  await waitFor('document.body.innerText.includes("3 agents ready")','re-check on focus');
  assert.equal(await js('!!document.querySelector("[data-needs-setup] [data-agent-row=kimi]")'),false,'signed-in agent leaves Needs setup');

  // One-click install, then its sign-in step opens itself.
  await click(rowButton('claude','Install'));
  assert.ok((await js(row('claude')+'.innerText')).includes('Installing'));
  await waitFor(row('claude')+'.innerText.includes("claude login")','claude sign-in step');
  await screenshot('2-installed-sign-in');

  // npm missing, then installed but not on PATH.
  await click(rowButton('codex','Install'));
  await waitFor(row('codex')+'.innerText.includes("Node.js isn")','npm-missing error');
  assert.equal(await js(rowButton('codex','Get Node.js')+'!==undefined'),true);
  assert.equal(await js(byLabel('Copy Codex CLI install command')+'!==null'),true);
  await click(rowButton('codex','Try again'));
  await waitFor(row('codex')+'.innerText.includes("PATH")','not-found-after-install hint');
  assert.deepEqual(installs,['claude','codex','codex']);

  // App shortcuts listen on window; the panel keeps them from firing.
  await js('window.qaWindowKeys=0;window.addEventListener("keydown",()=>{window.qaWindowKeys++});document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"n",metaKey:true,bubbles:true}))');
  assert.equal(await js('document.activeElement.closest("[role=dialog]")!==null'),true,'focus stays in the panel');
  assert.equal(await js('window.qaWindowKeys'),0,'window shortcuts do not see keys typed in the panel');

  // Full list and back.
  await click(byText('All agents'));
  assert.equal((await rows('[role=dialog]')).length,9);
  assert.equal(await js(rowButton('grok','Setup guide')+'!==undefined'),false,'ready agents show Ready, not setup');
  await screenshot('3-all-agents');
  await click(byLabel('Back'));
  assert.equal(await js('!!document.querySelector("[data-ready-agents]")'),true);

  // Bubble's Add key opens its setup with a way back.
  await click(rowButton('bubble','Add key'));
  assert.ok((await text()).includes('Start with Bubble'));
  await click(byLabel('Back'));
  assert.equal(await js('!!document.querySelector("[data-ready-agents]")'),true);

  // Choose a default agent and start with Enter.
  await click('document.querySelector("#agent-onboarding-default")');
  await waitFor('!!document.querySelector("[data-default-agent-option]")','default agent menu');
  assert.deepEqual(await js('[...document.querySelectorAll("[data-default-agent-option]")].map(e=>e.dataset.defaultAgentOption)'),['opencode','kimi','grok']);
  assert.equal(await js('[...document.querySelectorAll("[data-default-agent-option]")].every(e=>e.querySelector("img, svg"))'),true,'every option has a logo');
  await screenshot('1b-default-agent-menu');
  await click('document.querySelector("[data-default-agent-option=grok]")');
  await waitFor('!document.querySelector("[data-default-agent-option]")','menu closes');
  assert.equal(await js('document.querySelector("#agent-onboarding-default").dataset.defaultAgent'),'grok');
  assert.equal(await js('document.activeElement.closest("[role=dialog]")!==null'),true,'focus returns to the panel');
  await pressKey('document.querySelector("[role=dialog]")','Enter');
  assert.equal(await js('window.qaCompleted'),true,'Enter starts');
  assert.equal(await js('window.qaPreferred'),'grok','the chosen default is announced to the composer');

  // ── Everything ready: nothing to review, one full-width action ─────
  for(const key of Object.keys(states))states[key]='ready';
  win.reload();
  await waitFor('document.body.innerText.includes("9 agents ready")','all-ready summary');await delay(300);
  assert.equal(await js('!!document.querySelector("[data-needs-setup]")'),false);
  assert.equal(await js(byText('All agents')+'===undefined'),true,'no footer links when nothing needs setup');
  assert.equal(await js('(()=>{const b='+byText('Get started')+';const r=document.querySelector("#agent-onboarding-default").parentElement;return Math.round(b.getBoundingClientRect().width)===Math.round(r.getBoundingClientRect().width)})()'),true,'Get started spans the panel');
  await screenshot('0-all-ready');

  // ── Nothing ready: straight into Bubble ───────────────────────────
  for(const key of Object.keys(states))states[key]='not_installed';
  states.bubble='login_required';
  win.reload();
  await waitFor('document.body.innerText.includes("Start with Bubble")','bubble setup');await delay(300);
  body=await text();
  assert.ok(body.includes('Step 1 of 2'));
  assert.ok(body.includes("Where's your API key from?"));
  assert.equal(await js('document.activeElement.getAttribute("aria-label")'),'Search providers','search is focused');
  assert.equal(await js('document.querySelector("[aria-label=\\\\"Search providers\\\\"]").placeholder'),'Search 3 providers');
  assert.equal(await js('document.querySelectorAll("[role=option]").length'),3);
  assert.equal(await js('document.querySelector("[role=option][aria-selected=true]").dataset.providerId'),'openrouter');
  await screenshot('4-bubble-provider');
  await pressKey(byLabel('Search providers'),'ArrowDown');
  assert.equal(await js('document.querySelector("[role=option][aria-selected=true]").dataset.providerId'),'anthropic','arrow keys move the highlight');
  await typeInto(byLabel('Search providers'),'moon');
  assert.equal(await js('document.querySelectorAll("[role=option]").length'),1,'search filters');
  await typeInto(byLabel('Search providers'),'zzz');
  assert.ok((await text()).includes('No providers match.'));
  await typeInto(byLabel('Search providers'),'anth');
  await pressKey(byLabel('Search providers'),'Enter');

  // Step 2: key with show/hide, validation, save.
  await waitFor('document.body.innerText.includes("Add your Anthropic key")','key step');
  assert.equal(await js('document.querySelector("#agent-onboarding-key").type'),'password');
  await click(byLabel('Show key'));
  assert.equal(await js('document.querySelector("#agent-onboarding-key").type'),'text');
  assert.equal(await js(byLabel('Hide key')+'!==null'),true);
  await click(byText('Save and start'));
  assert.ok((await text()).includes('Enter your API key.'),'empty key is caught inline');
  assert.deepEqual(bubbleCalls,[]);
  await typeInto('document.querySelector("#agent-onboarding-key")','sk-ant-test');
  await screenshot('5-bubble-key');
  await click(byText('Save and start'));
  await waitFor('window.qaCompleted===true','finish after saving the key');
  assert.deepEqual(bubbleCalls,[['key','anthropic','sk-ant-test'],['default','anthropic']]);
  assert.equal(await js('window.qaPreferred'),'bubble','Bubble becomes the default agent');

  assert.deepEqual(errors.filter(e=>!/No handler registered/.test(e)),[]);
  console.log(JSON.stringify({ok:true,checks:['ready summary','re-check on focus','all ready full-width start','needs setup rows','inline sign-in','install opens sign-in','npm-missing and PATH fallbacks','shortcuts blocked','all agents','bubble add key','default agent + enter','bubble provider search','bubble key save']}));
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
  console.log('Agent onboarding Electron regression passed');
} finally { await server?.close(); await rm(tmp, { recursive: true, force: true }); }

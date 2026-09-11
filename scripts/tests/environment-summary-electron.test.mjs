import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await mkdir(path.join(root, 'dev-fixtures'), { recursive: true });
const tmp = await mkdtemp(path.join(root, 'dev-fixtures/environment-'));
const harness = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import '/src/ui/index.css';
window.qa={calls:[],refreshes:0,branchReads:0,attached:[],listeners:new Set()};
Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{qa.copied=text}}});
window.electron={
 getUiResumeStateSync:()=>null, getRendererStateAllSync:()=>({}), saveUiResumeState:async()=>{},
 getGitBranches:async()=>{qa.branchReads++;await new Promise(r=>setTimeout(r,350));return {ok:true,entries:[{name:'feature/card',fullRef:'refs/heads/feature/card',current:true,remote:false}]}},
 getGitOverview:async()=>qa.overview,
 listSessionPullRequests:async(id,refresh)=>qa.attached.map(pr=>({...pr,lookupStatus:refresh?'found':'cached'})),
 onSessionPullRequestsChanged:callback=>{qa.listeners.add(callback);return()=>qa.listeners.delete(callback)},
 attachSessionPullRequest:async input=>{
   const pr={...(qa.overview.pr||{number:42,title:'Created PR',state:'open',url:input.url}),repoRoot:input.repoRoot,headBranch:input.headBranch,attachedAt:Date.now()};
   const created=!qa.attached.some(item=>item.url===pr.url);if(created)qa.attached.push(pr);qa.listeners.forEach(fn=>fn(input.sessionId));return {created,pr};
 },
 detachSessionPullRequest:async(id,url)=>{qa.attached=qa.attached.filter(pr=>pr.url!==url);qa.listeners.forEach(fn=>fn(id))},
 getGitChanges:async()=>({ok:true,entries:[]}),
 gitGenerateCommitMessage:async()=>({ok:true,message:'style: update card'}),
 gitCommit:async()=>{qa.calls.push('commit');return {ok:true}},
 gitPush:async()=>{qa.calls.push('push');await new Promise(r=>setTimeout(r,400));qa.patch({aheadCount:0,hasUpstream:true});return {ok:true}},
 gitSync:async()=>{qa.calls.push('sync');return {ok:true}},
 gitCreatePr:async()=>{qa.calls.push('pr');return {ok:true,url:'https://github.com/aegis/desktop/pull/42'}},
 openExternalUrl:async url=>{qa.calls.push(['external',url]);return {ok:true}},
};
const {Toaster}=await import('sonner');
const {EnvironmentHub}=await import('/src/ui/components/environment/EnvironmentHub.tsx');
const {useGitEnvironment}=await import('/src/ui/components/environment/useGitEnvironment.ts');
const {useAppStore}=await import('/src/ui/store/useAppStore.ts');
const {useSessionOrganizationStore}=await import('/src/ui/store/useSessionOrganizationStore.ts');
qa.organization=useSessionOrganizationStore;
const draft=useAppStore.getState().createDraftSession('/projects/podcast');
const base={...useAppStore.getState().sessions[draft],id:'fixture',isDraft:false,status:'idle',messages:[]};
function GitProbe(){
 const [cwd,setCwd]=useState('/repo/a');qa.setProbeCwd=setCwd;
 const git=useGitEnvironment(cwd,cwd);qa.probe=git;
 return <output id="probe-branch">{git.overview.branch||'unknown'}</output>;
}
function Harness(){
 const [probe,setProbe]=useState(false);qa.setProbe=setProbe;
 const [sessionId,setSessionId]=useState('fixture');qa.setSessionId=setSessionId;
 const [mode,setMode]=useState('local');const [patch,setPatch]=useState({});const [narrow,setNarrow]=useState(false);qa.setMode=value=>{setPatch({});setMode(value)};qa.patch=setPatch;qa.setNarrow=setNarrow;
 const repo=!['local','local-extras','loading','error','draft'].includes(mode);
 const session={...base,id:sessionId,cwd:repo?'/projects/aegis':'/projects/podcast',envMode:mode==='worktree'?'worktree':'local',worktreePath:mode==='worktree'?'/projects/aegis-wt':null,status:mode==='running'?'running':'idle',associatedWorktreeBranch:'stale/session-branch'};
 if(mode==='local-extras')session.computerUseGrants=[{app:'Test app'}];
 const context={paneId:'main',paneLabel:'Main',sessionId,session,title:'Fixture',projectCwd:session.cwd,effectiveCwd:session.worktreePath||session.cwd,envMode:session.envMode,worktreePath:session.worktreePath,isRunning:mode==='running',isDraft:false,isDm:false,contextKey:mode,unavailableReason:mode==='draft'?'Choose a workspace to inspect its environment.':null};
 const overview={ok:repo,error:mode==='error'?'git-error':repo?null:'not-a-repo',hasRepo:repo,repoRoot:repo?session.cwd:null,repository:repo?{fullName:'aegis/desktop',webUrl:'https://github.com/aegis/desktop',defaultBranch:'main'}:null,branch:repo?'feature/card':null,upstream:'origin/feature/card',hasUpstream:true,aheadCount:1,behindCount:0,hasOriginRemote:true,isGitHubRemote:true,isDefaultBranch:false,totalChanges:2,insertions:24,deletions:6,prStatus:'not_found',pr:null};
 if(mode==='loading')overview.error=null;
 if(mode==='branch-loading')overview.branch=null;
 if(mode==='detached')overview.branch='HEAD';
 const clean=['push','publish','published','default','behind','diverged','pr','closed','merged'].includes(mode);
 if(clean)Object.assign(overview,{totalChanges:0,insertions:0,deletions:0,aheadCount:0});
 if(mode==='push')overview.aheadCount=2;
 if(mode==='publish')Object.assign(overview,{hasUpstream:false,upstream:null});
 if(mode==='behind'||mode==='diverged')overview.behindCount=2;
 if(mode==='diverged')overview.aheadCount=1;
 if(mode==='default')overview.isDefaultBranch=true;
 if(mode==='unknown')overview.prStatus='unknown';
 if(mode==='pr'||mode==='closed'||mode==='merged')Object.assign(overview,{prStatus:'found',pr:{number:42,title:'Improve environment content',url:'https://github.com/aegis/desktop/pull/42',state:mode==='pr'?'open':mode}});
 if(mode==='non-github')overview.isGitHubRemote=false;
 Object.assign(overview,patch);
 qa.overview=overview;
 const git={overview,loading:mode==='loading'||mode==='pr-loading',lastUpdatedAt:Date.now(),refresh:async()=>{qa.refreshes++},getSnapshot:()=>({contextKey:mode,cwd:context.effectiveCwd,repoRoot:overview.repoRoot,branch:overview.branch,signature:[overview.repoRoot||'',overview.branch||'',overview.upstream||'',overview.aheadCount,overview.behindCount,overview.totalChanges,overview.insertions,overview.deletions,overview.prStatus,overview.pr?.number||''].join(':')})};
 return <><Toaster/><div hidden>{probe?<GitProbe/>:null}</div><main style={{display:'flex',height:'100vh',background:'var(--bg-primary)'}}><div style={{width:narrow?420:720,padding:20}}><header style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><span>Environment preview</span><EnvironmentHub context={context} git={git} onOpenProjectPanel={view=>qa.view=view}/></header><button id="outside" style={{marginTop:480}}>Outside</button></div><aside style={{flex:1,borderLeft:'1px solid var(--border)',padding:20}}>Files</aside></main></>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main = `
const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1050,height:740,show:false,webPreferences:{backgroundThrottling:false}});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=code=>win.webContents.executeJavaScript(code,true);
 const click=async label=>{await js('(()=>{const e=[...document.querySelectorAll("button, [role=menuitem]")].find(e=>e.getAttribute("aria-label")==='+JSON.stringify(label)+'||e.textContent.trim()==='+JSON.stringify(label)+'||e.querySelector("span")?.textContent.trim()==='+JSON.stringify(label)+');if(!e)throw Error("Missing button: '+label+'");e.click()})()');await delay(150)};
 const visible=()=>js('document.body.innerText');
 const mode=async value=>{await js('qa.setMode('+JSON.stringify(value)+')');await delay(200)};
 const snap=async name=>{if(process.env.QA_CAPTURE){fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG())}};
 try{
 await win.loadURL(process.env.QA_URL);
 for(let i=0;i<100;i++){if(await js('!!window.qa?.setMode'))break;await delay(100)}
 assert.equal(await js('!!document.querySelector("button[title=Environment]")'),false,'non-Git without other sections has no empty card');
 await js('qa.organization.setState({projectSources:{"/projects/podcast":["/projects/podcast","/projects/shared-assets"]}})');await delay(100);
 await click('Open environment panel');assert.match(await visible(),/Project folders/);assert.match(await visible(),/shared-assets/);await snap('project-folders');
 await click('shared-assets');assert.equal(await js('qa.copied'),'/projects/shared-assets');await click('Open environment panel');
 await js('qa.organization.setState({projectSources:{}})');await delay(100);
 await mode('local-extras');await click('Open environment panel');assert.match(await visible(),/Computer Use/);assert.doesNotMatch(await visible(),/Local|Changes|Commit or push/);await snap('non-git-extras');
 await mode('loading');assert.match(await visible(),/Checking environment/);assert.doesNotMatch(await visible(),/HEAD|stale/);
 await mode('branch-loading');assert.doesNotMatch(await visible(),/HEAD|stale|feature/);
 assert.equal(await js('[...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="Commit or push").disabled'),true,'unknown branch cannot enable mutations');
 await js('qa.patch({branch:"master"})');await delay(100);assert.match(await visible(),/master/);assert.equal(await js('qa.branchReads'),0);
 await click('Open environment panel');await click('Open environment panel');assert.match(await visible(),/master/);assert.doesNotMatch(await visible(),/HEAD/);assert.equal(await js('qa.branchReads'),0,'reopening does not refetch branch list');
 await click('master');assert.match(await visible(),/Loading branches/);assert.equal(await js('!!document.querySelector("button[title=master]")'),true);
 await delay(400);assert.equal(await js('!!document.querySelector("button[title=master]")'),true,'candidate list cannot overwrite the current branch');
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await delay(200);
 await mode('detached');assert.match(await visible(),/Detached HEAD/);
 await mode('error');assert.match(await visible(),/Unable to read Git status/);
 await mode('draft');assert.match(await visible(),/Choose a workspace/);assert.doesNotMatch(await visible(),/Copy workspace path/);
 await mode('git');assert.match(await visible(),/feature\\/card/);assert.match(await visible(),/Changes/);await click('Changes');assert.equal(await js('qa.view'),'changes');
 assert.match(await visible(),/Commit or push/);assert.doesNotMatch(await visible(),/Copy workspace path|Open repository|Create pull request|Sync/);await snap('git');
 await click('Environment options');assert.match(await visible(),/Copy workspace path/);assert.match(await visible(),/Open repository/);
 await js('document.querySelector("[data-environment-hub-layer]").dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))');
 assert.equal(await js('document.querySelector("button[title=Environment]").getAttribute("aria-expanded")'),'true');
 await click('Copy workspace path');assert.equal(await js('qa.copied'),'/projects/aegis');
 await click('Commit or push');assert.match(await visible(),/Commit all changes/);assert.match(await visible(),/Commit only/);assert.match(await visible(),/Commit and push/);
 await js('document.querySelector("textarea").dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))');
 assert.equal(await js('document.querySelector("button[title=Environment]").getAttribute("aria-expanded")'),'true');
 await click('Cancel');await delay(450);assert.deepEqual(await js('qa.calls'),[]);
 await click('feature/card');assert.equal(await js('!!document.querySelector("[data-environment-hub-layer]")'),true);
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await delay(200);
 await mode('running');assert.match(await visible(),/active task is running/);
 assert.equal(await js('[...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="Commit or push").disabled'),true);
 await mode('unknown');assert.match(await visible(),/Pull request status unavailable/);assert.doesNotMatch(await visible(),/PR unknown|Create pull request/);await snap('pr-unavailable');
 const refreshBefore=await js('qa.refreshes');await click('Pull request status unavailable');assert.equal(await js('qa.refreshes'),refreshBefore+1);
 await mode('pr-loading');assert.doesNotMatch(await visible(),/Checking pull request|status unavailable|Create pull request/);await snap('silent-pr-check');
 assert.equal(await js('[...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="Commit or push").disabled'),false,'cached changes stay actionable during refresh');
 await click('Open environment panel');await click('Open environment panel');
 assert.equal(await js('[...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="Commit or push").disabled'),false,'reopening during refresh keeps eligibility');
 await click('Commit or push');assert.match(await visible(),/Commit all changes/);await click('Cancel');await delay(450);
 // Cached push eligibility is usable, but fresh validation must reject a changed branch.
 await js('qa.patch({totalChanges:0,aheadCount:2});qa.originalOverview=window.electron.getGitOverview;window.electron.getGitOverview=async()=>({...qa.overview,branch:"changed-externally"});true');await delay(100);
 await click('Commit or push');assert.deepEqual(await js('qa.calls'),[],'stale branch must not reach a Git mutation');
 await js('window.electron.getGitOverview=qa.originalOverview;qa.patch({totalChanges:0,aheadCount:0})');await delay(100);
 assert.equal(await js('[...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="Commit or push").disabled'),true,'clean synchronized branch stays disabled during refresh');
 await js('qa.patch({prStatus:"found",pr:{number:42,title:"Cached PR",state:"open",url:"https://github.com/aegis/desktop/pull/42"}})');await delay(100);
 assert.match(await visible(),/Existing pull request/,'keep known PR visible during background checks');assert.doesNotMatch(await visible(),/Checking pull request/);
 await js('qa.patch({totalChanges:0,aheadCount:0})');await delay(100);assert.match(await visible(),/Create pull request/);
 assert.equal(await js('[...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="Create pull request").disabled'),false,'known published branch retains PR creation eligibility during refresh');
 await mode('pr');assert.match(await visible(),/Existing pull request/);assert.match(await visible(),/Attach/);await snap('discovered-pr');
 await click('Attach');assert.match(await visible(),/PR #42/);assert.match(await visible(),/Open/);assert.doesNotMatch(await visible(),/Existing pull request/);await snap('attached-pr');
 await click('Undo');assert.match(await visible(),/Existing pull request/);assert.equal(await js('qa.attached.length'),0);
 await click('Attach');await mode('default');assert.match(await visible(),/PR #42/,'association survives branch change');
 await mode('local');assert.match(await visible(),/PR #42/,'association survives switching to a non-Git directory');assert.doesNotMatch(await visible(),/Commit or push/);
 await click('PR #42 options');await click('Remove from task');assert.equal(await js('qa.attached.length'),0);
 await mode('pr');
 await mode('closed');await click('Attach');assert.match(await visible(),/Closed/);
 await click('PR #42 options');await click('Remove from task');
 await mode('merged');await click('Attach');assert.match(await visible(),/Merged/);
 await click('PR #42 options');await click('Remove from task');
 await mode('non-github');assert.doesNotMatch(await visible(),/pull request|PR #/);
 await mode('default');assert.doesNotMatch(await visible(),/Create pull request/);
 await mode('behind');assert.match(await visible(),/Sync/);assert.match(await visible(),/2 behind/);
 await mode('diverged');assert.match(await visible(),/Branch has diverged/);
 assert.equal(await js('[...document.querySelectorAll("button")].find(e=>e.querySelector("span")?.textContent==="Sync").disabled'),true);
 await mode('worktree');assert.doesNotMatch(await visible(),/Squash-merge|Discard worktree/);
 await click('Worktree');assert.match(await visible(),/Squash-merge into project/);assert.match(await visible(),/Discard worktree/);
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await delay(200);
 // Exercise the combined row against isolated action spies, including the
 // post-push PR transition. No real repository or system clipboard is used.
 await mode('push');assert.match(await visible(),/2 to push/);await click('Commit or push');assert.match(await visible(),/Pushing/);await delay(500);
 assert.deepEqual(await js('qa.calls'),['push']);assert.match(await visible(),/Create pull request/);
 await click('Create pull request');assert.equal(await js('qa.attached.length'),1,'created PR is associated with the task');assert.deepEqual(await js('qa.calls'),['push','pr',['external','https://github.com/aegis/desktop/pull/42']]);
 await mode('publish');await click('Commit or push');await delay(500);assert.equal(await js('qa.calls.filter(c=>c==="push").length'),2);
 await mode('git');await js('qa.setNarrow(true)');await delay(100);
 assert.equal(await js('(()=>{const trigger=document.querySelector("button[title=Environment]");const card=trigger.nextElementSibling;return Math.abs(card.getBoundingClientRect().right-trigger.getBoundingClientRect().right)<1&&card.getBoundingClientRect().left>=0})()'),true);
 await snap('git-narrow');
 await js('document.documentElement.removeAttribute("style");document.documentElement.classList.add("dark")');await delay(150);await snap('git-dark');
 await js('document.querySelector("#outside").dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))');assert.equal(await js('document.querySelector("button[title=Environment]").getAttribute("aria-expanded")'),'false');
 await click('Open environment panel');await js('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');assert.equal(await js('document.querySelector("button[title=Environment]").getAttribute("aria-expanded")'),'false');
 // Delayed replies from a previous directory must not appear in a new one.
 await js('qa.pending=[];window.electron.getGitOverview=cwd=>new Promise(resolve=>qa.pending.push({cwd,resolve}));qa.setProbe(true)');await delay(100);
 assert.equal(await js('qa.probe.overview.branch'),null);
 await js('qa.pending[0].resolve({...qa.overview,branch:"branch-a"})');await delay(100);assert.equal(await js('qa.probe.overview.branch'),'branch-a');
 await js('void qa.probe.refresh()');await delay(50);
 await js('qa.setProbeCwd("/repo/b")');await delay(100);assert.equal(await js('qa.probe.overview.branch'),null);
 await js('qa.pending[1].resolve({...qa.overview,branch:"stale-a"})');await delay(100);assert.equal(await js('qa.probe.overview.branch'),null);
 await js('qa.pending[2].resolve({...qa.overview,branch:"branch-b"})');await delay(100);assert.equal(await js('qa.probe.overview.branch'),'branch-b');
 // A delayed association response from another task must never flash here.
 await click('Open environment panel');
 await js('qa.pendingPr=[];window.electron.listSessionPullRequests=id=>new Promise(resolve=>qa.pendingPr.push({id,resolve}));qa.listeners.forEach(fn=>fn("fixture"))');await delay(50);
 await js('qa.setSessionId("second-task")');await delay(100);
 assert.doesNotMatch(await visible(),/PR #42/);
 await js('qa.pendingPr[0].resolve([{...qa.attached[0],number:999,lookupStatus:"found"}])');await delay(100);
 assert.doesNotMatch(await visible(),/PR #999/,'ignore delayed results from previous task');
 await js('qa.pendingPr[1].resolve([])');await delay(100);
 await js('qa.pendingPr[2].resolve([])');await delay(100);
 assert.deepEqual(errors,[]);
 console.log('environment-summary: initial and cached branch, detached HEAD, non-Git sections, stale replies, combined commit/push, publish, PR states and creation, sync, worktree menu, clipboard menu, portals, running guards, anchor, dismissal passed');app.exit(0);
 }catch(e){console.error(e);console.error(errors);console.error(await visible());await snap('failure');app.exit(1)}
});
`;
let server;
try {
 await writeFile(path.join(tmp,'index.html'),'<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
 await writeFile(path.join(tmp,'harness.tsx'),harness);
 await writeFile(path.join(tmp,'main.cjs'),main);
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0,strictPort:false}});await server.listen();
 const url=new URL(path.relative(root,tmp)+'/index.html',server.resolvedUrls.local[0]).href;
 await new Promise((resolve,reject)=>{
  const env={...process.env,QA_URL:url};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(tmp,'main.cjs')],{cwd:root,env,stdio:'inherit'});
  const timeout=setTimeout(()=>{child.kill();reject(new Error('Environment test timed out'));},60000);
  child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);code===0?resolve():reject(new Error('Electron exited '+code))});
 });
} finally {await server?.close();await rm(tmp,{recursive:true,force:true});}

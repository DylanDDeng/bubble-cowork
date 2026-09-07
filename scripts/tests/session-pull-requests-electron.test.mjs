import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = await mkdtemp(path.join(os.tmpdir(), 'aegis-pr-test-'));
const main = String.raw`
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const root=process.env.QA_ROOT;
app.setPath('userData',path.join(__dirname,'profile'));app.setAppPath(__dirname);
const sessions=require(path.join(root,'dist-electron/electron/libs/session-store.js'));
const service=require(path.join(root,'dist-electron/electron/libs/session-pull-requests.js'));
const lookup=require(path.join(root,'dist-electron/electron/libs/git-pull-requests.js'));
const repo=path.join(__dirname,'repo');fs.mkdirSync(repo);
const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
git('init','-b','feature/pr');git('-c','user.name=QA','-c','user.email=qa@example.invalid','commit','--allow-empty','-m','test');git('remote','add','origin','https://github.com/test/project.git');
const url='https://github.com/test/project/pull/42';
const fixture=path.join(__dirname,'fixture.json');process.env.QA_GH_FIXTURE=fixture;process.env.PATH=path.join(__dirname,'bin')+path.delimiter+process.env.PATH;
const setMode=(mode,extra={})=>fs.writeFileSync(fixture,JSON.stringify({mode,...extra}));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 try {
  sessions.initialize();
  const a=sessions.createSession({title:'PR test',cwd:repo,provider:'kimi'});
  const b=sessions.createSession({title:'Other task',cwd:repo,provider:'codex'});
  const input={sessionId:a.id,cwd:repo,repoRoot:fs.realpathSync(repo),headBranch:'feature/pr',url};
  const query={cwd:repo,branch:'feature/pr',originRepo:{owner:'test',repo:'project'}};
  setMode('none');assert.equal((await lookup.getGitPullRequestInfo(query)).status,'not_found');
  setMode('auth');assert.equal((await lookup.getGitPullRequestInfo(query)).status,'unknown');
  setMode('malformed');assert.equal((await lookup.getGitPullRequestInfo(query)).status,'unknown');
  setMode('found');assert.equal((await lookup.getGitPullRequestInfo(query)).pr.number,42);
  assert.equal((await lookup.getGitPullRequestInfo({...query,branch:'HEAD'})).status,'not_found');
  assert.equal((await lookup.getGitPullRequestInfo({...query,originRepo:null})).status,'not_found');
  await assert.rejects(service.attachTaskPullRequest({...input,sessionId:'missing'}),/no longer/);
  await assert.rejects(service.attachTaskPullRequest({...input,headBranch:'stale'}),/branch changed/);
  await assert.rejects(service.attachTaskPullRequest({...input,url:'https://github.com/other/repo/pull/42'}),/branch changed/);
  await assert.rejects(service.attachTaskPullRequest({...input,url:'file:///tmp/pull/42'}),/Invalid/);
  await assert.rejects(service.attachTaskPullRequest({...input,url:url.replace('/42','/99')}),/verify/);
  assert.deepEqual(await service.listTaskPullRequests(a.id),[]);
  const first=await service.attachTaskPullRequest(input);assert.equal(first.created,true);
  assert.equal((await service.attachTaskPullRequest(input)).created,false,'idempotent attachment');
  assert.deepEqual(await service.listTaskPullRequests(b.id),[],'task isolation');
  sessions.close();sessions.initialize();assert.equal((await service.listTaskPullRequests(a.id))[0].url,url,'SQLite persistence');
  git('checkout','-b','other');setMode('merged');
  assert.equal((await service.listTaskPullRequests(a.id,true))[0].state,'merged','refresh by URL survives branch change');
  setMode('auth');const failed=await service.listTaskPullRequests(a.id,true);assert.equal(failed.length,1);assert.equal(failed[0].lookupStatus,'unknown');
  setMode('none');assert.equal((await service.listTaskPullRequests(a.id,true))[0].lookupStatus,'not_found');
  service.detachTaskPullRequest(a.id,url,first.pr.attachedAt+1);assert.equal(sessions.listSessionPullRequests(a.id).length,1,'stale Undo cannot remove attachment');
  service.detachTaskPullRequest(a.id,url,first.pr.attachedAt);assert.equal(sessions.listSessionPullRequests(a.id).length,0);
  git('checkout','feature/pr');setMode('found',{delay:0.3});
  const pending=service.attachTaskPullRequest(input);await delay(130);git('checkout','other');await assert.rejects(pending,/branch changed/);
  assert.equal(sessions.listSessionPullRequests(a.id).length,0,'branch switch during lookup is rejected');
  git('checkout','feature/pr');setMode('found');await service.attachTaskPullRequest(input);
  git('checkout','other');setMode('found',{number:43});
  await service.attachTaskPullRequest({...input,headBranch:'other',url:url.replace('/42','/43')});
  assert.equal(sessions.listSessionPullRequests(a.id).length,2,'multiple associations survive checkout');
  const current=sessions.listSessionPullRequests(a.id);setMode('found',{delay:0.3});
  const refresh=service.listTaskPullRequests(a.id,true);await delay(100);
  for(const pr of current)service.detachTaskPullRequest(a.id,pr.url,pr.attachedAt);
  assert.equal((await refresh).length,0,'refresh does not resurrect removed attachments');
  // Real preload + trusted IPC + broadcast with a separate hidden renderer.
  require(path.join(root,'dist-electron/electron/ipc/session-pull-requests.js')).setupSessionPullRequestsIPC();
  ipcMain.on('get-ui-resume-state-sync',e=>{e.returnValue=null});ipcMain.on('renderer-state:get-all-sync',e=>{e.returnValue={}});
  const win=new BrowserWindow({show:false,webPreferences:{preload:path.join(root,'dist-electron/electron/preload.cjs')}});
  await win.loadFile(path.join(__dirname,'dist-react/index.html'));
  const js=code=>win.webContents.executeJavaScript(code,true);
  await js('window.changes=[];window.electron.onSessionPullRequestsChanged(id=>window.changes.push(id));true');
  setMode('found',{number:43});
  const attached=await js('window.electron.attachSessionPullRequest('+JSON.stringify({...input,headBranch:'other',url:url.replace('/42','/43')})+')');
  assert.equal(attached.created,true);assert.equal((await js('window.electron.listSessionPullRequests('+JSON.stringify(a.id)+')')).length,1);
  await js('window.electron.detachSessionPullRequest('+JSON.stringify(a.id)+','+JSON.stringify(attached.pr.url)+','+attached.pr.attachedAt+')');
  assert.deepEqual(await js('window.changes'),[a.id,a.id]);
  assert.equal((await js('window.electron.listSessionPullRequests('+JSON.stringify(a.id)+')')).length,0);
  await service.attachTaskPullRequest({...input,headBranch:'other',url:url.replace('/42','/43')});
  sessions.deleteSession(a.id);assert.equal(sessions.listSessionPullRequests(a.id).length,0,'task deletion cascades');
  sessions.close();win.destroy();console.log('session-pull-requests: command execution, error classification, validation, SQLite persistence, multiple PRs, race guards, preload/IPC/broadcast, deletion passed');app.exit(0);
 }catch(error){console.error(error);app.exit(1)}
});
`;
const gh = `#!/usr/bin/python3
import os, sys, json, time
args = sys.argv[1:]
if '--head' in args:
    print('unknown flag: --head', file=sys.stderr); sys.exit(1)
assert args[:2] == ['pr', 'view'] and args[2] and args[3:] == ['--repo', 'test/project', '--json', 'number,title,state,url'], args
f = json.load(open(os.environ['QA_GH_FIXTURE']))
time.sleep(f.get('delay', 0))
mode = f['mode']
if mode in ['none', 'auth']:
    print('no pull requests found for branch' if mode == 'none' else 'authentication required', file=sys.stderr); sys.exit(1)
if mode == 'malformed':
    print('{broken json'); sys.exit(0)
number = f.get('number', 42)
print(json.dumps(dict(number=number, title='Verified PR', state='MERGED' if mode == 'merged' else 'OPEN', url='https://github.com/test/project/pull/' + str(number))))
`;
try {
  await mkdir(path.join(tmp,'bin'));await mkdir(path.join(tmp,'dist-react'));await mkdir(path.join(tmp,'profile'));
  await writeFile(path.join(tmp,'bin/gh'),gh,{mode:0o755});
  await writeFile(path.join(tmp,'main.cjs'),main);await writeFile(path.join(tmp,'dist-react/index.html'),'<!doctype html><title>PR IPC test</title>');
  await new Promise((resolve,reject)=>{
    const env={...process.env,QA_ROOT:root};delete env.ELECTRON_RUN_AS_NODE;
    const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(tmp,'main.cjs')],{cwd:root,env,stdio:'inherit'});
    const timer=setTimeout(()=>{child.kill();reject(Error('PR test timed out'));},60000);
    child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('PR test failed: '+code))});
  });
} finally {await rm(tmp,{recursive:true,force:true});}

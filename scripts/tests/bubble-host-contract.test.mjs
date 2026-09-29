import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require=createRequire(import.meta.url);
const root=mkdtempSync(join(tmpdir(),'aegis-bubble-contract-'));
const oldHome=process.env.BUBBLE_HOME;
process.env.BUBBLE_HOME=join(root,'home');
const tick=()=>new Promise(r=>setImmediate(r));
try {
  const {BubbleSdk}=await import('@bubblebrain-ai/bubble');
  const {PermissionAwareApprovalController}=await import('@bubblebrain-ai/bubble/dist/approval/controller.js');
  const {SettingsManager}=await import('@bubblebrain-ai/bubble/dist/permissions/settings.js');
  const {readRepoSettings,isRepoConfigTrusted}=await import('@bubblebrain-ai/bubble/dist/permissions/trust.js');
  const loader=require('../../dist-electron/electron/libs/provider/bubble-sdk-loader.js');
  const instances=await Promise.all(Array.from({length:6},()=>loader.getBubbleSdk(root)));
  assert(instances.every(instance=>instance===instances[0]),'concurrent starts share one SDK and trust queue');
  const {BubbleSdkAdapter}=require('../../dist-electron/electron/libs/provider/bubble-sdk-adapter.js');
  const {registerDynamicModelMetadata}=await import('@bubblebrain-ai/bubble/dist/model-catalog.js');
  registerDynamicModelMetadata({providerId:'openai',id:'contract',contextWindow:128000});
  const cwd=join(root,'workspace');mkdirSync(join(cwd,'.bubble'),{recursive:true});mkdirSync(join(cwd,'.git'),{recursive:true});
  symlinkSync(join(cwd,'.git'),join(cwd,'linked-git'));
  const adapter=new BubbleSdkAdapter();const prompts=[];
  const session={threadId:'protected',cwd,status:'running',permissionMode:'default',pendingRequests:new Map()};
  adapter.sessions.set(session.threadId,session);
  adapter.events.on('event',e=>{
    if(e.type==='permission_request'){
      prompts.push(e);
      assert.equal(e.input.toolCall.protectedPath,true);
      void adapter.respondToRequest(session.threadId,e.requestId,{behavior:'deny'});
    }
  });
  const controller=new PermissionAwareApprovalController({cwd,getMode:()=>session.permissionMode,
    handlerRef:{current:r=>adapter.requestApproval(session,r)}});
  for(const relative of ['.git/config','.git/hooks/pre-commit','.bubble/settings.json','.claude/settings.local.json','linked-git/config']){
    for(const type of ['write','edit'])assert.equal((await controller.request({type,path:join(cwd,relative)})).action,'reject');
  }
  assert.equal((await controller.request({type:'patch',paths:[join(cwd,'.git/config')],files:[{kind:'update',path:join(cwd,'.git/config')}]})).action,'reject');
  assert.equal(prompts.length,11,'every protected request reaches the host UI');
  assert.equal((await controller.request({type:'write',path:join(cwd,'ordinary.txt')})).action,'approve');
  assert.equal(prompts.length,11,'ordinary workspace edits keep their existing policy');

  // Run the SDK's actual tool assembly and Agent loop in Plan mode. A host
  // reader is callable; an ordinary MCP tool is still rejected by the native gate.
  const sdk=new BubbleSdk({defaultCwd:cwd,mcp:false});let readCount=0,mcpCount=0,promptCount=0,step=0;
  sdk.registerHostTool({name:'read_session',readOnly:true,effect:'read',description:'read',parameters:{type:'object',properties:{}},execute:async()=>{readCount++;return {content:'read ok'}}});
  sdk.mcpToolsFor=async()=>[
    {name:'read_session',readOnly:true,effect:'read',description:'collision',parameters:{type:'object',properties:{}},execute:async()=>{throw Error('MCP shadowed host reader')}},
    {name:'external_read',readOnly:true,effect:'read',description:'external',parameters:{type:'object',properties:{}},execute:async()=>{mcpCount++;return {content:'external'}}},
  ];
  sdk.resolveProvider=()=>({providerId:'openai',model:'openai:contract',provider:{async *streamChat(){
    const name=step++===0?'read_session':step===2?'external_read':null;
    if(name)yield {type:'tool_call',id:'call-'+step,name,arguments:'{}',isStart:true,isEnd:true};
    else yield {type:'text',content:'done'};
    yield {type:'done'};
  }}});
  const collect=async iterator=>{const events=[];for await(const e of iterator)events.push(e);return events};
  const events=await collect(sdk.runTurn(sdk.createSession({cwd}).id,{prompt:'read',mode:'plan',onApproval:async()=>{promptCount++;return {action:'approve'}}}));
  assert.equal(readCount,1);assert.equal(mcpCount,0);assert.equal(promptCount,0);
  assert(events.some(e=>e.type==='tool_end'&&e.name==='external_read'&&e.result.isError));
  writeFileSync(join(cwd,'.bubble','settings.json'),JSON.stringify({permissions:{deny:['read_session']}}));
  step=0;
  await collect(sdk.runTurn(sdk.createSession({cwd}).id,{prompt:'read denied',mode:'plan'}));
  assert.equal(readCount,1,'explicit deny rules still block the native reader');
  const denied=new PermissionAwareApprovalController({cwd,getMode:()=> 'bypassPermissions',getRuleSet:()=>new SettingsManager(cwd).getMerged().ruleSet,handlerRef:{current:async()=>{throw Error('deny must not prompt')}}});
  assert.equal((await denied.request({type:'external_tool',title:'read_session',kind:'mcp',rawInput:{}})).action,'reject');

  const config=join(cwd,'.bubble','settings.json');
  const setRules=rules=>writeFileSync(config,JSON.stringify({permissions:{allow:rules}}));
  const trustSdk=new BubbleSdk({defaultCwd:cwd,mcp:false});
  const signal=new AbortController().signal;
  setRules(['Read']);let asked=0;
  await trustSdk.resolveProjectTrust(cwd,{onProjectTrust:async()=>{asked++;return false}},signal);
  await trustSdk.resolveProjectTrust(cwd,{onProjectTrust:async()=>{asked++;return true}},signal);
  assert.equal(asked,2);assert(isRepoConfigTrusted(cwd,readRepoSettings(cwd)));
  setRules(['Read','Bash(npm test)']);let shutDown=0;
  trustSdk.mcpManagersByCwd.set(cwd,Promise.resolve({shutdown:async()=>{shutDown++}}));
  trustSdk.mcpToolsByCwd.set(cwd,[{name:'stale'}]);
  await trustSdk.resolveProjectTrust(cwd,{onProjectTrust:async request=>{
    asked++;assert(request.pending.allow.includes('Bash(npm test)'));
    assert(!trustSdk.mcpToolsByCwd.has(cwd));return true;
  }},signal);
  assert.equal(shutDown,1);assert.equal(asked,3);assert(isRepoConfigTrusted(cwd,readRepoSettings(cwd)));

  // Abort one visible question, retry, then resolve the abandoned question late.
  setRules(['Read','Bash(npm build)']);let late;
  const abort=new AbortController();
  const stopped=trustSdk.resolveProjectTrust(cwd,{onProjectTrust:()=>new Promise(r=>{late=r})},abort.signal);
  await tick();abort.abort();await assert.rejects(stopped);
  await trustSdk.resolveProjectTrust(cwd,{onProjectTrust:async()=>false},signal);
  late(true);await tick();assert(!isRepoConfigTrusted(cwd,readRepoSettings(cwd)));

  // Queued cancellation must not let a third caller bypass the active prompt.
  let release,active=0,questions=0;
  const callback=()=>{questions++;active++;return new Promise(r=>{release=value=>{active--;r(value)}})};
  const first=trustSdk.resolveProjectTrust(cwd,{onProjectTrust:callback},signal);await tick();
  const queuedAbort=new AbortController();
  const second=trustSdk.resolveProjectTrust(cwd,{onProjectTrust:callback},queuedAbort.signal);
  queuedAbort.abort();await assert.rejects(second);
  const third=trustSdk.resolveProjectTrust(cwd,{onProjectTrust:callback},signal);await tick();
  assert.equal(questions,1);assert.equal(active,1);
  release(true);await Promise.all([first,third]);assert.equal(questions,1);

  // Mutating the file while a question is open never trusts unseen contents.
  setRules(['Read','Bash(npm install)']);
  await trustSdk.resolveProjectTrust(cwd,{onProjectTrust:async()=>{setRules(['Read','Bash(npm publish)']);return true}},signal);
  assert(!isRepoConfigTrusted(cwd,readRepoSettings(cwd)));
  await trustSdk.resolveProjectTrust(cwd,{onProjectTrust:async request=>{assert(request.pending.allow.includes('Bash(npm publish)'));return true}},signal);
  assert(isRepoConfigTrusted(cwd,readRepoSettings(cwd)));
  // Removing all capabilities and noninteractive turns also invalidate caches.
  trustSdk.mcpManagersByCwd.set(cwd,Promise.resolve({shutdown:async()=>{shutDown++}}));
  trustSdk.mcpToolsByCwd.set(cwd,[{name:'removed-server-tool'}]);
  setRules([]);
  await trustSdk.resolveProjectTrust(cwd,{},signal);
  assert.equal(shutDown,2);assert(!trustSdk.mcpToolsByCwd.has(cwd));
  setRules(['Bash(npm test)']);
  await trustSdk.resolveProjectTrust(cwd,{},signal);
  assert(!isRepoConfigTrusted(cwd,readRepoSettings(cwd)));
  await trustSdk.resolveProjectTrust(cwd,{onProjectTrust:async()=>true},signal);
  assert(isRepoConfigTrusted(cwd,readRepoSettings(cwd)),'one-shot did not consume the interactive prompt');
  console.log('Bubble host contract: protected paths/symlinks, Plan reader, MCP/deny isolation, trust retry/change/abort/concurrency passed');
} finally {
  if(oldHome===undefined)delete process.env.BUBBLE_HOME;else process.env.BUBBLE_HOME=oldHome;
  rmSync(root,{recursive:true,force:true});
}

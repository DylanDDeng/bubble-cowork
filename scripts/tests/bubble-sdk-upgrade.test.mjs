import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require=createRequire(import.meta.url);
const home=mkdtempSync(join(tmpdir(),'aegis-bubble-upgrade-'));
const previousHome=process.env.BUBBLE_HOME;
process.env.BUBBLE_HOME=home;
const loader=require('../../dist-electron/electron/libs/provider/bubble-sdk-loader.js');
const originalSdk=loader.getBubbleSdk;
try {
  const {BubbleSdk,SessionManager}=await import('@bubblebrain-ai/bubble');
  const {registerDynamicModelMetadata}=await import('@bubblebrain-ai/bubble/dist/model-catalog.js');
  const {readRepoSettings,isRepoConfigTrusted}=await import('@bubblebrain-ai/bubble/dist/permissions/trust.js');
  const {BubbleSdkAdapter}=require('../../dist-electron/electron/libs/provider/bubble-sdk-adapter.js');
  const {emptyCostDetails}=require('../../dist-electron/electron/libs/agent-cost.js');
  registerDynamicModelMetadata({providerId:'openai',id:'aegis-upgrade-test',contextWindow:128000});
  function fixture(name,{trust='allow',plan=false,stop=false}={}) {
    const cwd=join(home,name);mkdirSync(join(cwd,'.bubble'),{recursive:true});
    writeFileSync(join(cwd,'.bubble','settings.json'),JSON.stringify({permissions:{allow:['Bash(echo fixture)']}}));
    const sdk=new BubbleSdk({defaultCwd:cwd,mcp:false});
    const adapter=new BubbleSdkAdapter();const events=[];
    const session={threadId:name,providerSessionId:sdk.createSession({cwd}).id,cwd,status:'running',turnActive:true,
      permissionMode:plan?'plan':'default',planExitMode:plan?'bypassPermissions':'default',
      usage:{input_tokens:0,output_tokens:0,total_tokens:0},costDetails:emptyCostDetails(),durationStartMs:Date.now(),
      pendingRequests:new Map(),subagentStreams:new Map(),subagentStartedAt:new Map(),toolNames:new Map(),
      heldSpawnResults:new Map(),emittedToolCallIds:new Set(),emittedToolResultIds:new Set(),currentAssistant:null};
    adapter.sessions.set(name,session);
    adapter.events.on('event',event=>{
      events.push(event);
      if(event.type!=='permission_request')return;
      if(event.toolName==='ProjectTrust'){
        assert.match(event.input.question,/Bash\(echo fixture\)/);
        assert(event.input.question.includes(cwd));
        if(stop){adapter.disposeSession(name);return}
        void adapter.respondToRequest(name,event.requestId,{behavior:trust});
      }else if(event.toolName==='ExitPlanMode'){
        void adapter.respondToRequest(name,event.requestId,{behavior:'allow',updatedInput:{answers:{plan:'Approve and execute'}}});
      }else{
        assert.equal(event.toolName,'fixture_mcp');
        void adapter.respondToRequest(name,event.requestId,{behavior:'allow'});
      }
    });
    let steps=0,executions=0;
    sdk.mcpToolsFor=async()=>[{name:'fixture_mcp',description:'fixture',parameters:{type:'object',properties:{}},execute:async()=>{executions++;return {content:'ok'}}}];
    sdk.resolveProvider=()=>({providerId:'openai',model:'aegis-upgrade-test',provider:{async *streamChat(){
      if(steps++===0){yield {type:'tool_call',id:'tool-1',name:plan?'exit_plan_mode':'fixture_mcp',arguments:JSON.stringify(plan?{plan:'Implement fixture'}:{}),isStart:true,isEnd:true}}
      else yield {type:'text',content:'Completed fixture'};
      yield {type:'usage',usage:{promptTokens:100,completionTokens:10,totalTokens:110}};
      yield {type:'done'};
    }}});
    loader.getBubbleSdk=async()=>sdk;
    return {sdk,adapter,session,events,cwd,executions:()=>executions};
  }
  for(const trust of ['deny','allow']){
    const f=fixture('trust-'+trust,{trust});
    await f.adapter.runTurnLoop(f.session,'test');
    assert.equal(f.session.status,'completed',JSON.stringify(f.events.filter(e=>e.type==='error')));
    assert.equal(isRepoConfigTrusted(f.cwd,readRepoSettings(f.cwd)),trust==='allow');
    assert.equal(f.executions(),1,'native MCP gate reaches host approval and executes once');
    assert.equal(f.events.filter(e=>e.type==='permission_request'&&e.toolName==='ProjectTrust').length,1);
    const messages=f.events.filter(e=>e.type==='message').map(e=>e.message);
    assert.equal(messages.filter(m=>m.subtype==='token_usage').at(-1).usage.totalTokens,110);
    assert.equal(messages.at(-1).usage.total_tokens,220,'billing still sums both model steps');
    assert.equal(messages.at(-1).usage.input_tokens,200);
    // New checkpoint-aware persistence must remain visible to the adapter's rewind API.
    const manager=new SessionManager(f.sdk.listSessions().find(s=>s.name===f.session.providerSessionId).file);
    assert.equal(manager.listUserTurns().length,1);
    const anchors=await f.adapter.listRewindAnchors(f.session.threadId);
    assert.equal(anchors[0].id,manager.listUserTurns()[0].id);
    for(let i=0;i<10;i++){
      manager.appendMessage({role:'user',content:'Historic request '+i});
      manager.appendMessage({role:'assistant',content:'Historic response '.repeat(1000)});
    }
    const {estimateContextTokens}=await import('@bubblebrain-ai/bubble/dist/context/budget.js');
    const beforeEstimate=estimateContextTokens(manager.getMessages(),'openai');
    f.session.contextTokens=beforeEstimate+100; // model reports 100 tokens of system/tool overhead
    const messageOffset=f.events.length;
    await f.adapter.runCompact(f.session,f.session.contextTokens);
    const afterEstimate=estimateContextTokens(manager.getMessages(),'openai');
    const snapshot=f.events.slice(messageOffset).find(e=>e.type==='message'&&e.message.subtype==='token_usage');
    assert.equal(snapshot.message.usage.totalTokens,afterEstimate+100);
    assert.equal(snapshot.message.usage.estimated,true);
    assert(f.session.contextTokens<beforeEstimate+100);
    assert(f.events.some(e=>e.type==='message'&&e.message.subtype==='compact_boundary'&&e.message.compactMetadata.trigger==='manual'));
    assert(manager.getMessages().length<23,'manual compact reads the new checkpoint projection');
    const rewind=await f.adapter.rewind(f.session.threadId,anchors[0].id,'conversation');
    assert.equal(rewind.ok,true);
    assert.equal(rewind.removedPrompt,'test');
    assert.equal(manager.listUserTurns().length,0,'rewind refreshes checkpoint-aware history');
  }
  // A restored session can compact before onStart/context_usage ever runs.
  const cold=fixture('cold-compact');
  cold.sdk.getModelConfig=()=>({defaultProviderId:'openai',defaultModel:'openai:cold-contract',providers:[{id:'openai',hasApiKey:true}]});
  cold.sdk.registry.getEnabled=()=>[{id:'openai'}];
  cold.sdk.registry.listModels=async()=>[{id:'cold-contract',contextWindow:64000}];
  const coldFile=join(home,'cold-history.jsonl');
  const coldManager=new SessionManager(coldFile);
  for(let i=0;i<10;i++){
    coldManager.appendMessage({role:'user',content:'Cold request '+i});
    coldManager.appendMessage({role:'assistant',content:'Cold response '.repeat(1000)});
  }
  cold.sdk.listSessions=()=>[{name:cold.session.providerSessionId,file:coldFile}];
  cold.adapter.disposeSession(cold.session.threadId);
  await cold.adapter.startSession({provider:'bubble',threadId:cold.session.threadId,cwd:cold.cwd,
    resumeSessionId:cold.session.providerSessionId,prompt:'/compact',model:'openai:cold-contract'});
  const coldUsage=cold.events.find(e=>e.type==='message'&&e.message.subtype==='token_usage')?.message.usage;
  assert(coldUsage?.totalTokens>0,'cold compact emits a usable snapshot');
  assert.equal(coldUsage.contextWindow,64000);
  assert.equal(coldUsage.estimated,true);
  assert(cold.events.some(e=>e.type==='message'&&e.message.subtype==='compact_boundary'&&e.message.compactMetadata.preTokens>0));

  // Stop while async initialization is pending must not write a checkpoint.
  const cancelled=fixture('compact-cancelled');
  const originalManager=loader.getBubbleSessionManager;
  let release;
  let compactCalls=0;
  loader.getBubbleSessionManager=()=>new Promise(resolve=>{release=()=>resolve({getMessages:()=>[],getCompactionPlan:()=>({}),compact:()=>{compactCalls++;return {compacted:true}}})});
  try {
    const pending=cancelled.adapter.runCompact(cancelled.session,100);
    await new Promise(r=>setImmediate(r));
    // stopSession sets status before its own awaited SDK teardown.
    cancelled.session.status='stopped';
    release();await pending;
    assert.equal(compactCalls,0);
    assert(!cancelled.events.some(e=>e.type==='message'));
  } finally {loader.getBubbleSessionManager=originalManager}
  const plan=fixture('plan',{plan:true});
  // Exercise the public cold-start entry: do not seed planExitMode in a fake session.
  plan.adapter.disposeSession(plan.session.threadId);
  plan.sdk.getModelConfig=()=>({providers:[{id:'openai',hasApiKey:true}]});
  await plan.adapter.startSession({provider:'bubble',threadId:plan.session.threadId,cwd:plan.cwd,
    prompt:'test plan',bubblePermissionMode:'plan',bubblePlanExitMode:'bypassPermissions'});
  for(let i=0;i<100 && !plan.events.some(e=>e.type==='status_change'&&e.status==='completed');i++) await new Promise(r=>setTimeout(r,10));
  assert.equal(plan.adapter.sessions.get(plan.session.threadId).permissionMode,'bypassPermissions');
  assert(plan.events.some(e=>e.type==='permission_mode_changed'&&e.mode==='bypassPermissions'));
  const stopped=fixture('stopped',{stop:true});
  await stopped.adapter.runTurnLoop(stopped.session,'stop at trust prompt');
  assert.equal(stopped.session.pendingRequests.size,0);
  assert.equal(stopped.executions(),0);
  assert.equal(isRepoConfigTrusted(stopped.cwd,readRepoSettings(stopped.cwd)),false);
  assert(stopped.events.some(e=>e.type==='permission_dismissed'));
  console.log('Bubble SDK upgrade: real turns, trust allow/deny/stop, MCP approval, plan exit, context/billing and rewind anchors passed');
} finally {
  loader.getBubbleSdk=originalSdk;
  if(previousHome===undefined)delete process.env.BUBBLE_HOME;else process.env.BUBBLE_HOME=previousHome;
  rmSync(home,{recursive:true,force:true});
}

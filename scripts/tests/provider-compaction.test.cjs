const assert = require('node:assert/strict');
const base = '../../dist-electron/electron/libs/provider/';
const { emptyCostDetails } = require('../../dist-electron/electron/libs/agent-cost.js');
function fixture(module, name) {
  const adapter = new (require(base + module + '-adapter.js')[name])();
  const events = [];
  adapter.events.on('event', e => events.push(e));
  const session = { threadId: 'trace', providerSessionId: 'native', status: 'running',
    usage: {}, costDetails: emptyCostDetails(), session: {}, durationStartMs: Date.now(),
    currentAssistant: null, lastContext: {}, pendingPromptIds: new Set(),
    messageRoles: new Map(), pendingPartUpdates: new Map(),
    subagentStreams: new Map(), heldSpawnResults: new Map(), pendingRequests: new Map(),
  };
  adapter.sessions.set(session.threadId, session);
  const messages = () => events.filter(e => e.type === 'message').map(e => e.message);
  const compact = () => messages().filter(m => m.subtype?.startsWith('compact_'));
  return { adapter, session, events, messages, compact };
}
function pair(f, trigger='auto') {
  const [start,end] = f.compact();
  assert.equal(f.compact().length, 2);
  assert.equal(start.status, 'started');
  assert.equal(end.subtype, 'compact_boundary');
  assert.equal(start.compactionId, end.compactionId);
  assert.equal(end.compactMetadata.trigger, trigger);
}
async function main() {
  const {CompactionTracker}=require(base+'compaction-tracker.js');
  const rows=[];
  const tracker=new CompactionTracker(event=>rows.push(event.message));
  const tracked={threadId:'tracker-review'};
  tracker.start(tracked,{id:'A',trigger:'manual',preTokens:100});
  tracker.interrupt(tracked,'A');
  tracker.start(tracked,{id:'B',trigger:'auto',preTokens:200});
  tracker.complete(tracked,{id:'A'});
  assert.equal(rows.at(-1).compactionId,'A','late completion updates only A');
  assert.equal(rows.at(-1).compactMetadata.trigger,'manual','interrupted attempt retains its metadata');
  tracker.complete(tracked,{id:'B'});
  assert.equal(rows.at(-1).compactionId,'B','B still receives its own completion');
  assert.equal(rows.at(-1).compactMetadata.preTokens,200);
  assert.equal(rows.filter(m=>m.subtype==='compact_boundary').length,2);
  tracker.complete(tracked,{id:'B'});
  assert.equal(rows.filter(m=>m.subtype==='compact_boundary').length,2,'late replay dedupes per actual ID');
  tracker.start(tracked,{id:'C'});
  tracker.complete(tracked,{id:'unmatched'});
  tracker.interrupt(tracked,'C');
  assert.equal(rows.at(-1).compactionId,'C','unknown completion does not clear the active native ID');
  assert.equal(rows.at(-1).status,'interrupted');
  tracker.start(tracked,{});
  const local=rows.at(-1).compactionId;
  tracker.complete(tracked,{id:'qoder-boundary'});
  assert.equal(rows.at(-1).compactionId,local,'a start without a native ID still correlates to Qoder completion');

  const q = fixture('qoder-sdk','QoderSdkAdapter');
  q.adapter.handleSystemMessage(q.session,{subtype:'status',status:'compacting'});
  q.adapter.handleSystemMessage(q.session,{subtype:'status',status:'compacting'});
  for(let i=0;i<2;i++) q.adapter.handleSystemMessage(q.session,{subtype:'compact_boundary',uuid:'q1',compact_metadata:{trigger:'manual',pre_tokens:123}});
  pair(q,'manual');assert.equal(q.messages().some(m=>m.type==='assistant'),false);
  q.adapter.handleSystemMessage(q.session,{subtype:'status',status:'compacting'});
  q.adapter.emit({type:'status_change',threadId:'trace',status:'stopped'});
  assert.equal(q.compact().at(-1).status,'interrupted');

  const k = fixture('kimi-server','KimiServerAdapter');
  k.session.generation = k.adapter.manager.getGeneration();
  k.adapter.manager.compactSession = async()=>k.adapter.handleHistoryCompacted(k.session,{});
  await k.adapter.sendTurn({threadId:'trace',prompt:'/compact'});
  pair(k,'manual');assert.equal(k.messages().filter(m=>m.type==='result').length,1);
  const kFail = fixture('kimi-server','KimiServerAdapter');
  // Test the same failure path without a network request.
  kFail.adapter.compactions.start(kFail.session,{trigger:'manual'});
  kFail.adapter.emit({type:'error',threadId:'trace',error:new Error('failed')});
  assert.equal(kFail.compact().at(-1).status,'interrupted');

  const pi = fixture('pi-sdk','PiSdkAdapter');
  pi.adapter.handlePiEvent(pi.session,{type:'agent_end',messages:[],willRetry:false});
  assert.equal(pi.messages().filter(m=>m.type==='result').length,0,'Pi must stay running during post-agent compaction');
  pi.adapter.handlePiEvent(pi.session,{type:'compaction_start',reason:'threshold'});
  pi.adapter.handlePiEvent(pi.session,{type:'compaction_end',reason:'threshold',result:{tokensBefore:123},aborted:false});
  pair(pi);
  pi.adapter.handlePiEvent(pi.session,{type:'agent_settled'});
  assert.equal(pi.messages().filter(m=>m.type==='result').length,1);
  pi.adapter.handlePiEvent(pi.session,{type:'agent_settled'});
  assert.equal(pi.messages().filter(m=>m.type==='result').length,1,'settlement is idempotent');
  const piManual = fixture('pi-sdk','PiSdkAdapter');
  piManual.session.ingestedUsageKeys = new Set();
  piManual.session.session.compact = async()=>{
    piManual.adapter.handlePiEvent(piManual.session,{type:'compaction_start',reason:'manual'});
    piManual.adapter.handlePiEvent(piManual.session,{type:'compaction_end',reason:'manual',result:{},aborted:false});
    return {};
  };
  await piManual.adapter.sendTurn({threadId:'trace',prompt:'/compact'});
  pair(piManual,'manual');
  piManual.adapter.handlePiEvent(piManual.session,{type:'compaction_start',reason:'overflow'});
  piManual.adapter.handlePiEvent(piManual.session,{type:'compaction_end',aborted:true});
  assert.equal(piManual.compact().at(-1).status,'interrupted');

  // OpenCode 2.x reports compaction as session.compaction.{started,ended,failed}.
  const ocFixture = () => {
    const f = fixture('opencode-sdk','OpenCodeSdkAdapter');
    f.send = (type, data = {}) => f.adapter.handleServerEvent(f.session, { type: 'session.compaction.' + type, data: { sessionID: 'native', ...data } });
    return f;
  };
  const oc = ocFixture();
  oc.send('started', { reason: 'manual' });
  oc.send('started', { reason: 'manual' });
  oc.send('ended', { reason: 'manual' });
  pair(oc,'manual');
  const ocAuto = ocFixture();
  ocAuto.send('started', { reason: 'auto' });
  ocAuto.send('ended', { reason: 'auto' });
  pair(ocAuto);
  const ocFailed = ocFixture();
  ocFailed.send('started', { reason: 'auto' });
  ocFailed.send('failed', { reason: 'auto', error: { type: 'x', message: 'boom' } });
  assert.equal(ocFailed.compact().at(-1).status,'interrupted','a failed compaction ends as interrupted');

  const ds = fixture('deepseek-sdk','DeepseekSdkAdapter');
  const dispatch=(type,data,parent=null)=>ds.adapter.dispatchSessionEvent(ds.session,'native',{params:{event:{type,data,time:1000}}},parent);
  dispatch('compaction/start',{compactionId:'child',turn:1},'child-tool');
  assert.equal(ds.compact().length,0,'child compaction is not shown as root compaction');
  dispatch('compaction/start',{compactionId:'d1',turn:1});
  dispatch('compaction/end',{compactionId:'d1',turn:1});
  dispatch('compaction/end',{compactionId:'d1',turn:1});
  pair(ds);
  dispatch('compaction/start',{compactionId:'d2',turn:null});
  dispatch('compaction/end',{compactionId:'d2',turn:null,error:'aborted'});
  assert.equal(ds.compact().at(-1).status,'interrupted');

  const nativeBubble=fixture('bubble-sdk','BubbleSdkAdapter');
  nativeBubble.adapter.handleBubbleEvent(nativeBubble.session,{type:'context_compaction',status:'started',preTokens:900});
  nativeBubble.adapter.handleBubbleEvent(nativeBubble.session,{type:'context_compaction',status:'completed',compactionId:'sdk-checkpoint',preTokens:900,postTokens:200,contextWindow:1000});
  pair(nativeBubble);
  assert.equal(nativeBubble.compact()[1].compactMetadata.preTokens,900);
  assert.equal(nativeBubble.session.contextTokens,200);
  assert.equal(nativeBubble.messages().at(-1).usage.totalTokens,200);
  nativeBubble.adapter.handleBubbleEvent(nativeBubble.session,{type:'context_compaction',status:'started',preTokens:950});
  nativeBubble.adapter.handleBubbleEvent(nativeBubble.session,{type:'context_compaction',status:'failed',preTokens:950});
  assert.equal(nativeBubble.compact().at(-1).status,'interrupted');
  const b = fixture('bubble-sdk','BubbleSdkAdapter');
  b.adapter.handleBubbleEvent(b.session,{type:'context_compaction',status:'completed',compactionId:'native:subturn:1',path:'subturn'});
  b.adapter.handleBubbleEvent(b.session,{type:'context_compaction',status:'completed',compactionId:'native:subturn:1',path:'subturn'});
  b.adapter.handleBubbleEvent(b.session,{type:'context_recovered',reason:'overflow',droppedMessages:3});
  assert.equal(b.compact().length,1,'only the normalized event creates a row; replay/native recovery cannot duplicate it');
  assert.equal(b.compact()[0].compactMetadata.trigger,'auto');
  const loader = require(base+'bubble-sdk-loader.js');
  const originalGetSdk = loader.getBubbleSdk;
  const originalGetManager = loader.getBubbleSessionManager;
  const live = fixture('bubble-sdk','BubbleSdkAdapter');
  loader.getBubbleSdk = async()=>({
    getModelConfig:()=>({defaultProviderId:'',defaultModel:'',providers:[]}),
    async *runTurn() {
      yield {type:'turn_start'};
      yield {type:'context_compaction',status:'completed',compactionId:'native:subturn:2',path:'subturn'};
      yield {type:'text_delta',content:'After compaction'};
      yield {type:'turn_end',willContinue:false};
    },
  });
  try {
    await live.adapter.runTurnLoop(live.session,'test');
    assert.equal(live.compact().length,1,'memory compaction works without a session file');
    assert(live.messages().indexOf(live.compact()[0]) < live.messages().findIndex(m=>m.type==='stream_event'),'compaction precedes subsequent output');
    loader.getBubbleSessionManager = async()=>({getMessages:()=>[],getCompactionPlan:()=>null});
    const noop=fixture('bubble-sdk','BubbleSdkAdapter');
    await noop.adapter.runCompact(noop.session,100);
    assert.equal(noop.messages().at(-1).subtype,'success');
    assert.equal(noop.compact().length,0,'no-op is not a completed or interrupted compaction');
    loader.getBubbleSessionManager = async()=>({getMessages:()=>[],getCompactionPlan:()=>({}),compact:()=>({compacted:true})});
    const manual=fixture('bubble-sdk','BubbleSdkAdapter');
    await manual.adapter.runCompact(manual.session,100);
    assert.equal(manual.compact()[0].compactMetadata.trigger,'manual');
  } finally {
    loader.getBubbleSdk = originalGetSdk;
    loader.getBubbleSessionManager = originalGetManager;
  }

  // Disk signals can advance without a start event; hydration is only a baseline.
  const signalsModule=require('../../dist-electron/electron/libs/grok-session-files.js');
  const original=signalsModule.readGrokSessionSignals;
  let count=4, readable=true;
  signalsModule.readGrokSessionSignals=()=>readable ? {compactionCount:count,contextTokensUsed:100,contextWindowTokens:1000} : null;
  try {
    const g=fixture('grok-acp','GrokAcpAdapter');
    g.adapter.hydrateContextFromDisk(g.session);
    g.adapter.emitGrokTokenUsage(g.session,{});
    assert.equal(g.compact().length,0,'resume must not replay old compactions');
    count++;
    g.adapter.emitGrokTokenUsage(g.session,{});
    g.adapter.emitGrokTokenUsage(g.session,{});
    assert.equal(g.compact().length,1,'one boundary per observed count increase');
    const restored=fixture('grok-acp','GrokAcpAdapter');
    readable=false;
    restored.adapter.hydrateContextFromDisk(restored.session);
    restored.adapter.emitGrokTokenUsage(restored.session,{});
    readable=true;
    restored.adapter.emitGrokTokenUsage(restored.session,{});
    assert.equal(restored.compact().length,0,'first readable sample establishes an unknown resume baseline');
    count++;
    restored.adapter.emitGrokTokenUsage(restored.session,{});
    assert.equal(restored.compact().length,1,'later count increase is a new compaction');
    const fresh=fixture('grok-acp','GrokAcpAdapter');
    readable=false;
    fresh.adapter.hydrateContextFromDisk(fresh.session,true);
    readable=true;count=1;
    fresh.adapter.emitGrokTokenUsage(fresh.session,{});
    assert.equal(fresh.compact().length,1,'known-new session still reports its first compaction');

  } finally {signalsModule.readGrokSessionSignals=original;}
  console.log('provider compaction: Qoder, Kimi, Pi, OpenCode, DeepSeek, Bubble and Grok lifecycles passed');
}
main().catch(error=>{console.error(error);process.exitCode=1});

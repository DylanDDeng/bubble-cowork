import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const home=mkdtempSync(join(tmpdir(),'aegis-bubble-compaction-'));
const previousHome=process.env.BUBBLE_HOME;
process.env.BUBBLE_HOME=home;
try {
  const {Agent}=await import('@bubblebrain-ai/bubble');
  const {registerDynamicModelMetadata}=await import('@bubblebrain-ai/bubble/dist/model-catalog.js');
  const collect=async iterator=>{const events=[];for await(const event of iterator)events.push(event);return events};
  registerDynamicModelMetadata({providerId:'openai',id:'aegis-compaction-test',contextWindow:4096});
  const history=()=>[{role:'system',content:'test'},{role:'user',content:'Inspect the repository'},
    ...Array.from({length:12},(_,i)=>[
      {role:'assistant',content:'Read '+i,toolCalls:[{id:'read-'+i,name:'read',arguments:JSON.stringify({file_path:'file-'+i})}]},
      {role:'tool',toolCallId:'read-'+i,content:('line '+i+' source text\n').repeat(2000)},
    ]).flat()];
  const options={provider:{async complete(){throw new Error('offline summary fixture')}},providerId:'openai',model:'aegis-compaction-test',tools:[]};
  const native=new Agent(options);
  native.messages=history();
  const memoryUsage=process.memoryUsage;
  try {
    process.memoryUsage=()=>({...memoryUsage(),heapUsed:8*1024**3});
    native.maybeCompactResidentHistory();
  } finally { process.memoryUsage=memoryUsage; }
  assert.equal(native.getCompactionStats().subturn,1);
  const [memoryEvent]=native.contextEvents;
  assert.equal(memoryEvent.type,'context_compaction');
  assert.equal(memoryEvent.status,'completed');
  assert.equal(memoryEvent.persisted,false);
  assert(memoryEvent.compactionId);
  assert(memoryEvent.postTokens<memoryEvent.preTokens);

  let checkpoint;
  const durable=new Agent({...options,onContextCheckpoint:c=>{checkpoint=c}});
  durable.messages=history();
  const events=await collect(durable.maybeCompactWithLLM());
  assert.deepEqual(events.map(e=>e.status),['started','completed'],'offline summarizer falls back to native compaction');
  assert.equal(events[0].compactionId,undefined,'native start intentionally has no ID');
  assert.equal(events[1].compactionId,checkpoint.compactionId);
  assert.equal(events[1].persisted,true);
  assert(events[1].postTokens<events[0].preTokens);

  const rejected=new Agent({...options,onContextCheckpoint(){throw new Error('stale revision')}});
  rejected.messages=history();
  const original=structuredClone(rejected.messages), failed=[];
  await assert.rejects(async()=>{for await(const event of rejected.maybeCompactWithLLM())failed.push(event)},/stale revision/);
  assert.deepEqual(failed.map(e=>e.status),['started','failed']);
  assert.deepEqual(rejected.messages,original,'failed persistence must not compact live memory');
  const noop=new Agent(options);noop.messages=[{role:'user',content:'hello'}];
  assert.deepEqual(await collect(noop.maybeCompactWithLLM()),[]);
  console.log('Bubble native compaction: resident/subturn, durable fallback, failed persistence, IDs and no-op passed');
} finally {
  if(previousHome===undefined)delete process.env.BUBBLE_HOME;else process.env.BUBBLE_HOME=previousHome;
  rmSync(home,{recursive:true,force:true});
}

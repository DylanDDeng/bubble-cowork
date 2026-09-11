const {app,BrowserWindow,ipcMain,dialog}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=process.env.QA_ROOT,temp=process.env.QA_TEMP;
app.setPath('userData',path.join(temp,'profile'));fs.mkdirSync(app.getPath('userData'),{recursive:true});
process.env.AEGIS_DSH_PROFILE_DIR=path.join(root,'dev-fixtures/deepseek-harness');
process.env.AEGIS_DSH_ATTACHMENT_HOME=path.join(temp,'image-store');
const {setupAttachmentIPC}=require(path.join(root,'dist-electron/electron/ipc/attachments.js'));
const {ATTACHMENT_MIME_TYPES}=require(path.join(root,'dist-electron/shared/attachment-policy.js'));
const {DeepseekSdkAdapter}=require(path.join(root,'dist-electron/electron/libs/provider/deepseek-sdk-adapter.js'));
const {getDeepseekModelConfig}=require(path.join(root,'dist-electron/electron/libs/deepseek-cli.js'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1060,height:800,show:true,webPreferences:{backgroundThrottling:false,preload:path.join(root,'dist-electron/electron/preload.cjs')}});
 const js=code=>win.webContents.executeJavaScript(code,true);
 const until=async(code,label)=>{for(let i=0;i<220;i++){if(await js(code))return;await delay(60);}throw new Error('Timed out: '+label+'\n'+await js('document.body.innerText'));};
 const capture=async(name)=>{await delay(180);const dir=process.env.QA_CAPTURE||path.join(root,'output/deepseek-images-ui');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,name+'.png'),(await win.webContents.capturePage()).toPNG());};
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error'){errors.push(e.message);console.error('Renderer:',e.message);}});
 setupAttachmentIPC(win);
 for(const [channel,value] of [['get-ui-resume-state-sync',null],['renderer-state:get-all-sync',{}],['save-ui-resume-state-sync',true]])ipcMain.on(channel,e=>{e.returnValue=value;});
 for(const provider of ['claude','codex','kimi','grok','opencode','pi','bubble','qoder','deepseek'])ipcMain.handle('get-'+provider+'-model-config',()=>provider==='deepseek'?getDeepseekModelConfig():({defaultModel:null,options:[],availableModels:[]}));
 for(const [channel,value] of [['get-git-branches',{branches:[],currentBranch:null}],['get-agent-runtime-directory',null],['codex-list-plugins',{plugins:[]}],['get-project-tree',[]],['set-theme',null],['get-claude-compatible-provider-config',{}],['get-recent-cwds',[]],['get-session-user-prompts',[]],['codex-list-skills',{skills:[]}],['deepseek-list-skills',{skills:[]}],['get-bubble-providers-config',{providers:[]}],['get-provider-composer-capabilities',{}]])ipcMain.handle(channel,()=>value);
 ipcMain.handle('read-attachment-preview',(_e,p)=>{const mime=ATTACHMENT_MIME_TYPES[path.extname(p)];return mime?.startsWith('image/')?'data:'+mime+';base64,'+fs.readFileSync(p).toString('base64'):null;});
 let picked=[path.join(temp,'sample.webp')],filters;
 dialog.showOpenDialog=async(_win,options)=>{filters=options.filters;return {canceled:false,filePaths:picked};};
 const requests=[],uploads=new Map();let callImage=true,usagePromptTokens=1200;
 const api=http.createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',async()=>{
  if(req.url.startsWith('/files')){res.setHeader('content-type','application/json');if(req.method==='POST'){
   const form=await new Response(Buffer.concat(chunks),{headers:{'content-type':req.headers['content-type']}}).formData(),file=form.get('file');const now=Math.floor(Date.now()/1000);
   const record={id:'file-'+uploads.size,object:'file',bytes:file.size,filename:file.name,purpose:'user_data',created_at:now,expires_at:now+86400};uploads.set(record.id,record);res.end(JSON.stringify(record));
  }else res.end(JSON.stringify(uploads.get(req.url.split('/').pop())));return;}
  const body=JSON.parse(Buffer.concat(chunks).toString());requests.push(body);
  const delta=callImage?{role:'assistant',tool_calls:[{index:0,id:'read-image',type:'function',function:{name:'read_image',arguments:JSON.stringify({file_path:path.join(temp,'sample.png')})}}]}:{role:'assistant',content:'The image contains a blue rectangle.'};
  const finish=callImage?'tool_calls':'stop';callImage=false;
  const chunk=(delta,finish_reason=null)=>({id:'ui-image',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta,finish_reason}]});
  res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify(chunk(delta))+'\n\n');res.write('data: '+JSON.stringify({...chunk({},finish),usage:{prompt_tokens:usagePromptTokens,prompt_cache_hit_tokens:200,completion_tokens:80,total_tokens:usagePromptTokens+80,completion_tokens_details:{reasoning_tokens:20}}})+'\n\n');res.end('data: [DONE]\n\n');
 });});await new Promise(r=>api.listen(0,'127.0.0.1',r));
 const adapter=new DeepseekSdkAdapter();let sent=[],running,savedSessionId;
 const contextEvents=[];
 const handleNotification=adapter.handleNotification.bind(adapter);
 adapter.handleNotification=(active,event)=>{if(event.params?.event?.type==='request/context')contextEvents.push(event.params.event);handleNotification(active,event);};
 const {DeepSeekHarness}=await import('@deepseek-ai/dsh-sdk-client');
 adapter.spawnHarness=async(_thread,cwd,model,permission,preset,effort,resume)=>{
  const profile=process.env.AEGIS_DSH_PROFILE_DIR;
  const harness=new DeepSeekHarness({dshBin:path.join(profile,'runtime-bin.mjs'),profile:'sdk',patches:[path.join(profile,'cordis.yml')],processCwd:profile,cwd,model,provider:'deepseek-official',reasoningEffort:effort,requestTimeoutMs:20000,
   env:{...process.env,HOME:path.join(temp,'runtime-home'),DSH_HOME:path.join(temp,'runtime-home/.dsh'),DSH_CWD:cwd,DSH_PERMISSION_MODE:permission,DSH_SESSION_ROOT:path.join(temp,'sessions'),AEGIS_DSH_PROJECT_ROOTS:'',AEGIS_DSH_AGENT_PRESET:preset,AEGIS_DSH_RESUME_SESSION_ID:resume||'',ELECTRON_RUN_AS_NODE:'1',DEEPSEEK_API_KEY:'ui-local-test',DEEPSEEK_BASE_URL:'http://127.0.0.1:'+api.address().port}});
  await harness.start();return {harness,disposeRuntimeConfig(){}};
 };
 const store=require(path.join(root,'dist-electron/electron/libs/session-store.js'));
 const {DEEPSEEK_COST_ACCOUNTING,estimateDeepseekUsageCost}=require(path.join(root,'dist-electron/electron/libs/deepseek-pricing.js'));
 store.initialize();
 const liveSession=store.createSession({provider:'deepseek',model:'deepseek-flash',cwd:temp,title:'Live cumulative cost'});
 let expectedSessionCost=0;
 ipcMain.handle('get-deepseek-session-cost',()=>store.getDeepseekSessionCost(liveSession.id));
 let report;
 ipcMain.handle('get-agent-usage-report',()=>report);
 for(const [channel,value] of [['get-user-profile',{displayName:'DeepSeek Usage QA',handle:'local-test',customized:true}],['get-codex-rate-limits',{snapshots:[]}],['get-claude-plan-usage',null]])ipcMain.handle(channel,()=>value);
 const emit=event=>win.webContents.send('server-event',JSON.stringify(event));
 adapter.events.on('event',e=>{if(e.type==='message'){store.addMessage(liveSession.id,e.message);if(e.message.type==='result')expectedSessionCost+=e.message.costEstimate.usd;}if(e.type==='message')emit({type:'stream.message',payload:{sessionId:e.threadId,message:e.message}});if(e.type==='error')errors.push(e.error.message);});
 ipcMain.on('client-event',(_e,json)=>{const e=JSON.parse(json);if(e.type!=='session.continue')return;sent.push(e.payload);const p=e.payload;
  emit({type:'stream.user_prompt',payload:{sessionId:p.sessionId,prompt:p.prompt,attachments:p.attachments,createdAt:Date.now()}});
  running=(async()=>{
   if(adapter.hasSession(p.sessionId))await adapter.sendTurn({threadId:p.sessionId,prompt:p.prompt,attachments:p.attachments});
   else {const started=await adapter.startSession({threadId:p.sessionId,cwd:temp,prompt:p.prompt,attachments:p.attachments,model:p.model,resumeSessionId:savedSessionId});savedSessionId=started.providerSessionId;}
  })();
 });
 try{
  await win.loadURL(process.env.QA_URL);await until('!!window.qa && !!qa.editor()','composer');win.focus();
  await js('document.querySelector("[aria-label=\\"Add files or photos\\"]").click()');await until('qa.images().length===1','WebP picker thumbnail');
  assert(filters[0].extensions.includes('webp')&&filters[0].extensions.includes('gif'));
  // Drop and clipboard-only raster blobs go through the production importer.
  const blob=fs.readFileSync(path.join(temp,'sample.gif')).toString('base64');
  await js(`(()=>{const dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(atob(${JSON.stringify(blob)}),c=>c.charCodeAt(0))],'drop.gif',{type:'image/gif'}));document.querySelector('[data-composer-drop-zone]').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));})()`);
  await until('qa.images().length===2','GIF drop');
  const jpeg=fs.readFileSync(path.join(temp,'sample.jpeg')).toString('base64');
  await js(`(()=>{const dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(atob(${JSON.stringify(jpeg)}),c=>c.charCodeAt(0))],'pasted',{type:'image/jpeg'}));qa.editor().dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt}));})()`);
  await until('qa.images().length===3','JPEG clipboard');
  await js('qa.editor().focus();document.execCommand("insertText",false,"What is in these images?")');
  await js('document.querySelector("[aria-label=Send]").click()');await until('document.body.innerText.includes("does not support image input")','unsupported model toast');
  assert.equal(sent.length,0);assert.equal(await js('qa.images().length'),3);assert((await js('qa.editor().textContent')).includes('What'));
  await capture('unsupported-model');
  await js('document.querySelector("[data-sonner-toast] button").click()');
  await until('!document.querySelector("[data-sonner-toast]")','dismiss previous validation toast');
  await js(`qa.store.setState(s=>({sessions:{...s.sessions,[qa.id]:{...s.sessions[qa.id],model:'deepseek-v4-flash'}}}))`);
  await until('document.querySelector("[aria-label=\\"Select agent and model\\"]").textContent.includes("legacy")','saved alias remains selected');
  await js('document.querySelector("[aria-label=\\"Select agent and model\\"]").click()');await js(`Array.from(document.querySelectorAll('[role=menuitem]')).find(e=>e.textContent.includes('DeepSeek Harness')).click()`);
  await until('!!document.querySelector("[aria-label=\\"Choose model\\"]")','DeepSeek reasoning panel');
  await js('document.querySelector("[aria-label=\\"Choose model\\"]").click()');await until('!!document.querySelector("[role=menuitem][title^=deepseek-flash]")','image model option');await delay(400);await capture('model-picker');
  assert.equal(await js(`document.querySelectorAll('[role=menuitem][title^="deepseek-v4-flash"]').length`),0,'duplicate alias is hidden from the model menu');
  assert.deepEqual(await js(`Array.from(document.querySelectorAll('[role=menuitem]')).filter(e=>e.title?.startsWith('deepseek-')||e.textContent==='Default').map(e=>e.textContent.trim())`),['Default','DeepSeek V4.1 Flash','DeepSeek V4 Pro'],'model rows show names only');
  assert.equal(await js('qa.store.getState().sessions[qa.id].model'),'deepseek-v4-flash','opening the picker preserves the saved model');
  await js(`Array.from(document.querySelectorAll('[role=menuitem],[role=option],button')).find(e=>e.title?.startsWith('deepseek-flash')).click()`);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await delay(150);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await until('document.querySelector("[aria-label=\\"Select agent and model\\"]").textContent.includes("DeepSeek V4.1 Flash")','select image model');
  await js('(()=>{const b=document.querySelector("[aria-label=\\"Select agent and model\\"]");if(b.getAttribute("aria-expanded")==="true")b.click();})()');
  await until('!document.querySelector("[role=menu]")','model menu closed');
  await js('document.querySelector("[aria-label=Send]").click()');await until('document.querySelector("main").innerText.includes("blue rectangle")','real Harness response');await running;
  assert.equal(sent.length,1);assert.equal(sent[0].attachments.length,3);assert(requests.some(r=>r.messages.some(m=>Array.isArray(m.content)&&m.content.filter(p=>p.type==='file'||p.type==='image_url').length===3)));
  await until('!!document.querySelector("[aria-label=\\"Context window usage\\"]")','usage ring');
  const ring=await js('(()=>{const r=document.querySelector("[aria-label=\\"Context window usage\\"]").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
  await delay(300);win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(ring.x),y:Math.round(ring.y)});
  await js('document.querySelector("[aria-label=\\"Context window usage\\"]").focus()');
  await until('document.querySelector("[data-testid=deepseek-session-cost]")?.textContent.includes("Cost")','turn cost tooltip');
  assert((await js('document.querySelector("[data-testid=deepseek-session-cost]").textContent')).includes('≈$'));
  assert.equal(await js('qa.store.getState().sessions[qa.id].messages.filter(m=>m.subtype==="token_usage").at(-1).usage.totalTokens'),1280);
  assert(!(await js('document.body.innerText')).includes('Turn estimate'));
  assert(!(await js('document.body.innerText')).includes('reported main-agent usage'));
  assert.equal(store.getDeepseekSessionCost(liveSession.id).usd,expectedSessionCost);
  await capture('session-cost');await js('document.activeElement.blur()');
  await js('Array.from(document.querySelectorAll("main button")).find(b=>b.textContent.includes("Show work"))?.click()');
  await until('!!Array.from(document.querySelectorAll("main button")).find(b=>/Read|Explor/.test(b.textContent))','read image workstream');
  await js('Array.from(document.querySelectorAll("main button")).find(b=>/Read|Explor/.test(b.textContent)).click()');
  await until('document.querySelectorAll("main [aria-label^=\\"Open image attachment\\"]").length>=4','tool image preview');await capture('read-image-result');
  await js('Array.from(document.querySelectorAll("main [aria-label^=\\"Open image attachment\\"]")).at(-1).click()');await until('!!document.querySelector("[aria-label=\\"Close image preview\\"]")','lightbox');await capture('image-lightbox');
  await js('document.querySelector("[aria-label=\\"Close image preview\\"]").click()');
  // A resumed native session does NOT re-emit unchanged request/context.
  // Verify both a warm second turn and a restarted third turn through the UI.
  const followup=async(tokens,label)=>{
    usagePromptTokens=tokens;const count=sent.length;
    await js('qa.editor().focus();document.execCommand("insertText",false,"Continue describing the image.")');
    await js('document.querySelector("[aria-label=Send]").click()');
    await until(`qa.store.getState().sessions[qa.id].messages.filter(m=>m.type==="user_prompt").length>${count}`,'followup sent');
    await running;
    await until(`qa.store.getState().sessions[qa.id].messages.filter(m=>m.type==="result").length>${count}`,'followup result');
    const latest=await js('qa.store.getState().sessions[qa.id].messages.filter(m=>m.subtype==="token_usage").at(-1).usage');
    assert.equal(latest.totalTokens,tokens+80,label+': context ring must advance');
    assert(latest.turnCostEstimate.usd>0,label+': fee remains available');
    const result=await js('qa.store.getState().sessions[qa.id].messages.filter(m=>m.type==="result").at(-1)');
    assert.equal(latest.turnCostEstimate.usd,result.costEstimate.usd,label+': raw per-turn accounting remains intact');
    assert(Math.abs(store.getDeepseekSessionCost(liveSession.id).usd-expectedSessionCost)<1e-12);
    await js('document.querySelector("[aria-label=\\"Context window usage\\"]").focus()');
    await until(`document.querySelector('[data-testid=deepseek-session-cost]')?.textContent.includes(${JSON.stringify('≈$'+expectedSessionCost.toFixed(4))})`,'cumulative '+label);
    assert(expectedSessionCost>result.costEstimate.usd,'Cost includes previous turns');
    await js('document.activeElement.blur()');
  };
  await followup(2300,'warm turn');
  const originalId=savedSessionId,contextEventCount=contextEvents.length;
  await adapter.stopSession(await js('qa.id'));
  await followup(3400,'resumed turn');
  assert.equal(savedSessionId,originalId,'resume retains native session identity');
  assert.equal(contextEvents.length,contextEventCount,'unchanged native context is not re-emitted');
  await js('document.querySelector("[aria-label=\\"Context window usage\\"]").focus()');
  await until('document.querySelector("[data-testid=deepseek-session-cost]")?.textContent.includes("Cost")','resumed cost tooltip');await capture('resumed-turn-cost');
  await js('document.activeElement.blur()');
  const history=await js('JSON.parse(JSON.stringify(qa.store.getState().sessions[qa.id].messages))');
  assert(history.some(m=>m.message?.content.some(b=>b.images?.length)),'stored history retains tool images');
  await win.reload();await until('!!window.qa && !!qa.editor()','reload');await js(`qa.restore(${JSON.stringify(history)})`);
  await until('document.querySelector("main").innerText.includes("blue rectangle")','history restored');
  assert.equal(await js('qa.store.getState().sessions[qa.id].messages.filter(m=>m.subtype==="token_usage").at(-1).usage.totalTokens'),3480,'resumed ring snapshot survives history reload');
  await js('Array.from(document.querySelectorAll("main button")).find(b=>b.textContent.includes("Show work"))?.click()');await delay(180);
  await js('Array.from(document.querySelectorAll("main button")).find(b=>/Read|Explor/.test(b.textContent)).click()');await until('document.querySelectorAll("main [aria-label^=\\"Open image attachment\\"]").length>=4','restored tool preview');
  // Loading only the latest history page must not reset the session total.
  const latestPage=history.slice(-2);
  await js(`qa.restore(${JSON.stringify(latestPage)})`);
  await js('document.querySelector("[aria-label=\\"Context window usage\\"]").focus()');
  await until(`document.querySelector('[data-testid=deepseek-session-cost]')?.textContent.includes(${JSON.stringify('≈$'+expectedSessionCost.toFixed(4))})`,'cumulative cost with paginated history');
  await capture('session-cost-restored');await js('document.activeElement.blur()');
  // Same guard also runs in the first-message composer.
  await js('qa.fresh(true)');await until('!!qa.editor()','new conversation');
  picked=[path.join(temp,'sample.png')];await js('document.querySelector("[aria-label=\\"Add files or photos\\"]").click()');await until('qa.images().length===1','new conversation image');
  await capture('new-conversation');
  // Historical reports use real SQLite in the isolated Electron profile.
  store.deleteSession(liveSession.id);
  const record=(model,extra={})=>{
    const session=store.createSession({provider:'deepseek',model,cwd:temp,title:model});
    store.addMessage(session.id,{type:'result',subtype:'success',duration_ms:1,total_cost_usd:0,model,
      usage:{input_tokens:100,output_tokens:20,cache_read_input_tokens:5},usageAccounting:'deepseek-step-last-wins-v1',...extra});return session.id;
  };
  const showUsage=async(label)=>{
    await js('qa.usage(false)');await delay(100);await js('qa.usage(true)');
    await until('!!document.querySelector("[aria-label=\\"DeepSeek Harness\\"]")','usage provider selector');
    await js('document.querySelector("[aria-label=\\"DeepSeek Harness\\"]").click()');
    await until('document.querySelector("[aria-label=\\"DeepSeek Harness\\"]").getAttribute("aria-pressed")==="true"','DeepSeek usage selected');
    await until(`document.body.innerText.includes(${JSON.stringify(label)})`,'cost mode '+label);
  };
  const unknownSession=record('custom-model');assert.equal(store.getDeepseekSessionCost(unknownSession).usd,null);report=store.getAgentUsageReport('deepseek',365);
  assert.equal(report.costMode,'unavailable');assert.equal(report.totals.totalTokens,125);
  await showUsage('Unavailable');await capture('usage-unavailable');
  const historicalAt=Date.parse('2026-08-14T12:00:00Z'),flashAt=Date.parse('2026-09-10T05:00:00Z');
  record('deepseek-v4-flash',{createdAt:historicalAt,usageAccounting:undefined,usage:{input_tokens:200,output_tokens:40,cache_read_input_tokens:10}});
  record('deepseek-flash',{createdAt:flashAt}); // Previously persisted zero price gets repaired.
  const isolatedSession=record('deepseek-flash',{costAccounting:DEEPSEEK_COST_ACCOUNTING,costEstimate:{usd:.003},total_cost_usd:.003});
  assert.equal(store.getDeepseekSessionCost(isolatedSession).usd,.003,'session cost excludes other conversations');

  report=store.getAgentUsageReport('deepseek',365);
  assert.equal(report.costMode,'partial');assert.equal(report.totals.totalTokens,500);
  assert.equal(report.models.reduce((n,m)=>n+m.totalTokens,0),500);
  assert.equal(report.daily.reduce((n,d)=>n+d.totalTokens,0),500);
  const usage={inputTokens:100,outputTokens:20,cacheReadTokens:5};
  const expected=.003+estimateDeepseekUsageCost('deepseek-v4-flash',usage,historicalAt)+estimateDeepseekUsageCost('deepseek-flash',usage,flashAt);
  assert(Math.abs(report.totals.totalCostUsd-expected)<1e-12);
  assert(report.note.includes('1 result(s)'));
  store.close();store.initialize();assert.equal(store.getAgentUsageReport('deepseek',365).totals.totalCostUsd,report.totals.totalCostUsd);
  await showUsage('Priced usage only');await capture('usage-partial');
  assert((await js('Array.from(document.querySelectorAll("[title]")).find(e=>e.textContent.includes("Priced usage only"))?.title')).includes('official DeepSeek API prices'));
  store.close();
  assert.deepEqual(errors,[]);console.log('DEEPSEEK_IMAGE_UI_OK: picker/drop/paste, preserved draft, model capabilities, real Harness, tool lightbox, warm/resumed turn costs and SQLite estimated/partial/unavailable history');
 }catch(error){console.error(error);console.error('UI snapshot',await js('JSON.stringify({active:document.activeElement.outerHTML.slice(0,200),usage:qa.store.getState().sessions[qa.id].messages.filter(m=>m.subtype==="token_usage").at(-1)})'));await capture('failure');process.exitCode=1;}
 finally{for(const id of adapter.sessions.keys())await adapter.stopSession(id);api.closeAllConnections();await new Promise(r=>api.close(r));app.exit(process.exitCode||0);}
}).catch(error=>{console.error(error);app.exit(1);});

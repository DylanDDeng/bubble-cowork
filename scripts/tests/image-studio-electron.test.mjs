import { createServer } from 'vite';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), {recursive:true});
const dir = await mkdtemp(path.join(root,'.aegis-design-qa/image-studio-'));
let server;
const harness = `
import React,{useState,useEffect} from 'react';
import {RightUtilityWorkspace} from '/src/ui/App';
import {PromptInput} from '/src/ui/components/PromptInput';
import {ImageStudioComposerHome} from '/src/ui/components/ImageStudioComposerDock';
import {ComposerPendingPermissionPanel} from '/src/ui/components/ComposerPendingPermissionPanel';
import {imageCommentPrompt} from '/src/ui/utils/image-studio';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {createRoot} from 'react-dom/client';
import {ImageStudioPanel} from '/src/ui/components/ImageStudioPanel';
import {GeneratedMediaGallery} from '/src/ui/components/GeneratedMediaGallery';
import {ImageStudioSessionContext,openImageStudio,submitImageEdit} from '/src/ui/lib/image-studio';
import {useAppPreferences} from '/src/ui/store/useAppPreferences';
import {useAppStore} from '/src/ui/store/useAppStore';
import {useImageStudioStore} from '/src/ui/store/useImageStudioStore';
import {useComposerQueueStore} from '/src/ui/store/useComposerQueueStore';
import {startQueueAutoFlush} from '/src/ui/lib/queue-auto-flush';
import '/src/ui/index.css';
useAppPreferences.setState({reduceMotion:'off'});
const store=useAppStore, studio=useImageStudioStore, queue=useComposerQueueStore;
const image=(color,label)=>{const c=document.createElement('canvas');c.width=800;c.height=600;const x=c.getContext('2d');x.fillStyle=color;x.fillRect(0,0,800,600);x.fillStyle='#f8dcab';x.beginPath();x.arc(400,285,170,0,7);x.fill();x.fillStyle='#253e36';x.fillRect(120,440,560,90);x.fillStyle='white';x.font='28px sans-serif';x.fillText(label,145,497);return c.toDataURL()};
const files={'/tmp/images/a.png':image('#ddd5be','Original'),'/tmp/images/b.png':image('#c4cfda','Variation'),'/tmp/images/c.png':image('#d1c6d4','Refined')};
const sent=[], masks=[],reads=[],approvals=[];let failImport=false, failPreview=false;
window.electron={readProjectFilePreview:async(_,path)=>{reads.push(path);if(failPreview||!files[path])throw Error('Image file is missing');return {kind:'image',dataUrl:files[path]}},
 importAttachments:async(paths)=>failImport?{attachments:[],errors:['Import failed']}:{attachments:paths.map(path=>({id:crypto.randomUUID(),kind:'image',name:path.split('/').pop(),path,mimeType:'image/png',size:100})),errors:[]},
 createFileAttachment:async(name,bytes)=>{masks.push(Array.from(bytes));return{id:'mask',name,path:'/tmp/image-mask.png',kind:'image',mimeType:'image/png',size:bytes.length}},
 listCodexSkills:async()=>({skills:[{name:'imagegen',path:'/skills/imagegen/SKILL.md',enabled:true}]}),
 sendClientEvent:event=>{if(event.type==='permission.response'){approvals.push(event);return}sent.push(event);const id=event.payload.sessionId;update(id,{status:'running',messages:[...store.getState().sessions[id].messages,{type:'user_prompt',prompt:event.payload.prompt,createdAt:Date.now()}]})},
};
function update(id,patch){store.setState(s=>({sessions:{...s.sessions,[id]:{...s.sessions[id],...patch}}}))}
const text=(id,path)=>({type:'assistant',uuid:id,message:{content:[{type:'text',text:'![Image]('+path+')'}]}});
const output=(id)=>({type:'assistant',message:{content:[{type:'tool_use',id:'gen-'+id,name:'image_gen',input:{__aegisGeneratedMedia:[{kind:'image',path:'/tmp/images/'+id+'.png'}]}}]}});
const messages=[{type:'user_prompt',prompt:'Generate two images',createdAt:1800000000000},output('a'),text('a','images/a.png'),output('b'),text('b','images/b.png'),{type:'user_prompt',prompt:'Refine the composition',createdAt:1800000060000},output('c'),text('c','images/c.png')];
Object.assign(window.electron,{
 getProjectTree:async()=>null,getRecentCwds:async()=>[],getProjectGitSummary:async()=>({isGitRepository:false}),
 getAgentRuntimeDirectory:async()=>({checkedAt:Date.now(),entries:[]}),getSessionUserPrompts:async()=>[],
 getSessionGoal:async()=>({goal:null,supported:false,revision:0}),onSessionGoalChanged:()=>()=>{},
 getClaudeCompatibleProviderConfig:async()=>({}),getBubbleProvidersConfig:async()=>({providers:[]}),getProjectFolders:async()=>[],getModels:async()=>[],
 readAttachmentPreview:async path=>files[path]||null,
});
for(const p of ['Claude','Kimi','Grok','Opencode','Pi','Bubble','Qoder','Deepseek','Codex'])window.electron['get'+p+'ModelConfig']=async()=>({defaultModel:null,options:[],availableModels:[]});
window.electron.getCodexModelConfig=async()=>({defaultModel:'gpt-test',options:['gpt-test'],availableModels:[{name:'gpt-test',label:'GPT Test'}]});
const seed=store.getState().createDraftSession('/tmp/images'),template=store.getState().sessions[seed];
for(const [id,provider] of [['codex','codex'],['grok','grok'],['claude','claude']])store.setState(s=>({sessions:{...s.sessions,[id]:{...template,id,isDraft:false,title:id,cwd:'/tmp/images',provider,model:provider==='grok'?'grok-test':'gpt-test',grokPermissionMode:provider==='grok'?'yolo':undefined,grokReasoningEffort:provider==='grok'?'high':undefined,status:'completed',permissionRequests:[],messages,readOnly:false,hydrated:true}}}));
store.setState({activeSessionId:'codex'});store.getState().setTheme('light');startQueueAutoFlush();
window.qa={store,studio,queue,sent,masks,reads,approvals,commentSubmit:()=>submitImageEdit('codex',imageCommentPrompt(studio.getState().sessions.codex.selected,studio.getState().sessions.codex.comments,'Keep the composition'),studio.getState().sessions.codex.selected),reduced:()=>useAppPreferences.setState({reduceMotion:'on'}),update,open:openImageStudio,submit:submitImageEdit,
 fail:(v)=>{failImport=v},files,
 result:(status='completed')=>{const e=sent.at(-1),p='/tmp/images/result-'+sent.length+'.png';files[p]=image('#c5d2bf','Edited result');update(e.payload.sessionId,{messages:[...store.getState().sessions[e.payload.sessionId].messages,text('result-'+sent.length,p)],status});return p},
 end:()=>{const e=sent.at(-1);update(e.payload.sessionId,{status:'completed'})},
 switch:id=>store.setState({activeSessionId:id,activeRightUtilityTab:null,rightUtilityTabs:[],rightPanelFullscreen:null}),
};
function App(){
 const [integrated,setIntegrated]=useState(true);qa.integrate=()=>{store.setState({pendingChatInjection:null});setIntegrated(true)};
 const id=store(s=>s.activeSessionId),tab=store(s=>s.activeRightUtilityTab),full=store(s=>s.rightPanelFullscreen),tabs=store(s=>s.rightUtilityTabs);
 const current=store(s=>s.sessions[id]);
 const panelHidden=store(s=>s.rightUtilityPanelHidden);
 const permission=current.status==='running'?current.permissionRequests[0]:undefined;
 const state=store.getState();
 useEffect(()=>{if(tab?.startsWith('images:')){state.setBrowserPanelOpen(false);state.setProjectTreeCollapsed(true)}},[tab]);
 const panel=tab?.startsWith('images:')?<ImageStudioPanel key={tab} sessionId={tab.slice(7)} hidden={panelHidden} fullscreen={full==='images'}/>:null;
 const gallery=<ImageStudioSessionContext.Provider value={id}><GeneratedMediaGallery cwd='/tmp/images' items={[{kind:'image',path:'/tmp/images/a.png'},{kind:'image',path:'/tmp/images/b.png'}]}/></ImageStudioSessionContext.Provider>;
 return <Tooltip.Provider><div style={{height:'100vh',display:'flex',background:'var(--bg-primary)'}}>
 {integrated?<><div style={{display:full?'none':'flex',flex:1,minWidth:0,flexDirection:'column',padding:24}}><div style={{flex:1}}>{gallery}</div>{!current.readOnly&&<ImageStudioComposerHome key={id} sessionId={id}><div className="aegis-chat-composer"><PromptInput sessionId={id} approvalPending={!!permission} approvalPanel={permission?<ComposerPendingPermissionPanel request={permission} pendingCount={1} onSubmit={(toolUseId,result)=>{window.electron.sendClientEvent({type:'permission.response',payload:{sessionId:id,toolUseId,result}});store.getState().removePermissionRequest(id,toolUseId)}}/>:undefined}/></div></ImageStudioComposerHome>}</div>
 {panel&&<RightUtilityWorkspace hidden={panelHidden} instantReveal={true} activePanel="images" tabs={tabs.map(id=>({id,kind:'images',label:'Images'}))} activeTab={tab} browserAvailable={false} width={480} resizable={false} fullscreen={!!full} windowControlsInset={false} onWidthChange={()=>{}} onSelectTab={state.setActiveRightUtilityTab} onCloseTab={state.closeRightUtilityTab} onOpenTab={state.openRightUtilityTab} onTogglePanel={state.closeRightUtilityPanels} onToggleFullscreen={()=>state.setRightPanelFullscreen(full?null:'images')}>{panel}</RightUtilityWorkspace>}</>:panel||<div style={{padding:32}}>{gallery}</div>}
 </div></Tooltip.Provider>
}
createRoot(document.getElementById('root')).render(<App/>);
`;
const main=String.raw`
const {app,BrowserWindow}=require('electron');const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',path.join(__dirname,'profile'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{const w=new BrowserWindow({width:1000,height:900,show:true});const errors=[];
w.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
const js=async s=>{try{return await w.webContents.executeJavaScript(s,true)}catch(e){console.error(s,errors);throw e}};
const until=async(s,label)=>{for(let i=0;i<80;i++){if(await js(s))return;await delay(100)}throw Error('Timed out: '+label)};
const click=async s=>{await js('document.querySelector('+JSON.stringify(s)+').click()');await delay(150)};
const type=async(s,text)=>{await js('(()=>{const el=document.querySelector('+JSON.stringify(s)+');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(el,'+JSON.stringify(text)+');el.dispatchEvent(new Event("input",{bubbles:true}))})()');await delay(60)};
const shot=async name=>{fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await w.webContents.capturePage()).toPNG())};
const picture='.image-studio-picture';
const point=async(selector,x,y)=>js('(()=>{const el=document.querySelector('+JSON.stringify(selector)+'),r=el.getBoundingClientRect();el.dispatchEvent(new MouseEvent("click",{bubbles:true,clientX:r.left+r.width*'+x+',clientY:r.top+r.height*'+y+'}))})()');
try{
 await w.loadURL(process.env.QA_URL);await until('!!window.qa','renderer');await until('!!document.querySelector("img")','gallery');
 await click('button[title="a.png"]');await until('!!document.querySelector(".image-studio-picture img")','focused image');
 assert.equal(await js('qa.store.getState().activeRightUtilityTab'),'images:codex');
 assert.equal(await js('document.querySelectorAll(".image-studio-rail button").length'),3,'relative embeds do not add duplicate thumbnails');
 await until('document.querySelectorAll(".image-studio-rail img").length===3','all thumbnails load');
 await js('qa.studio.getState().patch("codex",{activePath:"/tmp/images/images/a.png"})');
 await until('qa.studio.getState().sessions.codex.activePath==="/tmp/images/a.png"','stale broken selection repaired');
 for(const name of ['b.png','c.png','a.png']){await click('[aria-label="Open '+name+'"]');await until('document.querySelector(".image-studio-picture")?.dataset.imagePath==="/tmp/images/'+name+'"','thumbnail opens original')}
 assert.equal(await js('qa.reads.some(path=>path.includes("/images/images/"))'),false,'never requests synthesized project aliases');
 assert.equal(await js('qa.store.getState().rightPanelFullscreen'),'images','opening a thumbnail fills the workspace');
 await js('window.originalEditor=document.querySelector("[role=textbox]");window.footerBefore=document.querySelector(".image-studio-footer").getBoundingClientRect().bottom');await shot('focused-light');
 await click('[aria-label="Canvas view"]');assert(await js('document.querySelector(".image-studio-picture").getAnimations().length>0'),'view switch animates the same image');await until('document.querySelectorAll(".image-studio-turn").length===2','turn groups');
 assert.equal(await js('document.querySelectorAll(".image-studio-picture").length'),3);
 const canvasLayout=()=>js('(()=>{const row=document.querySelector(".image-studio-row"),[a,b]=[...row.querySelectorAll(".image-studio-picture")].map(el=>el.getBoundingClientRect()),v=document.querySelector(".image-studio-viewport");return {height:a.height,width:a.width,sameRow:Math.abs(a.top-b.top)<1,gap:b.left-a.right,overflow:v.scrollWidth>v.clientWidth}})()');
 await until('document.querySelector(".image-studio-picture").getAnimations().length===0','canvas transition settles');
 const fullLayout=await canvasLayout();
 assert.equal(fullLayout.height,292,'canvas uses the reference image height');
 assert(fullLayout.sameRow);assert.equal(Math.round(fullLayout.gap),8);
 w.setContentSize(520,800);await delay(200);
 const narrowLayout=await canvasLayout();
 assert.equal(narrowLayout.width,fullLayout.width,'window resize does not shrink canvas images');
 assert.equal(narrowLayout.height,fullLayout.height);
 assert(narrowLayout.sameRow,'same-turn images stay in one row below 600px');
 assert(narrowLayout.overflow,'narrow canvas scrolls horizontally');
 assert.equal(await js('document.documentElement.scrollWidth>innerWidth'),false,'overflow stays inside the canvas');
 await shot('canvas-narrow-horizontal');
 const wheelPoint=await js('(()=>{const v=document.querySelector(".image-studio-viewport"),r=v.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+100),left:v.scrollLeft}})()');
 app.focus({steal:true});w.focus();w.webContents.focus();
 w.webContents.sendInputEvent({type:'mouseMove',x:wheelPoint.x,y:wheelPoint.y});
 w.webContents.sendInputEvent({type:'mouseWheel',x:wheelPoint.x,y:wheelPoint.y,deltaX:-180,deltaY:0});
 await until('document.querySelector(".image-studio-viewport").scrollLeft>'+wheelPoint.left,'horizontal trackpad scroll moves the canvas');
 w.setContentSize(1000,868);await delay(200);
 assert(await js('originalEditor===document.querySelector("[role=textbox]")'),'view changes retain the same live editor');
 assert(await js('Math.abs(footerBefore-document.querySelector(".image-studio-footer").getBoundingClientRect().bottom)<1'),'view changes keep the composer anchored');
 assert.equal(await js('qa.store.getState().rightPanelFullscreen'),'images');
 assert.equal(await js('qa.studio.getState().sessions.codex.selected[0]'),'/tmp/images/a.png','canvas switch retains the focused image as context');
 await click('[aria-label="Multi-select"]');await point('.image-studio-row > div:nth-child(2) .image-studio-picture',.2,.2);
 assert.equal(await js('qa.studio.getState().sessions.codex.selected.length'),2);
 await click('[aria-label="Comment"]');await point(picture,.25,.75);await type('[aria-label="Comment text"]','Remove this shape');await click('.image-studio-comment-actions button[type="submit"]');
 assert(Math.abs(await js('qa.studio.getState().sessions.codex.comments["/tmp/images/a.png"][0].x')-.25)<.005);
 await click('.image-studio-pin');await type('[aria-label="Comment text"]','Make this shape blue');await click('.image-studio-comment-actions button[type="submit"]');
 assert.equal(await js('qa.studio.getState().sessions.codex.comments["/tmp/images/a.png"].length'),1);
 await shot('canvas-comments-light');
 await js('qa.commentSubmit()');await until('qa.sent.length===1','comment edit');
 await until('!!document.querySelector("[data-image-pending] canvas")','canvas generating placeholder');
 assert.equal(await js('document.querySelector(".image-studio-feedback")?.textContent.includes("Editing image")||false'),false,'no redundant editing text strip');
 await shot('generating-canvas-light');
 assert.equal(await js('qa.sent[0].payload.attachments.length'),2);
 assert.deepEqual(await js('qa.sent[0].payload.codexSkills'),[{name:'imagegen',path:'/skills/imagegen/SKILL.md'}]);
 assert((await js('qa.sent[0].payload.effectivePrompt')).includes('Make this shape blue'));
 const result=await js('qa.result()');await until('!qa.studio.getState().sessions.codex.pending','image completion');
 assert.equal(await js('qa.studio.getState().sessions.codex.activePath'),result);
 assert.equal(await js('document.querySelectorAll(".image-studio-picture").length'),4,'originals retained');
 await click('[aria-label="Focused view"]');await until('!!document.querySelector(".image-studio-picture img")','new focused image');
 await click('[aria-label="Zoom options"]');await click('.image-studio-zoom [role=menu] button:nth-child(2)');await click('[aria-label="Zoom options"]');assert.equal(await js('document.querySelector("[aria-label=\\"Zoom options\\"]").textContent'),'120%');
 await js('document.querySelector(".image-studio-viewport").dispatchEvent(new WheelEvent("wheel",{ctrlKey:true,deltaY:-60,bubbles:true,cancelable:true}))');await delay(100);
 assert(parseInt(await js('document.querySelector("[aria-label=\\"Zoom options\\"]").textContent'))>120);
 await click('[aria-label="Zoom options"]');await click('[role="menu"] button:nth-child(6)');
 await click('.image-studio-editbar > button:nth-child(2)');await until('!!document.querySelector("canvas")','brush');
 // Exercise pointer capture and stroke drawing with native mouse events.
 const r=await js('(()=>{const r=document.querySelector("canvas").getBoundingClientRect();return {x:r.left+r.width*.5,y:r.top+r.height*.5}})()');
 app.focus({steal:true});w.focus();w.webContents.focus();
 w.webContents.sendInputEvent({type:'mouseMove',x:Math.round(r.x),y:Math.round(r.y)});
 w.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:Math.round(r.x),y:Math.round(r.y)});
 w.webContents.sendInputEvent({type:'mouseMove',x:Math.round(r.x+30),y:Math.round(r.y+20)});
 w.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:Math.round(r.x+30),y:Math.round(r.y+20)});await delay(200);
 assert.equal(await js('document.querySelector("[aria-label=\\"Undo brush stroke\\"]").disabled'),false);
 await click('[aria-label="Undo brush stroke"]');assert.equal(await js('document.querySelector("[aria-label=\\"Redo brush stroke\\"]").disabled'),false);
 await click('[aria-label="Redo brush stroke"]');await shot('brush-selection');
 await click('.image-studio-editbar button:last-child');await until('qa.sent.length===2','mask edit');
 assert.equal(await js('qa.sent[1].payload.attachments[1].path'),'/tmp/image-mask.png');
 assert.equal(await js('qa.masks.length'),1);
 const mask=await js('(async()=>{const b=new Blob([new Uint8Array(qa.masks[0])],{type:"image/png"}),img=await createImageBitmap(b),c=document.createElement("canvas");c.width=img.width;c.height=img.height;const x=c.getContext("2d");x.drawImage(img,0,0);return {width:img.width,height:img.height,center:Array.from(x.getImageData(400,300,1,1).data),corner:Array.from(x.getImageData(0,0,1,1).data)}})()');
 assert.deepEqual(mask,{width:800,height:600,center:[255,255,255,255],corner:[0,0,0,255]});
 await js('qa.end()');await until('!qa.studio.getState().sessions.codex.pending','no-result feedback');
 assert((await js('document.querySelector(".image-studio-feedback").textContent')).includes('without a new image'));
 await js('qa.switch("grok")');await click('button[title="a.png"]');await until('!!document.querySelector(".image-studio-picture")','grok preview');
 await click('.image-studio-editbar > button:first-child');await until('qa.sent.length===3','grok background removal');
 assert((await js('document.querySelector(".image-studio-latest").textContent')).includes('Working'),'Grok image edits also update activity');
 await until('!!document.querySelector(".image-studio-focused-pending canvas")','focused generating placeholder');
 await until('document.querySelector(".image-studio-focused-pending canvas").width>0','dot field dimensions');
 const frameA=await js('document.querySelector(".image-studio-focused-pending canvas").toDataURL()');
 await delay(240);
 assert.notEqual(await js('document.querySelector(".image-studio-focused-pending canvas").toDataURL()'),frameA,'dot field changes over time');
 assert.equal(await js('document.querySelectorAll(".image-studio-picture").length'),0,'pending replaces the focused original');
 assert.equal(await js('document.querySelector(".image-studio-rail button:last-child").getAttribute("aria-current")'),'true');
 assert.equal(await js('getComputedStyle(document.querySelector(".image-studio-focused-pending canvas")).animationName'),'image-generation-dot-opacity','reference opacity breathing is applied');
 await shot('generating-focused-light');
 await click('[aria-label="Canvas view"]');await until('!!document.querySelector("[data-image-pending] canvas")','pending survives Canvas switch');
 await click('[aria-label="Focused view"]');await until('!!document.querySelector(".image-studio-focused-pending canvas")','pending survives focused switch');
 await click('[aria-label="Open a.png"]');await until('!!document.querySelector(".image-studio-picture img")','can browse the original while editing');
 await click('[aria-label="Open generating image"]');await until('!!document.querySelector(".image-studio-focused-pending canvas")','return to pending image');
 await js('qa.store.getState().setTheme("dark");qa.reduced()');await delay(160);
 const staticA=await js('document.querySelector(".image-studio-focused-pending canvas").toDataURL()');await delay(160);
 assert.equal(await js('document.querySelector(".image-studio-focused-pending canvas").toDataURL()'),staticA,'reduced motion is static');
 assert.equal(await js('getComputedStyle(document.querySelector(".image-studio-focused-pending canvas")).animationName'),'none','reduced motion also stops opacity breathing');
 await shot('generating-focused-dark-reduced');
 await js('qa.store.getState().setTheme("light")');

 assert((await js('qa.sent[2].payload.effectivePrompt')).startsWith('/imagine '));
 assert.equal(await js('qa.sent[2].payload.provider'),'grok');assert.equal(await js('qa.sent[2].payload.sessionId'),'grok');
 assert.equal(await js('qa.sent[2].payload.grokPermissionMode'),'yolo');
 assert.equal(await js('qa.sent[2].payload.grokReasoningEffort'),'high');
 assert.equal(await js('qa.sent[2].payload.model'),'grok-test');
 await js('qa.result("running")');await delay(650);
 assert(await js('!!qa.studio.getState().sessions.grok.pending'),'an image arriving does not finish the turn');
 await until('!!document.querySelector(".image-studio-picture img")','result appears before turn completion');
 assert.equal(await js('document.querySelectorAll(".image-generation-placeholder").length'),0,'result removes both pending placeholders while Working continues');
 await js('qa.store.getState().setRightPanelFullscreen("images");qa.update("grok",{permissionRequests:[{sessionId:"grok",toolUseId:"approval",toolName:"Check image dimensions",input:{kind:"acp-permission",provider:"grok",title:"Check image dimensions",question:"Check image dimensions",options:[{optionId:"once",kind:"allow_once",name:"Allow once"},{optionId:"reject",kind:"reject_once",name:"Reject"}]}}]})');
 await until('!!document.querySelector(".image-studio-composer-slot button[title=once]")','approval visible in fullscreen');
 await delay(150);await shot('canvas-permission');
 await click('.image-studio-composer-slot button[title="once"]');
 assert.equal(await js('qa.approvals[0].payload.sessionId'),'grok');
 assert.equal(await js('qa.approvals[0].payload.result.updatedInput.optionId'),'once');
 assert.equal(await js('qa.store.getState().sessions.grok.permissionRequests.length'),0);
 await js('qa.update("grok",{status:"completed"})');await until('!qa.studio.getState().sessions.grok.pending','grok result');
 await click('.image-studio-resize > button');await click('[role="menu"] button:last-child');await until('qa.sent.length===4','resize');
 assert((await js('qa.sent[3].payload.effectivePrompt')).includes('16:9'));
 await js('qa.update("grok",{status:"error",permissionRequests:[{sessionId:"grok",toolUseId:"stranded",toolName:"Check dimensions",input:{}}]})');
 await until('!qa.studio.getState().sessions.grok.pending','failed edit clears pending despite stranded permission');
 assert.equal(await js('document.querySelector(".image-studio-permission")===null'),true,'ended turns do not offer stale approvals');
 assert((await js('qa.studio.getState().sessions.grok.feedback')).includes('failed'));
 await js('qa.update("grok",{permissionRequests:[]})');
 await js('qa.update("grok",{status:"running"})');await click('.image-studio-editbar > button:first-child');await until('!!qa.studio.getState().sessions.grok.pending','queue edit');
 assert.equal(await js('qa.sent.length'),4);assert.equal(await js('qa.queue.getState().queues.grok.length'),1);
 await click('.image-studio-feedback button');await until('!qa.studio.getState().sessions.grok.pending','queue cancelled');
 assert.equal(await js('qa.queue.getState().queues.grok.length'),0);
 assert.equal(await js('document.querySelectorAll(".image-generation-placeholder").length'),0,'cancelled edit removes placeholders');
 await until('!!document.querySelector(".image-studio-picture img")','cancel restores original');
 await click('.image-studio-editbar > button:first-child');await until('qa.queue.getState().queues.grok.length===1','second queue');
 await js('qa.update("grok",{status:"completed"})');await until('qa.sent.length===5','auto flush');assert.equal(await js('qa.sent[4].payload.grokPermissionMode'),'yolo','queued edits retain permissions');
 await js('qa.result()');await until('!qa.studio.getState().sessions.grok.pending','queued result');
 await js('qa.fail(true)');await click('.image-studio-editbar > button:first-child');await until('!!document.querySelector("[role=alert]")','attachment error');assert.equal(await js('qa.sent.length'),5);
 await js('qa.fail(false)');await click('[aria-label="Dismiss message"]');
 await click('[aria-label="Comment"]');await point(picture,.4,.4);await type('[aria-label="Comment text"]','More contrast');await click('.image-studio-comment-actions button[type="submit"]');
 await until('document.querySelectorAll(".image-studio-composer-slot img").length>0','selected image is attached in shared composer');
 await js('qa.store.getState().setTheme("dark")');await delay(100);await shot('focused-dark');
 w.setContentSize(390,800);await delay(200);await shot('narrow-dark');assert.equal(await js('document.documentElement.scrollWidth>innerWidth'),false);
 await js('qa.update("grok",{readOnly:true})');await delay(100);assert.equal(await js('document.querySelector("[aria-label=Comment]").disabled'),true);assert.equal(await js('document.querySelector("[aria-label=\\"Send image edit\\"]")===null'),true);
 assert.equal(await js('qa.open("claude","/tmp/images/a.png")'),false);
 await js('qa.store.getState().setActiveRightUtilityTab("files")');assert.equal(await js('qa.store.getState().rightPanelFullscreen'),null);
 w.setContentSize(1200,900);await js('qa.switch("codex");qa.integrate();qa.store.getState().setTheme("light")');await until('!!document.querySelector("[role=textbox]")','actual composer');
 await js('qa.store.getState().requestChatInjection({sessionId:"codex",text:"Keep my draft",mode:"append"})');await until('document.querySelector("[role=textbox]").textContent.includes("Keep my draft")','draft');
 await click('button[title="a.png"]');await until('!!document.querySelector(".image-studio")','integrated image tab');
 await click('[aria-label="Canvas view"]');await delay(250);assert.equal(await js('qa.store.getState().rightPanelFullscreen'),'images','panel activation preserves Canvas fullscreen');
 await click('[aria-label="Focused view"]');await delay(250);
 await point(picture,.5,.5);await until('document.querySelectorAll(".image-studio-composer-slot img").length>0','image attaches without a separate add button');
 assert((await js('document.querySelector("[role=textbox]").textContent')).includes('Keep my draft'),'existing draft preserved');
 assert.equal(await js('document.querySelectorAll("[role=textbox]").length'),1,'only one persistent composer');
 assert.equal(await js('qa.store.getState().rightPanelFullscreen'),'images','single view also remains fullscreen');
 await shot('integrated-chat-light');
 await js('window.editorBeforeSplit=document.querySelector("[role=textbox]")');
 await click('[aria-label="Exit fullscreen"]');
 await until('!!document.querySelector("[data-composer-home] [role=textbox]")','split view restores composer to chat');
 assert.equal(await js('document.querySelector(".image-studio-composer-slot")'),null,'split image view has no composer dock');
 assert.equal(await js('document.querySelector(".image-studio-latest")'),null,'split image view has no latest turn tray');
 await click('[aria-label="Canvas view"]');
 assert.equal(await js('qa.store.getState().rightPanelFullscreen'),null,'switching to Canvas preserves split view');
 await point(picture,.5,.5);
 await until('document.querySelectorAll("[data-composer-home] img").length>0','canvas selection attaches to chat composer');
 await until('document.querySelector(".image-studio-picture").getAnimations().length===0','split canvas transition settles');
 assert((await canvasLayout()).sameRow,'side panel keeps images in a horizontal row');
 assert.equal((await canvasLayout()).height,292,'side panel keeps the same canvas scale');
 assert(await js('editorBeforeSplit===document.querySelector("[data-composer-home] [role=textbox]")'),'split view keeps the same editor');
 assert((await js('document.querySelector("[role=textbox]").textContent')).includes('Keep my draft'),'split view retains the draft');
 assert.equal(await js('document.querySelectorAll("[role=textbox]").length'),1,'split view has only the chat composer');
 await shot('split-canvas-light');
 await click('[aria-label="Enter fullscreen"]');
 await until('!!document.querySelector(".image-studio-composer-slot [role=textbox]")','fullscreen docks composer again');
 assert(await js('editorBeforeSplit===document.querySelector(".image-studio-composer-slot [role=textbox]")'),'fullscreen retains the same editor');
 await click('[aria-label="Focused view"]');
 await js('qa.store.getState().closeRightUtilityPanels()');await delay(150);
 assert.equal(await js('!!document.querySelector("[data-composer-home] [role=textbox]")'),true,'hiding Images restores the composer to chat');
 await js('qa.open("codex","/tmp/images/a.png")');await delay(150);
 assert.equal(await js('!!document.querySelector(".image-studio-composer-slot [role=textbox]")'),true,'reopening Images docks the same composer');
 await js('qa.reduced()');await delay(50);await click('[aria-label="Canvas view"]');assert.equal(await js('document.querySelector(".image-studio-picture").getAnimations().length'),0,'reduced motion skips the transition');
 await js('qa.update("codex",{messages:[...qa.store.getState().sessions.codex.messages,{type:"assistant",uuid:"latest-reply",phase:"final_answer",message:{content:[{type:"text",text:"The new cover keeps the logo in the top-right corner. [Download cover](/tmp/images/a.png)"}]}}]});window.editorBeforeLatest=document.querySelector("[role=textbox]");Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async text=>{qa.copied=text}}})');
 await click('.image-studio-latest');
 assert.equal(await js('document.querySelector(".image-studio-latest").getAttribute("aria-expanded")'),'true');
 assert((await js('document.querySelector(".image-studio-latest-content").textContent')).includes('The new cover keeps the logo'));
 assert((await js('document.querySelector(".image-studio-latest-content").textContent')).includes('Download cover'));
 assert.equal(await js('qa.store.getState().activeRightUtilityTab'),'images:codex','Latest turn keeps the image workspace open');
 assert.equal(await js('qa.store.getState().rightPanelFullscreen'),'images');
 assert(await js('editorBeforeLatest===document.querySelector("[role=textbox]")'),'Latest turn preserves the editor');
 await click('.image-studio-latest-copy [aria-label="Copy as markdown"]');
 assert((await js('qa.copied')).includes('[Download cover](/tmp/images/a.png)'));
 await shot('latest-turn-expanded-light');
 await js('qa.store.getState().setTheme("dark")');await delay(100);await shot('latest-turn-expanded-dark');
 await click('.image-studio-latest');
 assert.equal(await js('document.querySelector(".image-studio-latest").getAttribute("aria-expanded")'),'false');
 await js('qa.update("codex",{status:"running",streaming:{isStreaming:true,text:"Updating the cover now",thinking:""},messages:[...qa.store.getState().sessions.codex.messages,{type:"user_prompt",prompt:"Refine the colors"}]})');
 await click('.image-studio-latest');
 assert((await js('document.querySelector(".image-studio-latest-content").textContent')).includes('Updating the cover now'));
 assert(!(await js('document.querySelector(".image-studio-latest-content").textContent')).includes('The new cover keeps'));
 await js('qa.update("codex",{status:"completed",streaming:{isStreaming:false,text:"",thinking:""}})');await delay(100);
 assert((await js('document.querySelector(".image-studio-latest-content").textContent')).includes('No reply in this turn yet.'));
 await click('[aria-label="Close Images"]');await until('!document.querySelector(".image-studio")','tab close');
 assert.equal(await js('qa.store.getState().rightPanelFullscreen'),null);
 assert((await js('document.querySelector("[role=textbox]").textContent')).includes('Keep my draft'),'returning to chat preserves the draft');
 await js('qa.open("codex","/tmp/images/a.png");qa.store.getState().setTheme("light")');await delay(150);
 assert((await js('document.querySelector(".image-studio-latest").textContent')).includes('Latest turn'));
 const beforeSend=await js('qa.sent.length');
 await click('[aria-label="Send"]');await until('qa.sent.length>'+beforeSend,'shared composer sends the image edit');
 assert((await js('qa.sent.at(-1).payload.effectivePrompt')).includes('Keep my draft'));
 assert((await js('qa.sent.at(-1).payload.effectivePrompt')).includes('Use the available image generation/editing skill'));
 assert.deepEqual(await js('qa.sent.at(-1).payload.codexSkills'),[{name:'imagegen',path:'/skills/imagegen/SKILL.md'}]);
 assert.equal(await js('qa.studio.getState().sessions.codex.selected.length'),0,'send clears attached selection');
 assert.equal(await js('qa.studio.getState().sessions.codex.feedback'),undefined,'new send clears previous image-edit feedback');
 await until('document.querySelector(".image-studio-latest").textContent.includes("Working")','sending changes Latest turn to Working');
 assert.equal(await js('qa.store.getState().activeRightUtilityTab'),'images:codex','sending stays in Images');
 assert.equal(await js('qa.store.getState().rightPanelFullscreen'),'images');
 await js('qa.result("running")');await delay(150);
 assert((await js('document.querySelector(".image-studio-latest").textContent')).includes('Working'),'image arrival does not finish the turn');
 await shot('latest-turn-working');
 await js('qa.update("codex",{messages:[...qa.store.getState().sessions.codex.messages,{type:"assistant",uuid:"newest-reply",phase:"final_answer",message:{content:[{type:"text",text:"The newest edit is complete. [Download newest image](/tmp/images/result-6.png)"}]}}]});qa.store.getState().handleServerEvent({type:"session.status",payload:{sessionId:"codex",status:"completed"}})');
 await until('document.querySelector(".image-studio-latest").textContent.includes("Latest turn")','completion restores Latest turn');
 assert.equal(await js('qa.store.getState().activeRightUtilityTab'),'images:codex','completion stays in Images');
 assert.equal(await js('qa.store.getState().rightPanelFullscreen'),'images');
 await click('.image-studio-latest');
 assert((await js('document.querySelector(".image-studio-latest-content").textContent')).includes('The newest edit is complete.'));
 assert(!(await js('document.querySelector(".image-studio-latest-content").textContent')).includes('The new cover keeps'));
 await shot('latest-turn-completed');

 // A panorama and a portrait in one turn keep their aspect ratios and widths
 // while resizing changes only the visible portion of the canvas.
 await js('(()=>{for(const [name,width,height] of [["wide",1600,600],["portrait",600,900]]){const c=document.createElement("canvas");c.width=width;c.height=height;const x=c.getContext("2d");x.fillStyle=name==="wide"?"#c4cfda":"#ddd5be";x.fillRect(0,0,width,height);qa.files["/tmp/images/"+name+".png"]=c.toDataURL()}qa.update("codex",{messages:[...qa.store.getState().sessions.codex.messages,{type:"user_prompt",prompt:"Mixed aspect ratios",createdAt:Date.now()},{type:"assistant",uuid:"mixed-ratios",message:{content:[{type:"text",text:"![Wide](/tmp/images/wide.png) ![Portrait](/tmp/images/portrait.png)"}]}}]});qa.studio.getState().patch("codex",{view:"canvas",activePath:"/tmp/images/portrait.png",selected:["/tmp/images/portrait.png"]})})()');
 await until('!!document.querySelector("[data-image-path=\\"/tmp/images/portrait.png\\"]")','mixed ratio images');
 await until('!!document.querySelector("[data-image-path=\\"/tmp/images/wide.png\\"]")','panorama image');
 const mixed=()=>js('(()=>{const w=document.querySelector("[data-image-path=\\"/tmp/images/wide.png\\"]").getBoundingClientRect(),p=document.querySelector("[data-image-path=\\"/tmp/images/portrait.png\\"]").getBoundingClientRect(),v=document.querySelector(".image-studio-viewport").getBoundingClientRect();return {wide:w.width,portrait:p.width,height:p.height,sameRow:Math.abs(w.top-p.top)<1,visible:p.left>=v.left-1&&p.right<=v.right+1}})()');
 const mixedFull=await mixed();assert(mixedFull.sameRow);assert(Math.abs(mixedFull.wide-292*1600/600)<1);assert(Math.abs(mixedFull.portrait-292*600/900)<1);
 w.setContentSize(520,800);await delay(250);
 const mixedNarrow=await mixed();assert.equal(mixedNarrow.wide,mixedFull.wide);assert(mixedNarrow.sameRow);assert(mixedNarrow.visible,'resizing keeps the active image visible');
 await shot('canvas-mixed-ratios-narrow');
 await click('[aria-label="Zoom options"]');await click('.image-studio-zoom [role=menu] button:nth-child(2)');await click('[aria-label="Zoom options"]');
 assert(Math.abs((await mixed()).height-292*1.2)<1,'canvas zoom scales the row without reflow');
 assert((await mixed()).sameRow);
 w.setContentSize(1200,900);await delay(200);await shot('canvas-mixed-ratios');

 assert.deepEqual(errors,[],'renderer console errors');
 console.log('image studio Electron: gallery, canvas, comments, selection, zoom, brush/mask, both providers, queue/cancel, results, failures, readonly, themes passed');app.exit(0);
}catch(e){console.error(e,errors);await shot('failure');app.exit(1)}});
`;
try{
 await writeFile(path.join(dir,'index.html'),'<html><body style="margin:0"><div id="root"></div><script type="module" src="./probe.tsx"></script></body></html>');
 await writeFile(path.join(dir,'probe.tsx'),harness);await writeFile(path.join(dir,'main.cjs'),main);
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),plugins:[{name:'image-studio-qa',enforce:'pre',transform(source,id){if(id.endsWith('/src/ui/App.tsx'))return source+'\nexport { RightUtilityWorkspace };'}}],server:{host:'127.0.0.1',port:0,strictPort:false}});await server.listen();
 const env={...process.env,QA_URL:new URL(path.relative(root,dir)+'/index.html',server.resolvedUrls.local[0]).href,QA_CAPTURE:path.join(root,'output/playwright/image-studio')};delete env.ELECTRON_RUN_AS_NODE;
 await new Promise((resolve,reject)=>{const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(dir,'main.cjs')],{env,stdio:'inherit'});const timeout=setTimeout(()=>{child.kill();reject(Error('Electron test timed out'))},60000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);code===0?resolve():reject(Error('Electron test failed: '+code))})});
}finally{await server?.close();await rm(dir,{recursive:true,force:true})}

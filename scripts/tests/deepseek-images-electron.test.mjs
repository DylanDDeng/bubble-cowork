import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import sharp from 'sharp';
const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const temp = await mkdtemp(path.join(root, '.aegis-design-qa/deepseek-images-'));
const harness = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {Toaster} from 'sonner';
import {PromptInput} from '/src/ui/components/PromptInput.tsx';
import {NewSessionView} from '/src/ui/components/NewSessionView.tsx';
import {ClaudeUsageSettingsContent} from '/src/ui/components/settings/ClaudeUsageSettings.tsx';
import {MessageCard} from '/src/ui/components/MessageCard.tsx';
import {useAppStore} from '/src/ui/store/useAppStore.ts';
import {normalizeToolResultBlock} from '/src/ui/utils/message-content.ts';
import '/src/ui/index.css';
const cwd = new URL(location.href).searchParams.get('cwd');
const a = useAppStore.getState(); const id = a.createDraftSession(cwd);
useAppStore.setState(s=>({connected:true,projectCwd:cwd,sessions:{...s.sessions,[id]:{...s.sessions[id],isDraft:false,provider:'deepseek',model:'deepseek-v4-pro',status:'idle',messages:[]}}}));
a.setActiveSession(id);
window.electron.onServerEvent(e=>a.handleServerEvent(e));
window.qa={id,store:useAppStore,editor:()=>document.querySelector('[role=textbox]'),images:()=>document.querySelectorAll('button[aria-label="Remove attachment"]'),restore:(messages)=>useAppStore.setState(s=>({sessions:{...s.sessions,[id]:{...s.sessions[id],messages,status:'idle',model:'deepseek-flash'}}}))};
function Harness(){
 const [fresh,setFresh]=useState(false);qa.fresh=setFresh;
 const [usage,setUsage]=useState(false);qa.usage=setUsage;
 const s=useAppStore(),session=s.sessions[id];
 const resultMap=new Map(),statusMap=new Map();
 for(const m of session.messages)for(const b of m.message?.content||[]){const r=normalizeToolResultBlock(b);if(r){resultMap.set(r.tool_use_id,r);statusMap.set(r.tool_use_id,r.is_error?'error':'success');}}
 return <Tooltip.Provider><div style={{height:'100vh',display:'flex',flexDirection:'column',background:'var(--bg-primary)',color:'var(--text-primary)',padding:24}}>
 <header style={{fontSize:14}}>DeepSeek image understanding</header>
 {usage?<div style={{overflow:'auto'}}><ClaudeUsageSettingsContent/></div>:fresh?<NewSessionView/>:<><main style={{flex:1,overflow:'auto',padding:'24px 0'}}>{session.messages.map((m,i)=><MessageCard key={i} message={m} sessionId={id} toolStatusMap={statusMap} toolResultsMap={resultMap}/>)}</main><PromptInput sessionId={id}/></>}
 <Toaster closeButton/></div></Tooltip.Provider>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
let vite;
try {
  for (const format of ['png','jpeg','webp','gif']) await sharp({ create:{ width:240,height:160,channels:3,background:'#287bbd' } }).toFormat(format).toFile(path.join(temp, `sample.${format}`));
  await writeFile(path.join(temp,'index.html'), '<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(temp,'harness.tsx'),harness);
  // Fixtures are complete before startup; Electron cache writes must not reload the UI.
  vite=await createServer({root,configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0,strictPort:false,watch:{ignored:['**/.aegis-design-qa/**']}}});await vite.listen();
  const url=new URL(path.relative(root,temp)+'/index.html',vite.resolvedUrls.local[0]);url.searchParams.set('cwd',temp);
  await new Promise((resolve,reject)=>{
    const env={...process.env,QA_ROOT:root,QA_TEMP:temp,QA_URL:url.href,DEV_SERVER_URL:vite.resolvedUrls.local[0]};delete env.ELECTRON_RUN_AS_NODE;
    const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(root,'scripts/tests/deepseek-images-electron-main.cjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
    let output=''; child.stdout.on('data',c=>{output+=c;process.stdout.write(c);});child.stderr.on('data',c=>process.stderr.write(c));
    const timeout=setTimeout(()=>{child.kill();reject(new Error('DeepSeek image Electron test timed out'));},90000);
    child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);code===0&&output.includes('DEEPSEEK_IMAGE_UI_OK')?resolve():reject(new Error('Electron image test failed'));});
  });
} finally {await vite?.close(); await rm(temp,{recursive:true,force:true});}

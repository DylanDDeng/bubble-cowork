// Real Kimi CLI tools with a deterministic local model. No paid model calls or
// user config changes; KIMI_CODE_HOME and every file belong to this fixture.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { createRequire, Module } from 'node:module';
const binary = process.env.KIMI_CODE_PATH || path.join(homedir(), '.kimi-code/bin/kimi');
if (!fs.existsSync(binary)) throw new Error('Install Kimi CLI to run its native project-folder regression');
const root = fs.mkdtempSync(path.join(process.cwd(), '.aegis-kimi-project-roots-'));
const primary = path.join(root, 'primary'), extra = path.join(root, 'extra'), home = path.join(root, 'home');
for (const dir of [primary, extra, home]) fs.mkdirSync(dir);
const target = path.join(extra, 'probe.txt');
let calls = [], results = [], count = 0;
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  let body; try { body = JSON.parse(raw); } catch { res.writeHead(404); res.end(); return; }
  results.push(...(body.messages?.filter(m => m.role === 'tool') ?? []));
  const next = calls[count++];
  const call = next ? { index: 0, id: `call-${count}`, type: 'function', function: {name: next.name, arguments: JSON.stringify(next.args)} } : null;
  const chunk = (delta, finish_reason) => ({id:'fixture', object:'chat.completion.chunk', created:1, model:'fixture',
    choices:[{index:0,delta,finish_reason}]});
  res.writeHead(200, {'content-type':'text/event-stream'});
  res.write('data: ' + JSON.stringify(chunk(call ? {role:'assistant',tool_calls:[call]} : {role:'assistant',content:'done'}, null)) + '\n\n');
  res.end('data: ' + JSON.stringify(chunk({}, call ? 'tool_calls' : 'stop')) + '\n\ndata: [DONE]\n\n');
});
let child;
let web;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = `default_model = "fixture"\n[providers.local]\ntype = "openai"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\napi_key = "local-test-only"\n[models.fixture]\nprovider = "local"\nmodel = "fixture"\nmax_context_size = 128000\n`;
  fs.writeFileSync(path.join(home,'config.toml'), config);
  async function run(toolCalls, args = []) {
    calls = toolCalls; count = 0; results = [];
    child = spawn(binary, [...args, '--prompt', `Project folders: ${primary}, ${extra}. Use absolute paths outside cwd. Follow the requested file operations.`, '--output-format','stream-json'], {
      cwd:primary, env:{...process.env,KIMI_CODE_HOME:home}, stdio:['ignore','pipe','pipe']
    });
    let output = '', errors = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', c => errors += c);
    const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
    try {
      await new Promise((resolve,reject) => {child.on('exit', resolve); child.on('error',reject);});
      assert.equal(child.exitCode, 0, errors || output);
    } finally {clearTimeout(timer);}
    assert(count >= toolCalls.length + 1, 'native tool loop completed');
    assert.equal(fs.readFileSync(path.join(home,'config.toml'),'utf8'), config);
    assert(!fs.existsSync(path.join(primary,'.kimi-code/local.toml')));
    assert(!fs.existsSync(path.join(extra,'.kimi-code/local.toml')));
    return output.split('\n').filter(Boolean).map(line => JSON.parse(line));
  }
  const first = await run([{name:'Write',args:{path:target,content:'kimi-extra-directory'}}, {name:'Read',args:{path:target}}]);
  assert.equal(fs.readFileSync(target,'utf8'), 'kimi-extra-directory');
  assert(results.some(r => String(r.content).includes('kimi-extra-directory')));
  const sessionId = first.find(event => event.type === 'session.resume_hint')?.session_id;
  assert(sessionId, 'native session persisted');
  await run([{name:'Read',args:{path:target}}, {name:'Edit',args:{path:target,old_string:'kimi-extra-directory',new_string:'resumed'}}], ['--session',sessionId]);
  assert.equal(fs.readFileSync(target,'utf8'), 'resumed');
  // The CLI forbids --prompt with --plan. Exercise the REST path Aegis
  // actually uses, with an isolated daemon and the same deterministic model.
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  web = spawn(binary, ['web','--no-open','--port',String(port)], {
    cwd:primary, env:{...process.env,KIMI_CODE_HOME:home}, stdio:['ignore','ignore','ignore']
  });
  const deadline = Date.now() + 15000;
  let token;
  while (Date.now() < deadline) {
    if (web.exitCode !== null) throw new Error('Isolated Kimi server exited');
    try {token = fs.readFileSync(path.join(home,'server.token'),'utf8').trim();} catch {}
    if (token) {
      try {if ((await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, {headers:{authorization:`Bearer ${token}`}})).ok) break;} catch {}
    }
    await new Promise(resolve => setTimeout(resolve,100));
  }
  assert(token, 'isolated server became ready');
  async function rest(route, body) {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1${route}`, {method:body?'POST':'GET',
      headers:{authorization:`Bearer ${token}`,'content-type':'application/json'}, body:body?JSON.stringify(body):undefined});
    const result = await res.json(); assert.equal(result.code,0,JSON.stringify(result)); return result.data;
  }
  const native = await rest('/sessions',{metadata:{cwd:primary}});
  calls = [{name:'Write',args:{path:target,content:'Plan must not write'}}]; count=0; results=[];
  const require = createRequire(import.meta.url);
  const oldLoad = Module._load;
  Module._load = function(name, ...args) {
    if (name === 'electron') return {app:{getPath:()=>home, isPackaged:false}};
    return oldLoad.call(this,name,...args);
  };
  let KimiServerManager;
  try { ({KimiServerManager} = require('../../dist-electron/electron/libs/provider/kimi-server-manager.js')); }
  finally {Module._load = oldLoad;}
  const manager = {request: (method, route, body) => rest(route, body)};
  await KimiServerManager.prototype.submitPrompt.call(manager, native.id, {content:[{type:'text',text:'Test the supplied write operation.'}],model:'fixture',permission_mode:'manual',plan_mode:true});
  const turnDeadline = Date.now() + 15000;
  while (count < 2 && Date.now() < turnDeadline) await new Promise(resolve => setTimeout(resolve,100));
  assert(count >= 2, JSON.stringify({count, results, detail:await rest(`/sessions/${native.id}`), status:await rest(`/sessions/${native.id}/status`)}));
  assert.equal(fs.readFileSync(target,'utf8'), 'resumed');
  assert(results.some(r => /plan|denied|not allowed/i.test(String(r.content))), 'native Plan rejection returned');
  const settleDeadline = Date.now() + 5000;
  while ((await rest(`/sessions/${native.id}/status`)).busy && Date.now() < settleDeadline) await new Promise(resolve=>setTimeout(resolve,50));
  calls = [{name:'Write',args:{path:target,content:'Plan exited'}}]; count=0; results=[];
  await KimiServerManager.prototype.submitPrompt.call(manager, native.id, {content:[{type:'text',text:'Write the supplied fixture.'}],model:'fixture',permission_mode:'yolo',plan_mode:false});
  assert.equal((await rest(`/sessions/${native.id}/status`)).plan_mode, false);
  const exitDeadline = Date.now() + 5000;
  while (count < 2 && Date.now() < exitDeadline) await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(fs.readFileSync(target,'utf8'), 'Plan exited');
  assert.equal(fs.readFileSync(path.join(home,'config.toml'),'utf8'), config);
  assert(!fs.existsSync(path.join(primary,'.kimi-code/local.toml')));
  console.log('Kimi native project folders: write/read, persisted resume/edit, Plan denial, no project/global config mutation passed');
} finally {
  if (child && child.exitCode === null) child.kill('SIGTERM');
  if (web && web.exitCode === null) {web.kill('SIGTERM'); await new Promise(resolve => web.on('exit',resolve));}
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(root,{recursive:true,force:true});
}

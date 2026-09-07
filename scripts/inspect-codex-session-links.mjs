import asar from '@electron/asar';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Read-only source audit. Never alters/re-signs the installed application.
const app = process.argv[2] || '/Applications/Codex.app';
const resources = path.join(app, 'Contents/Resources');
const archive = path.join(resources, 'app.asar');
const files = asar.listPackage(archive);
const find = regex => files.find(file => regex.test(file))?.replace(/^\//, '');
const initial = find(/\/webview\/assets\/app-initial-[^/]+\.js$/);
const primary = find(/\/webview\/assets\/app-primary-[^/]+\.js$/);
const main = find(/\/\.vite\/build\/main-[^/]+\.js$/);
const definitions = [
  ['copy-link', initial, 'function Bqi(', 150],
  ['copy-working-directory', initial, 'function zqi(', 220],
  ['reference-prompt', initial, 'These are live references to Codex tasks', 420],
  ['tool-capability', initial, 'function T2t(', 410],
  ['thread-start-tools', initial, 'e.registerDynamicTools!==!1', 360],
  ['reference-send-gate', primary, 'async function Lqr(', 640],
  ['unavailable-ui', primary, 'function GXr(', 360],
  ['menu-sharing', primary, 'function dAn(', 430],
  ['runtime-mcp-overrides', main, 'async function tk(', 1410],
  ['runtime-launch-connection', main, 'getConfigOverrides:()=>tk(e)', 100],
  ['read-thread-handler', initial, 'async function RXi(', 630],
];
const sources = new Map();
const evidence = definitions.map(([topic,file,needle,length]) => {
  if (!file) throw new Error(`Missing bundle for ${topic}`);
  if (!sources.has(file)) sources.set(file, asar.extractFile(archive,file));
  const data = sources.get(file), text = data.toString('utf8'), offset = text.indexOf(needle);
  if (offset < 0) throw new Error(`Codex changed: source anchor missing for ${topic}`);
  return {topic,archiveEntry:file,offsetUtf16:offset,sha256:createHash('sha256').update(data).digest('hex'),excerpt:text.slice(offset,offset+length)};
});
const plugin=path.join(resources,'plugins/openai-bundled/plugins/codex-app-tools/server.mjs');
const pluginText=readFileSync(plugin,'utf8');
for(const needle of ['var PIPE_PATH_ENV_VAR = "CODEX_APP_TOOLS_PIPE_PATH"','server.setRequestHandler(CallToolRequestSchema','async function listTools()','net.createConnection(this.pipePath)']){
  const offset=pluginText.indexOf(needle);if(offset<0)throw Error(`Missing plugin anchor: ${needle}`);
  evidence.push({topic:'app-host-bridge',file:plugin,line:pluginText.slice(0,offset).split('\n').length,excerpt:pluginText.slice(offset,offset+300)});
}
const result={app,version:execFileSync('plutil',['-extract','CFBundleShortVersionString','raw',path.join(app,'Contents/Info.plist')],{encoding:'utf8'}).trim(),build:execFileSync('plutil',['-extract','CFBundleVersion','raw',path.join(app,'Contents/Info.plist')],{encoding:'utf8'}).trim(),evidence};
mkdirSync('output/session-links-qa',{recursive:true});
writeFileSync('output/session-links-qa/codex-source-evidence.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({version:result.version,build:result.build,anchors:evidence.length,output:'output/session-links-qa/codex-source-evidence.json'}));

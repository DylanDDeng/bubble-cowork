import { query, qodercliAuth } from '@qoder-ai/qoder-agent-sdk';

// A held-open iterable that yields NOTHING for 20s, then one message.
async function* idleThenOne() {
  await new Promise((r) => setTimeout(r, 20000));
  yield { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Reply with exactly: OK' }] }, parent_tool_use_id: null };
}

const t0 = Date.now();
let initAt = null;
const q = query({ prompt: idleThenOne(), options: { auth: qodercliAuth(), maxTurns: 1 } });
setTimeout(() => { if (!initAt) console.log(`t=12s: NO init yet (confirms lazy init)`); else console.log(`t=12s: init came at ${initAt}ms`); process.exit(0); }, 12000);
for await (const msg of q) {
  if (msg.type === 'system' && msg.subtype === 'init' && !initAt) {
    initAt = Date.now() - t0;
    console.log(`init at ${initAt}ms`);
  }
  if (msg.type === 'result') { console.log(`result at ${Date.now() - t0}ms`); break; }
}
process.exit(0);

import { query, qodercliAuth } from '@qoder-ai/qoder-agent-sdk';

async function probe(label, extraOptions) {
  const t0 = Date.now();
  try {
    const q = query({
      prompt: 'Reply with exactly: OK',
      options: { auth: qodercliAuth(), maxTurns: 1, stderr: (d) => console.log(`[${label} stderr]`, String(d).slice(0, 300)), ...extraOptions },
    });
    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        console.log(`[${label}] init ok in ${Date.now() - t0}ms, session=${msg.session_id}`);
      }
      if (msg.type === 'result') {
        console.log(`[${label}] result ${msg.subtype} in ${Date.now() - t0}ms`);
      }
    }
    console.log(`[${label}] DONE in ${Date.now() - t0}ms`);
  } catch (error) {
    console.log(`[${label}] ERROR in ${Date.now() - t0}ms:`, error?.message?.slice(0, 300));
  }
}

await probe('bundled', {});
await probe('machine-qodercli', { pathToQoderCLIExecutable: process.env.HOME + '/.local/bin/qodercli' });
process.exit(0);

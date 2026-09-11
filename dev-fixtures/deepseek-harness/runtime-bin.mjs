#!/usr/bin/env node
// Boot the DeepSeek Harness SDK runtime from this profile's cordis.yml
// (dsh-acp-demo bin pattern, minus the snapshot machinery). stdout carries
// the SDK JSON-RPC protocol; diagnostics go to stderr only.
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot';
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server';
import { SessionId } from '@deepseek-ai/dsh-session';
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { installDeepseekSdkResumeShim } from './runtime-resume-shim.mjs';

const NAME = 'aegis-dsh-sdk-runtime';
installFailLoud(NAME);
loadEnv(NAME);
process.env.AEGIS_DSH_ATTACHMENT_HOME ||= join(homedir(), '.aegis', 'deepseek');
installDeepseekSdkResumeShim({ HarnessSdkJsonRpcServer, SessionId });
// SDK 0.1.5 launches `dshBin --profile sdk --patch <config>`. Aegis owns
// the complete composition (including temporary MCP rows), so this single
// patch is our config, not an overlay on the user's global DSH profile.
const { values, positionals } = parseArgs({
  options: { profile: { type: 'string' }, patch: { type: 'string', multiple: true } },
  allowPositionals: true,
});
if ((values.profile && values.profile !== 'sdk') ||
    (values.patch?.length ?? 0) > 1 || positionals.length > 1 ||
    (values.patch?.length && positionals.length)) {
  throw new Error('Aegis runtime requires one SDK composition config');
}
await boot(
  NAME,
  resolveConfigPath(values.patch?.[0] ?? positionals[0] ?? './cordis.yml', undefined),
  undefined,
  undefined,
  new URL('./', import.meta.url).href,
);

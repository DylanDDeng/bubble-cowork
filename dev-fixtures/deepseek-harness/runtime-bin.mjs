#!/usr/bin/env node
// Boot the DeepSeek Harness SDK runtime from this profile's cordis.yml
// (dsh-acp-demo bin pattern, minus the snapshot machinery). stdout carries
// the SDK JSON-RPC protocol; diagnostics go to stderr only.
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot';
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server';
import { SessionId } from '@deepseek-ai/dsh-session';
import { installDeepseekSdkResumeShim } from './runtime-resume-shim.mjs';

const NAME = 'aegis-dsh-sdk-runtime';
installFailLoud(NAME);
loadEnv(NAME);
installDeepseekSdkResumeShim({ HarnessSdkJsonRpcServer, SessionId });
await boot(NAME, resolveConfigPath(process.argv[2] ?? './cordis.yml', undefined));

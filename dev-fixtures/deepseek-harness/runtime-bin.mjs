#!/usr/bin/env node
// Boot the DeepSeek Harness SDK runtime from this profile's cordis.yml
// (dsh-acp-demo bin pattern, minus the snapshot machinery). stdout carries
// the SDK JSON-RPC protocol; diagnostics go to stderr only.
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot';

const NAME = 'aegis-dsh-sdk-runtime';
installFailLoud(NAME);
loadEnv(NAME);
await boot(NAME, resolveConfigPath(process.argv[2] ?? './cordis.yml', undefined));

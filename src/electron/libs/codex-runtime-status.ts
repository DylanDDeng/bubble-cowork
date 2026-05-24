import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { CodexRuntimeStatus } from '../../shared/types';
import { getCodexModelConfig } from './codex-settings';

const CODEX_CONFIG_PATH = join(homedir(), '.codex', 'config.toml');

function checkCodexAppServer(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('codex', ['app-server', '--help'], { timeout: 2500 }, (error, stdout, stderr) => {
      const output = `${stdout}\n${stderr}`;
      resolve(!error && output.includes('app-server'));
    });
  });
}

export async function getCodexRuntimeStatus(): Promise<CodexRuntimeStatus> {
  const cliAvailable = await checkCodexAppServer();
  const configExists = existsSync(CODEX_CONFIG_PATH);
  const modelConfig = getCodexModelConfig();
  const hasModelConfig = Boolean(modelConfig.defaultModel || modelConfig.options.length > 0);

  return {
    ready: cliAvailable && (configExists || hasModelConfig),
    cliAvailable,
    configExists,
    hasModelConfig,
    checkedAt: Date.now(),
  };
}

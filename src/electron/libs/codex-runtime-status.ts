import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { CodexRuntimeStatus } from '../../shared/types';
import { getCodexModelConfig } from './codex-settings';

const CODEX_CONFIG_PATH = join(homedir(), '.codex', 'config.toml');

function checkCommandOnPath(command: string): Promise<boolean> {
  const locator = process.platform === 'win32' ? 'where' : 'which';

  return new Promise((resolve) => {
    execFile(locator, [command], { timeout: 2500 }, (error, stdout) => {
      resolve(!error && stdout.trim().length > 0);
    });
  });
}

export async function getCodexRuntimeStatus(): Promise<CodexRuntimeStatus> {
  const cliAvailable = await checkCommandOnPath('codex-acp');
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

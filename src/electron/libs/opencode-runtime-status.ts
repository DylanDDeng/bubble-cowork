import { execFile } from 'child_process';
import { existsSync } from 'fs';
import type { OpenCodeRuntimeStatus } from '../../shared/types';
import { getOpencodeConfigPath, getOpencodeModelConfig } from './opencode-settings';

function checkCommandOnPath(command: string): Promise<boolean> {
  const locator = process.platform === 'win32' ? 'where' : 'which';

  return new Promise((resolve) => {
    execFile(locator, [command], { timeout: 2500 }, (error, stdout) => {
      resolve(!error && stdout.trim().length > 0);
    });
  });
}

export async function getOpencodeRuntimeStatus(): Promise<OpenCodeRuntimeStatus> {
  const cliAvailable = await checkCommandOnPath('opencode');
  const configExists = existsSync(getOpencodeConfigPath());
  const modelConfig = getOpencodeModelConfig();
  const hasModelConfig = Boolean(modelConfig.defaultModel || modelConfig.options.length > 0);

  return {
    ready: cliAvailable && (configExists || hasModelConfig),
    cliAvailable,
    configExists,
    hasModelConfig,
    checkedAt: Date.now(),
  };
}

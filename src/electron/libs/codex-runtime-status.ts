import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { CodexRuntimeStatus } from '../../shared/types';
import { getCodexModelConfig } from './codex-settings';

const CODEX_CONFIG_PATH = join(homedir(), '.codex', 'config.toml');

function checkCodexAppServer(): Promise<{ ok: boolean; error: string | null }> {
  return new Promise((resolve) => {
    // 5s to match the Claude probe: the 2.5s budget produced false
    // "not installed" verdicts when the startup probe burst competed with
    // Vite/Electron dev spin-up for CPU.
    execFile('codex', ['app-server', '--help'], { timeout: 5000 }, (error, stdout, stderr) => {
      const output = `${stdout}\n${stderr}`;
      if (!error && output.includes('app-server')) {
        resolve({ ok: true, error: null });
        return;
      }
      // Keep the failure reason so the UI can tell "codex not found" apart
      // from "a codex shim ran and crashed" (e.g. a stale node_modules
      // install shadowing the real CLI on PATH).
      const firstStderrLine = (stderr || '').trim().split('\n')[0] || '';
      const messageLines = (error?.message || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !line.startsWith('at '));
      const reason =
        [messageLines[0], firstStderrLine]
          .filter((part) => part && part !== 'Command failed: codex app-server --help')
          .join(' | ') || 'codex app-server --help did not succeed';
      resolve({ ok: false, error: reason });
    });
  });
}

export async function getCodexRuntimeStatus(): Promise<CodexRuntimeStatus> {
  const probe = await checkCodexAppServer();
  const cliAvailable = probe.ok;
  const configExists = existsSync(CODEX_CONFIG_PATH);
  const modelConfig = getCodexModelConfig();
  const hasModelConfig = Boolean(modelConfig.defaultModel || modelConfig.options.length > 0);

  return {
    ready: cliAvailable && (configExists || hasModelConfig),
    cliAvailable,
    cliError: cliAvailable ? null : probe.error,
    configExists,
    hasModelConfig,
    checkedAt: Date.now(),
  };
}

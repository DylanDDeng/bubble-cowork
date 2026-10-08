import { app } from 'electron';
import { chmodSync, existsSync } from 'fs';
import { basename, dirname, isAbsolute, join } from 'path';
import { getAppPreferences } from './app-preferences';
import { isDev } from '../util';

export interface ShellLaunch {
  file: string;
  args: string[];
}

// Variables from the app's own process that must not leak into user shells.
const ENV_NOT_INHERITED = ['PORT', 'ELECTRON_RENDERER_PORT', 'ELECTRON_RUN_AS_NODE'];

export const describeLaunch = (launch: ShellLaunch) => [launch.file, ...launch.args].join(' ');

function launchFor(file: string): ShellLaunch {
  // zsh prints a reverse-video "%" before prompts that follow partial lines;
  // in an embedded terminal that marker only adds noise.
  const isZsh = process.platform !== 'win32' && basename(file).toLowerCase() === 'zsh';
  return { file, args: isZsh ? ['-o', 'nopromptsp'] : [] };
}

/** First word of $SHELL, without quotes, since some setups store flags there. */
function loginShell(): string | null {
  const raw = process.env.SHELL?.trim();
  if (!raw) return null;
  if (process.platform === 'win32') return raw;
  return raw.split(/\s+/)[0].replace(/^['"]|['"]$/g, '') || null;
}

/**
 * Shells to try, in order. A shell chosen in settings is used alone when it
 * exists; otherwise the platform defaults, skipping absolute paths that are
 * not installed.
 */
export function shellLaunchOrder(preference: string = getAppPreferences().terminalShell): ShellLaunch[] {
  if (preference !== 'system' && existsSync(preference)) return [launchFor(preference)];

  const files =
    process.platform === 'win32'
      ? [process.env.COMSPEC || 'powershell.exe', 'cmd.exe']
      : [loginShell(), '/bin/zsh', '/bin/bash', '/bin/sh', 'zsh', 'bash', 'sh'];
  const launches = new Map<string, ShellLaunch>();
  for (const file of files) {
    if (!file || (process.platform !== 'win32' && isAbsolute(file) && !existsSync(file))) continue;
    const launch = launchFor(file);
    launches.set(describeLaunch(launch), launch);
  }
  return [...launches.values()];
}

/** The environment for a new shell: the app's own, plus overrides, with terminal capabilities set. */
export function shellEnvironment(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...overrides })) {
    if (typeof value === 'string' && !ENV_NOT_INHERITED.includes(key)) env[key] = value;
  }
  env.TERM = overrides.TERM || process.env.TERM || 'xterm-256color';
  env.COLORTERM = overrides.COLORTERM || process.env.COLORTERM || 'truecolor';
  return env;
}

let helpersChecked = false;

/**
 * node-pty starts shells through a small `spawn-helper` binary; packaging can
 * drop its execute bit. Restore it once per process.
 */
export function ensurePtyHelperExecutable(): void {
  if (helpersChecked || process.platform === 'win32') return;
  helpersChecked = true;
  const candidates: string[] = [];
  try {
    const packaged = join(app?.getAppPath?.() ?? '', 'node_modules', 'node-pty');
    candidates.push(join(packaged, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'));
    candidates.push(join(packaged, 'build', 'Release', 'spawn-helper'));
  } catch {
    // No app path outside Electron.
  }
  try {
    candidates.push(join(dirname(require.resolve('node-pty')), 'build', 'Release', 'spawn-helper'));
  } catch {
    // node-pty resolved elsewhere.
  }
  for (const helper of candidates) {
    try {
      if (existsSync(helper)) chmodSync(helper, 0o755);
    } catch (error) {
      if (isDev()) console.warn('[Terminal] Could not make spawn-helper executable:', helper, error);
    }
  }
}

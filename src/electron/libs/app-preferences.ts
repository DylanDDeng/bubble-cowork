import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { DEFAULT_APP_PREFERENCES, normalizeAppPreferences, type AppPreferences } from '../../shared/app-preferences';

let cache: AppPreferences | undefined;
const running = new Set<string>();
let blocker: number | undefined;
const file = () => join(app.getPath('userData'), 'app-preferences.json');

export function getAppPreferences(): AppPreferences {
  if (!cache) {
    try { cache = normalizeAppPreferences(JSON.parse(readFileSync(file(), 'utf8'))); }
    catch { cache = { ...DEFAULT_APP_PREFERENCES }; }
  }
  return { ...cache };
}

export function getTerminalShellOptions(): { value: string; label: string }[] {
  const names = process.platform === 'win32' ? ['pwsh.exe', 'powershell.exe', 'cmd.exe'] : ['/bin/zsh', '/bin/bash', '/bin/sh', 'fish'];
  return [{ value: 'system', label: 'System default' }, ...names.flatMap(name => {
    const candidate = name.includes('/') ? name : (process.env.PATH || '').split(delimiter).map(dir => join(dir, name)).find(existsSync);
    return candidate && existsSync(candidate) ? [{ value: candidate, label: name.split('/').pop()!.replace('.exe', '') }] : [];
  })];
}

function updateSleepBlocker() {
  const needed = getAppPreferences().preventSleep && running.size > 0;
  if (needed && blocker === undefined) blocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!needed && blocker !== undefined) { powerSaveBlocker.stop(blocker); blocker = undefined; }
}

export function trackTaskPowerState(id: string, isRunning: boolean) {
  if (isRunning) running.add(id); else running.delete(id);
  updateSleepBlocker();
}

export function setAppPreferences(patch: Partial<AppPreferences>): AppPreferences {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid preferences.');
  if (patch.terminalShell !== undefined && !getTerminalShellOptions().some(shell => shell.value === patch.terminalShell)) throw new Error('This shell is not available.');
  const next = normalizeAppPreferences({ ...getAppPreferences(), ...patch });
  const target = file();
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(`${target}.tmp`, JSON.stringify(next, null, 2));
  renameSync(`${target}.tmp`, target);
  cache = next;
  updateSleepBlocker();
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('app-preferences-changed', next);
  return { ...next };
}

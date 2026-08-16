// Browser Use origin permissions: persisted per-origin policy consulted by
// every navigation-consent path (Claude in-process MCP + the HTTP server for
// codex/kimi/qoder/opencode). Codex-parity three-state model:
//   allow — the agent navigates this origin without asking
//   block — navigation is denied without asking
//   ask   — (default) the approval card is shown
// Plus a global default that applies to unlisted origins.

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

export type BrowserUseOriginPolicy = 'allow' | 'block' | 'ask';

export interface BrowserUsePermissionSettings {
  /** Policy for origins not in `origins`. Default 'ask'. */
  defaultPolicy: BrowserUseOriginPolicy;
  /** origin (https://example.com) -> policy. */
  origins: Record<string, BrowserUseOriginPolicy>;
}

const SETTINGS_PATH = path.join(homedir(), '.aegis', 'browser-use-permissions.json');

const DEFAULT_SETTINGS: BrowserUsePermissionSettings = {
  defaultPolicy: 'ask',
  origins: {},
};

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '');
}

export function getBrowserUsePermissionSettings(): BrowserUsePermissionSettings {
  try {
    const raw = readFileSync(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<BrowserUsePermissionSettings>;
    const defaultPolicy =
      parsed.defaultPolicy === 'allow' || parsed.defaultPolicy === 'block' || parsed.defaultPolicy === 'ask'
        ? parsed.defaultPolicy
        : 'ask';
    const origins: Record<string, BrowserUseOriginPolicy> = {};
    if (parsed.origins && typeof parsed.origins === 'object') {
      for (const [origin, policy] of Object.entries(parsed.origins)) {
        if (policy === 'allow' || policy === 'block' || policy === 'ask') {
          origins[normalizeOrigin(origin)] = policy;
        }
      }
    }
    return { defaultPolicy, origins };
  } catch {
    return { ...DEFAULT_SETTINGS, origins: {} };
  }
}

export function saveBrowserUsePermissionSettings(settings: BrowserUsePermissionSettings): void {
  mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  try {
    chmodSync(SETTINGS_PATH, 0o600);
  } catch {
    // chmod is best-effort (exotic filesystems)
  }
}

export function setBrowserUseOriginPolicy(origin: string, policy: BrowserUseOriginPolicy | null): void {
  const settings = getBrowserUsePermissionSettings();
  const key = normalizeOrigin(origin);
  if (policy === null) delete settings.origins[key];
  else settings.origins[key] = policy;
  saveBrowserUsePermissionSettings(settings);
}

export function setBrowserUseDefaultPolicy(policy: BrowserUseOriginPolicy): void {
  const settings = getBrowserUsePermissionSettings();
  settings.defaultPolicy = policy;
  saveBrowserUsePermissionSettings(settings);
}

/**
 * Resolve the effective policy for a URL. Returns 'ask' for unparsable URLs
 * (fail toward asking, never toward silent navigation).
 */
export function resolveBrowserUsePolicy(url: string): BrowserUseOriginPolicy {
  let origin: string;
  try {
    origin = normalizeOrigin(new URL(url).origin);
  } catch {
    return 'ask';
  }
  const settings = getBrowserUsePermissionSettings();
  return settings.origins[origin] ?? settings.defaultPolicy;
}

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
  /** Master switch for the built-in browser-use feature (default true).
   * Off = no MCP entries anywhere, no HTTP server, no Claude injection. */
  enabled: boolean;
  /** Policy for origins not in `origins`. Default 'ask'. */
  defaultPolicy: BrowserUseOriginPolicy;
  /** origin (https://example.com) -> policy. */
  origins: Record<string, BrowserUseOriginPolicy>;
}

const DEFAULT_SETTINGS_PATH = path.join(homedir(), '.aegis', 'browser-use-permissions.json');

function settingsPath(): string {
  return process.env.AEGIS_BROWSER_USE_SETTINGS_PATH?.trim() || DEFAULT_SETTINGS_PATH;
}

const DEFAULT_SETTINGS: BrowserUsePermissionSettings = {
  enabled: true,
  defaultPolicy: 'ask',
  origins: {},
};

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '');
}

export function getBrowserUsePermissionSettings(): BrowserUsePermissionSettings {
  try {
    const raw = readFileSync(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<BrowserUsePermissionSettings>;
    const enabled = typeof parsed.enabled === 'boolean' ? parsed.enabled : true;
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
    return { enabled, defaultPolicy, origins };
  } catch {
    return { ...DEFAULT_SETTINGS, origins: {} };
  }
}

export function saveBrowserUsePermissionSettings(settings: BrowserUsePermissionSettings): void {
  const targetPath = settingsPath();
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, JSON.stringify(settings, null, 2));
  try {
    chmodSync(targetPath, 0o600);
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

/** Master switch: built-in browser use is on unless explicitly disabled. */
export function isBrowserUseEnabled(): boolean {
  if (process.env.AEGIS_BROWSER_USE_TEST_MODE === '1') return true;
  return getBrowserUsePermissionSettings().enabled;
}

export function setBrowserUseEnabled(enabled: boolean): void {
  const settings = getBrowserUsePermissionSettings();
  settings.enabled = enabled;
  saveBrowserUsePermissionSettings(settings);
}

/**
 * Resolve the effective policy for a URL. Returns 'ask' for unparsable URLs
 * (fail toward asking, never toward silent navigation).
 */
export function resolveBrowserUsePolicy(url: string): BrowserUseOriginPolicy {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'ask';
  }
  const origin = normalizeOrigin(parsed.origin);
  const settings = getBrowserUsePermissionSettings();
  const exact = settings.origins[origin];
  if (exact) return exact;

  // Imported domain cookies apply to subdomains. An explicit `ask` on an
  // ancestor origin of the same scheme must win over defaultPolicy=allow.
  const hostname = parsed.hostname.toLowerCase();
  for (const [pinned, policy] of Object.entries(settings.origins)) {
    if (policy !== 'ask') continue;
    let pinnedUrl: URL;
    try {
      pinnedUrl = new URL(pinned);
    } catch {
      continue;
    }
    if (pinnedUrl.protocol !== parsed.protocol) continue;
    const pinnedHost = pinnedUrl.hostname.toLowerCase();
    if (!pinnedHost) continue;
    if (hostname === pinnedHost || hostname.endsWith(`.${pinnedHost}`)) return 'ask';
  }
  return settings.defaultPolicy;
}

/**
 * Imported Chrome cookies must not inherit a global `allow`. Pin missing
 * origins to `ask` so defaultPolicy=allow cannot silently authorize them.
 * Existing explicit allow/block/ask rules are left untouched.
 */
export function pinBrowserUseOriginsAsk(origins: string[]): void {
  const settings = getBrowserUsePermissionSettings();
  let changed = false;
  for (const raw of origins) {
    let origin: string;
    try {
      origin = normalizeOrigin(new URL(raw).origin);
    } catch {
      continue;
    }
    if (settings.origins[origin]) continue;
    settings.origins[origin] = 'ask';
    changed = true;
  }
  if (changed) saveBrowserUsePermissionSettings(settings);
}

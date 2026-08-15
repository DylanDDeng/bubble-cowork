import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { safeStorage } from 'electron';
import type {
  DeepseekAgentPreset,
  DeepseekModelConfig,
  DeepseekPermissionMode,
  DeepseekReasoningEffort,
} from '../../shared/types';

/**
 * DeepSeek Harness launch profile: a directory holding package.json (the dsh
 * plugin set), cordis.yml (the SDK runtime composition), runtime-bin.mjs (the
 * app-boot entry) and an installed node_modules. The adapter spawns
 * `node runtime-bin.mjs cordis.yml` from this directory through
 * @deepseek-ai/dsh-sdk-client; the per-thread workspace rides DSH_CWD and the
 * SDK initialize cwd instead. See dev-fixtures/deepseek-harness for the
 * reference profile.
 */
const PROFILE_RUNTIME_BIN = 'runtime-bin.mjs';
const PROFILE_BOOT_MARKER = path.join('node_modules', '@deepseek-ai', 'dsh-app-boot');

// Aegis-owned key store. Written from the settings page; encrypted with the
// OS keychain when available, otherwise a 0600 plaintext fallback (matching
// how dsh itself stores ~/.dsh/.credentials.yaml).
const AEGIS_DEEPSEEK_KEY_FILE = path.join(homedir(), '.aegis', 'deepseek-api-key');

/** Where the effective key came from, for the settings page badge. */
export type DeepseekKeySource = 'aegis' | 'env' | 'dsh';

/**
 * The official dsh CLI stores its key in ~/.dsh/.credentials.yaml as a flat
 * `DEEPSEEK_API_KEY: sk-...` mapping (managed by @deepseek-ai/dsh-credentials-local).
 * Read-only: Aegis never writes to dsh's files.
 */
function readDshCredentialsKey(): string | null {
  try {
    const raw = readFileSync(path.join(homedir(), '.dsh', '.credentials.yaml'), 'utf8');
    const match = raw.match(/^\s*DEEPSEEK_API_KEY\s*:\s*["']?([^"'\s#]+)/m);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function readStoredKey(): { key: string; encrypted: boolean } | null {
  try {
    const raw = readFileSync(AEGIS_DEEPSEEK_KEY_FILE, 'utf8');
    const record = JSON.parse(raw) as { v?: string; p?: string; e?: boolean };
    if (record.e && record.v) {
      const decrypted = safeStorage.decryptString(Buffer.from(record.v, 'base64'));
      return decrypted ? { key: decrypted, encrypted: true } : null;
    }
    return record.p ? { key: record.p, encrypted: false } : null;
  } catch {
    return null;
  }
}

/** Save the key from the settings page into the Aegis-owned store. */
export function setStoredDeepseekApiKey(apiKey: string): void {
  const key = apiKey.trim();
  if (!key) throw new Error('API key must not be empty.');
  mkdirSync(path.dirname(AEGIS_DEEPSEEK_KEY_FILE), { recursive: true });
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(key).toString('base64');
    writeFileSync(AEGIS_DEEPSEEK_KEY_FILE, JSON.stringify({ v: encrypted, e: true }));
  } else {
    writeFileSync(AEGIS_DEEPSEEK_KEY_FILE, JSON.stringify({ p: key, e: false }));
  }
  chmodSync(AEGIS_DEEPSEEK_KEY_FILE, 0o600);
}

export function clearStoredDeepseekApiKey(): void {
  try {
    rmSync(AEGIS_DEEPSEEK_KEY_FILE);
  } catch {
    // absent store is already clear
  }
}

export function hasStoredDeepseekApiKey(): boolean {
  return readStoredKey() !== null;
}

export function hasDshCredentialsKey(): boolean {
  return readDshCredentialsKey() !== null;
}

export function resolveDeepseekProfileDir(): string | null {
  const candidates = [
    process.env.AEGIS_DSH_PROFILE_DIR?.trim(),
    path.join(homedir(), '.aegis', 'deepseek-harness'),
    path.join(process.cwd(), 'dev-fixtures', 'deepseek-harness'),
  ];
  for (const candidate of candidates) {
    if (
      candidate &&
      existsSync(path.join(candidate, PROFILE_RUNTIME_BIN)) &&
      existsSync(path.join(candidate, PROFILE_BOOT_MARKER))
    ) {
      return candidate;
    }
  }
  return null;
}

export function resolveDeepseekRuntimeEntry(profileDir: string): {
  binPath: string;
  configPath: string;
} {
  return {
    binPath: path.join(profileDir, PROFILE_RUNTIME_BIN),
    configPath: path.join(profileDir, 'cordis.yml'),
  };
}

/**
 * The effective key, by precedence: the Aegis settings-page store, then the
 * DEEPSEEK_API_KEY env var, then the installed dsh CLI's credential file
 * (read-only import). Never persisted by Aegis beyond the settings-page store.
 */
export function resolveDeepseekApiKey(): string | null {
  return resolveDeepseekApiKeyWithSource()?.key ?? null;
}

export function resolveDeepseekApiKeyWithSource(): { key: string; source: DeepseekKeySource } | null {
  const stored = readStoredKey();
  if (stored?.key) return { key: stored.key, source: 'aegis' };
  const envKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (envKey) return { key: envKey, source: 'env' };
  const dshKey = readDshCredentialsKey();
  if (dshKey) return { key: dshKey, source: 'dsh' };
  return null;
}

export function hasDeepseekCredentials(): boolean {
  return Boolean(resolveDeepseekApiKey());
}

/**
 * Child environment for the runtime process. DSH_CWD anchors the sandbox
 * policy and file tools to the thread workspace; DSH_PERMISSION_MODE selects
 * the sandbox mode (the SDK wire has no approval channel, so escalations
 * fail closed under workspace-write). DSH_REASONING_EFFORT configures the
 * profile's per-runtime conversation default. AEGIS_DSH_AGENT_PRESET selects
 * the model-facing Cordis composition before the SDK handshake begins.
 */
export function buildDeepseekEnv(options: {
  cwd: string;
  permissionMode?: DeepseekPermissionMode;
  agentPreset?: DeepseekAgentPreset;
  reasoningEffort?: DeepseekReasoningEffort;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const apiKey = resolveDeepseekApiKey();
  if (apiKey) {
    env.DEEPSEEK_API_KEY = apiKey;
  }
  env.DSH_CWD = options.cwd;
  env.DSH_PERMISSION_MODE = options.permissionMode || 'workspace-write';
  env.AEGIS_DSH_AGENT_PRESET = options.agentPreset || 'standard';
  env.DSH_REASONING_EFFORT = options.reasoningEffort || 'max';
  return env;
}

/**
 * Model catalog from the profile's cordis.yml: the llm-deepseek plugin's
 * `models` id list; the first listed model is the default (the model itself
 * travels per session over the SDK initialize handshake). The profile file is
 * the single source of truth — add models there, not here. Tolerant
 * line-scan instead of a YAML parser because the file uses app-defined
 * `!!js` tags.
 */
export function getDeepseekModelConfig(): DeepseekModelConfig {
  const profileDir = resolveDeepseekProfileDir();
  if (!profileDir) {
    return { defaultModel: null, options: [] };
  }
  let raw: string;
  try {
    raw = readFileSync(path.join(profileDir, 'cordis.yml'), 'utf8');
  } catch {
    return { defaultModel: null, options: [] };
  }

  const options: string[] = [];
  let inLlmDeepseek = false;
  let inModels = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^- id:/.test(line)) {
      inLlmDeepseek = false;
      inModels = false;
    }
    if (/name:\s*'@deepseek-ai\/dsh-llm-deepseek'/.test(line)) {
      inLlmDeepseek = true;
      continue;
    }
    if (!inLlmDeepseek) continue;
    if (/^\s+models:/.test(line)) {
      inModels = true;
      continue;
    }
    if (inModels) {
      const entry = line.match(/^\s+-\s+id:\s*(\S+)/);
      if (entry) {
        options.push(entry[1]);
      } else if (line.trim() && !/^\s{6,}/.test(line)) {
        inModels = false;
      }
    }
  }

  return { defaultModel: options[0] || null, options };
}

export function buildDeepseekSetupCommand(): string {
  return 'cd dev-fixtures/deepseek-harness && npm install';
}

export interface DeepseekRuntimeStatus {
  ready: boolean;
  profileInstalled: boolean;
  hasApiKey: boolean;
}

export function getDeepseekRuntimeStatus(): DeepseekRuntimeStatus {
  const profileInstalled = Boolean(resolveDeepseekProfileDir());
  const hasApiKey = hasDeepseekCredentials();
  return { ready: profileInstalled && hasApiKey, profileInstalled, hasApiKey };
}

export function formatDeepseekRuntimeBlockingMessage(status: DeepseekRuntimeStatus): string {
  if (!status.profileInstalled) {
    return `DeepSeek Harness launch profile is not installed. Run \`${buildDeepseekSetupCommand()}\` or set AEGIS_DSH_PROFILE_DIR, then retry.`;
  }
  if (!status.hasApiKey) {
    return 'DeepSeek Harness has no API key. Add one in Settings → Providers → DeepSeek, then retry.';
  }
  return 'DeepSeek Harness is not ready.';
}

/** Settings-page view: effective key (masked) + where it came from. */
export interface DeepseekKeyStatus {
  hasApiKey: boolean;
  keySource: DeepseekKeySource | null;
  /** True when the installed dsh CLI has a key Aegis could fall back to. */
  dshKeyAvailable: boolean;
}

export function getDeepseekKeyStatus(): DeepseekKeyStatus {
  const effective = resolveDeepseekApiKeyWithSource();
  return {
    hasApiKey: effective !== null,
    keySource: effective?.source ?? null,
    dshKeyAvailable: hasDshCredentialsKey(),
  };
}

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import type { DeepseekModelConfig, DeepseekPermissionMode } from '../../shared/types';

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

export const DEEPSEEK_HOME_DIR = path.join(homedir(), '.deepseek');

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
 * The runtime takes its key from DEEPSEEK_API_KEY. Fall back to the DeepSeek
 * TUI's ~/.deepseek/config.toml so a machine that already runs the TUI needs
 * no extra setup. Never persisted by Aegis.
 */
export function resolveDeepseekApiKey(): string | null {
  const envKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (envKey) return envKey;
  try {
    const toml = readFileSync(path.join(DEEPSEEK_HOME_DIR, 'config.toml'), 'utf8');
    const match = toml.match(/^\s*api_key\s*=\s*"([^"]+)"/m);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

export function hasDeepseekCredentials(): boolean {
  return Boolean(resolveDeepseekApiKey());
}

/**
 * Child environment for the runtime process. DSH_CWD anchors the sandbox
 * policy and file tools to the thread workspace; DSH_PERMISSION_MODE selects
 * the sandbox mode (the SDK wire has no approval channel, so escalations
 * fail closed under workspace-write).
 */
export function buildDeepseekEnv(options: {
  cwd: string;
  permissionMode?: DeepseekPermissionMode;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const apiKey = resolveDeepseekApiKey();
  if (apiKey) {
    env.DEEPSEEK_API_KEY = apiKey;
  }
  env.DSH_CWD = options.cwd;
  env.DSH_PERMISSION_MODE = options.permissionMode || 'workspace-write';
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
    return 'DeepSeek Harness has no API key. Set DEEPSEEK_API_KEY or add api_key to ~/.deepseek/config.toml, then retry.';
  }
  return 'DeepSeek Harness is not ready.';
}

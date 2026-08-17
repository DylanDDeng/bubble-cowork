import { createHash } from 'crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { stringify } from 'yaml';
import type { McpServerConfig } from '../../shared/types';
import { BROWSER_USE_SERVER_NAME } from './browser-use';

const DEEPSEEK_MCP_CONFIG_PATH = join(homedir(), '.aegis', 'deepseek-mcp.json');
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const BROWSER_USE_TOOL_TIMEOUT_MS = 45_000;
const RUNTIME_CONFIG_PREFIX = 'aegis-dsh-config-';
const STALE_RUNTIME_CONFIG_AGE_MS = 24 * 60 * 60 * 1000;

/** Best-effort crash recovery for per-runtime files that normal dispose did
 * not get a chance to remove. Only the exact Aegis prefix under os.tmpdir is
 * eligible, and recent/live runtimes are never touched. */
export function cleanupStaleDeepseekMcpRuntimeConfigs(now = Date.now()): number {
  let removed = 0;
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith(RUNTIME_CONFIG_PREFIX)) continue;
      const target = join(tmpdir(), name);
      try {
        const stat = statSync(target);
        if (!stat.isDirectory() || now - stat.mtimeMs < STALE_RUNTIME_CONFIG_AGE_MS) continue;
        rmSync(target, { recursive: true, force: true });
        removed += 1;
      } catch {
        // Another runtime or the OS may have removed it concurrently.
      }
    }
  } catch {
    // Temp-directory enumeration is best effort.
  }
  return removed;
}

interface DeepseekMcpSettingsFile {
  mcpServers?: Record<string, McpServerConfig>;
  projects?: Record<string, { mcpServers?: Record<string, McpServerConfig> }>;
  [key: string]: unknown;
}

export interface DeepseekMcpRuntimeConfig {
  configPath: string;
  serverNames: string[];
  dispose: () => void;
}

function readSettings(): DeepseekMcpSettingsFile {
  try {
    if (!existsSync(DEEPSEEK_MCP_CONFIG_PATH)) return {};
    const parsed = JSON.parse(readFileSync(DEEPSEEK_MCP_CONFIG_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as DeepseekMcpSettingsFile)
      : {};
  } catch (error) {
    console.warn(`Failed to read DeepSeek Harness MCP config at ${DEEPSEEK_MCP_CONFIG_PATH}:`, error);
    return {};
  }
}

function writeSettings(settings: DeepseekMcpSettingsFile): void {
  mkdirSync(dirname(DEEPSEEK_MCP_CONFIG_PATH), { recursive: true });
  writeFileSync(DEEPSEEK_MCP_CONFIG_PATH, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    chmodSync(DEEPSEEK_MCP_CONFIG_PATH, 0o600);
  } catch {
    // Best effort on filesystems without POSIX permissions.
  }
}

export function getDeepseekGlobalMcpServers(): Record<string, McpServerConfig> {
  return readSettings().mcpServers || {};
}

export function getDeepseekProjectMcpServers(projectPath: string): Record<string, McpServerConfig> {
  if (!projectPath.trim()) return {};
  return readSettings().projects?.[projectPath]?.mcpServers || {};
}

export function getDeepseekMcpServers(projectPath: string): Record<string, McpServerConfig> {
  const globalServers = getDeepseekGlobalMcpServers();
  const merged = {
    ...globalServers,
    ...getDeepseekProjectMcpServers(projectPath),
  };
  // The built-in browser endpoint carries this app run's ephemeral port and
  // bearer token. A project entry must never shadow that fresh descriptor.
  if (globalServers[BROWSER_USE_SERVER_NAME]) {
    merged[BROWSER_USE_SERVER_NAME] = globalServers[BROWSER_USE_SERVER_NAME];
  }
  return merged;
}

export function saveDeepseekGlobalMcpServers(
  servers: Record<string, McpServerConfig>
): void {
  const settings = readSettings();
  settings.mcpServers = servers;
  writeSettings(settings);
}

export function saveDeepseekProjectMcpServers(
  projectPath: string,
  servers: Record<string, McpServerConfig>
): void {
  if (!projectPath.trim()) return;
  const settings = readSettings();
  settings.projects ||= {};
  settings.projects[projectPath] = {
    ...(settings.projects[projectPath] || {}),
    mcpServers: servers,
  };
  writeSettings(settings);
}

function stringRecord(value: Record<string, string> | undefined): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
}

/** Stable namespace accepted by dsh-mcp-client; lossy names carry a hash. */
export function toDeepseekMcpServerName(name: string): string {
  const trimmed = name.trim();
  if (SERVER_NAME_PATTERN.test(trimmed)) return trimmed;
  const normalized = trimmed.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
  const hash = createHash('sha256').update(trimmed).digest('hex').slice(0, 10);
  const stem = (normalized || 'server').slice(0, 21);
  return `${stem}_${hash}`;
}

function buildMcpPluginEntries(
  servers: Record<string, McpServerConfig>,
  cwd: string
): Array<Record<string, unknown>> {
  const usedServerNames = new Set<string>();
  return Object.entries(servers)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([displayName, server], index): Array<Record<string, unknown>> => {
      if (!server || server.enabled === false) return [];
      let serverName = toDeepseekMcpServerName(displayName);
      if (usedServerNames.has(serverName)) {
        const hash = createHash('sha256')
          .update(`${displayName}\0${index}`)
          .digest('hex')
          .slice(0, 10);
        serverName = `${serverName.slice(0, 21)}_${hash}`;
      }
      usedServerNames.add(serverName);
      const transport = server.type || (server.url ? 'http' : 'stdio');
      let config: Record<string, unknown>;
      if (transport === 'http') {
        const url = server.url?.trim();
        if (!url) return [];
        config = {
          serverName,
          transport: 'streamable-http',
          url,
          headers: stringRecord(server.headers),
          ...(displayName === BROWSER_USE_SERVER_NAME
            ? { toolCallTimeoutMs: BROWSER_USE_TOOL_TIMEOUT_MS }
            : {}),
        };
      } else if (transport === 'stdio') {
        const command = server.command?.trim();
        if (!command) return [];
        config = {
          serverName,
          transport: 'stdio',
          command,
          args: (server.args || []).filter((arg): arg is string => typeof arg === 'string'),
          env: stringRecord(server.env),
          cwd,
        };
      } else {
        throw new Error(
          `DeepSeek Harness MCP server "${displayName}" uses unsupported SSE transport. Use Streamable HTTP instead.`
        );
      }
      return [
        {
          id: `aegis-mcp-${index}`,
          name: '@deepseek-ai/dsh-mcp-client',
          // Preserve the official Minimal preset's exact two-tool contract.
          disabled: {
            tag: 'tag:yaml.org,2002:js',
            value: "(process.env.AEGIS_DSH_AGENT_PRESET ?? 'standard') === 'minimal'",
          },
          config,
        },
      ];
    });
}

/**
 * Create the per-runtime Cordis composition. MCP configuration can differ by
 * workspace, while the checked-in profile remains an immutable base.
 */
export function createDeepseekMcpRuntimeConfig(
  profileDir: string,
  cwd: string,
  servers: Record<string, McpServerConfig> = getDeepseekMcpServers(cwd)
): DeepseekMcpRuntimeConfig {
  const entries = buildMcpPluginEntries(servers, cwd);
  if (entries.length === 0) {
    return {
      configPath: join(profileDir, 'cordis.yml'),
      serverNames: [],
      dispose: () => {},
    };
  }

  if (!existsSync(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-mcp-client'))) {
    throw new Error(
      'DeepSeek Harness MCP support is missing from the runtime profile. Reinstall Aegis or repair the profile configured by AEGIS_DSH_PROFILE_DIR.'
    );
  }

  // yaml.stringify cannot emit the custom !!js tag through a plain object;
  // emit the small conditional as text after serializing ordinary values.
  const serializedEntries = entries
    .map((entry) => {
      const { disabled: _disabled, ...plain } = entry;
      const yaml = stringify([plain], { lineWidth: 0 }).trimEnd();
      return yaml.replace(
        /\n  config:/,
        `\n  disabled: !!js "(process.env.AEGIS_DSH_AGENT_PRESET ?? 'standard') === 'minimal'"\n  config:`
      );
    })
    .join('\n');
  const base = readFileSync(join(profileDir, 'cordis.yml'), 'utf8').trimEnd();
  cleanupStaleDeepseekMcpRuntimeConfigs();
  const runtimeDir = mkdtempSync(join(tmpdir(), RUNTIME_CONFIG_PREFIX));
  const configPath = join(runtimeDir, 'cordis.yml');
  writeFileSync(configPath, `${base}\n\n# Aegis per-workspace MCP bridge instances.\n${serializedEntries}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });

  return {
    configPath,
    serverNames: entries.map((entry) =>
      String((entry.config as Record<string, unknown>).serverName)
    ),
    dispose: () => {
      try {
        rmSync(runtimeDir, { recursive: true, force: true });
      } catch {
        // The OS temp directory will clean up a stubborn runtime file later.
      }
    },
  };
}

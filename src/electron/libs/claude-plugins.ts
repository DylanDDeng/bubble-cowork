import { execFile } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import type {
  ProviderListPluginsResult,
  ProviderPluginDescriptor,
  ProviderPluginDetail,
  ProviderPluginMarketplaceLoadError,
  ProviderPluginSource,
  ProviderReadPluginResult,
  ProviderSkillDescriptor,
} from '../../shared/types';

const execFileAsync = promisify(execFile);

const PLUGINS_ROOT = join(homedir(), '.claude', 'plugins');
const CLI_TIMEOUT_MS = 120_000;

interface KnownMarketplaceEntry {
  installLocation?: string;
}

interface MarketplaceCatalogPlugin {
  name?: string;
  displayName?: string;
  description?: string;
  category?: string;
  author?: { name?: string };
  homepage?: string;
  source?: unknown;
  lspServers?: Record<string, { extensionToLanguage?: Record<string, string> }>;
}

interface InstalledPluginRecord {
  scope?: string;
  installPath?: string;
  version?: string;
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readInstalledPlugins(): Map<string, InstalledPluginRecord> {
  const result = new Map<string, InstalledPluginRecord>();
  const raw = asRecord(readJson(join(PLUGINS_ROOT, 'installed_plugins.json')));
  const plugins = asRecord(raw?.plugins);
  if (!plugins) return result;
  for (const [id, records] of Object.entries(plugins)) {
    const first = Array.isArray(records) ? asRecord(records[0]) : asRecord(records);
    if (first) {
      result.set(id, {
        scope: typeof first.scope === 'string' ? first.scope : undefined,
        installPath: typeof first.installPath === 'string' ? first.installPath : undefined,
        version: typeof first.version === 'string' ? first.version : undefined,
      });
    }
  }
  return result;
}

function parseCatalogSource(value: unknown, marketplacePath: string): ProviderPluginSource {
  if (typeof value === 'string') {
    return { type: 'local', path: join(marketplacePath, value) };
  }
  const record = asRecord(value);
  const url = typeof record?.url === 'string' ? record.url : '';
  if (url) return { type: 'git', url };
  return { type: 'local', path: marketplacePath };
}

function titleCasePluginName(name: string): string {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Brand favicon for plugins whose homepage is a real product site. GitHub
 * repo homepages are skipped — a wall of identical GitHub marks is worse
 * than the letter-tile fallback.
 */
function homepageFaviconUrl(homepage: string | undefined): string | null {
  if (!homepage) return null;
  try {
    const url = new URL(homepage);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.toLowerCase();
    if (host === 'github.com' || host.endsWith('.github.com') || host.endsWith('.github.io')) {
      return null;
    }
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`;
  } catch {
    return null;
  }
}

/**
 * GitHub-hosted plugins get their owning org's avatar (github.com/<owner>.png)
 * — real brand marks (cloudflare, adobe, anthropics…), unlike the generic
 * GitHub favicon.
 */
function githubOwnerAvatarUrl(...urls: Array<string | undefined>): string | null {
  for (const raw of urls) {
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (url.hostname.toLowerCase() !== 'github.com') continue;
      const owner = url.pathname.split('/').filter(Boolean)[0];
      if (owner) {
        return `https://github.com/${encodeURIComponent(owner)}.png?size=128`;
      }
    } catch {
      // not a URL — keep looking
    }
  }
  return null;
}

// Official language homepages — their favicons are the language logos. Used
// for LSP plugins that declare languages but ship no icon or homepage.
const LANGUAGE_HOMEPAGES: Record<string, string> = {
  rust: 'rust-lang.org',
  swift: 'swift.org',
  go: 'go.dev',
  python: 'python.org',
  typescript: 'typescriptlang.org',
  kotlin: 'kotlinlang.org',
  ruby: 'ruby-lang.org',
  php: 'php.net',
  java: 'dev.java',
  csharp: 'dotnet.microsoft.com',
};

function lspLanguageFaviconUrl(
  lspServers: MarketplaceCatalogPlugin['lspServers']
): string | null {
  if (!lspServers) return null;
  for (const server of Object.values(lspServers)) {
    for (const language of Object.values(server?.extensionToLanguage ?? {})) {
      const domain = LANGUAGE_HOMEPAGES[language.toLowerCase()];
      if (domain) {
        return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
      }
    }
  }
  return null;
}

/** Installed plugins may ship their own icon file next to the manifest. */
function findInstalledIconPath(installPath: string | undefined): string | null {
  if (!installPath || !existsSync(installPath)) return null;
  try {
    const candidates = readdirSync(installPath).filter(
      (file) => /\.(svg|png)$/i.test(file) && /icon|logo/i.test(file)
    );
    if (candidates.length === 0) return null;
    // Prefer full-color marks over mono-line variants.
    candidates.sort((left, right) => {
      const leftColor = /full.?color/i.test(left) ? 0 : 1;
      const rightColor = /full.?color/i.test(right) ? 0 : 1;
      return leftColor - rightColor || left.localeCompare(right);
    });
    return join(installPath, candidates[0]);
  } catch {
    return null;
  }
}

function toDescriptor(
  raw: MarketplaceCatalogPlugin,
  marketplaceName: string,
  marketplacePath: string,
  installed: Map<string, InstalledPluginRecord>
): ProviderPluginDescriptor | null {
  const name = raw.name?.trim();
  if (!name) return null;
  const id = `${name}@${marketplaceName}`;
  const installRecord = installed.get(id);
  const source = parseCatalogSource(raw.source, marketplacePath);
  const localIcon = findInstalledIconPath(installRecord?.installPath);
  const remoteLogoUrl =
    homepageFaviconUrl(raw.homepage) ??
    githubOwnerAvatarUrl(raw.homepage, source.type === 'git' ? source.url : undefined) ??
    lspLanguageFaviconUrl(raw.lspServers);

  return {
    id,
    name,
    version: installRecord?.version ?? null,
    source,
    installed: Boolean(installRecord),
    enabled: Boolean(installRecord),
    installPolicy: 'AVAILABLE',
    authPolicy: 'ON_USE',
    interface: {
      displayName: raw.displayName?.trim() || titleCasePluginName(name),
      ...(raw.description ? { shortDescription: raw.description } : {}),
      ...(raw.category ? { category: raw.category } : {}),
      ...(raw.author?.name ? { developerName: raw.author.name } : {}),
      ...(raw.homepage ? { websiteUrl: raw.homepage } : {}),
      // `logo` (a local file path) is inlined to a data URL by the IPC layer
      // and wins over the remote favicon / org-avatar fallback.
      ...(localIcon ? { logo: localIcon } : {}),
      ...(remoteLogoUrl && !localIcon ? { logoUrl: remoteLogoUrl } : {}),
    },
  };
}

export function listClaudePlugins(): ProviderListPluginsResult {
  const known = asRecord(readJson(join(PLUGINS_ROOT, 'known_marketplaces.json'))) ?? {};
  const installed = readInstalledPlugins();
  const marketplaces: ProviderListPluginsResult['marketplaces'] = [];
  const marketplaceLoadErrors: ProviderPluginMarketplaceLoadError[] = [];

  for (const [marketplaceName, entryRaw] of Object.entries(known)) {
    const entry = asRecord(entryRaw) as KnownMarketplaceEntry | null;
    const installLocation = entry?.installLocation;
    if (!installLocation) continue;
    const catalogPath = join(installLocation, '.claude-plugin', 'marketplace.json');
    const catalog = asRecord(readJson(catalogPath));
    if (!catalog) {
      marketplaceLoadErrors.push({
        marketplacePath: installLocation,
        message: `Could not read ${catalogPath}`,
      });
      continue;
    }
    const rawPlugins = Array.isArray(catalog.plugins) ? catalog.plugins : [];
    const plugins = rawPlugins
      .map((raw) =>
        toDescriptor(
          (asRecord(raw) ?? {}) as MarketplaceCatalogPlugin,
          marketplaceName,
          installLocation,
          installed
        )
      )
      .filter((plugin): plugin is ProviderPluginDescriptor => Boolean(plugin));

    marketplaces.push({
      name: marketplaceName,
      path: installLocation,
      plugins,
    });
  }

  return {
    marketplaces,
    marketplaceLoadErrors,
    remoteSyncError: null,
    featuredPluginIds: [],
    source: 'claude-local',
    cached: false,
  };
}

function skillFrontmatterField(content: string, field: string): string | undefined {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (!frontmatter) return undefined;
  const line = frontmatter
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(`${field}:`));
  return line?.slice(field.length + 1).trim() || undefined;
}

/** Scan an installed plugin directory for the components it ships. */
function scanInstalledPlugin(installPath: string): {
  skills: ProviderSkillDescriptor[];
  commands: string[];
  mcpServers: string[];
} {
  const skills: ProviderSkillDescriptor[] = [];
  const commands: string[] = [];
  const mcpServers: string[] = [];

  const skillsRoot = join(installPath, 'skills');
  if (existsSync(skillsRoot)) {
    for (const dirent of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const skillPath = join(skillsRoot, dirent.name, 'SKILL.md');
      if (!existsSync(skillPath)) continue;
      try {
        const content = readFileSync(skillPath, 'utf8');
        skills.push({
          name: skillFrontmatterField(content, 'name') || dirent.name,
          description: skillFrontmatterField(content, 'description'),
          path: skillPath,
          enabled: true,
          scope: 'plugin',
        });
      } catch {
        // unreadable skill — skip
      }
    }
  }

  const commandsRoot = join(installPath, 'commands');
  if (existsSync(commandsRoot)) {
    for (const dirent of readdirSync(commandsRoot, { withFileTypes: true })) {
      if (dirent.isFile() && dirent.name.endsWith('.md')) {
        commands.push(`/${dirent.name.replace(/\.md$/, '')}`);
      }
    }
  }

  const mcpConfig = asRecord(readJson(join(installPath, '.mcp.json')));
  const mcpServersRecord = asRecord(mcpConfig?.mcpServers);
  if (mcpServersRecord) {
    mcpServers.push(...Object.keys(mcpServersRecord));
  }

  return { skills, commands, mcpServers };
}

export function readClaudePlugin(pluginId: string): ProviderReadPluginResult {
  const [, marketplaceName = ''] = pluginId.split('@');
  const list = listClaudePlugins();
  const marketplace = list.marketplaces.find((entry) => entry.name === marketplaceName);
  const summary = marketplace?.plugins.find((plugin) => plugin.id === pluginId);
  if (!marketplace || !summary) {
    throw new Error(`Unknown Claude plugin "${pluginId}".`);
  }

  const installRecord = readInstalledPlugins().get(pluginId);
  const installPath = installRecord?.installPath;
  const scanned =
    installPath && existsSync(installPath) && statSync(installPath).isDirectory()
      ? scanInstalledPlugin(installPath)
      : { skills: [], commands: [], mcpServers: [] };

  const detail: ProviderPluginDetail = {
    marketplaceName: marketplace.name,
    marketplacePath: marketplace.path,
    summary,
    description: summary.interface?.shortDescription,
    skills: scanned.skills,
    apps: [],
    mcpServers: [...scanned.mcpServers, ...scanned.commands],
  };

  return { plugin: detail, source: 'claude-local', cached: false };
}

async function runClaudePluginCommand(args: string[]): Promise<void> {
  try {
    await execFileAsync('claude', ['plugin', ...args], {
      timeout: CLI_TIMEOUT_MS,
      env: process.env,
    });
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error
        ? String((error as { stderr?: unknown }).stderr || '')
        : '';
    const base = error instanceof Error ? error.message : String(error);
    throw new Error(stderr.trim() || base);
  }
}

export async function installClaudePlugin(pluginId: string): Promise<void> {
  await runClaudePluginCommand(['install', pluginId, '--scope', 'user']);
}

export async function uninstallClaudePlugin(pluginId: string): Promise<void> {
  await runClaudePluginCommand(['uninstall', pluginId]);
}

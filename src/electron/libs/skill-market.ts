import { spawn } from 'child_process';
import { homedir } from 'os';
import type { SkillMarketDetail, SkillMarketInstallResult, SkillMarketItem } from '../../shared/types';
import { listClaudeSkills } from './claude-skills';

const SKILLS_BASE_URL = 'https://skills.sh';
const DEFAULT_LIMIT = 60;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12_000;
const FETCH_RETRY_DELAYS_MS = [250, 800];

type RawSkillRecord = {
  id?: string;
  source?: string;
  skillId?: string;
  name?: string;
  installs?: number;
  installsYesterday?: number;
  change?: number;
};

type ParsedSkillRoute = {
  owner: string;
  repo: string;
  skillId: string;
};

type FetchLikeError = Error & {
  cause?: {
    code?: string;
    host?: string;
    port?: number;
    message?: string;
  };
};

export async function getSkillMarketHot(limit = DEFAULT_LIMIT): Promise<SkillMarketItem[]> {
  const html = await fetchText(`${SKILLS_BASE_URL}/hot`);
  const records = parseEmbeddedSkillsRecords(html, 'hot');
  return records
    .map(toSkillMarketItem)
    .filter((item): item is SkillMarketItem => Boolean(item))
    .slice(0, sanitizeLimit(limit));
}

export async function searchSkillMarket(query: string, limit = DEFAULT_LIMIT): Promise<SkillMarketItem[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return getSkillMarketHot(limit);
  }

  const response = await fetchWithRetries(`${SKILLS_BASE_URL}/api/search?q=${encodeURIComponent(trimmed)}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'aegis/0.0.7',
    },
  }, 'searching skills.sh');

  if (!response.ok) {
    throw new Error(`skills.sh search failed (${response.status})`);
  }

  const payload = (await response.json()) as { skills?: RawSkillRecord[] };
  return (payload.skills || [])
    .map(toSkillMarketItem)
    .filter((item): item is SkillMarketItem => Boolean(item))
    .slice(0, sanitizeLimit(limit));
}

export async function getSkillMarketDetail(id: string): Promise<SkillMarketDetail> {
  const route = parseSkillRoute(id);
  if (!route) {
    throw new Error('Invalid skill id');
  }

  const detailUrl = `${SKILLS_BASE_URL}/${route.owner}/${route.repo}/${route.skillId}`;
  const html = await fetchText(detailUrl);
  const installCommand = buildInstallCommand(route.owner, route.repo, route.skillId);
  const repoUrl = extractRepoUrl(html) || `https://github.com/${route.owner}/${route.repo}`;
  const name = extractTitle(html) || route.skillId;
  const description = extractDescription(html) || 'No description available from skills.sh.';
  const originalSource = extractOriginalSource(html);
  const weeklyInstallsLabel = extractWeeklyInstallsLabel(html);
  const securityAudits = extractSecurityAudits(html);

  return {
    id,
    owner: route.owner,
    repo: route.repo,
    skillId: route.skillId,
    name,
    source: `${route.owner}/${route.repo}`,
    installs: 0,
    detailUrl,
    repoUrl,
    installCommand,
    description,
    originalSource: originalSource || undefined,
    weeklyInstallsLabel: weeklyInstallsLabel || undefined,
    securityAudits,
  };
}

export async function installSkillFromMarket(id: string): Promise<SkillMarketInstallResult> {
  const route = parseSkillRoute(id);
  if (!route) {
    return {
      ok: false,
      command: '',
      output: '',
      message: 'Invalid skill id.',
    };
  }

  const repoUrl = `https://github.com/${route.owner}/${route.repo}`;
  const command = buildInstallCommand(route.owner, route.repo, route.skillId);
  const args = ['--yes', 'skills', 'add', repoUrl, '--skill', route.skillId, '-g', '-a', 'claude-code', '--copy', '-y'];

  return new Promise<SkillMarketInstallResult>((resolve) => {
    const proc = spawn('npx', args, {
      cwd: homedir(),
      env: {
        ...process.env,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let settled = false;
    const settle = (result: SkillMarketInstallResult) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      settle({
        ok: false,
        command,
        output: output.trim(),
        message: 'Install timed out.',
      });
    }, INSTALL_TIMEOUT_MS);

    proc.stdout?.on('data', (chunk) => {
      output += String(chunk);
    });
    proc.stderr?.on('data', (chunk) => {
      output += String(chunk);
    });

    proc.on('error', (error) => {
      clearTimeout(timer);
      settle({
        ok: false,
        command,
        output: output.trim(),
        message: error instanceof Error ? error.message : String(error),
      });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      const installed = listClaudeSkills().userSkills.some((skill) => skill.name === route.skillId);
      settle({
        ok: code === 0 && installed,
        command,
        output: output.trim(),
        message:
          code !== 0
            ? `Install failed with exit code ${code ?? 'unknown'}.`
            : installed
              ? undefined
              : `The installer exited successfully, but ${route.skillId} was not found in ~/.claude/skills afterwards.`,
      });
    });
  });
}

function sanitizeLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_LIMIT;
  }

  return Math.min(Math.floor(limit), 100);
}

async function fetchText(url: string): Promise<string> {
  const response = await fetchWithRetries(url, {
    headers: {
      Accept: 'text/html,application/json',
      'User-Agent': 'aegis/0.0.7',
    },
  }, 'loading skills.sh');

  if (!response.ok) {
    throw new Error(`skills.sh request failed (${response.status})`);
  }

  return response.text();
}

async function fetchWithRetries(
  url: string,
  init: RequestInit,
  actionLabel: string
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= FETCH_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = error;
      if (!isRetriableFetchError(error) || attempt === FETCH_RETRY_DELAYS_MS.length) {
        throw buildSkillsMarketNetworkError(actionLabel, error);
      }

      await new Promise((resolve) => setTimeout(resolve, FETCH_RETRY_DELAYS_MS[attempt]));
    }
  }

  throw buildSkillsMarketNetworkError(actionLabel, lastError);
}

function isRetriableFetchError(error: unknown): boolean {
  const code = (error as FetchLikeError | undefined)?.cause?.code;
  return ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED'].includes(String(code || ''));
}

function buildSkillsMarketNetworkError(actionLabel: string, error: unknown): Error {
  const fetchError = error as FetchLikeError | undefined;
  const code = fetchError?.cause?.code;
  const host = fetchError?.cause?.host;
  const port = fetchError?.cause?.port;
  const causeMessage = fetchError?.cause?.message || fetchError?.message || 'Unknown network error.';
  const endpoint = host ? `${host}${port ? `:${port}` : ''}` : 'skills.sh';
  const detail = code ? `${code} while reaching ${endpoint}` : causeMessage;

  return new Error(
    `Unable to reach skills.sh while ${actionLabel}. Check your network connection, proxy, or firewall. Last error: ${detail}.`
  );
}

function parseEmbeddedSkillsRecords(html: string, view: 'hot' | 'all-time'): RawSkillRecord[] {
  const rawArray = extractEmbeddedSkillsArray(html, view);
  if (!rawArray) {
    return [];
  }

  try {
    return JSON.parse(rawArray.replace(/\\"/g, '"')) as RawSkillRecord[];
  } catch {
    return [];
  }
}

function extractEmbeddedSkillsArray(html: string, view: 'hot' | 'all-time'): string | null {
  const endMarker = `],\\"totalSkills\\":`;
  const viewMarker = `\\"view\\":\\"${view}\\"`;
  const viewIndex = html.indexOf(viewMarker);
  if (viewIndex === -1) {
    return null;
  }

  const endIndex = html.lastIndexOf(endMarker, viewIndex);
  if (endIndex === -1) {
    return null;
  }

  const candidateStarts = ['[{\\"source\\":', '[{\\"id\\":'];
  const startIndex = Math.max(
    ...candidateStarts.map((marker) => html.lastIndexOf(marker, endIndex))
  );
  if (startIndex === -1) {
    return null;
  }

  return html.slice(startIndex, endIndex + 1);
}

function toSkillMarketItem(raw: RawSkillRecord): SkillMarketItem | null {
  const routeId = normalizeSkillRouteId(raw);
  const route = parseSkillRoute(routeId);
  if (!route) {
    return null;
  }

  return {
    id: routeId,
    owner: route.owner,
    repo: route.repo,
    skillId: route.skillId,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : route.skillId,
    source: typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : `${route.owner}/${route.repo}`,
    installs: Number.isFinite(raw.installs) ? Number(raw.installs) : 0,
    installsYesterday: Number.isFinite(raw.installsYesterday) ? Number(raw.installsYesterday) : undefined,
    change: Number.isFinite(raw.change) ? Number(raw.change) : undefined,
    detailUrl: `${SKILLS_BASE_URL}/${route.owner}/${route.repo}/${route.skillId}`,
  };
}

function normalizeSkillRouteId(raw: RawSkillRecord): string {
  if (typeof raw.id === 'string' && raw.id.trim()) {
    return raw.id.trim().replace(/^\/+/, '');
  }

  const source = typeof raw.source === 'string' ? raw.source.trim().replace(/^\/+/, '') : '';
  const skillId = typeof raw.skillId === 'string' ? raw.skillId.trim().replace(/^\/+/, '') : '';
  return source && skillId ? `${source}/${skillId}` : '';
}

function parseSkillRoute(id: string): ParsedSkillRoute | null {
  const segments = id.split('/').filter(Boolean);
  if (segments.length < 3) {
    return null;
  }

  return {
    owner: segments[0],
    repo: segments[1],
    skillId: segments.slice(2).join('/'),
  };
}

function buildInstallCommand(owner: string, repo: string, skillId: string): string {
  return `npx --yes skills add https://github.com/${owner}/${repo} --skill ${skillId} -g -a claude-code --copy -y`;
}

function extractInstallCommand(html: string): string | null {
  const match = html.match(/npx(?:\s+--yes)?\s+skills\s+add\s+[^<\n]+?\s+--skill\s+[^\s<]+/i);
  return match?.[0]?.trim() || null;
}

function extractRepoUrl(html: string): string | null {
  const match = html.match(/href="(https:\/\/github\.com\/[^"]+)"/i);
  return match?.[1] || null;
}

function extractTitle(html: string): string | null {
  const match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  return match?.[1]?.trim() || null;
}

function extractOriginalSource(html: string): string | null {
  const match = html.match(/Originally from[\s\S]*?>([^<]+)<\/a>/i);
  return match?.[1]?.trim() || null;
}

function extractWeeklyInstallsLabel(html: string): string | null {
  const sectionMatch = html.match(/Weekly Installs[\s\S]*?<div class="text-3xl[^"]*">([^<]+)<\/div>/i);
  return sectionMatch?.[1]?.trim() || null;
}

function extractSecurityAudits(html: string): Array<{ name: string; status: string }> | undefined {
  const sectionMatch = html.match(/Security Audits[\s\S]*?<div class="divide-y divide-border">([\s\S]*?)<\/div><\/div>/i);
  if (!sectionMatch?.[1]) {
    return undefined;
  }

  const audits = Array.from(
    sectionMatch[1].matchAll(
      /<span class="text-sm font-medium text-foreground truncate">([^<]+)<\/span>[\s\S]*?<span class="text-xs font-mono uppercase[^"]*">([^<]+)<\/span>/gi
    )
  ).map((match) => ({
    name: decodeHtml(match[1].trim()),
    status: decodeHtml(match[2].trim()),
  }));

  return audits.length > 0 ? audits : undefined;
}

function extractDescription(html: string): string | null {
  const proseMatch = html.match(/<div class="prose[^"]*">([\s\S]*?)<\/div><\/div><\/div>/i);
  if (!proseMatch?.[1]) {
    return null;
  }

  const paragraphMatch = proseMatch[1].match(/<p>([\s\S]*?)<\/p>/i);
  if (!paragraphMatch?.[1]) {
    return null;
  }

  const text = decodeHtml(stripTags(paragraphMatch[1])).replace(/\s+/g, ' ').trim();
  return text || null;
}

function stripTags(input: string): string {
  return input.replace(/<[^>]+>/g, ' ');
}

function decodeHtml(input: string): string {
  return input
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#x26;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

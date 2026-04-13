/**
 * Memory Extractor — automatically extracts memorable information from conversations.
 *
 * Runs every 3 assistant turns. Uses a lightweight direct API call (not the
 * full Claude Agent SDK) to extract durable memories from recent messages.
 * Writes to the current Aegis memory root under projects/<hash>/daily/{date}.md
 * for project-scoped daily logs. Dev and packaged builds use separate roots.
 *
 * Skips extraction if the AI already called remember_write in the current turn.
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, appendFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { getClaudeSettings } from './claude-settings';
import { getEnabledCompatibleProviderConfigs } from './compatible-provider-config';
import { getAegisMemoryHome, getAegisProjectsRoot } from './memory-paths';

const EXTRACTION_INTERVAL = 3;
const AEGIS_HOME = getAegisMemoryHome();
const PROJECTS_ROOT = getAegisProjectsRoot();

const GLOBAL_KEY = '__aegis_memory_extraction_counters__';

function hashProjectPath(projectCwd: string): string {
  return createHash('sha256').update(projectCwd).digest('hex').slice(0, 16);
}

function getProjectDailyDir(projectCwd: string): string {
  const normalized = resolve(projectCwd.trim());
  return join(PROJECTS_ROOT, hashProjectPath(normalized), 'daily');
}

function getCounterMap(): Map<string, number> {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map<string, number>();
  }
  return g[GLOBAL_KEY] as Map<string, number>;
}

export function shouldExtractMemory(sessionId: string): boolean {
  const counters = getCounterMap();
  const counter = (counters.get(sessionId) || 0) + 1;
  counters.set(sessionId, counter);
  return counter % EXTRACTION_INTERVAL === 0;
}

export function resetExtractionCounter(sessionId: string): void {
  getCounterMap().delete(sessionId);
}

/**
 * Check if the AI already wrote to memory in this turn by looking for
 * remember_write tool calls in the accumulated response text.
 */
export function hasMemoryWritesInTurn(responseText: string): boolean {
  return responseText.includes('remember_write') && responseText.includes('tool_use');
}

function getLocalDateString(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Resolve API credentials for a lightweight extraction call.
 * Tries: env ANTHROPIC_API_KEY → claude settings → compatible providers.
 * Returns null if no credentials available.
 */
function resolveCredentials(): {
  apiKey: string;
  baseUrl: string;
  model: string;
  authStyle: 'api_key' | 'auth_token';
} | null {
  // 1) Try env vars set by the runner (most reliable — matches the active session)
  const envKey = process.env.ANTHROPIC_API_KEY;
  const envToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const envBase = process.env.ANTHROPIC_BASE_URL;
  const envSmall = process.env.ANTHROPIC_SMALL_FAST_MODEL;
  const envModel = process.env.ANTHROPIC_MODEL;

  if ((envKey || envToken) && envBase) {
    return {
      apiKey: (envKey || envToken)!,
      baseUrl: envBase,
      model: envSmall?.trim() || envModel?.trim() || 'claude-haiku-4-5-20251001',
      authStyle: envToken ? 'auth_token' : 'api_key',
    };
  }

  // 2) Fall back to saved claude settings (direct Anthropic key)
  const settings = getClaudeSettings();
  if (settings?.apiKey) {
    return {
      apiKey: settings.apiKey,
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-haiku-4-5-20251001',
      authStyle: 'api_key',
    };
  }

  // 3) Fall back to compatible provider configs
  const providers = getEnabledCompatibleProviderConfigs();
  if (providers.length > 0) {
    const provider = providers[0];
    return {
      apiKey: provider.secret,
      baseUrl: provider.baseUrl,
      model: provider.smallFastModel?.trim() || provider.model,
      authStyle: provider.authType === 'api_key' ? 'api_key' : 'auth_token',
    };
  }

  return null;
}

async function callLLM(system: string, prompt: string): Promise<string | null> {
  const creds = resolveCredentials();
  if (!creds) {
    console.warn('[memory-extractor] No credentials available for extraction');
    return null;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (creds.authStyle === 'auth_token') {
    headers['Authorization'] = `Bearer ${creds.apiKey}`;
  } else {
    headers['x-api-key'] = creds.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  }

  let apiUrl = creds.baseUrl.replace(/\/+$/, '');
  if (!apiUrl.endsWith('/v1/messages')) {
    if (!apiUrl.endsWith('/v1')) apiUrl += '/v1';
    apiUrl += '/messages';
  }

  console.log(`[memory-extractor] Calling ${apiUrl} with model=${creds.model}, authStyle=${creds.authStyle}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: creds.model,
        max_tokens: 300,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      console.warn(`[memory-extractor] LLM call failed: ${response.status} ${errorBody.slice(0, 200)}`);
      return null;
    }

    const data = await response.json() as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = data.content?.find(b => b.type === 'text')?.text;
    return text || null;
  } catch (err) {
    console.warn('[memory-extractor] LLM call error:', err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Extract memories from recent conversation messages and write to project daily log.
 */
export async function extractMemories(
  recentMessages: Array<{ role: string; content: string }>,
  projectCwd: string,
): Promise<void> {
  if (recentMessages.length < 2) return;

  try {
    const context = recentMessages.slice(-6).map(m =>
      `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 500)}`
    ).join('\n\n');

    const result = await callLLM(
      'You extract durable memories from conversations. Only extract information worth remembering long-term: user preferences, decisions, important facts, commitments, deadlines, corrections. NOT transient details, small talk, or code snippets.',
      `Review this conversation excerpt and extract any durable memories worth saving.

${context}

If there are memories worth saving, output them as a markdown list:
- Memory 1
- Memory 2

If nothing is worth remembering, output exactly: NOTHING`,
    );

    if (!result || result.trim() === 'NOTHING' || result.trim().length < 10) return;

    const dailyDir = getProjectDailyDir(projectCwd);
    if (!existsSync(dailyDir)) {
      mkdirSync(dailyDir, { recursive: true });
    }

    const today = getLocalDateString();
    const dailyPath = join(dailyDir, `${today}.md`);
    const separator = existsSync(dailyPath) ? '\n\n---\n\n' : '';
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    appendFileSync(dailyPath, `${separator}## Auto-extracted (${timestamp})\n${result.trim()}\n`, 'utf-8');
    console.log(`[memory-extractor] Extracted memories to ${dailyPath}`);
  } catch (err) {
    console.error('[memory-extractor] Extraction failed:', err);
  }
}

/**
 * Load recent daily memories for a project (most recent N days).
 */
export function loadRecentDailyMemories(projectCwd: string, count = 3): Array<{ date: string; path: string }> {
  const dailyDir = getProjectDailyDir(projectCwd);
  if (!existsSync(dailyDir)) return [];
  try {
    return readdirSync(dailyDir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .slice(0, count)
      .map(f => ({
        date: f.replace('.md', ''),
        path: join(dailyDir, f),
      }));
  } catch {
    return [];
  }
}

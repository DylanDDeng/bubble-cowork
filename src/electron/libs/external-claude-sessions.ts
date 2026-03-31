import { promises as fs } from 'fs';
import * as path from 'path';
import type { BrowserWindow } from 'electron';
import type { ContentBlock, SessionSource, StreamMessage } from '../../shared/types';
import * as sessions from './session-store';

const CLAUDE_PROJECTS_ROOT = path.join(process.env.HOME || '', '.claude', 'projects');
const EXTERNAL_SESSION_SOURCE: SessionSource = 'claude_code';
const RESCAN_INTERVAL_MS = 30_000;

type ClaudeSessionsIndexEntry = {
  sessionId: string;
  fullPath?: string;
  fileMtime?: number;
  firstPrompt?: string;
  summary?: string;
  messageCount?: number;
  created?: string;
  modified?: string;
  projectPath?: string;
};

type ClaudeSessionsIndexFile = {
  version?: number;
  entries?: ClaudeSessionsIndexEntry[];
  originalPath?: string;
};

let syncInFlight = false;
let syncQueued = false;
let lastSyncAt = 0;

function toTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildSessionTitle(entry: ClaudeSessionsIndexEntry | undefined, fallbackPrompt: string, sessionId: string): string {
  const preferred = entry?.summary?.trim() || entry?.firstPrompt?.trim() || fallbackPrompt.trim();
  if (!preferred) {
    return `Claude Code ${sessionId.slice(0, 8)}`;
  }

  const singleLine = preferred.replace(/\s+/g, ' ').trim();
  return singleLine.length > 88 ? `${singleLine.slice(0, 85)}...` : singleLine;
}

function normalizeToolResultContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return typeof item === 'string' ? item : '';
        }

        const block = item as { type?: unknown; text?: unknown; tool_name?: unknown };
        if (block.type === 'text' && typeof block.text === 'string') {
          return block.text;
        }
        if (block.type === 'tool_reference' && typeof block.tool_name === 'string') {
          return `Selected tool: ${block.tool_name}`;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  if (content && typeof content === 'object') {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }

  return '';
}

function normalizeContentBlocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') {
    return content.trim() ? [{ type: 'text', text: content }] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const normalized: ContentBlock[] = [];

  for (const item of content) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const block = item as {
      type?: unknown;
      text?: unknown;
      thinking?: unknown;
      signature?: unknown;
      id?: unknown;
      name?: unknown;
      input?: unknown;
      tool_use_id?: unknown;
      content?: unknown;
      is_error?: unknown;
    };

    if (block.type === 'text' && typeof block.text === 'string') {
      normalized.push({ type: 'text', text: block.text });
      continue;
    }

    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      normalized.push({
        type: 'thinking',
        thinking: block.thinking,
        ...(typeof block.signature === 'string' ? { signature: block.signature } : {}),
      });
      continue;
    }

    if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      normalized.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {},
      });
      continue;
    }

    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      normalized.push({
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: normalizeToolResultContent(block.content),
        ...(block.is_error === true ? { is_error: true } : {}),
      });
    }
  }

  return normalized;
}

function extractPromptText(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }

      const block = item as { type?: unknown; text?: unknown };
      return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function loadClaudeSessionFromJsonl(
  filePath: string,
  entry?: ClaudeSessionsIndexEntry
): Promise<{
  messages: StreamMessage[];
  title: string;
  cwd: string | null;
  model: string | null;
  createdAt: number;
  updatedAt: number;
}> {
  const raw = await fs.readFile(filePath, 'utf-8');
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const messages: StreamMessage[] = [];
  let firstPrompt = '';
  let cwd: string | null = entry?.projectPath?.trim() || null;
  let model: string | null = null;
  let firstTimestamp: number | null = toTimestamp(entry?.created);
  let lastTimestamp: number | null = toTimestamp(entry?.modified);

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const timestamp = typeof event.timestamp === 'string' ? toTimestamp(event.timestamp) : null;
      if (!cwd && typeof event.cwd === 'string' && event.cwd.trim()) {
        cwd = event.cwd;
      }
      if (timestamp !== null) {
        firstTimestamp = firstTimestamp === null ? timestamp : Math.min(firstTimestamp, timestamp);
        lastTimestamp = lastTimestamp === null ? timestamp : Math.max(lastTimestamp, timestamp);
      }

      if (event.type === 'user') {
        const message = event.message as { content?: unknown } | undefined;
        const content = message?.content;
        const promptText = extractPromptText(content);
        const createdAt = timestamp ?? Date.now();

        if (promptText) {
          if (!firstPrompt) {
            firstPrompt = promptText;
          }
          messages.push({
            type: 'user_prompt',
            prompt: promptText,
            createdAt,
          });
          continue;
        }

        const normalized = normalizeContentBlocks(content);
        if (normalized.length > 0) {
          messages.push({
            type: 'user',
            uuid: typeof event.uuid === 'string' ? event.uuid : `external-user-${createdAt}`,
            message: { content: normalized },
            createdAt,
          });
        }
        continue;
      }

      if (event.type === 'assistant') {
        const message = event.message as { content?: unknown; model?: unknown } | undefined;
        const normalized = normalizeContentBlocks(message?.content);
        if (typeof message?.model === 'string' && message.model.trim()) {
          model = message.model;
        }
        if (normalized.length > 0) {
          messages.push({
            type: 'assistant',
            uuid: typeof event.uuid === 'string' ? event.uuid : `external-assistant-${timestamp ?? Date.now()}`,
            message: { content: normalized },
            createdAt: timestamp ?? Date.now(),
          });
        }
        continue;
      }

      if (event.type === 'system' && event.subtype === 'compact_boundary' && typeof event.uuid === 'string') {
        messages.push({
          type: 'system',
          subtype: 'compact_boundary',
          uuid: event.uuid,
          session_id: typeof event.sessionId === 'string' ? event.sessionId : path.basename(filePath, '.jsonl'),
          compactMetadata:
            event.compactMetadata && typeof event.compactMetadata === 'object'
              ? {
                  trigger:
                    (event.compactMetadata as { trigger?: unknown }).trigger === 'auto' ? 'auto' : 'manual',
                  preTokens:
                    typeof (event.compactMetadata as { preTokens?: unknown }).preTokens === 'number'
                      ? (event.compactMetadata as { preTokens: number }).preTokens
                      : 0,
                }
              : { trigger: 'manual', preTokens: 0 },
          createdAt: timestamp ?? Date.now(),
        });
      }
    } catch {
      continue;
    }
  }

  const stat = await fs.stat(filePath);
  const createdAt = firstTimestamp ?? Math.trunc(stat.mtimeMs);
  const updatedAt = lastTimestamp ?? Math.trunc(stat.mtimeMs);
  const title = buildSessionTitle(entry, firstPrompt, path.basename(filePath, '.jsonl'));

  return {
    messages,
    title,
    cwd,
    model,
    createdAt,
    updatedAt,
  };
}

async function listProjectDirectories(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

async function readSessionsIndex(projectDir: string): Promise<Map<string, ClaudeSessionsIndexEntry>> {
  const map = new Map<string, ClaudeSessionsIndexEntry>();
  const indexPath = path.join(projectDir, 'sessions-index.json');

  try {
    const raw = await fs.readFile(indexPath, 'utf-8');
    const parsed = JSON.parse(raw) as ClaudeSessionsIndexFile;
    for (const entry of parsed.entries || []) {
      if (entry && typeof entry.sessionId === 'string') {
        map.set(entry.sessionId, entry);
      }
    }
  } catch {
    // ignore missing or malformed index files
  }

  return map;
}

async function syncExternalClaudeSessions(): Promise<boolean> {
  if (!process.env.HOME) {
    return false;
  }

  const projectDirs = await listProjectDirectories(CLAUDE_PROJECTS_ROOT);
  if (projectDirs.length === 0) {
    const removed = sessions.pruneMissingExternalClaudeSessions([]);
    return removed > 0;
  }

  const validSessionIds: string[] = [];
  let changed = false;

  for (const projectDir of projectDirs) {
    const sessionIndex = await readSessionsIndex(projectDir);
    let fileEntries: string[] = [];

    try {
      fileEntries = (await fs.readdir(projectDir))
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => path.join(projectDir, name));
    } catch {
      continue;
    }

    for (const filePath of fileEntries) {
      const sessionId = path.basename(filePath, '.jsonl');
      validSessionIds.push(sessionId);

      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch {
        continue;
      }

      const nextMtime = Math.trunc(stat.mtimeMs);
      const syncInfo = sessions.getExternalSessionSyncInfo(sessionId);
      if (
        syncInfo?.session_origin === EXTERNAL_SESSION_SOURCE &&
        syncInfo.external_file_path === filePath &&
        syncInfo.external_file_mtime === nextMtime
      ) {
        continue;
      }

      const entry = sessionIndex.get(sessionId);
      const parsed = await loadClaudeSessionFromJsonl(filePath, entry);

      sessions.upsertExternalClaudeSession({
        sessionId,
        title: parsed.title,
        cwd: parsed.cwd,
        model: parsed.model,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        externalFilePath: filePath,
        externalFileMtime: nextMtime,
      });
      sessions.replaceSessionHistory(sessionId, parsed.messages);
      changed = true;

      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  const removed = sessions.pruneMissingExternalClaudeSessions(validSessionIds);
  return changed || removed > 0;
}

export function scheduleExternalClaudeSessionSync(
  mainWindow: BrowserWindow,
  onUpdated: () => void
): void {
  if (syncInFlight) {
    syncQueued = true;
    return;
  }

  if (Date.now() - lastSyncAt < RESCAN_INTERVAL_MS) {
    return;
  }

  syncInFlight = true;
  void syncExternalClaudeSessions()
    .then((changed) => {
      lastSyncAt = Date.now();
      if (changed && !mainWindow.isDestroyed()) {
        onUpdated();
      }
    })
    .catch((error) => {
      console.warn('[external-claude-sessions] Failed to sync external Claude sessions:', error);
    })
    .finally(() => {
      syncInFlight = false;
      if (syncQueued) {
        syncQueued = false;
        scheduleExternalClaudeSessionSync(mainWindow, onUpdated);
      }
    });
}

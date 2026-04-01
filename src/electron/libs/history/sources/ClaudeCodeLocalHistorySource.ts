import { promises as fs } from 'fs';
import * as path from 'path';
import { adaptClaudeCodeJsonl } from '../adapters/claudeCodeLocalAdapter';
import type {
  ClaudeCodeSessionIndexEntry,
  ClaudeCodeSessionIndexFile,
  ClaudeCodeSessionScanResult,
  SessionHistorySource,
  UnifiedHistoryPage,
  UnifiedSessionRecord,
} from '../types';

const CLAUDE_PROJECTS_ROOT = path.join(process.env.HOME || '', '.claude', 'projects');

function encodeCursor(offset: number): string {
  return String(offset);
}

function decodeCursor(cursor: string): number {
  const parsed = Number(cursor);
  return Number.isFinite(parsed) ? parsed : 0;
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

async function readSessionsIndex(projectDir: string): Promise<Map<string, ClaudeCodeSessionIndexEntry>> {
  const map = new Map<string, ClaudeCodeSessionIndexEntry>();
  const indexPath = path.join(projectDir, 'sessions-index.json');

  try {
    const raw = await fs.readFile(indexPath, 'utf-8');
    const parsed = JSON.parse(raw) as ClaudeCodeSessionIndexFile;
    for (const entry of parsed.entries || []) {
      if (entry && typeof entry.sessionId === 'string') {
        map.set(entry.sessionId, entry);
      }
    }
  } catch {
    // ignore
  }

  return map;
}

async function loadAdaptedSession(
  filePath: string,
  entry?: ClaudeCodeSessionIndexEntry
): Promise<ClaudeCodeSessionScanResult> {
  const stat = await fs.stat(filePath);
  const raw = await fs.readFile(filePath, 'utf-8');
  const adapted = adaptClaudeCodeJsonl(raw, filePath, entry);
  return {
    session: {
      ...adapted.session,
      externalFileMtime: Math.trunc(stat.mtimeMs),
    },
    messages: adapted.messages,
  };
}

export class ClaudeCodeLocalHistorySource implements SessionHistorySource {
  readonly kind = 'claude_code_local' as const;

  async scanSessions(): Promise<ClaudeCodeSessionScanResult[]> {
    if (!process.env.HOME) {
      return [];
    }

    const results: ClaudeCodeSessionScanResult[] = [];
    const projectDirs = await listProjectDirectories(CLAUDE_PROJECTS_ROOT);

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
        const entry = sessionIndex.get(sessionId);
        try {
          results.push(await loadAdaptedSession(filePath, entry));
        } catch {
          continue;
        }
      }
    }

    return results;
  }

  async loadLatest(session: UnifiedSessionRecord, limit: number): Promise<UnifiedHistoryPage> {
    const messages = await this.loadAll(session);
    const safeLimit = Math.max(1, limit);
    const start = Math.max(0, messages.length - safeLimit);
    return {
      messages: messages.slice(start),
      cursor: start > 0 ? encodeCursor(start) : null,
      hasMore: start > 0,
    };
  }

  async loadBefore(session: UnifiedSessionRecord, cursor: string, limit: number): Promise<UnifiedHistoryPage> {
    const messages = await this.loadAll(session);
    const offset = Math.max(0, decodeCursor(cursor));
    const safeLimit = Math.max(1, limit);
    const start = Math.max(0, offset - safeLimit);
    return {
      messages: messages.slice(start, offset),
      cursor: start > 0 ? encodeCursor(start) : null,
      hasMore: start > 0,
    };
  }

  async loadAround(
    session: UnifiedSessionRecord,
    anchorCreatedAt: number,
    before: number,
    after: number
  ): Promise<UnifiedHistoryPage> {
    const messages = await this.loadAll(session);
    const anchorIndex = messages.findIndex((message) => message.createdAt === anchorCreatedAt);
    if (anchorIndex === -1) {
      throw new Error('Target message not found in session history.');
    }

    const safeBefore = Math.max(0, before);
    const safeAfter = Math.max(0, after);
    const start = Math.max(0, anchorIndex - safeBefore);
    const end = Math.min(messages.length, anchorIndex + safeAfter + 1);

    return {
      messages: messages.slice(start, end),
      cursor: start > 0 ? encodeCursor(start) : null,
      hasMore: start > 0,
    };
  }

  async loadAll(session: UnifiedSessionRecord) {
    if (!session.externalFilePath) {
      return [];
    }
    const result = await loadAdaptedSession(session.externalFilePath);
    return result.messages;
  }
}

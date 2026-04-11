import { readFileSync } from 'fs';
import { getMemoryWorkspace } from './memory-store';
import {
  extractMemories,
  hasMemoryWritesInTurn,
  loadRecentDailyMemories,
  shouldExtractMemory,
} from './memory-extractor';

type RuntimeProvider = 'claude' | 'codex' | 'opencode';

type MemoryMessage = {
  role: 'user' | 'assistant';
  content: string;
};

const MEMORY_MESSAGE_STORE_KEY = '__aegis_runtime_memory_messages__';
const MEMORY_TOOL_STATE_STORE_KEY = '__aegis_runtime_memory_tool_state__';
const RUNTIME_MEMORY_MAX_CHARS = 2600;
const RUNTIME_MEMORY_MAX_SEGMENT_CHARS = 500;
const RUNTIME_MEMORY_MAX_MATCHES = 4;
const RUNTIME_MEMORY_GET_MAX_MATCHES = 2;
const STOP_WORDS = new Set([
  'the',
  'and',
  'that',
  'this',
  'with',
  'from',
  'have',
  'your',
  'about',
  'what',
  'when',
  'where',
  'which',
  'will',
  'please',
  'thanks',
  'then',
  'just',
  '但是',
  '这个',
  '那个',
  '我们',
  '你们',
  '他们',
  '现在',
  '还是',
  '已经',
  '因为',
  '所以',
  '如果',
  '然后',
  '就是',
  '可以',
  '一下',
]);
const MEMORY_SEARCH_HINTS = [
  'remember',
  'memory',
  'previous',
  'earlier',
  'before',
  'we decided',
  'decision',
  'preference',
  'prefer',
  'history',
  '过去',
  '之前',
  '上次',
  '记得',
  '回顾',
  '偏好',
  '决策',
  '约定',
  '历史',
];

type RuntimeMemoryToolState = {
  didRunRecent: boolean;
};

function getMessageStore(): Map<string, MemoryMessage[]> {
  const globalRef = globalThis as Record<string, unknown>;
  if (!globalRef[MEMORY_MESSAGE_STORE_KEY]) {
    globalRef[MEMORY_MESSAGE_STORE_KEY] = new Map<string, MemoryMessage[]>();
  }
  return globalRef[MEMORY_MESSAGE_STORE_KEY] as Map<string, MemoryMessage[]>;
}

function getMemoryToolStateStore(): Map<string, RuntimeMemoryToolState> {
  const globalRef = globalThis as Record<string, unknown>;
  if (!globalRef[MEMORY_TOOL_STATE_STORE_KEY]) {
    globalRef[MEMORY_TOOL_STATE_STORE_KEY] = new Map<string, RuntimeMemoryToolState>();
  }
  return globalRef[MEMORY_TOOL_STATE_STORE_KEY] as Map<string, RuntimeMemoryToolState>;
}

function getMemoryToolState(sessionId: string): RuntimeMemoryToolState {
  const store = getMemoryToolStateStore();
  const existing = store.get(sessionId);
  if (existing) {
    return existing;
  }
  const next: RuntimeMemoryToolState = { didRunRecent: false };
  store.set(sessionId, next);
  return next;
}

function trimMemorySection(content: string, maxChars: number): string {
  const trimmed = content.trim();
  if (!trimmed) return '';
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}\n\n...[truncated for runtime prompt]`;
}

function extractQueryTerms(prompt: string, maxTerms = 12): string[] {
  const rawTerms = prompt
    .toLowerCase()
    .match(/[\p{L}\p{N}_-]{2,}/gu);
  if (!rawTerms) return [];

  return Array.from(
    new Set(
      rawTerms.filter((term) => term.length >= 2 && !STOP_WORDS.has(term))
    )
  ).slice(0, maxTerms);
}

function buildSearchSnippet(content: string, terms: string[]): { snippet: string; score: number } {
  const normalized = content.trim();
  if (!normalized) return { snippet: '', score: 0 };
  if (terms.length === 0) {
    return { snippet: trimMemorySection(normalized, 220), score: 0 };
  }

  const lower = normalized.toLowerCase();
  let bestIndex = -1;
  let score = 0;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx >= 0) {
      score += 2;
      if (bestIndex === -1 || idx < bestIndex) {
        bestIndex = idx;
      }
    }
  }

  if (bestIndex < 0) {
    return { snippet: '', score: 0 };
  }

  const start = Math.max(0, bestIndex - 120);
  const end = Math.min(normalized.length, start + RUNTIME_MEMORY_MAX_SEGMENT_CHARS);
  const snippet = normalized.slice(start, end).trim();
  return {
    snippet: trimMemorySection(snippet, RUNTIME_MEMORY_MAX_SEGMENT_CHARS),
    score,
  };
}

function normalizeRecentDailyContent(content: string): string {
  return trimMemorySection(
    content
      .replace(/^##\s+Auto-extracted.*$/gim, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    320
  );
}

function buildMemoryGetSnippet(content: string, terms: string[]): string {
  const normalized = content.trim();
  if (!normalized) return '';
  if (terms.length === 0) {
    return trimMemorySection(normalized, 700);
  }

  const lower = normalized.toLowerCase();
  let bestIndex = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx >= 0 && (bestIndex === -1 || idx < bestIndex)) {
      bestIndex = idx;
    }
  }

  if (bestIndex < 0) {
    return '';
  }

  const start = Math.max(0, bestIndex - 220);
  const end = Math.min(normalized.length, start + 700);
  return trimMemorySection(normalized.slice(start, end).trim(), 700);
}

function shouldRunMemorySearch(prompt: string): boolean {
  const lowerPrompt = prompt.toLowerCase();
  if (MEMORY_SEARCH_HINTS.some((hint) => lowerPrompt.includes(hint))) {
    return true;
  }

  return extractQueryTerms(prompt, 8).length >= 5;
}

async function buildMemoryRecentPayload(projectCwd?: string | null): Promise<string> {
  const workspace = await getMemoryWorkspace(projectCwd);
  const sections: string[] = [];

  const assistantIdentity = trimMemorySection(workspace.assistantDocument.content, 260);
  if (assistantIdentity) {
    sections.push(`assistant:\n${assistantIdentity}`);
  }

  const userSnapshot = trimMemorySection(workspace.userDocument.content, 360);
  if (userSnapshot) {
    sections.push(`user:\n${userSnapshot}`);
  }

  const projectSnapshot = trimMemorySection(workspace.projectDocument?.content || '', 420);
  if (projectSnapshot) {
    sections.push(`project:\n${projectSnapshot}`);
  }

  if (projectCwd?.trim()) {
    const recentEntries = loadRecentDailyMemories(projectCwd, 2);
    if (recentEntries.length > 0) {
      const recentBlocks = recentEntries
        .map((entry) => {
          try {
            const raw = readFileSync(entry.path, 'utf-8');
            const normalized = normalizeRecentDailyContent(raw);
            if (!normalized) return '';
            return `${entry.date}: ${normalized}`;
          } catch {
            return '';
          }
        })
        .filter(Boolean)
        .slice(0, 2);

      if (recentBlocks.length > 0) {
        sections.push(`daily:\n${recentBlocks.join('\n')}`);
      }
    }
  }

  return trimMemorySection(sections.join('\n\n'), 1300);
}

async function buildMemorySearchAndGetPayload(params: {
  prompt: string;
  projectCwd?: string | null;
}): Promise<{ searchSection: string; getSections: string[] }> {
  const workspace = await getMemoryWorkspace(params.projectCwd);
  const terms = extractQueryTerms(params.prompt);

  const candidateMatches = [
    { label: 'user', content: workspace.userDocument.content },
    { label: 'project', content: workspace.projectDocument?.content || '' },
    { label: 'assistant', content: workspace.assistantDocument.content },
  ]
    .map((candidate) => {
      const { snippet, score } = buildSearchSnippet(candidate.content, terms);
      return {
        label: candidate.label,
        snippet,
        score,
      };
    })
    .filter((entry) => entry.score > 0 && entry.snippet.length > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, RUNTIME_MEMORY_MAX_MATCHES);

  if (candidateMatches.length === 0) {
    return { searchSection: '', getSections: [] };
  }

  const searchSection = [
    `query: ${params.prompt.trim()}`,
    ...candidateMatches.map((entry, index) => `${index + 1}) [${entry.label}] ${entry.snippet}`),
  ].join('\n');

  const kindToContent: Record<string, string> = {
    assistant: workspace.assistantDocument.content,
    user: workspace.userDocument.content,
    project: workspace.projectDocument?.content || '',
  };

  const getSections = candidateMatches
    .slice(0, RUNTIME_MEMORY_GET_MAX_MATCHES)
    .map((entry) => {
      const content = kindToContent[entry.label] || '';
      const snippet = buildMemoryGetSnippet(content, terms);
      if (!snippet) return '';
      return `[${entry.label}]\n${snippet}`;
    })
    .filter(Boolean);

  return {
    searchSection: trimMemorySection(searchSection, 1200),
    getSections,
  };
}

export async function buildRuntimeManagedPrompt(params: {
  provider: RuntimeProvider;
  prompt: string;
  projectCwd?: string | null;
  sessionId?: string | null;
}): Promise<string> {
  const { provider, prompt, projectCwd } = params;
  if (provider === 'claude') {
    return prompt;
  }

  const sessionKey = params.sessionId?.trim() || `runtime-${provider}-default`;
  const state = getMemoryToolState(sessionKey);
  const toolRuns: string[] = [];
  const sections: string[] = [];

  if (!state.didRunRecent) {
    const recentPayload = await buildMemoryRecentPayload(projectCwd);
    if (recentPayload) {
      toolRuns.push('memory_recent(days=2)');
      sections.push(`memory_recent output:\n${recentPayload}`);
    }
    state.didRunRecent = true;
  }

  if (shouldRunMemorySearch(prompt)) {
    const { searchSection, getSections } = await buildMemorySearchAndGetPayload({
      prompt,
      projectCwd,
    });
    if (searchSection) {
      toolRuns.push(`memory_search(query="${trimMemorySection(prompt.trim(), 120)}")`);
      sections.push(`memory_search output:\n${searchSection}`);
    }
    if (getSections.length > 0) {
      for (let index = 0; index < getSections.length; index += 1) {
        toolRuns.push(`memory_get(match=${index + 1})`);
      }
      sections.push(
        getSections.map((entry, index) => `memory_get #${index + 1} output:\n${entry}`).join('\n\n')
      );
    }
  }

  if (sections.length === 0) {
    return prompt;
  }

  const memoryPacket = trimMemorySection(
    [
      'Tool run log:',
      ...toolRuns.map((tool, index) => `${index + 1}. ${tool}`),
      '',
      ...sections,
    ].join('\n'),
    RUNTIME_MEMORY_MAX_CHARS
  );

  return [
    '## Aegis Runtime Memory Tool Context',
    'Memory was loaded using tool-style retrieval.',
    'Run order: memory_recent first, then memory_search/memory_get only when needed.',
    'If current user instructions conflict with memory, follow the current request.',
    memoryPacket,
    '## User Request',
    prompt,
  ].join('\n\n');
}

export function createRuntimeTurnMemoryTracker(params: {
  sessionId: string;
  projectCwd?: string | null;
}): {
  beginTurn: (prompt: string) => void;
  setAssistantText: (text: string) => void;
  markMemoryWrite: (rawText?: string) => void;
  finalizeTurn: () => void;
} {
  const sessionId = params.sessionId.trim() || 'runtime-default';
  const projectCwd = params.projectCwd?.trim() || '';
  const store = getMessageStore();

  let currentAssistantText = '';
  let currentTurnHasMemoryWrite = false;

  const ensureSessionMessages = (): MemoryMessage[] => {
    const existing = store.get(sessionId);
    if (existing) {
      return existing;
    }
    const next: MemoryMessage[] = [];
    store.set(sessionId, next);
    return next;
  };

  const capMessages = (messages: MemoryMessage[]): void => {
    while (messages.length > 10) {
      messages.shift();
    }
  };

  return {
    beginTurn: (prompt: string) => {
      const trimmedPrompt = prompt.trim();
      currentAssistantText = '';
      currentTurnHasMemoryWrite = false;
      if (!trimmedPrompt) {
        return;
      }
      const messages = ensureSessionMessages();
      messages.push({ role: 'user', content: trimmedPrompt });
      capMessages(messages);
    },
    setAssistantText: (text: string) => {
      currentAssistantText = text.trim();
    },
    markMemoryWrite: (rawText?: string) => {
      if (currentTurnHasMemoryWrite) return;
      const raw = rawText || '';
      if (raw.includes('remember_write') || hasMemoryWritesInTurn(raw)) {
        currentTurnHasMemoryWrite = true;
      }
    },
    finalizeTurn: () => {
      const messages = ensureSessionMessages();
      if (currentAssistantText) {
        messages.push({ role: 'assistant', content: currentAssistantText });
        capMessages(messages);
      }

      if (!projectCwd || currentTurnHasMemoryWrite || messages.length < 2 || !shouldExtractMemory(sessionId)) {
        return;
      }

      void extractMemories(messages.slice(), projectCwd).catch((error) => {
        console.warn('[runtime-memory] Extraction failed:', error);
      });
    },
  };
}

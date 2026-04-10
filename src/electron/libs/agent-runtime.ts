import { getMemoryWorkspace } from './memory-store';
import { extractMemories, hasMemoryWritesInTurn, shouldExtractMemory } from './memory-extractor';

type RuntimeProvider = 'claude' | 'codex' | 'opencode';

type MemoryMessage = {
  role: 'user' | 'assistant';
  content: string;
};

const MEMORY_MESSAGE_STORE_KEY = '__aegis_runtime_memory_messages__';

function getMessageStore(): Map<string, MemoryMessage[]> {
  const globalRef = globalThis as Record<string, unknown>;
  if (!globalRef[MEMORY_MESSAGE_STORE_KEY]) {
    globalRef[MEMORY_MESSAGE_STORE_KEY] = new Map<string, MemoryMessage[]>();
  }
  return globalRef[MEMORY_MESSAGE_STORE_KEY] as Map<string, MemoryMessage[]>;
}

function trimMemorySection(content: string, maxChars: number): string {
  const trimmed = content.trim();
  if (!trimmed) return '';
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}\n\n...[truncated for runtime prompt]`;
}

export async function buildRuntimeManagedPrompt(params: {
  provider: RuntimeProvider;
  prompt: string;
  projectCwd?: string | null;
}): Promise<string> {
  const { provider, prompt, projectCwd } = params;
  if (provider === 'claude') {
    return prompt;
  }

  const workspace = await getMemoryWorkspace(projectCwd);
  const assistantMemory = trimMemorySection(workspace.assistantDocument.content, 1200);
  const userMemory = trimMemorySection(workspace.userDocument.content, 1200);
  const projectMemory = workspace.projectDocument
    ? trimMemorySection(workspace.projectDocument.content, 1400)
    : '';

  const sections = [
    assistantMemory ? `## Assistant Memory\n${assistantMemory}` : '',
    userMemory ? `## User Memory\n${userMemory}` : '',
    projectMemory ? `## Project Memory\n${projectMemory}` : '',
  ].filter(Boolean);

  if (sections.length === 0) {
    return prompt;
  }

  return [
    '## Aegis Runtime Memory Snapshot',
    'Use the memory snapshot below as durable context. Prefer these notes for stable preferences and project conventions.',
    'If the current user prompt conflicts with memory, follow the current prompt.',
    sections.join('\n\n'),
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

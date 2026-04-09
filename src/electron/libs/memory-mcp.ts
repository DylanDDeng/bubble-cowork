import { resolve } from 'path';
import {
  getMemoryWorkspace,
  saveMemoryDocument,
  buildMemoryContext,
} from './memory-store';

type ClaudeAgentSdkModule = typeof import('@anthropic-ai/claude-agent-sdk');

let sdkModule: ClaudeAgentSdkModule | null = null;

async function loadSdk(): Promise<ClaudeAgentSdkModule> {
  if (sdkModule) return sdkModule;
  const dynamicImport = new Function(
    'specifier',
    'return import(specifier);'
  ) as (specifier: string) => Promise<ClaudeAgentSdkModule>;
  sdkModule = await dynamicImport('@anthropic-ai/claude-agent-sdk');
  return sdkModule;
}

async function loadZod() {
  const dynamicImport = new Function(
    'specifier',
    'return import(specifier);'
  ) as (specifier: string) => Promise<typeof import('zod')>;
  return dynamicImport('zod');
}

export const MEMORY_SYSTEM_PROMPT = `## Aegis Memory

**At the start of every conversation, call remember_get for each available memory kind (assistant, user, project) to load long-term context.**

### Memory Retrieval
When the user asks about past decisions, preferences, or context:
1. Use remember_search to find relevant memories
2. Use remember_get to read the full content
3. Do not guess — always search first, then answer

### Proactive Memory Extraction
During the conversation, silently observe and remember important information by calling remember_write (mode: "append"). You should proactively save:
- **User preferences**: communication style, tools they use, recurring requests
- **Decisions made**: architecture choices, design decisions, agreed approaches
- **Key facts**: names, roles, project details, deadlines, account info
- **Corrections**: when the user corrects you, remember the correct information

Do this naturally — no need to announce every save. Aim to save 1-2 entries per meaningful conversation. Skip trivial or transient details.

### Memory Hygiene
- Only use remember_write to update memory. Do NOT edit ad-hoc files like MEMORY.md, user_profile.md, etc.
- Use "append" mode by default. Only use "replace" when consolidating or cleaning up.
- When a memory file grows long, consolidate: read it with remember_get, merge redundant/outdated entries, then replace with a cleaner version.
- Keep each memory file focused and high-signal. Remove outdated information during consolidation.

### Daily Memories
The system automatically extracts conversation highlights into daily logs.
Use remember_recent to review what was discussed in recent days.
These are auto-generated — you do NOT need to write daily memories manually.

### Memory Scopes
- **user**: stable personal facts and preferences (name, style, accounts, habits)
- **assistant**: how you should behave, communicate, and collaborate
- **project**: project-specific context, conventions, decisions, and progress
- **daily** (auto): conversation highlights extracted every few turns`;

function buildSnippet(content: string, query: string): string {
  const lower = content.toLowerCase();
  const target = query.toLowerCase();
  const index = lower.indexOf(target);
  if (index === -1) {
    return content.slice(0, 180).trim();
  }
  const start = Math.max(0, index - 80);
  const end = Math.min(content.length, index + target.length + 80);
  return content.slice(start, end).trim();
}

export async function createAegisMemoryMcpServer(projectCwd?: string | null) {
  const sdk = await loadSdk();
  const { z } = await loadZod();

  return sdk.createSdkMcpServer({
    name: 'aegis-memory',
    version: '0.1.0',
    tools: [
      sdk.tool(
        'remember_search',
        'Search long-term Aegis memory for user preferences, project context, identity, or prior decisions. Always search before answering questions about the past.',
        {
          query: z.string().describe('Search keywords'),
          scope: z.enum(['assistant', 'user', 'project', 'all']).optional().default('all')
            .describe('Scope to search: assistant (persona/rules), user (preferences), project (project-specific), or all'),
        },
        async ({ query, scope }) => {
          try {
            const workspace = await getMemoryWorkspace(projectCwd);
            const docs = [
              ...(scope === 'all' || scope === 'assistant' ? [workspace.assistantDocument] : []),
              ...(scope === 'all' || scope === 'user' ? [workspace.userDocument] : []),
              ...(scope === 'all' || scope === 'project'
                ? workspace.projectDocument ? [workspace.projectDocument] : []
                : []),
            ];
            const matches = docs
              .filter((doc) => doc.content.toLowerCase().includes(query.toLowerCase()))
              .map((doc) => ({
                title: doc.title,
                kind: doc.kind,
                path: doc.path,
                snippet: buildSnippet(doc.content, query),
              }));

            if (matches.length === 0) {
              return { content: [{ type: 'text' as const, text: 'No matching memories found.' }] };
            }

            const formatted = matches
              .map((m, i) => `${i + 1}. [${m.kind}] ${m.title}\n   ${m.snippet}`)
              .join('\n\n');

            return { content: [{ type: 'text' as const, text: formatted }] };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Search failed: ${err instanceof Error ? err.message : 'unknown error'}` }],
            };
          }
        },
      ),

      sdk.tool(
        'remember_get',
        'Read one of the authoritative Aegis memory files. Call this at the START of each conversation to load context.',
        {
          kind: z.enum(['assistant', 'user', 'project']).describe('Which memory to read'),
        },
        async ({ kind }) => {
          try {
            const workspace = await getMemoryWorkspace(projectCwd);
            const doc =
              kind === 'assistant'
                ? workspace.assistantDocument
                : kind === 'user'
                  ? workspace.userDocument
                  : kind === 'project'
                    ? workspace.projectDocument
                    : null;
            if (!doc) {
              return { content: [{ type: 'text' as const, text: `Memory kind "${kind}" is not available (no project selected?).` }] };
            }
            return { content: [{ type: 'text' as const, text: doc.content }] };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Read failed: ${err instanceof Error ? err.message : 'unknown error'}` }],
            };
          }
        },
      ),

      sdk.tool(
        'remember_write',
        'Update one of the authoritative Aegis memory files. Use this instead of editing arbitrary files when storing long-term context.',
        {
          kind: z.enum(['assistant', 'user', 'project']).describe('Which memory to update'),
          content: z.string().describe('New content to write'),
          mode: z.enum(['replace', 'append']).optional().default('append')
            .describe('"append" adds to the end, "replace" overwrites entirely'),
        },
        async ({ kind, content, mode }) => {
          try {
            const workspace = await getMemoryWorkspace(projectCwd);
            const doc =
              kind === 'assistant'
                ? workspace.assistantDocument
                : kind === 'user'
                  ? workspace.userDocument
                  : kind === 'project'
                    ? workspace.projectDocument
                    : null;
            if (!doc) {
              return { content: [{ type: 'text' as const, text: `Memory kind "${kind}" is not available.` }] };
            }

            const nextContent = mode === 'append'
              ? `${doc.content.trimEnd()}\n\n${content}`
              : content;
            const saved = await saveMemoryDocument(resolve(doc.path), nextContent);

            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ ok: true, kind: saved.kind, path: saved.path, updatedAt: saved.updatedAt }, null, 2),
              }],
            };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Write failed: ${err instanceof Error ? err.message : 'unknown error'}` }],
            };
          }
        },
      ),

      sdk.tool(
        'remember_recent',
        'Get recent auto-extracted daily memories (last few days). These are automatically captured conversation highlights. Call this to review what was discussed recently.',
        {
          days: z.number().optional().default(3).describe('Number of recent days to retrieve'),
        },
        async ({ days }) => {
          try {
            const { loadRecentDailyMemories } = await import('./memory-extractor') as typeof import('./memory-extractor');
            const { readFileSync } = await import('fs');
            if (!projectCwd) {
              return { content: [{ type: 'text' as const, text: 'No project selected — daily memories are project-scoped.' }] };
            }
            const recent = loadRecentDailyMemories(projectCwd, days || 3);

            if (recent.length === 0) {
              return { content: [{ type: 'text' as const, text: 'No recent daily memories found.' }] };
            }

            const parts = recent.map(entry => {
              try {
                const content = readFileSync(entry.path, 'utf-8').trim();
                const truncated = content.length > 800 ? content.slice(0, 800) + '...' : content;
                return `## ${entry.date}\n${truncated}`;
              } catch {
                return `## ${entry.date}\n(failed to read)`;
              }
            });

            return { content: [{ type: 'text' as const, text: parts.join('\n\n') }] };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Failed to load daily memories: ${err instanceof Error ? err.message : 'unknown error'}` }],
            };
          }
        },
      ),
    ],
  });
}

export { buildMemoryContext };

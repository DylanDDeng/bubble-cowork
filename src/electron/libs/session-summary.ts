import { createHash } from 'crypto';
import type { ContentBlock, StreamMessage } from '../../shared/types';

export type SessionSummaryEntryRole =
  | 'user'
  | 'assistant'
  | 'plan'
  | 'tool'
  | 'tool_result'
  | 'event';

export interface SessionSummaryEntry {
  role: SessionSummaryEntryRole;
  text: string;
}

export interface SessionSummarySourceMetadata {
  entryCount: number;
  digest: string;
  incrementalUpdates: number;
}

export const SESSION_SUMMARY_SOURCE_VERSION = 'environment-session-summary-v1';
export const SESSION_SUMMARY_CHUNK_MAX_CHARS = 36_000;
export const SESSION_SUMMARY_MAX_INCREMENTAL_UPDATES = 4;

const TOOL_DETAIL_MAX_CHARS = 4_000;

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

function truncateToolDetail(value: string): string {
  const normalized = normalizeText(value);
  if (normalized.length <= TOOL_DETAIL_MAX_CHARS) return normalized;
  return `${normalized.slice(0, TOOL_DETAIL_MAX_CHARS - 30).trimEnd()}\n...[tool detail truncated]`;
}

function stringifyToolInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return '[unserializable tool input]';
  }
}

function isLocalUtilityAssistantText(text: string): boolean {
  return (
    text.startsWith('**Session usage**') ||
    text.startsWith('**Context compacted**') ||
    text.startsWith('Compacting conversation...') ||
    text.startsWith('Failed to compact conversation') ||
    text.includes('Aegis yet.')
  );
}

function appendContentBlocks(entries: SessionSummaryEntry[], blocks: ContentBlock[]): void {
  for (const block of blocks) {
    if (block.type === 'text') {
      const text = normalizeText(block.text);
      if (text && !isLocalUtilityAssistantText(text)) {
        entries.push({ role: 'assistant', text });
      }
      continue;
    }

    if (block.type === 'tool_use') {
      const input = truncateToolDetail(stringifyToolInput(block.input));
      entries.push({
        role: 'tool',
        text: input ? `${block.name}\n${input}` : block.name,
      });
      continue;
    }

    if (block.type === 'tool_result') {
      const content = truncateToolDetail(block.content);
      if (content) {
        entries.push({
          role: 'tool_result',
          text: `${block.is_error ? 'Error' : 'Result'} for ${block.tool_use_id}\n${content}`,
        });
      }
    }
  }
}

export function collectSessionSummaryEntries(history: StreamMessage[]): SessionSummaryEntry[] {
  const entries: SessionSummaryEntry[] = [];

  for (const message of history) {
    if (message.parentToolUseId) continue;

    if (message.type === 'user_prompt') {
      const prompt = normalizeText(message.prompt);
      if (prompt) entries.push({ role: 'user', text: prompt });
      continue;
    }

    if (message.type === 'user') {
      const text = message.message.content
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => normalizeText(block.text))
        .filter(Boolean)
        .join('\n\n');
      if (text) entries.push({ role: 'user', text });
      for (const block of message.message.content) {
        if (block.type !== 'tool_result') continue;
        const content = truncateToolDetail(block.content);
        if (content) {
          entries.push({
            role: 'tool_result',
            text: `${block.is_error ? 'Error' : 'Result'} for ${block.tool_use_id}\n${content}`,
          });
        }
      }
      continue;
    }

    if (message.type === 'assistant') {
      appendContentBlocks(entries, message.message.content);
      continue;
    }

    if (message.type === 'proposed_plan') {
      const plan = normalizeText(message.planMarkdown);
      if (plan) entries.push({ role: 'plan', text: plan });
      continue;
    }

    if (message.type === 'plan_update') {
      const plan = message.steps
        .map((step) => `- [${step.status}] ${step.step}`)
        .join('\n');
      if (plan) entries.push({ role: 'plan', text: plan });
      continue;
    }

    if (message.type === 'result' && message.subtype !== 'success') {
      entries.push({ role: 'event', text: 'The turn ended with an error.' });
    }
  }

  return entries;
}

const ROLE_LABELS: Record<SessionSummaryEntryRole, string> = {
  user: 'USER',
  assistant: 'ASSISTANT',
  plan: 'PLAN',
  tool: 'TOOL CALL',
  tool_result: 'TOOL RESULT',
  event: 'EVENT',
};

export function renderSessionSummaryEntry(entry: SessionSummaryEntry): string {
  return `[${ROLE_LABELS[entry.role]}]\n${entry.text}`;
}

export function renderSessionSummaryEntries(entries: SessionSummaryEntry[]): string {
  return entries.map(renderSessionSummaryEntry).join('\n\n');
}

export function digestSessionSummaryEntries(entries: SessionSummaryEntry[]): string {
  return createHash('sha256').update(renderSessionSummaryEntries(entries)).digest('hex');
}

export function buildSessionSummarySourceIds(
  entries: SessionSummaryEntry[],
  incrementalUpdates: number
): string[] {
  return [
    SESSION_SUMMARY_SOURCE_VERSION,
    `entries:${entries.length}`,
    `digest:${digestSessionSummaryEntries(entries)}`,
    `increments:${Math.max(0, Math.floor(incrementalUpdates))}`,
  ];
}

export function parseSessionSummarySourceIds(
  sourceIds: string[] | null | undefined
): SessionSummarySourceMetadata | null {
  if (!sourceIds?.includes(SESSION_SUMMARY_SOURCE_VERSION)) return null;
  const entryCount = Number(sourceIds.find((value) => value.startsWith('entries:'))?.slice(8));
  const digest = sourceIds.find((value) => value.startsWith('digest:'))?.slice(7) || '';
  const incrementalUpdates = Number(
    sourceIds.find((value) => value.startsWith('increments:'))?.slice(11)
  );
  if (!Number.isInteger(entryCount) || entryCount < 0 || !/^[a-f0-9]{64}$/.test(digest)) {
    return null;
  }
  return {
    entryCount,
    digest,
    incrementalUpdates:
      Number.isInteger(incrementalUpdates) && incrementalUpdates >= 0 ? incrementalUpdates : 0,
  };
}

export function isSessionSummaryCurrent(
  entries: SessionSummaryEntry[],
  metadata: SessionSummarySourceMetadata | null
): boolean {
  return Boolean(
    metadata &&
      metadata.entryCount === entries.length &&
      metadata.digest === digestSessionSummaryEntries(entries)
  );
}

export function isAppendOnlySessionSummaryUpdate(
  entries: SessionSummaryEntry[],
  metadata: SessionSummarySourceMetadata | null
): boolean {
  if (!metadata || entries.length <= metadata.entryCount) return false;
  return (
    digestSessionSummaryEntries(entries.slice(0, metadata.entryCount)) === metadata.digest
  );
}

function splitRenderedEntry(value: string, maxChars: number): string[] {
  if (value.length <= maxChars) return [value];
  const parts: string[] = [];
  for (let offset = 0; offset < value.length; offset += maxChars) {
    parts.push(value.slice(offset, offset + maxChars));
  }
  return parts;
}

export function chunkSessionSummaryEntries(
  entries: SessionSummaryEntry[],
  maxChars = SESSION_SUMMARY_CHUNK_MAX_CHARS
): string[] {
  const safeMaxChars = Math.max(1_000, Math.floor(maxChars));
  const chunks: string[] = [];
  let current = '';

  for (const entry of entries) {
    const renderedParts = splitRenderedEntry(renderSessionSummaryEntry(entry), safeMaxChars);
    for (const rendered of renderedParts) {
      const next = current ? `${current}\n\n${rendered}` : rendered;
      if (next.length > safeMaxChars && current) {
        chunks.push(current);
        current = rendered;
      } else {
        current = next;
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

const SUMMARY_REQUIREMENTS = [
  '- the overall user goal and expected deliverable',
  '- work completed and important findings',
  '- key decisions, user preferences, and constraints',
  '- relevant files, commands, errors, and technical details',
  '- the current state, unresolved issues, and concrete next steps',
];

export function buildSessionSummaryChunkPrompt(params: {
  sessionTitle: string;
  transcriptChunk: string;
  part: number;
  totalParts: number;
}): string {
  return [
    'You are extracting durable facts from one part of an Aegis coding session.',
    'Do not continue the task, ask questions, or use tools.',
    `Session title: ${params.sessionTitle || 'Untitled session'}`,
    `Transcript part: ${params.part} of ${params.totalParts}`,
    '',
    'Preserve:',
    ...SUMMARY_REQUIREMENTS,
    '',
    'Return concise factual notes in the dominant language of the conversation.',
    'Do not add assumptions or commentary.',
    '',
    params.transcriptChunk,
  ].join('\n');
}

export function buildSessionSummaryPrompt(params: {
  sessionTitle: string;
  sourceText: string;
  previousSummary?: string | null;
  incremental?: boolean;
}): string {
  const contextSections: string[] = [];
  if (params.previousSummary) {
    contextSections.push('Previous session summary:', params.previousSummary.trim(), '');
  }
  contextSections.push(
    params.incremental ? 'New conversation since that summary:' : 'Complete session material:',
    params.sourceText.trim()
  );

  return [
    'Create a faithful, compact summary of the entire Aegis session.',
    'Do not continue the task, ask questions, or use tools.',
    `Session title: ${params.sessionTitle || 'Untitled session'}`,
    '',
    'The summary must cover:',
    ...SUMMARY_REQUIREMENTS,
    '',
    'Use the dominant language of the conversation.',
    'Use short **bold** markdown section headings and concise "- " bullets where useful.',
    'Aim for 800-1600 characters, but preserve critical technical facts over brevity.',
    'Do not mention that you are summarizing and do not invent missing information.',
    'Return only the summary wrapped in <summary></summary>.',
    '',
    ...contextSections,
  ].join('\n');
}


// Scores sidebar palette results for actions, projects, and threads.
// Pure client-side, deterministic — keeps title hits ahead of message-content hits
// while still surfacing a useful snippet for chat matches.
import type { AgentProvider } from '../../types';

export interface SidebarSearchAction {
  id: string;
  label: string;
  description: string;
  keywords?: readonly string[];
  shortcutLabel?: string | null;
}

export interface SidebarSearchProject {
  id: string;
  name: string;
  cwd: string;
  sessionCount: number;
  lastUpdatedAt: number;
}

export interface SidebarSearchProjectMatch {
  id: string;
  project: SidebarSearchProject;
}

export interface SidebarSearchThread {
  id: string;
  title: string;
  projectName: string;
  projectCwd: string | null;
  provider?: AgentProvider;
  updatedAt: number;
  messages: readonly { text: string }[];
}

export interface SidebarSearchThreadMatch {
  id: string;
  thread: SidebarSearchThread;
  matchKind: 'message' | 'project' | 'title';
  snippet: string | null;
  messageMatchCount: number;
}

function normalizeText(value: string): string {
  return value.trim().replaceAll(/\s+/g, ' ').toLowerCase();
}

function normalizeDisplayText(value: string): string {
  return value.trim().replaceAll(/\s+/g, ' ');
}

function tokenizeQuery(value: string): string[] {
  return normalizeText(value)
    .split(' ')
    .filter((token) => token.length > 0);
}

function truncateSnippet(value: string, startIndex: number, queryLength: number): string {
  const SNIPPET_MAX_LENGTH = 88;
  const safeStart = Math.max(0, startIndex);
  if (value.length <= SNIPPET_MAX_LENGTH) {
    return value;
  }

  const contextBefore = Math.min(28, safeStart);
  const center = safeStart + Math.max(queryLength, 1) / 2;
  const desiredStart = Math.max(
    0,
    Math.round(center - SNIPPET_MAX_LENGTH / 2) - contextBefore
  );
  const boundedStart = Math.min(desiredStart, Math.max(0, value.length - SNIPPET_MAX_LENGTH));
  const boundedEnd = Math.min(value.length, boundedStart + SNIPPET_MAX_LENGTH);
  const prefix = boundedStart > 0 ? '...' : '';
  const suffix = boundedEnd < value.length ? '...' : '';
  return `${prefix}${value.slice(boundedStart, boundedEnd).trim()}${suffix}`;
}

function buildMessageSnippet(
  messageText: string,
  query: string,
  queryTokens: readonly string[]
): string {
  const display = normalizeDisplayText(messageText);
  if (!display) return '';
  const lower = display.toLowerCase();

  const phraseIndex = lower.indexOf(query);
  if (phraseIndex >= 0) {
    return truncateSnippet(display, phraseIndex, query.length);
  }

  let earliest = Number.POSITIVE_INFINITY;
  let matchedToken = '';
  for (const token of queryTokens) {
    const idx = lower.indexOf(token);
    if (idx >= 0 && idx < earliest) {
      earliest = idx;
      matchedToken = token;
    }
  }

  if (!Number.isFinite(earliest)) {
    return truncateSnippet(display, 0, 0);
  }
  return truncateSnippet(display, earliest, matchedToken.length);
}

function scoreMessage(
  messages: SidebarSearchThread['messages'],
  query: string,
  queryTokens: readonly string[]
): { messageMatchCount: number; score: number | null; snippet: string | null } {
  let bestScore: number | null = null;
  let bestSnippet: string | null = null;
  let matchCount = 0;

  for (const message of messages) {
    const normalized = normalizeText(message.text);
    if (!normalized) continue;

    let score: number | null = null;
    if (normalized === query) {
      score = 165;
    } else if (normalized.startsWith(query)) {
      score = 155;
    } else if (normalized.includes(query)) {
      score = 145;
    } else if (
      queryTokens.length > 1 &&
      queryTokens.every((token) => normalized.includes(token))
    ) {
      score = 132;
    }

    if (score === null) continue;
    matchCount += 1;
    if (bestScore === null || score > bestScore) {
      bestScore = score;
      bestSnippet = buildMessageSnippet(message.text, query, queryTokens);
    }
  }

  return { messageMatchCount: matchCount, score: bestScore, snippet: bestSnippet };
}

function scoreAction(action: SidebarSearchAction, query: string): number | null {
  if (!query) return 0;
  const label = normalizeText(action.label);
  const description = normalizeText(action.description);
  const keywords = (action.keywords ?? []).map(normalizeText);

  if (label === query) return 140;
  if (label.startsWith(query)) return 120;
  if (keywords.some((k) => k === query)) return 110;
  if (label.includes(query)) return 100;
  if (keywords.some((k) => k.includes(query))) return 90;
  if (description.includes(query)) return 70;
  return null;
}

function scoreProject(project: SidebarSearchProject, query: string): number | null {
  if (!query) return null;
  const name = normalizeText(project.name);
  const cwd = normalizeText(project.cwd);

  if (name === query) return 150;
  if (name.startsWith(query)) return 130;
  if (name.includes(query)) return 105;
  if (cwd.includes(query)) return 70;
  return null;
}

export function matchSidebarSearchActions(
  actions: readonly SidebarSearchAction[],
  query: string
): SidebarSearchAction[] {
  const normalized = normalizeText(query);

  const scored = actions
    .map((action, index) => ({ action, index, score: scoreAction(action, normalized) }))
    .filter((c): c is { action: SidebarSearchAction; index: number; score: number } => c.score !== null);

  scored.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    return left.index - right.index;
  });

  return scored.map((c) => c.action);
}

export function matchSidebarSearchProjects(
  projects: readonly SidebarSearchProject[],
  query: string,
  limit = 6
): SidebarSearchProjectMatch[] {
  const normalized = normalizeText(query);
  if (!normalized) return [];

  const scored = projects
    .map((project) => ({
      id: `project:${project.id}`,
      project,
      score: scoreProject(project, normalized),
    }))
    .filter(
      (c): c is { id: string; project: SidebarSearchProject; score: number } => c.score !== null
    );

  scored.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    if (left.project.lastUpdatedAt !== right.project.lastUpdatedAt) {
      return right.project.lastUpdatedAt - left.project.lastUpdatedAt;
    }
    return left.project.name.localeCompare(right.project.name);
  });

  return scored.slice(0, limit).map(({ id, project }) => ({ id, project }));
}

export function matchSidebarSearchThreads(
  threads: readonly SidebarSearchThread[],
  query: string,
  limit = 8
): SidebarSearchThreadMatch[] {
  const normalized = normalizeText(query);
  const queryTokens = tokenizeQuery(query);

  if (!normalized) {
    // Empty query: show a few recent threads as quick-jump suggestions.
    const recents: SidebarSearchThreadMatch[] = threads.map((thread) => ({
      id: `thread:${thread.id}`,
      thread,
      matchKind: 'title',
      snippet: null,
      messageMatchCount: 0,
    }));
    recents.sort((left, right) => right.thread.updatedAt - left.thread.updatedAt);
    return recents.slice(0, 5);
  }

  interface ScoredThread {
    id: string;
    thread: SidebarSearchThread;
    index: number;
    score: number;
    matchKind: SidebarSearchThreadMatch['matchKind'];
    snippet: string | null;
    messageMatchCount: number;
    titleLength: number;
  }

  const scored: ScoredThread[] = [];
  for (const [index, thread] of threads.entries()) {
    const title = normalizeText(thread.title);
    const projectName = normalizeText(thread.projectName);
    const messageMatch = scoreMessage(thread.messages, normalized, queryTokens);

    let score: number | null = null;
    let matchKind: SidebarSearchThreadMatch['matchKind'] = 'title';
    let snippet: string | null = null;

    if (title === normalized) {
      score = 170;
      matchKind = 'title';
    } else if (title.startsWith(normalized)) {
      score = 145;
      matchKind = 'title';
    } else if (title.includes(normalized)) {
      score = 125;
      matchKind = 'title';
    } else if (messageMatch.score !== null) {
      score = messageMatch.score;
      matchKind = 'message';
      snippet = messageMatch.snippet;
    } else if (projectName.startsWith(normalized)) {
      score = 80;
      matchKind = 'project';
    } else if (projectName.includes(normalized)) {
      score = 65;
      matchKind = 'project';
    }

    if (score === null) continue;

    scored.push({
      id: `thread:${thread.id}`,
      thread,
      index,
      score,
      matchKind,
      snippet,
      messageMatchCount: messageMatch.messageMatchCount,
      titleLength: thread.title.length,
    });
  }

  scored.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    if (left.thread.updatedAt !== right.thread.updatedAt) {
      return right.thread.updatedAt - left.thread.updatedAt;
    }
    if (left.titleLength !== right.titleLength) return left.titleLength - right.titleLength;
    return left.index - right.index;
  });

  return scored
    .slice(0, limit)
    .map(({ id, matchKind, messageMatchCount, snippet, thread }) => ({
      id,
      thread,
      matchKind,
      snippet,
      messageMatchCount,
    }));
}

export function hasSidebarSearchResults(input: {
  actions: readonly SidebarSearchAction[];
  projects: readonly SidebarSearchProjectMatch[];
  threads: readonly SidebarSearchThreadMatch[];
}): boolean {
  return input.actions.length > 0 || input.projects.length > 0 || input.threads.length > 0;
}

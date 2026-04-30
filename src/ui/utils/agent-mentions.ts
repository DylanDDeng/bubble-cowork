import type { AgentProfile } from '../types';

export interface ProjectAgentMentionState {
  query: string;
  start: number;
  end: number;
}

export interface ProjectAgentMentionSuggestion {
  profile: AgentProfile;
  handle: string;
}

export interface ProjectAgentMentionMatch {
  profile: AgentProfile;
  handle: string;
  raw: string;
  start: number;
  end: number;
}

const AGENT_HANDLE_PATTERN = /(^|\s)@([A-Za-z0-9_-]+)(?=$|\s|[.,!?;:])/g;

export function normalizeAgentMentionHandle(value: string): string {
  return value
    .replace(/^@/, '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .toLowerCase();
}

export function getAgentMentionHandle(profile: AgentProfile): string {
  return (
    normalizeAgentMentionHandle(profile.name) ||
    normalizeAgentMentionHandle(profile.id) ||
    'agent'
  );
}

export function getAgentMentionAliases(profile: AgentProfile): string[] {
  return Array.from(
    new Set([
      getAgentMentionHandle(profile),
      normalizeAgentMentionHandle(profile.id),
      normalizeAgentMentionHandle(profile.role),
    ].filter(Boolean))
  );
}

export function getProjectAgentProfiles(params: {
  agentProfiles: Record<string, AgentProfile>;
  projectAgentRostersByProject: Record<string, string[]>;
  cwd?: string | null;
}): AgentProfile[] {
  const projectKey = params.cwd?.trim();
  if (!projectKey || !Object.prototype.hasOwnProperty.call(params.projectAgentRostersByProject, projectKey)) {
    return [];
  }

  return params.projectAgentRostersByProject[projectKey]
    .map((profileId) => params.agentProfiles[profileId])
    .filter((profile): profile is AgentProfile => Boolean(profile?.enabled));
}

export function getProjectAgentMentionState(
  prompt: string,
  cursorIndex: number
): ProjectAgentMentionState | null {
  const safeCursor = Math.max(0, Math.min(cursorIndex, prompt.length));
  const beforeCursor = prompt.slice(0, safeCursor);
  const mentionMatch = beforeCursor.match(/(?:^|\s)@([A-Za-z0-9_-]*)$/);

  if (!mentionMatch) {
    return null;
  }

  const query = mentionMatch[1] || '';
  const start = safeCursor - query.length - 1;
  if (start < 0 || prompt[start] !== '@') {
    return null;
  }

  let end = safeCursor;
  while (end < prompt.length) {
    const next = prompt[end];
    if (!next || /\s/.test(next) || next === '@' || /[.,!?;:]/.test(next)) {
      break;
    }
    if (!/[A-Za-z0-9_-]/.test(next)) {
      return null;
    }
    end += 1;
  }

  return { query, start, end };
}

function rankAgentSuggestion(profile: AgentProfile, handle: string, query: string): number {
  if (!query) {
    return 0;
  }

  const normalizedQuery = normalizeAgentMentionHandle(query);
  const aliases = getAgentMentionAliases(profile);
  const name = profile.name.trim().toLowerCase();
  const role = profile.role.trim().toLowerCase();

  if (handle === normalizedQuery || aliases.includes(normalizedQuery)) return 0;
  if (handle.startsWith(normalizedQuery)) return 1;
  if (aliases.some((alias) => alias.startsWith(normalizedQuery))) return 2;
  if (name.includes(normalizedQuery) || role.includes(normalizedQuery)) return 3;
  if (handle.includes(normalizedQuery)) return 4;
  return 5;
}

export function filterProjectAgentMentionSuggestions(
  profiles: AgentProfile[],
  query: string,
  limit = 6
): ProjectAgentMentionSuggestion[] {
  const normalizedQuery = normalizeAgentMentionHandle(query);

  return profiles
    .map((profile) => ({
      profile,
      handle: getAgentMentionHandle(profile),
    }))
    .filter(({ profile, handle }) => {
      if (!normalizedQuery) {
        return true;
      }
      const aliases = getAgentMentionAliases(profile);
      return (
        handle.includes(normalizedQuery) ||
        aliases.some((alias) => alias.includes(normalizedQuery)) ||
        profile.name.toLowerCase().includes(normalizedQuery) ||
        profile.role.toLowerCase().includes(normalizedQuery)
      );
    })
    .sort((left, right) => {
      const rankDiff =
        rankAgentSuggestion(left.profile, left.handle, normalizedQuery) -
        rankAgentSuggestion(right.profile, right.handle, normalizedQuery);
      if (rankDiff !== 0) {
        return rankDiff;
      }
      return left.profile.createdAt - right.profile.createdAt;
    })
    .slice(0, limit);
}

export function insertProjectAgentMention(
  prompt: string,
  mention: ProjectAgentMentionState,
  profile: AgentProfile
): { prompt: string; cursorIndex: number } {
  const replacement = `@${getAgentMentionHandle(profile)} `;
  const nextPrompt = `${prompt.slice(0, mention.start)}${replacement}${prompt.slice(mention.end)}`;
  return {
    prompt: nextPrompt,
    cursorIndex: mention.start + replacement.length,
  };
}

export function extractProjectAgentMentions(
  prompt: string,
  profiles: AgentProfile[]
): ProjectAgentMentionMatch[] {
  const profileByAlias = new Map<string, AgentProfile>();
  const handleByProfileId = new Map<string, string>();

  for (const profile of profiles) {
    const handle = getAgentMentionHandle(profile);
    handleByProfileId.set(profile.id, handle);
    for (const alias of getAgentMentionAliases(profile)) {
      if (!profileByAlias.has(alias)) {
        profileByAlias.set(alias, profile);
      }
    }
  }

  const matches: ProjectAgentMentionMatch[] = [];
  for (const match of prompt.matchAll(AGENT_HANDLE_PATTERN)) {
    const prefix = match[1] || '';
    const value = normalizeAgentMentionHandle(match[2] || '');
    const profile = profileByAlias.get(value);
    if (!profile) {
      continue;
    }

    const matchIndex = match.index ?? 0;
    const start = matchIndex + prefix.length;
    const end = start + 1 + (match[2] || '').length;
    matches.push({
      profile,
      handle: handleByProfileId.get(profile.id) || getAgentMentionHandle(profile),
      raw: `@${match[2] || ''}`,
      start,
      end,
    });
  }

  return matches;
}

export function resolveProjectAgentMentionRoute(
  prompt: string,
  profiles: AgentProfile[]
): ProjectAgentMentionMatch | null {
  const uniqueMatches = new Map<string, ProjectAgentMentionMatch>();
  for (const mention of extractProjectAgentMentions(prompt, profiles)) {
    if (!uniqueMatches.has(mention.profile.id)) {
      uniqueMatches.set(mention.profile.id, mention);
    }
  }

  return Array.from(uniqueMatches.values()).sort((left, right) => left.start - right.start)[0] || null;
}

export function getAgentMentionHandles(profiles: AgentProfile[]): string[] {
  return profiles.flatMap(getAgentMentionAliases);
}

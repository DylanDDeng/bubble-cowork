import type { ClaudeSkillSummary, StreamMessage } from '../types';

function normalizeSkillToken(value: string): string {
  return value.replace(/^\//, '').trim().toLowerCase();
}

export function getSlashSkillQuery(prompt: string): string | null {
  const trimmed = prompt.trimStart();
  const match = trimmed.match(/^\/([^\s]*)$/);
  return match ? match[1].toLowerCase() : null;
}

export function insertSlashSkill(prompt: string, skillName: string): string {
  const leadingWhitespace = prompt.match(/^\s*/)?.[0] || '';
  return `${leadingWhitespace}/${skillName} `;
}

export function buildPromptWithSkill(skillName: string, remainder: string): string {
  const trimmedRemainder = remainder.trimStart();
  return trimmedRemainder ? `/${skillName} ${trimmedRemainder}` : `/${skillName}`;
}

export function parseSelectedSkillPrompt(
  prompt: string,
  skills: ClaudeSkillSummary[]
): { skill: ClaudeSkillSummary; remainder: string } | null {
  const trimmed = prompt.trimStart();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const firstWhitespaceIndex = trimmed.search(/\s/);
  const skillName =
    firstWhitespaceIndex === -1
      ? trimmed.slice(1)
      : trimmed.slice(1, firstWhitespaceIndex);

  if (!skillName) {
    return null;
  }

  const normalizedSkillName = normalizeSkillToken(skillName);
  const skill = skills.find((item) => normalizeSkillToken(item.name) === normalizedSkillName);
  if (!skill) {
    return null;
  }

  const remainder =
    firstWhitespaceIndex === -1 ? '' : trimmed.slice(firstWhitespaceIndex).replace(/^\s+/, '');

  return { skill, remainder };
}

export function getSessionSkillNames(messages: StreamMessage[]): Set<string> {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type === 'system' && message.subtype === 'init' && Array.isArray(message.skills)) {
      return new Set(message.skills.map((skill) => skill.trim()).filter(Boolean));
    }
  }

  return new Set();
}

function rankSkill(skill: ClaudeSkillSummary, query: string): number {
  const lowerName = skill.name.toLowerCase();
  const lowerTitle = skill.title.toLowerCase();

  if (!query) return 0;
  if (lowerName === query) return 0;
  if (lowerName.startsWith(query)) return 1;
  if (lowerTitle.startsWith(query)) return 2;
  if (lowerName.includes(query)) return 3;
  if (lowerTitle.includes(query)) return 4;
  return 5;
}

function rankSkillSource(source: ClaudeSkillSummary['source']): number {
  if (source === 'project') return 0;
  if (source === 'plugin') return 1;
  return 2;
}

export function mergeClaudeSkills(
  userSkills: ClaudeSkillSummary[],
  projectSkills: ClaudeSkillSummary[],
  sessionSkillNames?: Set<string>
): ClaudeSkillSummary[] {
  const merged = new Map<string, ClaudeSkillSummary>();

  for (const skill of userSkills) {
    merged.set(skill.name, skill);
  }

  for (const skill of projectSkills) {
    merged.set(skill.name, skill);
  }

  const result = Array.from(merged.values());
  if (!sessionSkillNames || sessionSkillNames.size === 0) {
    return result.sort((left, right) => left.name.localeCompare(right.name));
  }

  return result
    .sort((left, right) => {
      const leftInSession = sessionSkillNames.has(left.name);
      const rightInSession = sessionSkillNames.has(right.name);
      if (leftInSession !== rightInSession) {
        return leftInSession ? -1 : 1;
      }

      if (left.source !== right.source) {
        return rankSkillSource(left.source) - rankSkillSource(right.source);
      }

      return left.name.localeCompare(right.name);
    });
}

export function filterClaudeSkills(
  skills: ClaudeSkillSummary[],
  query: string,
  limit = 8
): ClaudeSkillSummary[] {
  return skills
    .filter((skill) => {
      if (!query) return true;
      const lowerName = skill.name.toLowerCase();
      const lowerTitle = skill.title.toLowerCase();
      return lowerName.includes(query) || lowerTitle.includes(query);
    })
    .sort((left, right) => {
      const rankDifference = rankSkill(left, query) - rankSkill(right, query);
      if (rankDifference !== 0) {
        return rankDifference;
      }

      if (left.source !== right.source) {
        return rankSkillSource(left.source) - rankSkillSource(right.source);
      }

      return left.name.localeCompare(right.name);
    })
    .slice(0, limit);
}

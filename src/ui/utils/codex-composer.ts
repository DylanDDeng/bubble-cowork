import type { ClaudeSkillSummary, ProviderInputReference } from '../types';

export const CODEX_PLUGIN_SLASH_PREFIX = 'plugin:';

export interface CodexReferencePayload {
  codexSkills?: ProviderInputReference[];
  codexMentions?: ProviderInputReference[];
}

export function isCodexPluginSlashSkill(skill: ClaudeSkillSummary | null | undefined): boolean {
  return Boolean(
    skill &&
      (skill.source === 'plugin' ||
        skill.name.toLowerCase().startsWith(CODEX_PLUGIN_SLASH_PREFIX))
  );
}

export function buildCodexReferencePayload(
  selectedSkill: ClaudeSkillSummary | null | undefined
): CodexReferencePayload {
  if (!selectedSkill) {
    return {};
  }

  const name = selectedSkill.name.replace(/^\//, '').trim();
  const path = selectedSkill.path.trim();
  if (!name || !path) {
    return {};
  }

  if (isCodexPluginSlashSkill(selectedSkill)) {
    const pluginName = name.toLowerCase().startsWith(CODEX_PLUGIN_SLASH_PREFIX)
      ? name.slice(CODEX_PLUGIN_SLASH_PREFIX.length).trim()
      : name;
    return pluginName ? { codexMentions: [{ name: pluginName, path }] } : {};
  }

  return { codexSkills: [{ name, path }] };
}

import type { ClaudeSkillSummary, ProviderInputReference } from '../types';

export interface AegisReferencePayload {
  aegisSkills?: ProviderInputReference[];
  aegisMentions?: ProviderInputReference[];
}

export function buildAegisReferencePayload(
  selectedSkill: ClaudeSkillSummary | null | undefined
): AegisReferencePayload {
  if (!selectedSkill) return {};
  const name = selectedSkill.name.replace(/^\$/, '').trim();
  const path = selectedSkill.path.trim();
  if (!name || !path) return {};
  return { aegisSkills: [{ name, path }] };
}

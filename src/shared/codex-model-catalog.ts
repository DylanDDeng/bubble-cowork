/**
 * Codex model catalog helpers shared by the main-process settings reader.
 *
 * Why this exists:
 * - `~/.codex/models_cache.json` is rewritten frequently by Codex online refresh.
 * - Bare `codex app-server` `model/list` currently often returns an incomplete
 *   catalog (missing gpt-5.6-sol/terra/luna) and can overwrite a fuller cache.
 * - The models themselves remain usable by slug even when metadata is missing
 *   (verified with `codex exec -c model="gpt-5.6-terra"`).
 *
 * So Aegis keeps a sticky union of every model we've ever seen, and expands the
 * known GPT-5.6 family when any member appears (including config default).
 */

export type CodexCatalogModelSeed = {
  name: string;
  label?: string;
  priority?: number | null;
};

/** GPT-5.6 family currently shipped by Codex (Sol / Terra / Luna). */
export const CODEX_GPT_56_FAMILY: readonly CodexCatalogModelSeed[] = [
  { name: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', priority: 1 },
  { name: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', priority: 2 },
  { name: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', priority: 3 },
] as const;

export function isCodexGpt56FamilyMember(model: string | null | undefined): boolean {
  const normalized = model?.trim().toLowerCase() || '';
  return normalized === 'gpt-5.6' || normalized.startsWith('gpt-5.6-');
}

/**
 * If any GPT-5.6 variant is present, ensure Sol/Terra/Luna are all listed.
 * Does not invent unrelated model families.
 */
export function expandCodexModelFamilies(models: string[]): string[] {
  const normalized = models
    .map((model) => model.trim())
    .filter((model) => model.length > 0);

  const set = new Set(normalized);
  if (normalized.some(isCodexGpt56FamilyMember)) {
    for (const member of CODEX_GPT_56_FAMILY) {
      set.add(member.name);
    }
  }

  return Array.from(set);
}

/**
 * Union two ordered model lists. Prefer left-hand order for shared entries,
 * then append any right-hand-only models in their original order.
 */
export function unionCodexModelNames(primary: string[], secondary: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const name of [...primary, ...secondary]) {
    const trimmed = name.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

export function seedLabelForCodexModel(name: string): string | undefined {
  const match = CODEX_GPT_56_FAMILY.find((entry) => entry.name === name);
  return match?.label;
}

export function seedPriorityForCodexModel(name: string): number | null {
  const match = CODEX_GPT_56_FAMILY.find((entry) => entry.name === name);
  return typeof match?.priority === 'number' ? match.priority : null;
}

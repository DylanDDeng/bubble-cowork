export type FastServiceTier = {
  id: string;
  name?: string;
};

function normalizeTierId(value: string | null | undefined): string {
  return (value || '').trim().toLowerCase();
}

export function isFastServiceTier(tier: FastServiceTier): boolean {
  const id = normalizeTierId(tier.id);
  const name = normalizeTierId(tier.name);
  return id === 'priority' || id === 'fast' || name === 'fast';
}

/**
 * Map the Fast toggle to a concrete service-tier id.
 *
 * Prefer a tier that is explicitly named Fast / id `priority`, even when that
 * tier is also the model default (gpt-5.6-sol). Fall back to the unique
 * non-default tier when the catalog does not label speed.
 */
export function resolveFastTier<T extends FastServiceTier>(entry: {
  serviceTiers: readonly T[];
  defaultServiceTier?: string | null;
}): T | null {
  const namedFast = entry.serviceTiers.find((tier) => isFastServiceTier(tier));
  if (namedFast) return namedFast;

  const nonDefault = entry.serviceTiers.filter(
    (tier) => tier.id !== entry.defaultServiceTier
  );
  return nonDefault.length === 1 ? nonDefault[0] : null;
}

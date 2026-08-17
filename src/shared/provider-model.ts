/**
 * Grok Build's ACP catalog uses `grok-*` model ids. This predicate is only a
 * cold-start boundary: once the catalog is loaded, callers should still use
 * the catalog itself as the source of truth.
 */
export function isGrokModelId(model: string | null | undefined): boolean {
  const normalized = model?.trim().toLowerCase();
  return Boolean(normalized && normalized.startsWith('grok-'));
}

export function formatGrokModelId(model: string): string {
  return model
    .trim()
    .split('-')
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === 'grok') return 'Grok';
      if (lower === 'composer') return 'Composer';
      if (lower === 'fast') return 'Fast';
      return part;
    })
    .join(' ');
}

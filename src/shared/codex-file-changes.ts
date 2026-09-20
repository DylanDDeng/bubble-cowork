/** Convert app-server fileChange items to the per-path Edit format we persist. */
export function normalizeCodexFileChanges(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) {
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
  }
  const changes: Record<string, unknown> = Object.create(null);
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' || !entry.path) continue;
    const kind = entry.kind;
    const type = typeof kind === 'string' ? kind : kind?.type;
    const movePath = kind && typeof kind === 'object' ? kind.movePath ?? kind.move_path : null;
    changes[entry.path] = {
      type: typeof type === 'string' ? type : 'update',
      ...(typeof movePath === 'string' && movePath ? { move_path: movePath } : {}),
      ...(typeof entry.diff === 'string' ? { unified_diff: entry.diff } : {}),
    };
  }
  return Object.keys(changes).length ? changes : null;
}

import type { CodexReasoningEffort } from './types';

/**
 * The single owner of codex reasoning-effort normalization (main process and
 * renderer both import this). Open vocabulary: the valid set is model-specific
 * and comes from models_cache `supported_reasoning_levels`, so pass any
 * non-empty slug through — a whitelist here silently dropped "ultra"/"max".
 */
export function normalizeCodexReasoningEffort(
  value?: string | null
): CodexReasoningEffort | null {
  const normalized = (value || '').trim().toLowerCase();
  return normalized || null;
}

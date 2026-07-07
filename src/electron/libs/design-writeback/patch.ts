// Context-anchored reverse patches — the ONLY undo/rollback primitive.
//
// Red-team findings A2/C1/C2: whole-file snapshot restore silently erases
// third-party writes (the user's editor save, a concurrent agent edit) that
// landed after ours. A reverse patch instead matches `before + newText +
// after` in the CURRENT file content and only then swaps newText back to
// oldText; any mismatch aborts loudly instead of clobbering.

export interface ReversePatch {
  filePath: string;
  /** Context immediately preceding the edited span (in the NEW content). */
  before: string;
  /** Context immediately following the edited span (in the NEW content). */
  after: string;
  /** What our edit wrote. */
  newText: string;
  /** What the span contained before our edit. */
  oldText: string;
}

const CONTEXT_CHARS = 48;

export function createReversePatch(
  filePath: string,
  originalContent: string,
  newContent: string,
  editedSpan: { start: number; end: number }
): ReversePatch {
  const newText = newContent.slice(editedSpan.start, editedSpan.end);
  const before = newContent.slice(Math.max(0, editedSpan.start - CONTEXT_CHARS), editedSpan.start);
  const after = newContent.slice(editedSpan.end, editedSpan.end + CONTEXT_CHARS);
  // Reconstruct oldText: original shares the prefix up to span.start and the
  // suffix after the edit, so old span length = original length - (new length - span length).
  const oldSpanLength = originalContent.length - (newContent.length - (editedSpan.end - editedSpan.start));
  const oldText = originalContent.slice(editedSpan.start, editedSpan.start + oldSpanLength);
  return { filePath, before, after, newText, oldText };
}

export type PatchApplyResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'not-found' | 'ambiguous'; detail: string };

/**
 * Apply the reverse patch to the CURRENT file content (which may contain
 * later third-party edits elsewhere in the file — those are preserved).
 */
export function applyReversePatch(currentContent: string, patch: ReversePatch): PatchApplyResult {
  const needle = patch.before + patch.newText + patch.after;
  const first = currentContent.indexOf(needle);
  if (first === -1) {
    return {
      ok: false,
      reason: 'not-found',
      detail: 'edited region no longer matches — the file changed around our edit; refusing to touch it',
    };
  }
  const second = currentContent.indexOf(needle, first + 1);
  if (second !== -1) {
    return { ok: false, reason: 'ambiguous', detail: 'edited region matches multiple locations' };
  }
  const start = first + patch.before.length;
  const end = start + patch.newText.length;
  return {
    ok: true,
    content: currentContent.slice(0, start) + patch.oldText + currentContent.slice(end),
  };
}

const SESSION_TITLE_LIMIT = 50;

function localTitleCandidate(prompt: string): string {
  const cleaned = prompt
    .replace(/\s+/g, ' ')
    .replace(/[`*_#>\-\[\]\(\)]/g, ' ')
    .trim();
  if (!cleaned) return '';
  const firstSentence = cleaned.split(/[.!?。！？\n]/, 1)[0]?.trim() || cleaned;
  return firstSentence.split(/\s+/).filter(Boolean).slice(0, 6).join(' ').trim();
}

export function truncateSessionTitle(title: string): string {
  const characters = Array.from(title.trim());
  if (characters.length <= SESSION_TITLE_LIMIT) return characters.join('');
  return characters.slice(0, SESSION_TITLE_LIMIT - 1).join('').trimEnd() + '…';
}

export function generateSessionTitleLocally(prompt: string): string {
  return truncateSessionTitle(localTitleCandidate(prompt));
}

/** Repair the display of legacy prompt-prefix titles without rewriting history. */
export function getSessionTitleDisplay(title: string, firstPrompt?: string): string {
  // The previous generator used UTF-16 slice(0, 50). A length alone is not
  // evidence of truncation: require the longer original prefix as well.
  if (title.length !== SESSION_TITLE_LIMIT || !firstPrompt || title.endsWith('…') || title.endsWith('...')) {
    return title;
  }
  const candidate = localTitleCandidate(firstPrompt);
  return candidate.length > title.length && candidate.startsWith(title) ? title + '…' : title;
}

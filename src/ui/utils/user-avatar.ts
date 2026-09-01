// The settings-usage avatar identity: a deterministic color + initials pair
// derived from the display name, shared by every surface that renders the
// user (usage profile header, board activity timeline).
const AVATAR_COLORS = ['#0F9D90', '#315EFB', '#D97757', '#7C3AED', '#DB2777', '#B45309', '#15803D'];

export function avatarColorFor(name: string): string {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0][0]}${words[1][0]}`.toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

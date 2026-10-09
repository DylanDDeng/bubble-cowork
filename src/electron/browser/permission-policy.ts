// What a page in the in-app browser may use without asking. Electron grants
// every permission request unless the session says otherwise, so the browser
// partition answers here: harmless ones pass, privacy-sensitive ones ask the
// user once per site and app run, everything else is refused.

export type BrowserPermissionRule = 'allow' | 'ask' | 'deny';

const ALLOWED = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock']);
const ASKED = new Set(['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal']);

export function browserPermissionRule(permission: string): BrowserPermissionRule {
  if (ALLOWED.has(permission)) return 'allow';
  if (ASKED.has(permission)) return 'ask';
  return 'deny';
}

/** The capabilities one request asks for: media splits into camera and microphone. */
export function permissionKinds(permission: string, mediaTypes?: readonly string[]): string[] {
  if (permission !== 'media') return [permission];
  const kinds = (mediaTypes ?? []).filter((type) => type === 'video' || type === 'audio').map((type) => `media:${type}`);
  return kinds.length ? kinds : ['media:video', 'media:audio'];
}

const KIND_LABELS: Record<string, string> = {
  'media:video': 'your camera',
  'media:audio': 'your microphone',
  geolocation: 'your location',
  notifications: 'show notifications',
  'clipboard-read': 'read your clipboard',
};

/** "localhost:5173 wants to use your camera and your microphone". */
export function permissionQuestion(site: string, kinds: readonly string[], externalUrl?: string): string {
  if (kinds.includes('openExternal')) {
    const target = externalUrl ? ` (${externalUrl.slice(0, 120)})` : '';
    return `${site} wants to open a link in another app${target}.`;
  }
  const labels = kinds.map((kind) => KIND_LABELS[kind] ?? kind);
  const media = labels.filter((label) => label.startsWith('your '));
  const actions = labels.filter((label) => !label.startsWith('your '));
  const parts: string[] = [];
  if (media.length) parts.push(`use ${media.join(' and ')}`);
  parts.push(...actions);
  return `${site} wants to ${parts.join(' and ')}.`;
}

/** The site part of a requesting URL, as people read it. */
export function permissionSite(requestingUrl: string): string {
  try {
    const url = new URL(requestingUrl);
    if (url.protocol === 'file:') return 'A local file';
    return url.host || url.origin;
  } catch {
    return 'This page';
  }
}

export function permissionOrigin(requestingUrl: string): string {
  try {
    const url = new URL(requestingUrl);
    return url.protocol === 'file:' ? 'file://' : url.origin;
  } catch {
    return '';
  }
}

/** Answers people gave this app run, per origin and capability. */
export class PermissionGrants {
  private readonly answers = new Map<string, boolean>();

  /** True or false once answered for every kind; undefined while any is open. */
  answer(origin: string, kinds: readonly string[]): boolean | undefined {
    let all = true;
    for (const kind of kinds) {
      const answer = this.answers.get(`${origin} ${kind}`);
      if (answer === undefined) return undefined;
      all &&= answer;
    }
    return all;
  }

  record(origin: string, kinds: readonly string[], allowed: boolean): void {
    for (const kind of kinds) this.answers.set(`${origin} ${kind}`, allowed);
  }

  clear(): void {
    this.answers.clear();
  }
}

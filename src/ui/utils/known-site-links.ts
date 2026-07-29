export interface KnownSiteLinkToken {
  /** The exact matched text, preserved verbatim for serialization. */
  raw: string;
  /** Registry key of the site the link belongs to ("github", "x", ...). */
  site: string;
  /** Short human label shown inside the chip ("owner/repo", "@handle"). */
  label: string;
  /** Canonical https URL for the link target. */
  url: string;
  start: number;
  end: number;
}

interface KnownSiteDescriptor {
  site: string;
  hostnames: Set<string>;
  /**
   * Inspect the parsed URL's non-empty path segments and return the chip
   * label and canonical URL, or null when the path is not chip-worthy.
   */
  parsePath(segments: string[], url: URL): { label: string; url: string } | null;
}

// First path segments on github.com that are site routes, not repo owners.
const GITHUB_RESERVED_OWNER_SEGMENTS = new Set([
  'about',
  'collections',
  'contact',
  'features',
  'issues',
  'join',
  'login',
  'marketplace',
  'new',
  'notifications',
  'orgs',
  'pricing',
  'pulls',
  'search',
  'settings',
  'sponsors',
  'topics',
  'trending',
]);

const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9_.-]+$/;

// First path segments on x.com that are site routes, not user handles.
const X_RESERVED_HANDLE_SEGMENTS = new Set([
  'about',
  'compose',
  'download',
  'explore',
  'hashtag',
  'help',
  'home',
  'i',
  'intent',
  'jobs',
  'login',
  'logout',
  'messages',
  'notifications',
  'privacy',
  'search',
  'settings',
  'share',
  'signup',
  'tos',
]);

const X_HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

// First path segments on huggingface.co that are site routes, not owner
// namespaces. `datasets` and `spaces` are handled separately as prefixes.
const HUGGINGFACE_RESERVED_OWNER_SEGMENTS = new Set([
  'blog',
  'brand',
  'changelog',
  'chat',
  'collections',
  'docs',
  'enterprise',
  'join',
  'jobs',
  'learn',
  'login',
  'logout',
  'models',
  'new',
  'organizations',
  'papers',
  'posts',
  'pricing',
  'privacy',
  'settings',
  'support',
  'tasks',
  'terms',
  'welcome',
]);

const HUGGINGFACE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const GITHUB_DESCRIPTOR: KnownSiteDescriptor = {
  site: 'github',
  hostnames: new Set(['github.com']),
  parsePath(segments) {
    if (segments.length < 2) {
      return null;
    }
    const owner = segments[0];
    // Only strip the .git suffix from bare repo URLs; deep paths keep segments verbatim.
    const repo =
      segments.length === 2 ? segments[1].replace(/\.git$/, '') : segments[1];
    if (!GITHUB_OWNER_PATTERN.test(owner) || GITHUB_RESERVED_OWNER_SEGMENTS.has(owner.toLowerCase())) {
      return null;
    }
    // Repo names made only of dots ("." / "..") are not real repositories.
    if (!GITHUB_REPO_PATTERN.test(repo) || /^\.+$/.test(repo)) {
      return null;
    }
    return {
      label: `${owner}/${repo}`,
      url:
        segments.length === 2
          ? `https://github.com/${owner}/${repo}`
          : `https://github.com/${segments.join('/')}`,
    };
  },
};

const X_DESCRIPTOR: KnownSiteDescriptor = {
  site: 'x',
  hostnames: new Set(['x.com', 'twitter.com', 'mobile.twitter.com']),
  parsePath(segments) {
    if (segments.length === 0) {
      return null;
    }
    const handle = segments[0];
    if (!X_HANDLE_PATTERN.test(handle) || X_RESERVED_HANDLE_SEGMENTS.has(handle.toLowerCase())) {
      return null;
    }
    // Deeper segments (status/<id>, with_replies, media, ...) all belong to the
    // same profile, so the handle stays the label either way.
    return {
      label: `@${handle}`,
      url: `https://x.com/${segments.join('/')}`,
    };
  },
};

const HUGGINGFACE_DESCRIPTOR: KnownSiteDescriptor = {
  site: 'huggingface',
  hostnames: new Set(['huggingface.co', 'hf.co']),
  parsePath(segments) {
    // Dataset and Space URLs nest the owner/name pair one level deeper:
    // huggingface.co/datasets/owner/name, huggingface.co/spaces/owner/name.
    const namespace = segments[0]?.toLowerCase();
    const pairStart = namespace === 'datasets' || namespace === 'spaces' ? 1 : 0;
    const owner = segments[pairStart];
    const name = segments[pairStart + 1];
    if (!owner || !name) {
      return null;
    }
    if (
      pairStart === 0 &&
      HUGGINGFACE_RESERVED_OWNER_SEGMENTS.has(owner.toLowerCase())
    ) {
      return null;
    }
    if (!HUGGINGFACE_SEGMENT_PATTERN.test(owner) || !HUGGINGFACE_SEGMENT_PATTERN.test(name)) {
      return null;
    }
    return {
      label: `${owner}/${name}`,
      url: `https://huggingface.co/${segments.join('/')}`,
    };
  },
};

const KNOWN_SITE_DESCRIPTORS: KnownSiteDescriptor[] = [
  GITHUB_DESCRIPTOR,
  X_DESCRIPTOR,
  HUGGINGFACE_DESCRIPTOR,
];

const DESCRIPTORS_BY_HOSTNAME = new Map<string, KnownSiteDescriptor>();
for (const descriptor of KNOWN_SITE_DESCRIPTORS) {
  for (const hostname of descriptor.hostnames) {
    DESCRIPTORS_BY_HOSTNAME.set(hostname, descriptor);
  }
}

// A whitespace-delimited http(s) URL run. Site-specific validation happens
// after parsing, so unknown hosts and malformed paths stay plain text.
const URL_RUN_PATTERN = /(^|\s)(https?:\/\/\S+)(?=\s|$)/g;

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function extractKnownSiteLinkTokens(text: string): KnownSiteLinkToken[] {
  const tokens: KnownSiteLinkToken[] = [];

  for (const match of text.matchAll(URL_RUN_PATTERN)) {
    const prefix = match[1] || '';
    const raw = match[2] || '';
    const url = parseUrl(raw);
    if (!url) {
      continue;
    }

    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    const descriptor = DESCRIPTORS_BY_HOSTNAME.get(hostname);
    if (!descriptor) {
      continue;
    }

    const segments = url.pathname.split('/').filter(Boolean);
    const parsed = descriptor.parsePath(segments, url);
    if (!parsed) {
      continue;
    }

    const start = (match.index ?? 0) + prefix.length;
    tokens.push({
      raw,
      site: descriptor.site,
      label: parsed.label,
      url: parsed.url,
      start,
      end: start + raw.length,
    });
  }

  return tokens;
}

export type KnownSiteLinkTextSegment =
  | { type: 'text'; text: string }
  | {
      type: 'link';
      site: string;
      label: string;
      url: string;
      text: string;
      start: number;
      end: number;
    };

/**
 * Splits a plain-text run into text and known-site link segments. `offset`
 * maps local indices back to positions in the full prompt.
 */
export function splitTextIntoKnownSiteLinkSegments(
  text: string,
  offset = 0
): KnownSiteLinkTextSegment[] {
  const tokens = extractKnownSiteLinkTokens(text);
  if (tokens.length === 0) {
    return text ? [{ type: 'text', text }] : [];
  }

  const segments: KnownSiteLinkTextSegment[] = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.start > cursor) {
      segments.push({ type: 'text', text: text.slice(cursor, token.start) });
    }
    segments.push({
      type: 'link',
      site: token.site,
      label: token.label,
      url: token.url,
      text: token.raw,
      start: token.start + offset,
      end: token.end + offset,
    });
    cursor = token.end;
  }
  if (cursor < text.length) {
    segments.push({ type: 'text', text: text.slice(cursor) });
  }

  return segments;
}

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
  /** 14x14 inline SVG markup rendered inside the chip icon box. */
  iconSvg: string;
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
  iconSvg:
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-4.3 1.4 -4.3 -2.5 -6 -3m12 5v-3.5c0 -1 .1 -1.4 -.5 -2c2.8 -.3 5.5 -1.4 5.5 -6a4.6 4.6 0 0 0 -1.3 -3.2a4.2 4.2 0 0 0 -.1 -3.2s-1.1 -.3 -3.5 1.3a12.3 12.3 0 0 0 -6.2 0c-2.4 -1.6 -3.5 -1.3 -3.5 -1.3a4.2 4.2 0 0 0 -.1 3.2a4.6 4.6 0 0 0 -1.3 3.2c0 4.6 2.7 5.7 5.5 6c-.6 .6 -.6 1.2 -.5 2v3.5"/></svg>',
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
  iconSvg:
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"/></svg>',
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
  iconSvg:
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12.025 1.13c-5.77 0-10.449 4.647-10.449 10.378 0 1.112.178 2.181.503 3.185.064-.222.203-.444.416-.577a.96.96 0 0 1 .524-.15c.293 0 .584.124.84.284.278.173.48.408.71.694.226.282.458.611.684.951v-.014c.017-.324.106-.622.264-.874s.403-.487.762-.543c.3-.047.596.06.787.203s.31.313.4.467c.15.257.212.468.233.542.01.026.653 1.552 1.657 2.54.616.605 1.01 1.223 1.082 1.912.055.537-.096 1.059-.38 1.572.637.121 1.294.187 1.967.187.657 0 1.298-.063 1.921-.178-.287-.517-.44-1.041-.384-1.581.07-.69.465-1.307 1.081-1.913 1.004-.987 1.647-2.513 1.657-2.539.021-.074.083-.285.233-.542.09-.154.208-.323.4-.467a1.08 1.08 0 0 1 .787-.203c.359.056.604.29.762.543s.247.55.265.874v.015c.225-.34.457-.67.683-.952.23-.286.432-.52.71-.694.257-.16.547-.284.84-.285a.97.97 0 0 1 .524.151c.228.143.373.388.43.625l.006.04a10.3 10.3 0 0 0 .534-3.273c0-5.731-4.678-10.378-10.449-10.378M8.327 6.583a1.5 1.5 0 0 1 .713.174 1.487 1.487 0 0 1 .617 2.013c-.183.343-.762-.214-1.102-.094-.38.134-.532.914-.917.71a1.487 1.487 0 0 1 .69-2.803m7.486 0a1.487 1.487 0 0 1 .689 2.803c-.385.204-.536-.576-.916-.71-.34-.12-.92.437-1.103.094a1.487 1.487 0 0 1 .617-2.013 1.5 1.5 0 0 1 .713-.174m-10.68 1.55a.96.96 0 1 1 0 1.921.96.96 0 0 1 0-1.92m13.838 0a.96.96 0 1 1 0 1.92.96.96 0 0 1 0-1.92M8.489 11.458c.588.01 1.965 1.157 3.572 1.164 1.607-.007 2.984-1.155 3.572-1.164.196-.003.305.12.305.454 0 .886-.424 2.328-1.563 3.202-.22-.756-1.396-1.366-1.63-1.32q-.011.001-.02.006l-.044.026-.01.008-.03.024q-.018.017-.035.036l-.032.04a1 1 0 0 0-.058.09l-.014.025q-.049.088-.11.19a1 1 0 0 1-.083.116 1.2 1.2 0 0 1-.173.18q-.035.029-.075.058a1.3 1.3 0 0 1-.251-.243 1 1 0 0 1-.076-.107c-.124-.193-.177-.363-.337-.444-.034-.016-.104-.008-.2.022q-.094.03-.216.087-.06.028-.125.063l-.13.074q-.067.04-.136.086a3 3 0 0 0-.135.096 3 3 0 0 0-.26.219 2 2 0 0 0-.12.121 2 2 0 0 0-.106.128l-.002.002a2 2 0 0 0-.09.132l-.001.001a1.2 1.2 0 0 0-.105.212q-.013.036-.024.073c-1.139-.875-1.563-2.317-1.563-3.203 0-.334.109-.457.305-.454m.836 10.354c.824-1.19.766-2.082-.365-3.194-1.13-1.112-1.789-2.738-1.789-2.738s-.246-.945-.806-.858-.97 1.499.202 2.362c1.173.864-.233 1.45-.685.64-.45-.812-1.683-2.896-2.322-3.295s-1.089-.175-.938.647 2.822 2.813 2.562 3.244-1.176-.506-1.176-.506-2.866-2.567-3.49-1.898.473 1.23 2.037 2.16c1.564.932 1.686 1.178 1.464 1.53s-3.675-2.511-4-1.297c-.323 1.214 3.524 1.567 3.287 2.405-.238.839-2.71-1.587-3.216-.642-.506.946 3.49 2.056 3.522 2.064 1.29.33 4.568 1.028 5.713-.624m5.349 0c-.824-1.19-.766-2.082.365-3.194 1.13-1.112 1.789-2.738 1.789-2.738s.246-.945.806-.858.97 1.499-.202 2.362c-1.173.864.233 1.45.685.64.451-.812 1.683-2.896 2.322-3.295s1.089-.175.938.647-2.822 2.813-2.562 3.244 1.176-.506 1.176-.506 2.866-2.567 3.49-1.898-.473 1.23-2.037 2.16c-1.564.932-1.686 1.178-1.464 1.53s3.675-2.511 4-1.297c.323 1.214-3.524 1.567-3.287 2.405.238.839 2.71-1.587 3.216-.642.506.946-3.49 2.056-3.522 2.064-1.29.33-4.568 1.028-5.713-.624"/></svg>',
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

export function getKnownSiteIconSvg(site: string): string | null {
  for (const descriptor of KNOWN_SITE_DESCRIPTORS) {
    if (descriptor.site === site) {
      return descriptor.iconSvg;
    }
  }
  return null;
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

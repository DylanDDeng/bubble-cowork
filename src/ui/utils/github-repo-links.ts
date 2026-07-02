export interface GitHubRepoToken {
  /** The exact matched text, preserved verbatim for serialization. */
  raw: string;
  owner: string;
  repo: string;
  /** Canonical https URL for the repository. */
  url: string;
  start: number;
  end: number;
}

// First path segments on github.com that are site routes, not repo owners.
const RESERVED_OWNER_SEGMENTS = new Set([
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

// A bare repository URL: scheme + github.com + /owner/repo, optionally ending
// with .git or a trailing slash, delimited by whitespace. Deeper paths
// (issues, PRs, blobs) are intentionally left as plain text.
const GITHUB_REPO_URL_PATTERN =
  /(^|\s)(https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?)(?=\s|$)/g;

export function extractGitHubRepoTokens(text: string): GitHubRepoToken[] {
  const tokens: GitHubRepoToken[] = [];

  for (const match of text.matchAll(GITHUB_REPO_URL_PATTERN)) {
    const prefix = match[1] || '';
    const raw = match[2] || '';
    const owner = match[3] || '';
    const repo = match[4] || '';
    if (!owner || !repo || RESERVED_OWNER_SEGMENTS.has(owner.toLowerCase())) {
      continue;
    }
    // Repo names made only of dots ("." / "..") are not real repositories.
    if (/^\.+$/.test(repo)) {
      continue;
    }

    const start = (match.index ?? 0) + prefix.length;
    tokens.push({
      raw,
      owner,
      repo,
      url: `https://github.com/${owner}/${repo}`,
      start,
      end: start + raw.length,
    });
  }

  return tokens;
}

export type GitHubRepoTextSegment =
  | { type: 'text'; text: string }
  | { type: 'repo'; owner: string; repo: string; url: string; text: string; start: number; end: number };

/**
 * Splits a plain-text run into text and GitHub repo segments. `offset` maps
 * local indices back to positions in the full prompt.
 */
export function splitTextIntoGitHubRepoSegments(
  text: string,
  offset = 0
): GitHubRepoTextSegment[] {
  const tokens = extractGitHubRepoTokens(text);
  if (tokens.length === 0) {
    return text ? [{ type: 'text', text }] : [];
  }

  const segments: GitHubRepoTextSegment[] = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.start > cursor) {
      segments.push({ type: 'text', text: text.slice(cursor, token.start) });
    }
    segments.push({
      type: 'repo',
      owner: token.owner,
      repo: token.repo,
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

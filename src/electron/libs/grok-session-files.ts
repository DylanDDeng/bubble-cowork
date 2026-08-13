import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export function grokSessionsRoot(home = homedir()): string {
  return join(home, '.grok', 'sessions');
}

function listSessionGroupsForCwd(root: string, cwd: string): string[] {
  const groups: string[] = [];
  const encoded = join(root, encodeURIComponent(cwd));
  if (existsSync(encoded)) groups.push(encoded);

  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const group = join(root, entry.name);
      if (groups.includes(group)) continue;
      const marker = join(group, '.cwd');
      if (!existsSync(marker)) continue;
      const recorded = readFileSync(marker, 'utf8').trim();
      if (recorded === cwd) groups.push(group);
    }
  } catch {
    // The sessions root may not exist yet.
  }
  return groups;
}

/**
 * Resolve a Grok-relative path such as `images/1.jpg` against on-disk
 * session folders under ~/.grok/sessions/<encoded-cwd>/.
 */
export function resolveGrokSessionRelativeFile(
  cwd: string,
  relativePath: string,
  home = homedir()
): string | null {
  const rel = relativePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!rel || rel.split('/').includes('..')) return null;

  const hits: Array<{ path: string; mtime: number }> = [];
  for (const group of listSessionGroupsForCwd(grokSessionsRoot(home), cwd)) {
    let sessionDirs: string[] = [];
    try {
      sessionDirs = readdirSync(group, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(group, entry.name));
    } catch {
      continue;
    }
    for (const sessionDir of sessionDirs) {
      const target = join(sessionDir, rel);
      try {
        const stat = statSync(target);
        if (stat.isFile()) hits.push({ path: target, mtime: stat.mtimeMs });
      } catch {
        // This session does not have that relative file.
      }
    }
  }

  hits.sort((left, right) => right.mtime - left.mtime);
  return hits[0]?.path ?? null;
}

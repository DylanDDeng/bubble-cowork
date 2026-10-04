import { promises as fsPromises } from 'fs';
import { basename, join } from 'path';

// Obsidian resolves a bare embed name like ![[clip.mp4]] anywhere in the
// vault, so attachments may live in another folder than the note. Index file
// names per project root briefly so a note full of embeds walks the tree once.
const PROJECT_FILE_INDEX_TTL_MS = 10_000;
const PROJECT_FILE_INDEX_MAX_ENTRIES = 50_000;
const projectFileIndexCache = new Map<string, { at: number; files: Promise<Map<string, string[]>> }>();

async function buildProjectFileIndex(rootReal: string): Promise<Map<string, string[]>> {
  const files = new Map<string, string[]>();
  const queue = [rootReal];
  let seen = 0;
  // Breadth-first, so the shallowest match comes first, as in Obsidian.
  while (queue.length > 0 && seen < PROJECT_FILE_INDEX_MAX_ENTRIES) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen += 1;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) queue.push(fullPath);
      else if (entry.isFile()) {
        const key = entry.name.toLowerCase();
        const paths = files.get(key);
        if (paths) paths.push(fullPath);
        else files.set(key, [fullPath]);
      }
    }
  }
  return files;
}

export async function findProjectFileByName(cwd: string, fileName: string): Promise<string | null> {
  const name = basename(fileName.trim());
  if (!cwd || !name || name !== fileName.trim()) return null;
  let rootReal: string;
  try {
    rootReal = await fsPromises.realpath(cwd);
  } catch {
    return null;
  }
  const cached = projectFileIndexCache.get(rootReal);
  const index = cached && Date.now() - cached.at < PROJECT_FILE_INDEX_TTL_MS
    ? cached
    : { at: Date.now(), files: buildProjectFileIndex(rootReal) };
  projectFileIndexCache.set(rootReal, index);
  return (await index.files).get(name.toLowerCase())?.[0] ?? null;
}

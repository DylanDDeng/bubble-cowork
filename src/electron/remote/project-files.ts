// Read-only project file access for the phone's Files view. Every path is
// resolved (symlinks included) and must stay inside the authorized project
// root; dot entries are hidden and reads are size-capped.
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface ProjectFileEntry {
  name: string;
  /** Path relative to the project root, with forward slashes. */
  path: string;
  kind: "dir" | "file";
}
export interface ProjectFileContent {
  path: string;
  size: number;
  /** Null for binary files. */
  text: string | null;
  truncated: boolean;
}

const MAX_ENTRIES = 2000;
const MAX_READ = 512 * 1024;
const SEARCH_LIMIT = 200;
const SEARCH_VISIT_LIMIT = 30000;
const SEARCH_SKIP = new Set(["node_modules"]);

const toPosix = (p: string) => p.split(sep).join("/");
const hidden = (name: string) => name.startsWith(".");

/** Resolves `input` (relative to root, or absolute inside it) to a real path inside root. */
export async function resolveInside(root: string, input: string): Promise<{ full: string; rel: string }> {
  if (input.includes("\0")) throw new Error("INVALID_PATH");
  const realRoot = await realpath(root);
  const candidate = isAbsolute(input) ? resolve(input) : resolve(realRoot, input);
  let full: string;
  try {
    full = await realpath(candidate);
  } catch {
    throw new Error("NOT_FOUND");
  }
  const rel = relative(realRoot, full);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new Error("SCOPE_DENIED");
  if (rel.split(sep).some((part) => hidden(part))) throw new Error("SCOPE_DENIED");
  return { full, rel: toPosix(rel) };
}

/** Children of a directory: folders first, then files, each alphabetical. */
export async function listProjectDir(root: string, path = ""): Promise<ProjectFileEntry[]> {
  const { full, rel } = await resolveInside(root, path || ".");
  if (!(await stat(full)).isDirectory()) throw new Error("NOT_A_DIRECTORY");
  const entries: ProjectFileEntry[] = [];
  for (const dirent of await readdir(full, { withFileTypes: true })) {
    if (hidden(dirent.name)) continue;
    let kind: "dir" | "file" | null = dirent.isDirectory() ? "dir" : dirent.isFile() ? "file" : null;
    if (dirent.isSymbolicLink()) {
      // Follow links only when they stay inside the project.
      try {
        const target = await resolveInside(root, join(full, dirent.name));
        kind = (await stat(target.full)).isDirectory() ? "dir" : "file";
      } catch {
        kind = null;
      }
    }
    if (!kind) continue;
    entries.push({ name: dirent.name, path: rel ? `${rel}/${dirent.name}` : dirent.name, kind });
    if (entries.length >= MAX_ENTRIES) break;
  }
  const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
  return entries.sort((a, b) => (a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === "dir" ? -1 : 1));
}

/** Files whose path contains `query` (case-insensitive), breadth first. */
export async function searchProjectFiles(root: string, query: string): Promise<ProjectFileEntry[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const realRoot = await realpath(root);
  const results: ProjectFileEntry[] = [];
  const queue = [""];
  let visited = 0;
  while (queue.length && results.length < SEARCH_LIMIT && visited < SEARCH_VISIT_LIMIT) {
    const dir = queue.shift()!;
    let dirents;
    try {
      dirents = await readdir(join(realRoot, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      visited++;
      if (hidden(dirent.name) || dirent.isSymbolicLink()) continue;
      const path = dir ? `${dir}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        if (!SEARCH_SKIP.has(dirent.name)) queue.push(path);
      } else if (dirent.isFile() && path.toLowerCase().includes(needle)) {
        results.push({ name: dirent.name, path, kind: "file" });
        if (results.length >= SEARCH_LIMIT) break;
      }
    }
  }
  return results;
}

/** Text of a file (up to 512 KB); binary files return text: null. */
export async function readProjectFile(root: string, path: string): Promise<ProjectFileContent> {
  const { full, rel } = await resolveInside(root, path);
  const info = await lstat(full);
  if (!info.isFile()) throw new Error("NOT_A_FILE");
  const length = Math.min(info.size, MAX_READ);
  const handle = await open(full, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    const binary = buffer.subarray(0, Math.min(length, 8000)).includes(0);
    return {
      path: rel,
      size: info.size,
      text: binary ? null : buffer.toString("utf8"),
      truncated: info.size > MAX_READ,
    };
  } finally {
    await handle.close();
  }
}

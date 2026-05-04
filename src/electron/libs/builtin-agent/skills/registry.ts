import { existsSync, readdirSync, readFileSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join, relative, resolve, sep } from 'path';
import type {
  AegisSkillDescriptor,
  AegisSkillDependencies,
  AegisSkillInterface,
  AegisSkillLoadOutcome,
  AegisSkillPolicy,
  AegisSkillScope,
  AegisSkillSource,
} from './types';

const SKILL_FILE = 'SKILL.md';
const MAX_SCAN_DEPTH = 6;
const MAX_DIRS_PER_ROOT = 2000;

interface SkillRootCandidate {
  path: string;
  scope: AegisSkillScope;
  source: AegisSkillSource;
}

interface SkillFrontmatter {
  name?: string;
  title?: string;
  description?: string;
  metadata?: {
    'short-description'?: string;
  };
}

function sanitizeSingleLine(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.split(/\s+/).filter(Boolean).join(' ').trim();
  return normalized || undefined;
}

function parseFrontmatter(content: string): SkillFrontmatter | null {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const closeIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (closeIndex <= 1) return null;
  const metadata: SkillFrontmatter = {};
  let section: 'metadata' | null = null;
  for (const rawLine of lines.slice(1, closeIndex)) {
    const line = rawLine.replace(/\t/g, '  ');
    const topLevel = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (topLevel && !line.startsWith(' ')) {
      section = null;
      const key = topLevel[1];
      const value = stripYamlScalar(topLevel[2]);
      if (key === 'name') metadata.name = value;
      if (key === 'title') metadata.title = value;
      if (key === 'description') metadata.description = value;
      if (key === 'metadata') section = 'metadata';
      continue;
    }
    const nested = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (nested && section === 'metadata') {
      metadata.metadata = metadata.metadata || {};
      if (nested[1] === 'short-description') {
        metadata.metadata['short-description'] = stripYamlScalar(nested[2]);
      }
    }
  }
  return metadata;
}

function stripYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function fallbackTitle(name: string): string {
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function readOpenAiYaml(skillDir: string): {
  interface?: AegisSkillInterface;
  dependencies?: AegisSkillDependencies;
  policy?: AegisSkillPolicy;
} {
  const metadataPath = join(skillDir, 'agents', 'openai.yaml');
  if (!existsSync(metadataPath)) return {};
  try {
    const content = readFileSync(metadataPath, 'utf-8');
    const result: { interface?: AegisSkillInterface; dependencies?: AegisSkillDependencies; policy?: AegisSkillPolicy } = {};
    const current: string[] = [];
    let dependencyIndex = -1;
    for (const rawLine of content.split(/\r?\n/)) {
      const top = /^([A-Za-z0-9_-]+):\s*$/.exec(rawLine);
      if (top) {
        current.length = 0;
        current.push(top[1]);
        continue;
      }
      const nested = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(rawLine);
      if (!nested || current.length === 0) continue;
      const key = nested[1];
      const value = sanitizeSingleLine(stripYamlScalar(nested[2]));
      if (!value) continue;
      if (current[0] === 'interface') {
        result.interface = result.interface || {};
        if (key === 'display_name') result.interface.displayName = value;
        if (key === 'short_description') result.interface.shortDescription = value;
        if (key === 'icon_small') result.interface.iconSmall = resolve(skillDir, value);
        if (key === 'icon_large') result.interface.iconLarge = resolve(skillDir, value);
        if (key === 'brand_color' && /^#[0-9a-fA-F]{6}$/.test(value)) result.interface.brandColor = value;
        if (key === 'default_prompt') result.interface.defaultPrompt = value;
      }
      if (current[0] === 'policy') {
        result.policy = result.policy || {};
        if (key === 'allow_implicit_invocation') {
          result.policy.allowImplicitInvocation = value === 'true';
        }
        if (key === 'products') {
          result.policy.products = value.split(',').map((item) => item.trim()).filter(Boolean);
        }
      }
      if (current[0] === 'dependencies' && rawLine.trim() === 'tools:') {
        result.dependencies = result.dependencies || { tools: [] };
        continue;
      }
    }
    dependencyIndex = -1;
    for (const rawLine of content.split(/\r?\n/)) {
      if (!/^\s{4,}-\s+/.test(rawLine) && !/^\s{6,}[A-Za-z0-9_-]+:/.test(rawLine)) continue;
      const first = /^\s{4,}-\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(rawLine);
      if (first) {
        result.dependencies = result.dependencies || { tools: [] };
        dependencyIndex += 1;
        result.dependencies.tools[dependencyIndex] = { type: '', value: '' };
        const value = sanitizeSingleLine(stripYamlScalar(first[2]));
        if (value && first[1] === 'type') result.dependencies.tools[dependencyIndex].type = value;
        if (value && first[1] === 'value') result.dependencies.tools[dependencyIndex].value = value;
        continue;
      }
      const field = /^\s{6,}([A-Za-z0-9_-]+):\s*(.*)$/.exec(rawLine);
      if (!field || dependencyIndex < 0 || !result.dependencies) continue;
      const dep = result.dependencies.tools[dependencyIndex];
      const value = sanitizeSingleLine(stripYamlScalar(field[2]));
      if (!value) continue;
      if (field[1] === 'type') dep.type = value;
      if (field[1] === 'value') dep.value = value;
      if (field[1] === 'description') dep.description = value;
      if (field[1] === 'transport') dep.transport = value;
      if (field[1] === 'command') dep.command = value;
      if (field[1] === 'url') dep.url = value;
    }
    if (result.dependencies) {
      result.dependencies.tools = result.dependencies.tools.filter((dep) => dep.type && dep.value);
      if (result.dependencies.tools.length === 0) delete result.dependencies;
    }
    return result;
  } catch {
    return {};
  }
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function rootCandidates(cwd: string): SkillRootCandidate[] {
  const home = homedir();
  const projectDirs = dirsBetweenProjectRootAndCwd(resolve(cwd));
  const codexPluginCache = join(home, '.codex', 'plugins', 'cache');
  const repoRoots = projectDirs.flatMap((dir): SkillRootCandidate[] => [
    { path: join(dir, '.agents', 'skills'), scope: 'repo', source: 'agents' },
    { path: join(dir, '.codex', 'skills'), scope: 'repo', source: 'codex' },
    { path: join(dir, '.claude', 'skills'), scope: 'legacy-claude', source: 'claude' },
  ]);
  return [
    ...repoRoots,
    { path: join(home, '.agents', 'skills'), scope: 'user', source: 'agents' },
    { path: join(home, '.codex', 'skills'), scope: 'user', source: 'codex' },
    { path: join(home, '.codex', 'skills', '.system'), scope: 'system', source: 'system' },
    { path: join(home, '.claude', 'skills'), scope: 'legacy-claude', source: 'claude' },
    ...discoverPluginSkillRoots(codexPluginCache),
  ];
}

function discoverPluginSkillRoots(cacheRoot: string): SkillRootCandidate[] {
  if (!existsSync(cacheRoot)) return [];
  const roots: SkillRootCandidate[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: cacheRoot, depth: 0 }];
  const visited = new Set<string>([canonicalPath(cacheRoot)]);
  while (queue.length > 0 && visited.size <= MAX_DIRS_PER_ROOT && roots.length < 500) {
    const item = queue.shift();
    if (!item) break;
    let entries: Array<{ name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }>;
    try {
      entries = readdirSync(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const path = join(item.dir, entry.name);
      if (entry.name === 'skills') {
        roots.push({ path, scope: 'plugin', source: 'plugin' });
        continue;
      }
      if (item.depth < MAX_SCAN_DEPTH) {
        const canonical = canonicalPath(path);
        if (!visited.has(canonical)) {
          visited.add(canonical);
          queue.push({ dir: path, depth: item.depth + 1 });
        }
      }
    }
  }
  return roots;
}

function dirsBetweenProjectRootAndCwd(cwd: string): string[] {
  const markers = ['.git', '.codex', 'package.json', 'pnpm-workspace.yaml', 'Cargo.toml'];
  const ancestors: string[] = [];
  let current = cwd;
  while (true) {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const projectRoot =
    ancestors.find((dir) => markers.some((marker) => existsSync(join(dir, marker)))) || cwd;
  const fromRoot = ancestors.slice(0, ancestors.indexOf(projectRoot) + 1).reverse();
  return fromRoot.length > 0 ? fromRoot : [cwd];
}

function discoverSkillFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  const visited = new Set<string>([canonicalPath(root)]);
  while (queue.length > 0 && visited.size <= MAX_DIRS_PER_ROOT) {
    const item = queue.shift();
    if (!item) break;
    let entries: Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean; isSymbolicLink: () => boolean }>;
    try {
      entries = readdirSync(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = join(item.dir, entry.name);
      if (entry.isFile() && entry.name === SKILL_FILE) {
        files.push(path);
        continue;
      }
      if ((entry.isDirectory() || entry.isSymbolicLink()) && item.depth < MAX_SCAN_DEPTH) {
        const canonical = canonicalPath(path);
        if (!visited.has(canonical)) {
          visited.add(canonical);
          queue.push({ dir: path, depth: item.depth + 1 });
        }
      }
    }
  }
  return files;
}

function descriptorFromSkillFile(
  skillPath: string,
  root: SkillRootCandidate
): AegisSkillDescriptor | { error: string } {
  try {
    const content = readFileSync(skillPath, 'utf-8');
    const frontmatter = parseFrontmatter(content);
    const skillDir = dirname(skillPath);
    const defaultName = basename(skillDir);
    const baseName = sanitizeSingleLine(frontmatter?.name) || defaultName;
    const namespace = root.source === 'plugin' ? pluginNamespaceForRoot(root.path) : undefined;
    const name = namespace && !baseName.includes(':') ? `${namespace}:${baseName}` : baseName;
    const title = sanitizeSingleLine(frontmatter?.title) || fallbackTitle(name);
    const description =
      sanitizeSingleLine(frontmatter?.description) ||
      sanitizeSingleLine(frontmatter?.metadata?.['short-description']) ||
      '';
    const shortDescription = sanitizeSingleLine(frontmatter?.metadata?.['short-description']);
    const metadata = readOpenAiYaml(skillDir);
    const canonicalRoot = canonicalPath(root.path);
    const canonicalSkillPath = canonicalPath(skillPath);
    return {
      name,
      title,
      description,
      shortDescription,
      scope: root.scope,
      source: root.source,
      root: canonicalRoot,
      path: canonicalSkillPath,
      relativePath: relative(canonicalRoot, canonicalSkillPath).split(sep).join('/'),
      skillDir: dirname(canonicalSkillPath),
      interface: metadata.interface,
      policy: metadata.policy,
      dependencies: metadata.dependencies,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function pluginNamespaceForRoot(rootPath: string): string | undefined {
  const normalized = resolve(rootPath).split(sep);
  const skillsIndex = normalized.lastIndexOf('skills');
  if (skillsIndex <= 0) return undefined;
  const beforeSkills = normalized.slice(0, skillsIndex);
  const cacheIndex = beforeSkills.lastIndexOf('cache');
  if (cacheIndex === -1) return undefined;
  const afterCache = beforeSkills.slice(cacheIndex + 1);
  if (afterCache.length >= 2 && /^openai-/.test(afterCache[0])) {
    return afterCache[1];
  }
  return afterCache[0];
}

function scopeRank(scope: AegisSkillScope): number {
  switch (scope) {
    case 'repo':
      return 0;
    case 'user':
      return 1;
    case 'system':
      return 2;
    case 'plugin':
      return 3;
    case 'legacy-claude':
      return 4;
  }
}

export function loadAegisSkills(cwd: string): AegisSkillLoadOutcome {
  const roots = rootCandidates(cwd);
  const skills: AegisSkillDescriptor[] = [];
  const errors: Array<{ path: string; message: string }> = [];
  const usedRoots = new Set<string>();
  const seenPaths = new Set<string>();

  for (const root of roots) {
    for (const skillPath of discoverSkillFiles(root.path)) {
      const descriptor = descriptorFromSkillFile(skillPath, root);
      if ('error' in descriptor) {
        errors.push({ path: skillPath, message: descriptor.error });
        continue;
      }
      if (seenPaths.has(descriptor.path)) continue;
      seenPaths.add(descriptor.path);
      usedRoots.add(descriptor.root);
      skills.push(descriptor);
    }
  }

  skills.sort((a, b) =>
    scopeRank(a.scope) - scopeRank(b.scope) ||
    a.name.localeCompare(b.name) ||
    a.path.localeCompare(b.path)
  );

  return {
    skills,
    errors,
    roots: Array.from(usedRoots),
  };
}

export function findAegisSkill(
  outcome: AegisSkillLoadOutcome,
  input: { name?: string; path?: string }
): AegisSkillDescriptor | null {
  const normalizedPath = input.path ? canonicalPath(input.path) : '';
  if (normalizedPath) {
    const byPath = outcome.skills.find((skill) => skill.path === normalizedPath);
    if (byPath) return byPath;
  }
  const name = input.name?.trim();
  if (!name) return null;
  return outcome.skills.find((skill) => skill.name === name || skill.title === name) || null;
}

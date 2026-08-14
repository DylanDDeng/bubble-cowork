import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { parse } from 'yaml';
import type { ProviderSkillDescriptor } from '../../shared/types';

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type SkillRoot = {
  path: string;
  scope: string;
  skipSystem?: boolean;
};

function findProjectRoot(cwd: string): string {
  let current = cwd;
  while (true) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

function frontmatterBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') throw new TypeError('invalid skill invocation flag');
  switch (value.trim().toLowerCase()) {
    case 'true':
    case 'yes':
    case 'on':
    case '1':
      return true;
    case 'false':
    case 'no':
    case 'off':
    case '0':
      return false;
    default:
      throw new TypeError('invalid skill invocation flag');
  }
}

function parseSkill(path: string, scope: string): ProviderSkillDescriptor | null {
  try {
    const raw = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    const match = raw.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
    if (!match) return null;
    const data = parse(match[1]);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const fields = data as Record<string, unknown>;
    if (Object.hasOwn(fields, 'disableModelInvocation') || Object.hasOwn(fields, 'userInvocable')) {
      return null;
    }
    const name = typeof fields.name === 'string' ? fields.name.trim() : '';
    const description = typeof fields.description === 'string' ? fields.description.trim() : '';
    if (!SKILL_NAME.test(name) || !description) return null;
    const userInvocable = frontmatterBoolean(fields['user-invocable']);
    // The runtime keeps model-only skills in its catalog, but the composer
    // must only advertise names that its user-explicit `/name` path accepts.
    if (userInvocable === false) return null;
    return {
      name,
      description,
      path,
      enabled: true,
      scope,
    };
  } catch {
    // Match the Harness provider's fail-closed behavior for malformed skill
    // frontmatter or unreadable files.
    return null;
  }
}

function listRoot(root: SkillRoot): ProviderSkillDescriptor[] {
  if (!existsSync(root.path)) return [];
  try {
    return readdirSync(root.path, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .flatMap((entry): ProviderSkillDescriptor[] => {
        if (root.skipSystem && entry.name === '.system') return [];
        const entryPath = join(root.path, entry.name);
        let skillPath: string | null = null;
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          const candidate = join(entryPath, 'SKILL.md');
          if (existsSync(candidate)) skillPath = candidate;
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          skillPath = entryPath;
        }
        if (!skillPath) return [];
        try {
          if (!statSync(skillPath).isFile()) return [];
        } catch {
          return [];
        }
        const skill = parseSkill(skillPath, root.scope);
        return skill ? [skill] : [];
      });
  } catch {
    return [];
  }
}

/**
 * Mirror dsh-skill-filesystem's default user-invocable catalog. Lower-ranked
 * project roots win duplicate names before user roots, matching Harness.
 */
export function listDeepseekSkills(cwd?: string): ProviderSkillDescriptor[] {
  const effectiveCwd = cwd?.trim() || process.cwd();
  const projectRoot = findProjectRoot(effectiveCwd);
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  const agentsHome = process.env.DSH_AGENTS_HOME?.trim() || join(homedir(), '.agents');
  const roots: SkillRoot[] = [
    { path: join(projectRoot, '.dsh', 'skills'), scope: 'project-dsh' },
    { path: join(projectRoot, '.agents', 'skills'), scope: 'project-agents' },
    { path: join(dshHome, 'skills'), scope: 'user-dsh', skipSystem: true },
    { path: join(agentsHome, 'skills'), scope: 'user-agents' },
    ...(process.env.DSH_BUNDLED_SKILL_DIR?.trim()
      ? [{ path: process.env.DSH_BUNDLED_SKILL_DIR.trim(), scope: 'bundled' }]
      : []),
  ];

  const winners = new Map<string, ProviderSkillDescriptor>();
  for (const root of roots) {
    for (const skill of listRoot(root)) {
      if (!winners.has(skill.name)) winners.set(skill.name, skill);
    }
  }
  return [...winners.values()].sort((left, right) => left.name.localeCompare(right.name));
}

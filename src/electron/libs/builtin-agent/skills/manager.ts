import type { ProviderListSkillsResult } from '../../../../shared/types';
import { loadAegisSkills } from './registry';
import type { AegisSkillLoadOutcome } from './types';
import { loadAegisSkillsConfig } from './config';

interface CacheEntry {
  loadedAt: number;
  outcome: AegisSkillLoadOutcome;
}

const CACHE_TTL_MS = 5_000;
const cache = new Map<string, CacheEntry>();

function cacheKey(cwd: string): string {
  return cwd || process.cwd();
}

export function clearAegisSkillsCache(cwd?: string): void {
  if (cwd) {
    cache.delete(cacheKey(cwd));
    return;
  }
  cache.clear();
}

export function getAegisSkills(cwd?: string, forceReload = false): { outcome: AegisSkillLoadOutcome; cached: boolean } {
  const key = cacheKey(cwd || process.cwd());
  const existing = cache.get(key);
  if (!forceReload && existing && Date.now() - existing.loadedAt < CACHE_TTL_MS) {
    return { outcome: existing.outcome, cached: true };
  }
  const outcome = loadAegisSkills(key);
  const config = loadAegisSkillsConfig();
  const disabled = new Set(config.disabled);
  outcome.skills = outcome.skills.filter((skill) => {
    if (!config.bundled.enabled && skill.scope === 'system') return false;
    return !disabled.has(skill.name) && !disabled.has(skill.path);
  });
  cache.set(key, { loadedAt: Date.now(), outcome });
  return { outcome, cached: false };
}

export function listAegisSkillsForProvider(input?: { cwd?: string; forceReload?: boolean }): ProviderListSkillsResult {
  const { outcome, cached } = getAegisSkills(input?.cwd, input?.forceReload);
  return {
    source: 'aegis',
    cached,
    skills: outcome.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: skill.path,
      enabled: skill.policy?.allowImplicitInvocation !== false,
      scope: skill.scope,
      interface: {
        displayName: skill.interface?.displayName || skill.title,
        shortDescription: skill.interface?.shortDescription || skill.shortDescription,
      },
      dependencies: skill.dependencies,
    })),
  };
}

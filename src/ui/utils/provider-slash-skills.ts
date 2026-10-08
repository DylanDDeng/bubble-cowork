import type {
  ClaudeSkillSummary,
  ProviderListPluginsResult,
  ProviderPluginDescriptor,
  ProviderPluginMarketplaceDescriptor,
  ProviderSkillDescriptor,
} from '../types';
import { CODEX_PLUGIN_SLASH_PREFIX } from './codex-composer';

// Provider skill catalogs as composer entries. Pure so the main process can
// build the same lists for the iPhone composer.

function codexSkillSource(scope?: string): ClaudeSkillSummary['source'] {
  const normalized = (scope || '').toLowerCase();
  if (normalized === 'repo' || normalized === 'project' || normalized === 'workspace') {
    return 'project';
  }
  return 'user';
}

export function toCodexSlashSkill(skill: ProviderSkillDescriptor): ClaudeSkillSummary | null {
  const name = skill.name.replace(/^\//, '').trim();
  const path = skill.path.trim();
  if (!name || !path || skill.enabled === false) {
    return null;
  }

  return {
    name,
    title: skill.interface?.displayName || name,
    description: skill.interface?.shortDescription || skill.description,
    path,
    source: codexSkillSource(skill.scope),
  };
}

function isInstalledCodexPlugin(plugin: ProviderPluginDescriptor): boolean {
  return plugin.enabled || plugin.installed || plugin.installPolicy === 'INSTALLED_BY_DEFAULT';
}

function getCodexPluginReferencePath(
  marketplace: ProviderPluginMarketplaceDescriptor,
  plugin: ProviderPluginDescriptor
): string {
  const marketplaceName = marketplace.name.trim();
  const pluginName = plugin.name.trim();
  if (marketplaceName && pluginName) {
    return `plugin://${pluginName}@${marketplaceName}`;
  }

  if (plugin.source.type === 'local') return plugin.source.path;
  if (plugin.source.type === 'git') return plugin.source.path || plugin.source.url;
  return marketplace.path || marketplace.name;
}

function toCodexPluginSlashSkill(
  marketplace: ProviderPluginMarketplaceDescriptor,
  plugin: ProviderPluginDescriptor
): ClaudeSkillSummary | null {
  const pluginName = plugin.name.trim();
  const path = getCodexPluginReferencePath(marketplace, plugin).trim();
  if (!pluginName || !path || !isInstalledCodexPlugin(plugin)) {
    return null;
  }

  return {
    name: `${CODEX_PLUGIN_SLASH_PREFIX}${pluginName}`,
    title: plugin.interface?.displayName || pluginName,
    description: plugin.interface?.shortDescription || plugin.interface?.longDescription || 'Codex plugin',
    path,
    source: 'plugin',
  };
}

export function flattenCodexPluginSlashSkills(result: ProviderListPluginsResult): ClaudeSkillSummary[] {
  return result.marketplaces.flatMap((marketplace) =>
    marketplace.plugins
      .map((plugin) => toCodexPluginSlashSkill(marketplace, plugin))
      .filter((skill): skill is ClaudeSkillSummary => Boolean(skill))
  );
}

export function toSlashSkills(skills: ProviderSkillDescriptor[]): ClaudeSkillSummary[] {
  return skills
    .map(toCodexSlashSkill)
    .filter((skill): skill is ClaudeSkillSummary => Boolean(skill));
}

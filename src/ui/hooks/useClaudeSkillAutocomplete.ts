import { useEffect, useMemo, useState } from 'react';
import { sendEvent } from './useIPC';
import { useAppStore } from '../store/useAppStore';
import type { ClaudeSkillSummary, StreamMessage } from '../types';
import type { ClaudeSlashSuggestion } from '../utils/claude-slash';
import {
  filterClaudeSkills,
  parseSelectedSkillPrompt,
  getSessionSkillNames,
  getSlashSkillQuery,
  insertSlashSkill,
  mergeClaudeSkills,
} from '../utils/claude-skills';
import {
  buildProviderSlashCommands,
  filterClaudeSlashCommands,
  getSessionSlashCommands,
  parseSelectedSlashCommandPrompt,
  shouldAutoSubmitSlashCommand,
} from '../utils/claude-slash';
import { createSlashTokenContext, type SlashTokenContext } from '../utils/composer-segments';
import { CODEX_PLUGIN_SLASH_PREFIX } from '../utils/codex-composer';
import type {
  AgentProvider,
  ProviderListPluginsResult,
  ProviderPluginDescriptor,
  ProviderPluginMarketplaceDescriptor,
  ProviderSkillDescriptor,
} from '../types';

function codexSkillSource(scope?: string): ClaudeSkillSummary['source'] {
  const normalized = (scope || '').toLowerCase();
  if (normalized === 'repo' || normalized === 'project' || normalized === 'workspace') {
    return 'project';
  }
  return 'user';
}

function toCodexSlashSkill(skill: ProviderSkillDescriptor): ClaudeSkillSummary | null {
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

function flattenCodexPluginSlashSkills(result: ProviderListPluginsResult): ClaudeSkillSummary[] {
  return result.marketplaces.flatMap((marketplace) =>
    marketplace.plugins
      .map((plugin) => toCodexPluginSlashSkill(marketplace, plugin))
      .filter((skill): skill is ClaudeSkillSummary => Boolean(skill))
  );
}

export function useClaudeSkillAutocomplete({
  enabled,
  enableSkills = true,
  provider = 'claude',
  prompt,
  projectPath,
  sessionMessages = [],
  setPrompt,
  setCursorIndex,
  onAutoSubmitCommand,
}: {
  enabled: boolean;
  enableSkills?: boolean;
  provider?: AgentProvider;
  prompt: string;
  projectPath?: string;
  sessionMessages?: StreamMessage[];
  setPrompt: (prompt: string) => void;
  setCursorIndex?: (index: number) => void;
  onAutoSubmitCommand?: (prompt: string) => void;
}) {
  const { claudeUserSkills, claudeProjectSkills } = useAppStore();
  const [codexSlashSkills, setCodexSlashSkills] = useState<ClaudeSkillSummary[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    if (!enabled || !enableSkills || provider === 'codex') {
      return;
    }

    sendEvent({
      type: 'skills.list',
      payload: { projectPath },
    });
  }, [enableSkills, enabled, projectPath, provider]);

  useEffect(() => {
    let cancelled = false;

    if (!enabled || !enableSkills || provider !== 'codex') {
      setCodexSlashSkills([]);
      return () => {
        cancelled = true;
      };
    }

    const cwd = projectPath?.trim();
    if (!cwd) {
      setCodexSlashSkills([]);
      return () => {
        cancelled = true;
      };
    }

    void Promise.all([
      window.electron.listCodexSkills({ cwd }),
      window.electron.listCodexPlugins({ cwd }),
    ])
      .then(([skillsResult, pluginsResult]) => {
        if (cancelled) return;

        const skills = skillsResult.skills
          .map(toCodexSlashSkill)
          .filter((skill): skill is ClaudeSkillSummary => Boolean(skill));
        const plugins = flattenCodexPluginSlashSkills(pluginsResult);
        setCodexSlashSkills(mergeClaudeSkills(plugins, skills));
      })
      .catch((error) => {
        console.warn('[Codex composer] Failed to load Codex skills/plugins:', error);
        if (!cancelled) {
          setCodexSlashSkills([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [enableSkills, enabled, projectPath, provider]);

  const query = useMemo(() => getSlashSkillQuery(prompt), [prompt]);
  const sessionSkillNames = useMemo(
    () => (enableSkills && provider !== 'codex' ? getSessionSkillNames(sessionMessages) : new Set<string>()),
    [enableSkills, provider, sessionMessages]
  );
  const sessionSlashCommands = useMemo(() => getSessionSlashCommands(sessionMessages), [sessionMessages]);

  const availableSkills = useMemo(
    () => {
      if (!enableSkills) {
        return [];
      }
      if (provider === 'codex') {
        return codexSlashSkills;
      }
      return mergeClaudeSkills(claudeUserSkills, claudeProjectSkills, sessionSkillNames);
    },
    [claudeUserSkills, claudeProjectSkills, codexSlashSkills, enableSkills, provider, sessionSkillNames]
  );

  const availableCommands = useMemo(
    () => buildProviderSlashCommands(provider, sessionSlashCommands),
    [provider, sessionSlashCommands]
  );

  const skillSuggestions = useMemo(() => {
    if (!enabled || query === null) {
      return [] as ClaudeSkillSummary[];
    }

    return filterClaudeSkills(availableSkills, query);
  }, [availableSkills, enabled, query]);

  const commandSuggestions = useMemo(() => {
    if (!enabled || query === null) {
      return [] as ReturnType<typeof filterClaudeSlashCommands>;
    }

    return filterClaudeSlashCommands(availableCommands, query);
  }, [availableCommands, enabled, query]);

  const selectedSkillState = useMemo(
    () => (enabled && enableSkills ? parseSelectedSkillPrompt(prompt, availableSkills) : null),
    [availableSkills, enableSkills, enabled, prompt]
  );

  const selectedCommandState = useMemo(
    () => (enabled ? parseSelectedSlashCommandPrompt(prompt, availableCommands) : null),
    [availableCommands, enabled, prompt]
  );

  // Claude CLI exposes every skill as a slash command too, so drop commands
  // whose names collide with a known skill to avoid duplicate entries.
  const suggestions = useMemo(() => {
    if (!enabled || query === null) {
      return [] as ClaudeSlashSuggestion[];
    }

    const skillNameSet = new Set(
      availableSkills.map((skill) => skill.name.replace(/^\//, '').toLowerCase())
    );
    const dedupedCommands = commandSuggestions.filter(
      (command) => !skillNameSet.has(command.name.toLowerCase())
    );

    return [
      ...dedupedCommands.map((command) => ({ kind: 'command', command }) as ClaudeSlashSuggestion),
      ...skillSuggestions.map((skill) => ({ kind: 'skill', skill }) as ClaudeSlashSuggestion),
    ];
  }, [availableSkills, commandSuggestions, enabled, query, skillSuggestions]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (selectedIndex < suggestions.length) {
      return;
    }
    setSelectedIndex(0);
  }, [selectedIndex, suggestions.length]);

  // Hide the picker once a skill/command has been selected, even though the
  // canonicalised prompt (e.g. "/agent-browser") still matches the slash query
  // regex — the chip already represents the selection.
  const hasSlashQuery = enabled && query !== null && !selectedSkillState && !selectedCommandState;

  const selectSkill = (skill: ClaudeSkillSummary) => {
    const nextPrompt = insertSlashSkill(prompt, skill.name);
    setPrompt(nextPrompt);
    setCursorIndex?.(nextPrompt.length);
  };

  const selectSuggestion = (suggestion: ClaudeSlashSuggestion) => {
    if (suggestion.kind === 'command') {
      const nextPrompt = insertSlashSkill(prompt, suggestion.command.name);
      if (shouldAutoSubmitSlashCommand(suggestion.command) && onAutoSubmitCommand) {
        onAutoSubmitCommand(nextPrompt.trim());
        return;
      }

      setPrompt(nextPrompt);
      setCursorIndex?.(nextPrompt.length);
      return;
    }

    selectSkill(suggestion.skill);
  };

  const slashContext = useMemo<SlashTokenContext>(
    () =>
      createSlashTokenContext(
        enabled && enableSkills ? availableSkills.map((skill) => skill.name) : [],
        enabled ? availableCommands.map((command) => command.name) : []
      ),
    [availableCommands, availableSkills, enableSkills, enabled]
  );

  return {
    hasSlashQuery,
    suggestions,
    availableSkills,
    availableCommands,
    slashContext,
    selectedIndex,
    setSelectedIndex,
    selectedSkill: selectedSkillState?.skill || null,
    selectedCommand: selectedCommandState?.command || null,
    selectedSkillRemainder: selectedSkillState?.remainder ?? '',
    selectedCommandRemainder: selectedCommandState?.remainder ?? '',
    displayPrompt: prompt,
    moveSelection: (direction: 1 | -1) => {
      if (suggestions.length === 0) {
        return;
      }

      setSelectedIndex((current) => {
        const next = current + direction;
        if (next < 0) {
          return suggestions.length - 1;
        }
        if (next >= suggestions.length) {
          return 0;
        }
        return next;
      });
    },
    selectCurrentSuggestion: () => {
      const suggestion = suggestions[selectedIndex];
      if (suggestion) {
        selectSuggestion(suggestion);
      }
    },
    setDisplayPrompt: (nextPrompt: string) => {
      setPrompt(nextPrompt);
    },
    clearSelectedSkill: () => {
      setPrompt(selectedSkillState?.remainder || '');
      setCursorIndex?.(0);
    },
    clearSelectedCommand: () => {
      setPrompt(selectedCommandState?.remainder || '');
      setCursorIndex?.(0);
    },
    selectSkill,
    selectSuggestion,
  };
}

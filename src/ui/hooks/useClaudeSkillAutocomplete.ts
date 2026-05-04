import { useEffect, useMemo, useState } from 'react';
import { sendEvent } from './useIPC';
import { useAppStore } from '../store/useAppStore';
import type { ClaudeSkillSummary, PromptLibraryItem, StreamMessage } from '../types';
import type { ClaudeSlashSuggestion } from '../utils/claude-slash';
import {
  parseSelectedSkillPrompt,
  getSessionSkillNames,
  mergeClaudeSkills,
} from '../utils/claude-skills';
import {
  buildProviderSlashCommands,
  getSessionSlashCommands,
  parseSelectedSlashCommandPrompt,
  shouldAutoSubmitSlashCommand,
} from '../utils/claude-slash';
import { createSlashTokenContext, type SlashTokenContext } from '../utils/composer-segments';
import { buildComposerCapabilitySuggestions } from '../utils/composer-capabilities';
import {
  detectComposerTrigger,
  replaceComposerTriggerText,
  type ComposerTrigger,
} from '../utils/composer-triggers';
import { CODEX_PLUGIN_SLASH_PREFIX } from '../utils/codex-composer';
import { getPromptLibraryItems } from '../utils/prompt-library-api';
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

function skillMentionPrefix(provider: AgentProvider): '/' | '$' {
  return provider === 'claude' ? '/' : '$';
}

function normalizeCapabilityName(value: string): string {
  return value.replace(/^[/$]/, '').trim().toLowerCase();
}

function mergeSlashCommands(
  commands: ClaudeSlashSuggestion['command'][]
): ClaudeSlashSuggestion['command'][] {
  const seen = new Set<string>();
  const result: ClaudeSlashSuggestion['command'][] = [];

  for (const command of commands) {
    const key = normalizeCapabilityName(command.name);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(command);
  }

  return result.sort((left, right) => left.name.localeCompare(right.name));
}

function replaceComposerTriggerOrLeadingToken(input: {
  prompt: string;
  trigger: ComposerTrigger | null;
  fallbackPrefix: '/' | '$';
  name: string;
}): { prompt: string; cursorIndex: number } {
  const replacement = `${input.fallbackPrefix}${input.name.replace(/^[/$\s]+/, '')} `;
  if (input.trigger) {
    return replaceComposerTriggerText(input.prompt, input.trigger, replacement);
  }

  const leadingWhitespace = input.prompt.match(/^\s*/)?.[0] || '';
  const nextPrompt = `${leadingWhitespace}${replacement}`;
  return {
    prompt: nextPrompt,
    cursorIndex: nextPrompt.length,
  };
}

export function useComposerCapabilityMenu({
  enabled,
  enableSkills = true,
  provider = 'claude',
  prompt,
  cursorIndex,
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
  cursorIndex?: number;
  projectPath?: string;
  sessionMessages?: StreamMessage[];
  setPrompt: (prompt: string) => void;
  setCursorIndex?: (index: number) => void;
  onAutoSubmitCommand?: (prompt: string) => void;
}) {
  const { claudeUserSkills, claudeProjectSkills } = useAppStore();
  const [codexSlashSkills, setCodexSlashSkills] = useState<ClaudeSkillSummary[]>([]);
  const [promptLibraryItems, setPromptLibraryItems] = useState<PromptLibraryItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    if (!enabled || !enableSkills || provider !== 'claude') {
      return;
    }

    sendEvent({
      type: 'skills.list',
      payload: { projectPath },
    });
  }, [enableSkills, enabled, projectPath, provider]);

  useEffect(() => {
    let cancelled = false;

    if (!enabled) {
      setPromptLibraryItems([]);
      return () => {
        cancelled = true;
      };
    }

    void getPromptLibraryItems()
      .then((items) => {
        if (!cancelled) {
          setPromptLibraryItems(items);
        }
      })
      .catch((error) => {
        console.warn('[Composer] Failed to load prompt library:', error);
        if (!cancelled) {
          setPromptLibraryItems([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useEffect(() => {
    let cancelled = false;

    if (!enabled || !enableSkills || (provider !== 'codex' && provider !== 'aegis')) {
      setCodexSlashSkills([]);
      return () => {
        cancelled = true;
      };
    }

    const cwd = projectPath?.trim() || undefined;
    const skillsPromise =
      provider === 'aegis'
        ? window.electron.listAegisSkills({ cwd })
        : window.electron.listCodexSkills({ cwd });
    const pluginsPromise =
      provider === 'codex'
        ? window.electron.listCodexPlugins({ cwd })
        : Promise.resolve({ marketplaces: [] });

    void Promise.all([
      skillsPromise,
      pluginsPromise,
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

  const composerTrigger = useMemo(
    () => (enabled ? detectComposerTrigger(prompt, cursorIndex ?? prompt.length) : null),
    [cursorIndex, enabled, prompt]
  );
  const query = composerTrigger?.query ?? null;
  const triggerKind = composerTrigger?.kind ?? null;
  const sessionSkillNames = useMemo(
    () => (enableSkills && provider !== 'codex' ? getSessionSkillNames(sessionMessages) : new Set<string>()),
    [enableSkills, provider, sessionMessages]
  );
  const claudeRecognitionSkillNames = useMemo(
    () => (enableSkills ? getSessionSkillNames(sessionMessages) : new Set<string>()),
    [enableSkills, sessionMessages]
  );
  const sessionSlashCommands = useMemo(() => getSessionSlashCommands(sessionMessages), [sessionMessages]);

  const availableSkills = useMemo(
    () => {
      if (!enableSkills) {
        return [];
      }
      if (provider === 'codex' || provider === 'aegis') {
        return codexSlashSkills;
      }
      if (provider === 'claude') {
        return mergeClaudeSkills(claudeUserSkills, claudeProjectSkills, sessionSkillNames);
      }
      return [];
    },
    [claudeUserSkills, claudeProjectSkills, codexSlashSkills, enableSkills, provider, sessionSkillNames]
  );

  const availableCommands = useMemo(
    () => buildProviderSlashCommands(provider, sessionSlashCommands),
    [provider, sessionSlashCommands]
  );

  const recognitionSkills = useMemo(
    () => {
      if (!enableSkills) {
        return [];
      }
      const claudeSkills = mergeClaudeSkills(
        claudeUserSkills,
        claudeProjectSkills,
        claudeRecognitionSkillNames
      );
      return mergeClaudeSkills(availableSkills, claudeSkills);
    },
    [
      availableSkills,
      claudeProjectSkills,
      claudeRecognitionSkillNames,
      claudeUserSkills,
      enableSkills,
    ]
  );

  const recognitionCommands = useMemo(
    () =>
      mergeSlashCommands([
        ...availableCommands,
        ...buildProviderSlashCommands('claude', sessionSlashCommands),
        ...buildProviderSlashCommands('opencode', sessionSlashCommands),
      ]),
    [availableCommands, sessionSlashCommands]
  );

  const selectedSkillState = useMemo(
    () =>
      enabled && enableSkills
        ? parseSelectedSkillPrompt(prompt, recognitionSkills, provider === 'claude' ? ['/', '$'] : ['$'])
        : null,
    [enableSkills, enabled, prompt, provider, recognitionSkills]
  );

  const selectedCommandState = useMemo(
    () => (enabled ? parseSelectedSlashCommandPrompt(prompt, recognitionCommands) : null),
    [enabled, prompt, recognitionCommands]
  );

  const suggestions = useMemo(() => {
    return buildComposerCapabilitySuggestions({
      enabled,
      query,
      triggerKind,
      availableCommands,
      availableSkills,
      promptLibraryItems,
      includeCommands: triggerKind !== 'skill',
      includeSkills: triggerKind === 'skill' || (triggerKind === 'slash-command' && provider === 'claude'),
      includePrompts: triggerKind === 'slash-command',
    });
  }, [availableCommands, availableSkills, enabled, promptLibraryItems, provider, query, triggerKind]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, triggerKind]);

  useEffect(() => {
    if (selectedIndex < suggestions.length) {
      return;
    }
    setSelectedIndex(0);
  }, [selectedIndex, suggestions.length]);

  // Hide the picker once a skill/command has been selected; the chip already
  // represents the leading capability token.
  const hasSlashQuery = enabled && composerTrigger !== null && !selectedSkillState && !selectedCommandState;

  const selectSkill = (skill: ClaudeSkillSummary) => {
    const next = replaceComposerTriggerOrLeadingToken({
      prompt,
      trigger: composerTrigger,
      fallbackPrefix: skillMentionPrefix(provider),
      name: skill.name,
    });
    setPrompt(next.prompt);
    setCursorIndex?.(next.cursorIndex);
  };

  const selectSuggestion = (suggestion: ClaudeSlashSuggestion) => {
    if (suggestion.kind === 'command') {
      const next = replaceComposerTriggerOrLeadingToken({
        prompt,
        trigger: composerTrigger,
        fallbackPrefix: '/',
        name: suggestion.command.name,
      });
      if (shouldAutoSubmitSlashCommand(suggestion.command) && onAutoSubmitCommand) {
        onAutoSubmitCommand(next.prompt.trim());
        return;
      }

      setPrompt(next.prompt);
      setCursorIndex?.(next.cursorIndex);
      return;
    }

    if (suggestion.kind === 'prompt') {
      const nextPrompt = suggestion.prompt.content;
      setPrompt(nextPrompt);
      setCursorIndex?.(nextPrompt.length);
      return;
    }

    selectSkill(suggestion.skill);
  };

  const slashContext = useMemo<SlashTokenContext>(
    () =>
      createSlashTokenContext(
        enabled && enableSkills ? recognitionSkills.map((skill) => skill.name) : [],
        enabled ? recognitionCommands.map((command) => command.name) : [],
        enabled && enableSkills
          ? recognitionSkills
              .filter((skill) => skill.source === 'plugin')
              .map((skill) => skill.name)
          : []
      ),
    [enableSkills, enabled, recognitionCommands, recognitionSkills]
  );

  return {
    hasSlashQuery,
    composerTrigger,
    composerTriggerKind: triggerKind,
    menuTitle:
      triggerKind === 'skill'
        ? 'Skills'
        : triggerKind === 'slash-model'
          ? 'Models'
          : provider === 'claude'
            ? 'Commands, Skills & Prompts'
            : 'Commands & Prompts',
    emptyMessage:
      triggerKind === 'skill'
        ? 'No matching skills.'
        : triggerKind === 'slash-model'
          ? 'No matching models.'
          : provider === 'claude'
            ? 'No matching commands, skills, or prompts.'
            : 'No matching commands or prompts.',
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

export const useClaudeSkillAutocomplete = useComposerCapabilityMenu;

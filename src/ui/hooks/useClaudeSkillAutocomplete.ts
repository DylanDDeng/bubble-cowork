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
import { getPromptLibraryItems } from '../utils/prompt-library-api';
import { useProviderSlashSkills } from './useProviderSlashSkills';
import type { AgentProvider } from '../types';

const EMPTY_SKILLS: ClaudeSkillSummary[] = [];

function skillMentionPrefix(provider: AgentProvider): '/' | '$' {
  return provider === 'claude' ? '/' : '$';
}

function normalizeCapabilityName(value: string): string {
  return value.replace(/^[/$]/, '').trim().toLowerCase().replace(/\s+/g, '-');
}

function formatCapabilityDisplayName(skill: ClaudeSkillSummary): string {
  const preferred = skill.title?.trim() || skill.name;
  return preferred
    .replace(/^[/$]/, '')
    .replace(/^plugin:/i, '')
    .trim();
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
  // Tokens end at whitespace, so spaced skill names insert hyphenated; chip
  // matching normalizes the same way (normalizeSkillToken).
  const replacement = `${input.fallbackPrefix}${input.name
    .replace(/^[/$\s]+/, '')
    .replace(/\s+/g, '-')} `;
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
  // Shared provider catalog (codex/kimi/qoder) — the same cache backs the
  // sent-message chips in MessageCard, keeping both surfaces consistent.
  const providerSlashSkills = useProviderSlashSkills(
    provider,
    projectPath,
    enabled && enableSkills
  );
  const kimiSlashSkills = provider === 'kimi' ? providerSlashSkills : EMPTY_SKILLS;
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
      if (provider === 'codex' || provider === 'kimi' || provider === 'qoder') {
        return providerSlashSkills;
      }
      if (provider === 'claude') {
        return mergeClaudeSkills(claudeUserSkills, claudeProjectSkills, sessionSkillNames);
      }
      return [];
    },
    [claudeUserSkills, claudeProjectSkills, enableSkills, provider, providerSlashSkills, sessionSkillNames]
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

  const selectedCommandState = useMemo(
    () => (enabled ? parseSelectedSlashCommandPrompt(prompt, recognitionCommands) : null),
    [enabled, prompt, recognitionCommands]
  );

  const selectedSkillState = useMemo(() => {
    if (!enabled || !enableSkills) {
      return null;
    }
    // Codex matches the codex app: `/` can summon skills too, `$` stays the
    // canonical mention prefix.
    const state = parseSelectedSkillPrompt(
      prompt,
      recognitionSkills,
      provider === 'claude' || provider === 'codex' ? ['/', '$'] : ['$']
    );
    // Codex builtin commands win over same-named skills on `/` tokens: the
    // skill path strips the token into a reference, which would bypass the
    // adapter's command routing (`/review` must run a review, not activate a
    // "review" skill).
    if (state && provider === 'codex' && state.prefix === '/' && selectedCommandState) {
      return null;
    }
    return state;
  }, [enableSkills, enabled, prompt, provider, recognitionSkills, selectedCommandState]);

  const suggestions = useMemo(() => {
    return buildComposerCapabilitySuggestions({
      enabled,
      query,
      triggerKind,
      availableCommands,
      availableSkills,
      promptLibraryItems,
      includeCommands: triggerKind !== 'skill',
      includeSkills:
        triggerKind === 'skill' ||
        (triggerKind === 'slash-command' &&
          (provider === 'claude' || provider === 'codex' || provider === 'kimi' || provider === 'qoder')),
      includePrompts: triggerKind === 'slash-command',
      // Codex/Kimi/Qoder match the codex app: `/` reaches the full skill
      // catalog, same budget as the `$` menu (Claude keeps the compact
      // 8-slot mix).
      skillLimit: provider === 'codex' || provider === 'kimi' || provider === 'qoder' ? 80 : undefined,
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
  // Keep the menu visible while the cursor is still inside a slash token even
  // when the text already equals a command name: the composer has no inline
  // "selected command" visual, so suppressing the menu there reads as a match
  // failure ("/rewind" typed in full showed nothing at all).
  const hasSlashQuery =
    enabled &&
    composerTrigger !== null &&
    !selectedSkillState &&
    (!selectedCommandState || composerTrigger.kind === 'slash-command');

  const selectSkill = (skill: ClaudeSkillSummary) => {
    // Kimi and Qoder have no skill-reference pipeline: the runtime expands
    // the prompt text inside the turn (kimi as `/skill:<name> <args>`,
    // qoder as `/<name> <args>` — skills double as slash commands, verified
    // live), so insert exactly that token.
    const next = replaceComposerTriggerOrLeadingToken({
      prompt,
      trigger: composerTrigger,
      fallbackPrefix: provider === 'kimi' || provider === 'qoder' ? '/' : skillMentionPrefix(provider),
      name: provider === 'kimi' ? `skill:${skill.name}` : skill.name,
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
      // Two-step flow by design: confirming a suggestion only writes the
      // command into the composer; a second Enter dispatches it from there.
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
        enabled && enableSkills
          ? [
              ...recognitionSkills.map((skill) => skill.name),
              // Kimi skill invocations are the literal `/skill:<name>` token;
              // registering the prefixed variant renders them as skill chips.
              ...(provider === 'kimi'
                ? kimiSlashSkills.map((skill) => `skill:${skill.name}`)
                : []),
            ]
          : [],
        enabled ? recognitionCommands.map((command) => command.name) : [],
        enabled && enableSkills
          ? recognitionSkills
              .filter((skill) => skill.source === 'plugin')
              .map((skill) => skill.name)
          : []
      ),
    [enableSkills, enabled, kimiSlashSkills, provider, recognitionCommands, recognitionSkills]
  );

  const slashDisplayLabels = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const skill of recognitionSkills) {
      const key = normalizeCapabilityName(skill.name);
      const label = formatCapabilityDisplayName(skill);
      if (key && label) {
        labels[key] = label;
      }
    }
    if (provider === 'kimi') {
      // The chip label drops the `skill:` prefix — the skill icon already
      // says what it is.
      for (const skill of kimiSlashSkills) {
        const key = normalizeCapabilityName(`skill:${skill.name}`);
        const label = formatCapabilityDisplayName(skill);
        if (key && label) {
          labels[key] = label;
        }
      }
    }
    return labels;
  }, [kimiSlashSkills, provider, recognitionSkills]);

  return {
    hasSlashQuery,
    composerTrigger,
    composerTriggerKind: triggerKind,
    menuTitle:
      triggerKind === 'skill'
        ? 'Skills'
        : triggerKind === 'slash-model'
          ? 'Models'
          : provider === 'claude' || provider === 'codex'
            ? 'Commands, Skills & Prompts'
            : 'Commands & Prompts',
    emptyMessage:
      triggerKind === 'skill'
        ? 'No matching skills.'
        : triggerKind === 'slash-model'
          ? 'No matching models.'
          : provider === 'claude' || provider === 'codex'
            ? 'No matching commands, skills, or prompts.'
            : 'No matching commands or prompts.',
    suggestions,
    availableSkills,
    availableCommands,
    slashContext,
    slashDisplayLabels,
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

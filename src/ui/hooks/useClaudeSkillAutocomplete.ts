import { useEffect, useMemo, useState } from 'react';
import { sendEvent } from './useIPC';
import { useAppStore } from '../store/useAppStore';
import type { ClaudeSkillSummary, StreamMessage } from '../types';
import type { ClaudeSlashSuggestion } from '../utils/claude-slash';
import {
  buildPromptWithSkill,
  filterClaudeSkills,
  parseSelectedSkillPrompt,
  getSessionSkillNames,
  getSlashSkillQuery,
  insertSlashSkill,
  mergeClaudeSkills,
} from '../utils/claude-skills';
import {
  buildPromptWithSlashCommand,
  buildClaudeSlashCommands,
  filterClaudeSlashCommands,
  getSessionSlashCommands,
  parseSelectedSlashCommandPrompt,
  shouldAutoSubmitSlashCommand,
} from '../utils/claude-slash';

export function useClaudeSkillAutocomplete({
  enabled,
  prompt,
  projectPath,
  sessionMessages = [],
  setPrompt,
  onAutoSubmitCommand,
}: {
  enabled: boolean;
  prompt: string;
  projectPath?: string;
  sessionMessages?: StreamMessage[];
  setPrompt: (prompt: string) => void;
  onAutoSubmitCommand?: (prompt: string) => void;
}) {
  const { claudeUserSkills, claudeProjectSkills } = useAppStore();
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    sendEvent({
      type: 'skills.list',
      payload: { projectPath },
    });
  }, [enabled, projectPath]);

  const query = useMemo(() => getSlashSkillQuery(prompt), [prompt]);
  const sessionSkillNames = useMemo(() => getSessionSkillNames(sessionMessages), [sessionMessages]);
  const sessionSlashCommands = useMemo(() => getSessionSlashCommands(sessionMessages), [sessionMessages]);

  const availableSkills = useMemo(
    () => mergeClaudeSkills(claudeUserSkills, claudeProjectSkills, sessionSkillNames),
    [claudeUserSkills, claudeProjectSkills, sessionSkillNames]
  );

  const availableCommands = useMemo(
    () => buildClaudeSlashCommands(sessionSlashCommands),
    [sessionSlashCommands]
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

  const suggestions = useMemo(() => {
    if (!enabled || query === null) {
      return [] as ClaudeSlashSuggestion[];
    }

    return [
      ...commandSuggestions.map((command) => ({ kind: 'command', command }) as ClaudeSlashSuggestion),
      ...skillSuggestions.map((skill) => ({ kind: 'skill', skill }) as ClaudeSlashSuggestion),
    ];
  }, [commandSuggestions, enabled, query, skillSuggestions]);

  const selectedSkillState = useMemo(
    () => (enabled ? parseSelectedSkillPrompt(prompt, availableSkills) : null),
    [availableSkills, enabled, prompt]
  );

  const selectedCommandState = useMemo(
    () => (enabled ? parseSelectedSlashCommandPrompt(prompt, availableCommands) : null),
    [availableCommands, enabled, prompt]
  );

  useEffect(() => {
    if (!enabled || !selectedSkillState) {
      return;
    }

    const leadingWhitespace = prompt.match(/^\s*/)?.[0] || '';
    const canonicalPrompt = `${leadingWhitespace}${buildPromptWithSkill(
      selectedSkillState.skill.name,
      selectedSkillState.remainder
    )}`;

    if (canonicalPrompt !== prompt) {
      setPrompt(canonicalPrompt);
    }
  }, [enabled, prompt, selectedSkillState, setPrompt]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (selectedIndex < suggestions.length) {
      return;
    }
    setSelectedIndex(0);
  }, [selectedIndex, suggestions.length]);

  const hasSlashQuery = enabled && query !== null;

  const selectSkill = (skill: ClaudeSkillSummary) => {
    setPrompt(insertSlashSkill(prompt, skill.name));
  };

  const selectSuggestion = (suggestion: ClaudeSlashSuggestion) => {
    if (suggestion.kind === 'command') {
      const nextPrompt = insertSlashSkill(prompt, suggestion.command.name);
      if (shouldAutoSubmitSlashCommand(suggestion.command) && onAutoSubmitCommand) {
        onAutoSubmitCommand(nextPrompt.trim());
        return;
      }

      setPrompt(nextPrompt);
      return;
    }

    selectSkill(suggestion.skill);
  };

  const setDisplayPrompt = (nextPrompt: string) => {
    if (selectedSkillState) {
      setPrompt(buildPromptWithSkill(selectedSkillState.skill.name, nextPrompt));
      return;
    }

    if (selectedCommandState) {
      setPrompt(buildPromptWithSlashCommand(selectedCommandState.command.name, nextPrompt));
      return;
    }

    setPrompt(nextPrompt);
  };

  return {
    hasSlashQuery,
    suggestions,
    availableSkills,
    availableCommands,
    selectedIndex,
    setSelectedIndex,
    selectedSkill: selectedSkillState?.skill || null,
    selectedCommand: selectedCommandState?.command || null,
    displayPrompt: selectedSkillState?.remainder ?? selectedCommandState?.remainder ?? prompt,
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
    setDisplayPrompt,
    clearSelectedSkill: () => {
      setPrompt(selectedSkillState?.remainder || '');
    },
    clearSelectedCommand: () => {
      setPrompt(selectedCommandState?.remainder || '');
    },
    selectSkill,
    selectSuggestion,
  };
}

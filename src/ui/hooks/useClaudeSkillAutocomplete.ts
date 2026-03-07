import { useEffect, useMemo, useState } from 'react';
import { sendEvent } from './useIPC';
import { useAppStore } from '../store/useAppStore';
import type { ClaudeSkillSummary, StreamMessage } from '../types';
import {
  buildPromptWithSkill,
  filterClaudeSkills,
  parseSelectedSkillPrompt,
  getSessionSkillNames,
  getSlashSkillQuery,
  insertSlashSkill,
  mergeClaudeSkills,
} from '../utils/claude-skills';

export function useClaudeSkillAutocomplete({
  enabled,
  prompt,
  projectPath,
  sessionMessages = [],
  setPrompt,
}: {
  enabled: boolean;
  prompt: string;
  projectPath?: string;
  sessionMessages?: StreamMessage[];
  setPrompt: (prompt: string) => void;
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

  const availableSkills = useMemo(
    () => mergeClaudeSkills(claudeUserSkills, claudeProjectSkills, sessionSkillNames),
    [claudeUserSkills, claudeProjectSkills, sessionSkillNames]
  );

  const suggestions = useMemo(() => {
    if (!enabled || query === null) {
      return [] as ClaudeSkillSummary[];
    }

    return filterClaudeSkills(availableSkills, query);
  }, [availableSkills, enabled, query]);

  const selectedSkillState = useMemo(
    () => (enabled ? parseSelectedSkillPrompt(prompt, availableSkills) : null),
    [availableSkills, enabled, prompt]
  );

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

  const setDisplayPrompt = (nextPrompt: string) => {
    if (selectedSkillState) {
      setPrompt(buildPromptWithSkill(selectedSkillState.skill.name, nextPrompt));
      return;
    }

    setPrompt(nextPrompt);
  };

  return {
    hasSlashQuery,
    suggestions,
    availableSkills,
    selectedIndex,
    setSelectedIndex,
    selectedSkill: selectedSkillState?.skill || null,
    displayPrompt: selectedSkillState?.remainder ?? prompt,
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
    selectCurrentSkill: () => {
      const skill = suggestions[selectedIndex];
      if (skill) {
        selectSkill(skill);
      }
    },
    setDisplayPrompt,
    clearSelectedSkill: () => {
      setPrompt(selectedSkillState?.remainder || '');
    },
    selectSkill,
  };
}

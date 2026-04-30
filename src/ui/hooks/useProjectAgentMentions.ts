import { useEffect, useMemo, useState } from 'react';
import type { AgentProfile } from '../types';
import {
  filterProjectAgentMentionSuggestions,
  getProjectAgentMentionState,
  type ProjectAgentMentionSuggestion,
} from '../utils/agent-mentions';

export function useProjectAgentMentions({
  profiles,
  prompt,
  cursorIndex,
}: {
  profiles: AgentProfile[];
  prompt: string;
  cursorIndex: number;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const mention = useMemo(
    () => getProjectAgentMentionState(prompt, cursorIndex),
    [cursorIndex, prompt]
  );

  const suggestions = useMemo(
    () => (mention ? filterProjectAgentMentionSuggestions(profiles, mention.query) : []),
    [mention, profiles]
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [mention?.query]);

  useEffect(() => {
    if (selectedIndex < suggestions.length) {
      return;
    }

    setSelectedIndex(0);
  }, [selectedIndex, suggestions.length]);

  return {
    mention,
    hasMentionQuery: mention !== null,
    suggestions,
    selectedIndex,
    setSelectedIndex,
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
    getCurrentSuggestion: (): ProjectAgentMentionSuggestion | null =>
      suggestions[selectedIndex] || null,
  };
}

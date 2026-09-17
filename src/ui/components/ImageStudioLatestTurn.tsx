import { useId, useMemo, useState } from 'react';
import { getAssistantPhase } from '../../shared/assistant-phase';
import { useAppStore } from '../store/useAppStore';
import { useAppReducedMotion } from '../hooks/useAppReducedMotion';
import { normalizeBacktickMarkdownImages } from '../utils/generated-media';
import { MDContent } from '../render/markdown';
import { AssistantCopyAction, getAssistantMarkdownToCopy } from './MessageCard';
import { ImageStudioSessionContext } from '../lib/image-studio';
import { ChevronRight } from './icons';
import { WorkstreamActivityLabel } from './WorkstreamPrimitives';

export function ImageStudioLatestTurn({ sessionId }: { sessionId: string }) {
  const session = useAppStore(state => state.sessions[sessionId]);
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const reducedMotion = useAppReducedMotion();
  const working = session?.status === 'running' || session?.status === 'stopping';
  const reply = useMemo(() => {
    const messages = session?.messages || [];
    let start = messages.length - 1;
    while (start >= 0 && messages[start].type !== 'user_prompt') start--;
    const candidates = messages.slice(start + 1).filter(message =>
      message.type === 'assistant' && !message.parentToolUseId && getAssistantMarkdownToCopy(message).trim());
    // Prefer the terminal reply; until it arrives show the latest visible narration.
    const answer = [...candidates].reverse().find(message => getAssistantPhase(message) === 'final_answer') || candidates.at(-1);
    return answer ? getAssistantMarkdownToCopy(answer) : '';
  }, [session?.messages]);
  const text = working && session?.streaming.text.trim() ? session.streaming.text : reply;
  // Keep image references available as links without duplicating the large canvas image.
  const content = normalizeBacktickMarkdownImages(text).replace(/!\[([^\]]*)\]\(/g, (_, label: string) => `[${label || 'View image'}](`);
  return <section className="image-studio-latest-tray group" data-expanded={expanded} data-reduced-motion={reducedMotion}
    onKeyDown={event => { if (event.key === 'Escape' && expanded) { event.stopPropagation(); setExpanded(false); } }}>
    <button className="image-studio-latest" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}>
      <WorkstreamActivityLabel active={working}>{working ? 'Working' : 'Latest turn'}</WorkstreamActivityLabel><ChevronRight size={14} />
    </button>
    <div id={contentId} className="image-studio-latest-collapse" aria-hidden={!expanded} inert={!expanded}>
      <div className="image-studio-latest-content" role="region" aria-label={working ? 'Current turn reply' : 'Latest turn reply'}>
        <ImageStudioSessionContext.Provider value={sessionId}>
          {content.trim() ? <><MDContent content={content} /><AssistantCopyAction text={text} className="image-studio-latest-copy" /></>
            : <p className="image-studio-latest-empty">{working ? 'Waiting for the agent’s reply…' : 'No reply in this turn yet.'}</p>}
        </ImageStudioSessionContext.Provider>
      </div>
    </div>
  </section>;
}

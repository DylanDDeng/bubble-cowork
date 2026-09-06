import { getSessionTitleDisplay } from '../../shared/session-title';
import type { SessionView } from '../types';

export function SessionTitleText({ session, className = '' }: {
  session: Pick<SessionView, 'title' | 'messages'> | null | undefined;
  className?: string;
}) {
  const firstPrompt = session?.messages.find((message) => message.type === 'user_prompt');
  const title = getSessionTitleDisplay(
    session?.title || 'Chat',
    firstPrompt?.type === 'user_prompt' ? firstPrompt.prompt : undefined
  );
  return <span title={title} className={`min-w-0 truncate ${className}`}>{title}</span>;
}

import type { SessionView } from '../types';
import { SessionActionsMenu } from './SessionActionsMenu';
import { SessionTitleEditor } from './SessionTitleEditor';

/** Keep the conversation menu beside its title, including in split panes. */
export function SessionTitleActions({ session, className = '' }: {
  session: SessionView | null | undefined;
  className?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2" data-session-title-actions>
      <SessionTitleEditor session={session} className={className} />
      {session ? <SessionActionsMenu session={session} /> : null}
    </div>
  );
}

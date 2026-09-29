import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { AnimatePresence } from 'motion/react';

/** Panel animations belong to a session, never to navigation between sessions. */
export function SessionRightPanelPresence({ sessionId, children }: {
  sessionId: string | null;
  children: (sessionChanged: boolean) => ReactNode;
}) {
  const previousSession = useRef(sessionId);
  const sessionChanged = previousSession.current !== sessionId;
  useLayoutEffect(() => {
    previousSession.current = sessionId;
  }, [sessionId]);

  // Replacing the presence boundary immediately unmounts the old session,
  // including any exit already in progress. Restored panels start at full width.
  return (
    <AnimatePresence key={sessionId ?? '__new-session__'} initial={false}>
      {children(sessionChanged)}
    </AnimatePresence>
  );
}

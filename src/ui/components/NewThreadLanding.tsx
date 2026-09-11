import type { ReactNode } from 'react';
import { NewThreadLogo } from './NewThreadLogo';

/**
 * Landing chrome used both on first app entry (NewSessionView) and on a
 * freshly created draft thread with no messages (ChatPane). The composer itself is
 * passed in as `children` so each surface keeps its own wired composer.
 */
export function NewThreadLanding({
  heading,
  children,
}: {
  heading: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="aegis-new-thread-landing">
      <div className="aegis-new-thread-hero">
        <div className="aegis-new-thread-hero-content">
          <NewThreadLogo />
          <h1 className="aegis-new-thread-heading no-drag">
            {heading}
          </h1>
        </div>
      </div>
      <div className="aegis-new-thread-composer-zone">
        <div className="aegis-new-thread-composer no-drag">{children}</div>
      </div>
    </div>
  );
}

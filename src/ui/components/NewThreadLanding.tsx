import type { ReactNode } from 'react';

/**
 * Centered landing chrome used both on first app entry (NewSessionView) and on a
 * freshly created draft thread with no messages (ChatPane). The composer itself is
 * passed in as `children` so each surface keeps its own wired composer.
 */
export function NewThreadLanding({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  return (
    <div className="flex-1 overflow-y-auto px-8 pb-16">
      <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col justify-center py-12">
        <h1 className="mb-8 text-center text-[28px] font-normal leading-tight tracking-[-0.01em] text-[var(--text-primary)] no-drag">
          {heading}
        </h1>

        <div className="no-drag">{children}</div>
      </div>
    </div>
  );
}

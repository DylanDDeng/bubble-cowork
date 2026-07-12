import type { ReactNode } from 'react';
import { MessageCircle, Plug } from './icons';

// Shared starter prompts shown on the new-thread landing (first entry + empty draft).
export const STARTER_PROMPTS = [
  'Explain how this project is structured and where to start',
  'Find and fix a bug in the current code',
  'Add tests for the most important module',
  'Review my recent changes and suggest improvements',
];

/**
 * Centered landing chrome used both on first app entry (NewSessionView) and on a
 * freshly created draft thread with no messages (ChatPane). The composer itself is
 * passed in as `children` so each surface keeps its own wired composer.
 */
export function NewThreadLanding({
  heading,
  children,
  onPickSuggestion,
  onConnectApps,
}: {
  heading: string;
  children: ReactNode;
  onPickSuggestion: (text: string) => void;
  onConnectApps: () => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto px-8 pb-16">
      <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col justify-center py-12">
        <h1 className="mb-8 text-center text-[28px] font-normal leading-tight tracking-[-0.01em] text-[var(--text-primary)] no-drag">
          {heading}
        </h1>

        <div className="no-drag">{children}</div>

        <div className="mt-7 no-drag">
          {STARTER_PROMPTS.map((text) => (
            <button
              key={text}
              type="button"
              onClick={() => onPickSuggestion(text)}
              className="group flex w-full items-center gap-3 border-b border-[color-mix(in_srgb,var(--border)_60%,transparent)] px-1 py-3 text-left transition-colors hover:bg-[var(--bg-secondary)]"
            >
              <MessageCircle className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
              <span className="min-w-0 truncate text-[14px] text-[var(--text-secondary)] transition-colors group-hover:text-[var(--text-primary)]">
                {text}
              </span>
            </button>
          ))}
          <button
            type="button"
            onClick={onConnectApps}
            className="group flex w-full items-center gap-3 px-1 py-3 text-left transition-colors hover:bg-[var(--bg-secondary)]"
          >
            <Plug className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
            <span className="min-w-0 truncate text-[14px] text-[var(--text-secondary)] transition-colors group-hover:text-[var(--text-primary)]">
              Connect your favorite apps
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

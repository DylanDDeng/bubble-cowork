import { useState } from 'react';
import { Brain, ChevronRight } from 'lucide-react';
import { formatDurationLabel } from '../utils/format-duration';

interface ThinkingBlockProps {
  content: string;
  title?: string;
  durationMs?: number;
  defaultExpanded?: boolean;
}

export function ThinkingBlock({
  content,
  title = 'Thinking',
  durationMs,
  defaultExpanded = false,
}: ThinkingBlockProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  if (!content || !content.trim()) return null;

  const durationLabel = formatDurationLabel(durationMs);

  return (
    <div className="my-1 border-l border-[var(--border)]/60 pl-3">
      <button
        onClick={() => setIsExpanded((value) => !value)}
        className="flex w-full items-center gap-2 py-1.5 text-left"
        aria-expanded={isExpanded}
      >
        <ChevronRight
          className={`h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)] transition-transform ${
            isExpanded ? 'rotate-90' : ''
          }`}
        />
        <Brain className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
        <span className="text-[12px] font-medium text-[var(--text-primary)]">{title}</span>
        {durationLabel ? (
          <span className="text-[11px] text-[var(--text-muted)]">· {durationLabel}</span>
        ) : null}
      </button>

      {isExpanded ? (
        <div className="pb-2 pl-[22px] pr-1 text-[12px] leading-5 text-[var(--text-secondary)] whitespace-pre-wrap break-words">
          {content}
        </div>
      ) : null}
    </div>
  );
}

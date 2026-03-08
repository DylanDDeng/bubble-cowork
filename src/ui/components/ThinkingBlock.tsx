import { useState } from 'react';
import { Brain, ChevronRight } from 'lucide-react';

interface ThinkingBlockProps {
  content: string;
  title?: string;
  defaultExpanded?: boolean;
}

export function ThinkingBlock({
  content,
  title = 'Thinking',
  defaultExpanded = false,
}: ThinkingBlockProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  // Skip empty content
  if (!content || !content.trim()) return null;

  const preview = content.length > 160 ? `${content.slice(0, 160).trimEnd()}...` : content;

  return (
    <div className="rounded-lg border border-[var(--border)]/70 bg-[var(--bg-primary)]/80">
      <button
        onClick={() => setIsExpanded((value) => !value)}
        className="flex w-full items-start gap-2 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-tertiary)]/20"
      >
        <ChevronRight
          className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)] transition-transform ${
            isExpanded ? 'rotate-90' : ''
          }`}
        />
        <Brain className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--text-muted)]" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-[var(--text-primary)]">{title}</div>
          <div className="mt-0.5 text-sm leading-5 text-[var(--text-secondary)]">
            {isExpanded ? content : preview}
          </div>
        </div>
      </button>
    </div>
  );
}

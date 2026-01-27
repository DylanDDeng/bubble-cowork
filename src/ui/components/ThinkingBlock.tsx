import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { MDContent } from '../render/markdown';

interface ThinkingBlockProps {
  content: string;
}

export function ThinkingBlock({ content }: ThinkingBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Skip empty content
  if (!content || !content.trim()) return null;

  const isLong = content.length > 200;

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-tertiary)]/50 p-3">
      {/* Header - clickable to expand/collapse */}
      <button
        onClick={() => isLong && setIsExpanded(!isExpanded)}
        className={`flex w-full items-center gap-2 text-left text-sm text-[var(--text-muted)] ${
          isLong ? 'cursor-pointer' : 'cursor-default'
        }`}
      >
        <span className="opacity-60">⊛</span>
        <span className="font-medium">Thinking</span>
        {isLong && (
          <ChevronDown
            className={`ml-auto w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          />
        )}
      </button>

      {/* Content area */}
      {(isExpanded || !isLong) && (
        <div className="mt-2 text-sm text-[var(--text-secondary)]">
          <MDContent content={content} />
        </div>
      )}

      {/* Collapsed preview */}
      {!isExpanded && isLong && (
        <div className="mt-2 text-sm text-[var(--text-secondary)] line-clamp-3">
          <MDContent content={content} />
        </div>
      )}
    </div>
  );
}

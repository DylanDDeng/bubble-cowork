import { useEffect, useRef, useMemo } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { useDebounce } from '../../hooks/useDebounce';
import type { SearchMatch } from '../../types';

export function InSessionSearch() {
  const inputRef = useRef<HTMLInputElement>(null);
  const {
    inSessionSearchOpen,
    inSessionSearchQuery,
    inSessionSearchResults,
    inSessionSearchCurrentIndex,
    setInSessionSearchQuery,
    setInSessionSearchResults,
    navigateSearchResult,
    closeInSessionSearch,
    activeSessionId,
    sessions,
  } = useAppStore();

  const debouncedQuery = useDebounce(inSessionSearchQuery, 200);

  // 获取当前会话的消息
  const currentSession = activeSessionId ? sessions[activeSessionId] : null;

  // 客户端搜索逻辑
  useEffect(() => {
    if (!debouncedQuery.trim() || !currentSession) {
      setInSessionSearchResults([]);
      return;
    }

    const query = debouncedQuery.toLowerCase();
    const matches: SearchMatch[] = [];

    currentSession.messages.forEach((message, index) => {
      let text = '';

      if (message.type === 'user_prompt') {
        text = message.prompt;
      } else if (message.type === 'assistant' || message.type === 'user') {
        text = message.message.content
          .map((block) => {
            if (block.type === 'text') return block.text;
            if (block.type === 'thinking') return block.thinking;
            return '';
          })
          .join(' ');
      }

      if (text.toLowerCase().includes(query)) {
        // 提取包含关键词的片段
        const lowerText = text.toLowerCase();
        const matchIndex = lowerText.indexOf(query);
        const start = Math.max(0, matchIndex - 30);
        const end = Math.min(text.length, matchIndex + query.length + 30);
        const snippet = (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '');

        matches.push({
          messageIndex: index,
          snippet,
        });
      }
    });

    setInSessionSearchResults(matches);
  }, [debouncedQuery, currentSession, setInSessionSearchResults]);

  // 自动聚焦输入框
  useEffect(() => {
    if (inSessionSearchOpen) {
      inputRef.current?.focus();
    }
  }, [inSessionSearchOpen]);

  // 处理键盘事件
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeInSessionSearch();
    } else if (e.key === 'Enter') {
      if (e.shiftKey) {
        navigateSearchResult('prev');
      } else {
        navigateSearchResult('next');
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      navigateSearchResult('prev');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      navigateSearchResult('next');
    }
  };

  // 滚动到当前匹配的消息
  useEffect(() => {
    if (inSessionSearchResults.length > 0) {
      const match = inSessionSearchResults[inSessionSearchCurrentIndex];
      if (match) {
        const messageEl = document.querySelector(`[data-message-index="${match.messageIndex}"]`);
        messageEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [inSessionSearchCurrentIndex, inSessionSearchResults]);

  if (!inSessionSearchOpen) return null;

  const total = inSessionSearchResults.length;
  const current = total > 0 ? inSessionSearchCurrentIndex + 1 : 0;

  return (
    <div className="absolute top-0 left-0 right-0 z-50 p-2 bg-[var(--bg-secondary)] border-b border-[var(--border)] shadow-md">
      <div className="flex items-center gap-2">
        <div className="flex-1 relative">
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]">
            <SearchIcon />
          </div>
          <input
            ref={inputRef}
            type="text"
            value={inSessionSearchQuery}
            onChange={(e) => setInSessionSearchQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Find in session..."
            className="w-full pl-9 pr-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg text-sm placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] transition-colors"
          />
        </div>

        {/* 匹配计数和导航 */}
        <div className="flex items-center gap-1 text-sm text-[var(--text-muted)]">
          <span className="min-w-[60px] text-center">
            {total > 0 ? `${current} / ${total}` : 'No results'}
          </span>
          <button
            onClick={() => navigateSearchResult('prev')}
            disabled={total === 0}
            className="p-1.5 rounded hover:bg-[var(--bg-tertiary)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="Previous (Shift+Enter)"
          >
            <ChevronUpIcon />
          </button>
          <button
            onClick={() => navigateSearchResult('next')}
            disabled={total === 0}
            className="p-1.5 rounded hover:bg-[var(--bg-tertiary)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="Next (Enter)"
          >
            <ChevronDownIcon />
          </button>
        </div>

        {/* 关闭按钮 */}
        <button
          onClick={closeInSessionSearch}
          className="p-1.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
          title="Close (Escape)"
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

function ChevronUpIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

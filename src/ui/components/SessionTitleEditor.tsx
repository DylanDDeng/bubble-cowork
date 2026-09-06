import { useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { MAX_SESSION_TITLE_LENGTH, normalizeSessionTitleInput } from '../../shared/session-rename';
import { useAppStore } from '../store/useAppStore';
import type { SessionView } from '../types';
import { SessionTitleText } from './SessionTitleText';

type Props = { session: SessionView | null | undefined; className?: string };

export function SessionTitleEditor({ session, className = '' }: Props) {
  // A tab/pane switch cancels that editor instead of carrying its text to the next conversation.
  return session
    ? <TitleEditor key={session.id} session={session} className={className} />
    : <SessionTitleText session={session} className={className} />;
}

function TitleEditor({ session, className }: { session: SessionView; className: string }) {
  const renameSession = useAppStore((state) => state.renameSession);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const finishing = useRef(false);
  const composing = useRef(false);
  const restoreFocus = useRef(false);

  useLayoutEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (restoreFocus.current) {
      restoreFocus.current = false;
      buttonRef.current?.focus();
    }
  }, [editing]);

  function finish(restore: boolean) {
    if (finishing.current) return;
    finishing.current = true;
    restoreFocus.current = restore;
    const next = draft.replace(/\s+/g, ' ').trim();
    // Empty/unchanged titles simply leave edit mode, preserving the original.
    if (!next || next === session.title) {
      setEditing(false);
      return;
    }
    setSaving(true);
    void (async () => {
      try {
        await renameSession(session.id, normalizeSessionTitleInput(next));
        setEditing(false);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Could not rename the conversation.');
        finishing.current = false;
        // Keep the text available for retry without stealing focus after a blur.
        if (restore) inputRef.current?.focus();
      } finally {
        setSaving(false);
      }
    })();
  }

  if (!editing) {
    return (
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Rename conversation: ${session.title}`}
        title="Rename conversation"
        onClick={() => {
          finishing.current = false;
          composing.current = false;
          setDraft(session.title);
          setEditing(true);
        }}
        className={`no-drag -mx-1.5 inline-flex h-[26px] min-w-0 max-w-full items-center rounded-lg border border-transparent px-1.5 text-left transition-colors hover:bg-[var(--sidebar-item-hover)] focus-visible:bg-[var(--sidebar-item-hover)] ${className}`}
      >
        <SessionTitleText session={session} />
      </button>
    );
  }

  return (
    <span
      className={`no-drag -mx-1.5 inline-grid h-[26px] min-w-[28px] max-w-full items-center ${className}`}
      style={{ width: 'max-content' }}
    >
      <span aria-hidden="true" className="invisible col-start-1 row-start-1 overflow-hidden whitespace-pre border border-transparent px-1.5">
        {draft || ' '}
      </span>
      <input
        ref={inputRef}
        aria-label="Conversation title"
        aria-busy={saving}
        value={draft}
        readOnly={saving}
        maxLength={MAX_SESSION_TITLE_LENGTH}
        size={1}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onBlur={() => finish(false)}
        onKeyDown={(event) => {
          // Enter/Escape belong to the IME until its candidate is committed.
          if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            finish(true);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (saving) return;
            finishing.current = true;
            restoreFocus.current = true;
            setEditing(false);
          }
        }}
        className="col-start-1 row-start-1 h-[26px] w-full min-w-0 rounded-lg border border-[var(--accent)] bg-transparent px-1.5 text-inherit outline-none focus:ring-1 focus:ring-[var(--accent)]"
      />
    </span>
  );
}

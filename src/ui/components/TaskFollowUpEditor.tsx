import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AttachmentChips } from './AttachmentChips';
import { ClaudeSkillMenu } from './ClaudeSkillMenu';
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from './ComposerPromptEditor';
import { ProjectFileMentionMenu } from './ProjectFileMentionMenu';
import { useComposerCapabilityMenu } from '../hooks/useClaudeSkillAutocomplete';
import { useProjectFileMentions } from '../hooks/useProjectFileMentions';
import { buildCodexReferencePayload, type CodexReferencePayload } from '../utils/codex-composer';
import {
  LONG_PROMPT_AUTO_ATTACHMENT_THRESHOLD,
  maybeConvertLongPromptToAttachment,
} from '../utils/long-prompt-attachment';
import { buildPromptWithProjectFileMentions } from '../utils/project-file-mention-context';
import { insertProjectFileMention } from '../utils/project-file-mentions';
import type { Attachment, SessionView } from '../types';

/** What a task follow-up sends: the text as typed, plus what the runtime needs. */
export interface TaskFollowUpOutgoing {
  prompt: string;
  /** Mentions expanded; for Codex a picked skill is dropped here and sent as a reference. */
  effectivePrompt: string;
  attachments: Attachment[];
  references: CodexReferencePayload;
}

export interface TaskFollowUpEditorHandle {
  submit: () => void;
  focus: () => void;
  /** Open the file picker and attach what was chosen. */
  addAttachments: () => void;
}

/**
 * The board's follow-up input with the session composer's capabilities:
 * "/" and "$" for commands and skills, "@" for project files, pasted
 * images and picked files as attachment chips, long pastes converted to a
 * text attachment. Enter sends; Shift+Enter breaks the line.
 */
export const TaskFollowUpEditor = forwardRef<
  TaskFollowUpEditorHandle,
  {
    value: string;
    onChange: (value: string) => void;
    /** Return true when the message was sent; the editor then clears its attachments. */
    onSubmit: (outgoing: TaskFollowUpOutgoing) => boolean;
    onAttachmentsChange?: (count: number) => void;
    session: SessionView | null;
    placeholder: string;
    className: string;
    /** Padding for the attachment chip row, matching the editor's inset. */
    chipsClassName?: string;
    placeholderClassName?: string;
    ariaLabel?: string;
    /** Where the menus open relative to the field. */
    menuSide?: 'top' | 'bottom';
  }
>(function TaskFollowUpEditor(
  {
    value,
    onChange,
    onSubmit,
    onAttachmentsChange,
    session,
    placeholder,
    className,
    chipsClassName = 'px-4 pt-3',
    placeholderClassName,
    ariaLabel,
    menuSide = 'top',
  },
  ref
) {
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const isComposingRef = useRef(false);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [attachments, setAttachmentsState] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const provider = session?.provider || 'claude';
  const cwd = session?.cwd || null;

  const setAttachments = useCallback(
    (update: (prev: Attachment[]) => Attachment[]) => {
      setAttachmentsState((prev) => {
        const next = update(prev);
        onAttachmentsChange?.(next.length);
        return next;
      });
    },
    [onAttachmentsChange]
  );

  const mergeAttachments = useCallback(
    (incoming: Attachment[]) => {
      if (incoming.length === 0) return;
      setAttachments((prev) => {
        const existing = new Set(prev.map((entry) => entry.path));
        const next = [...prev];
        for (const entry of incoming) {
          if (!existing.has(entry.path)) next.push(entry);
        }
        return next;
      });
    },
    [setAttachments]
  );

  const capabilityMenu = useComposerCapabilityMenu({
    enabled: Boolean(session),
    enableSkills: true,
    provider,
    prompt: value,
    cursorIndex,
    projectPath: session?.cwd,
    sessionMessages: session?.messages || [],
    setPrompt: onChange,
    setCursorIndex,
  });

  const projectFileMentions = useProjectFileMentions({ cwd, prompt: value, cursorIndex });

  const focusAt = (index: number) => {
    window.requestAnimationFrame(() => {
      editorRef.current?.focus();
      editorRef.current?.setCursorIndex(index);
    });
  };

  const selectProjectFile = (file: { path: string; relativePath?: string }) => {
    const mention = projectFileMentions.mention;
    if (!cwd || !mention) return;
    const next = insertProjectFileMention(value, mention, file.relativePath || file.path);
    onChange(next.prompt);
    setCursorIndex(next.cursorIndex);
    focusAt(next.cursorIndex);
  };

  const addAttachments = async () => {
    const selected = await window.electron.selectAttachments();
    if (selected && selected.length > 0) mergeAttachments(selected);
  };

  const handlePasteImages = async (
    images: { mimeType: string; data: Uint8Array; name?: string }[]
  ): Promise<boolean> => {
    if (images.length === 0) return false;
    const created: Attachment[] = [];
    let failed = 0;
    for (const image of images) {
      try {
        const attachment = await window.electron.createInlineImageAttachment(
          image.mimeType,
          image.data
        );
        if (attachment) created.push(attachment);
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    mergeAttachments(created);
    if (failed > 0) toast.error(`Could not attach ${failed} pasted image${failed === 1 ? '' : 's'}.`);
    return created.length > 0;
  };

  const handleLongPaste = (context: { text: string; start: number; end: number }): boolean => {
    const pastedText = context.text.trim();
    if (pastedText.length <= LONG_PROMPT_AUTO_ATTACHMENT_THRESHOLD) return false;
    const pasteInline = () => {
      const nextPrompt = `${value.slice(0, context.start)}${context.text}${value.slice(context.end)}`;
      const nextCursorIndex = context.start + context.text.length;
      onChange(nextPrompt);
      setCursorIndex(nextCursorIndex);
      focusAt(nextCursorIndex);
    };
    const toastId = toast.loading('Creating text attachment...');
    void (async () => {
      try {
        const result = await maybeConvertLongPromptToAttachment({
          cwd,
          prompt: pastedText,
          attachments,
          allowProjectMentions: true,
        });
        if (!result.converted) {
          pasteInline();
          if (result.reason === 'attachment_create_failed') {
            toast.error('Failed to convert the long paste into an attachment.');
          }
          return;
        }
        setAttachments(() => result.attachments);
        window.requestAnimationFrame(() => editorRef.current?.focus());
      } finally {
        toast.dismiss(toastId);
      }
    })();
    return true;
  };

  const submit = async () => {
    const displayPrompt = value.trim();
    if ((!displayPrompt && attachments.length === 0) || sending) return;
    setSending(true);
    try {
      const codexSkill = provider === 'codex' ? capabilityMenu.selectedSkill : null;
      const normalized = await buildPromptWithProjectFileMentions({
        cwd,
        prompt: codexSkill ? capabilityMenu.selectedSkillRemainder.trim() : displayPrompt,
        ignoredMentionPaths: [],
      });
      const withAttachment = await maybeConvertLongPromptToAttachment({
        cwd,
        prompt: displayPrompt,
        attachments,
      });
      if (withAttachment.reason === 'attachment_create_failed') {
        toast.error('Failed to convert the long message into an attachment. Sending inline instead.');
      }
      const sent = onSubmit({
        prompt: withAttachment.converted ? withAttachment.prompt : displayPrompt,
        effectivePrompt: withAttachment.converted ? withAttachment.prompt : normalized,
        attachments: withAttachment.attachments,
        references: buildCodexReferencePayload(codexSkill),
      });
      if (sent) {
        setAttachments(() => []);
        setCursorIndex(0);
        // The parent clears the text on the next render; move the editor's
        // own caret back to the start once that has happened.
        focusAt(0);
      }
    } finally {
      setSending(false);
    }
  };

  useImperativeHandle(ref, () => ({
    submit: () => void submit(),
    focus: () => editorRef.current?.focus(),
    addAttachments: () => void addAttachments(),
  }));

  const menuPosition = menuSide === 'top' ? 'bottom-full' : 'top-full';

  return (
    <div className="relative">
      {projectFileMentions.hasMentionQuery ? (
        <div className={`absolute inset-x-0 z-40 ${menuPosition}`}>
          <ProjectFileMentionMenu
            suggestions={projectFileMentions.suggestions}
            selectedIndex={projectFileMentions.selectedIndex}
            loading={projectFileMentions.loading}
            onSelect={selectProjectFile}
          />
        </div>
      ) : capabilityMenu.hasSlashQuery ? (
        <div className={`absolute inset-x-0 z-40 ${menuPosition}`}>
          <ClaudeSkillMenu
            suggestions={capabilityMenu.suggestions}
            selectedIndex={capabilityMenu.selectedIndex}
            empty={capabilityMenu.suggestions.length === 0}
            title={capabilityMenu.menuTitle}
            emptyMessage={capabilityMenu.emptyMessage}
            onSelect={(suggestion) => {
              capabilityMenu.selectSuggestion(suggestion);
              window.requestAnimationFrame(() => editorRef.current?.focus());
            }}
            onHighlight={capabilityMenu.setSelectedIndex}
          />
        </div>
      ) : null}
      {attachments.length > 0 ? (
        <div className={chipsClassName}>
          <AttachmentChips
            attachments={attachments}
            onRemove={(id) => setAttachments((prev) => prev.filter((entry) => entry.id !== id))}
          />
        </div>
      ) : null}
      <ComposerPromptEditor
        ref={editorRef}
        value={capabilityMenu.displayPrompt}
        cursorIndex={cursorIndex}
        slashContext={capabilityMenu.slashContext}
        slashDisplayLabels={capabilityMenu.slashDisplayLabels}
        onChange={(next, nextCursorIndex) => {
          onChange(next);
          setCursorIndex(nextCursorIndex);
        }}
        onPasteText={handleLongPaste}
        onPasteImages={handlePasteImages}
        onCompositionStart={() => {
          isComposingRef.current = true;
        }}
        onCompositionEnd={() => {
          isComposingRef.current = false;
        }}
        onKeyDown={(event) => {
          if (isComposingRef.current || event.nativeEvent.isComposing) return;
          if (projectFileMentions.hasMentionQuery) {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              projectFileMentions.moveSelection(1);
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              projectFileMentions.moveSelection(-1);
              return;
            }
            if (
              (event.key === 'Enter' || event.key === 'Tab') &&
              projectFileMentions.suggestions.length > 0
            ) {
              event.preventDefault();
              const current = projectFileMentions.getCurrentSuggestion();
              if (current) selectProjectFile(current);
              return;
            }
          }
          if (capabilityMenu.hasSlashQuery) {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              capabilityMenu.moveSelection(1);
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              capabilityMenu.moveSelection(-1);
              return;
            }
            if (
              (event.key === 'Enter' || event.key === 'Tab') &&
              capabilityMenu.suggestions.length > 0
            ) {
              event.preventDefault();
              capabilityMenu.selectCurrentSuggestion();
              window.requestAnimationFrame(() => editorRef.current?.focus());
              return;
            }
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder={placeholder}
        placeholderClassName={placeholderClassName}
        disabled={sending}
        className={className}
        autoFocus={false}
      />
      {ariaLabel ? <span className="sr-only">{ariaLabel}</span> : null}
    </div>
  );
});

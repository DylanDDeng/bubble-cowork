import {
  type ClipboardEvent,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import { getFileTypeIconUrl } from './FileTypeIcon';
import { extractProjectFileMentions } from '../utils/project-file-mentions';
import {
  removeLeadingSlashTokenAdjacentToCursor,
  splitPromptIntoComposerSegments,
  type PromptSegment,
  type SlashSegmentKind,
  type SlashTokenContext,
} from '../utils/composer-segments';
import { normalizeAgentMentionHandle } from '../utils/agent-mentions';

export interface ComposerPromptEditorHandle {
  focus: () => void;
  setCursorIndex: (index: number) => void;
}

export interface ComposerPasteContext {
  text: string;
  start: number;
  end: number;
}

export interface ComposerPasteImage {
  mimeType: string;
  data: Uint8Array;
  name?: string;
}

function basenameOfPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || path;
}

function isSegmentElement(node: Node | null | undefined): boolean {
  return (
    node instanceof HTMLElement &&
    typeof node.dataset.segmentType === 'string' &&
    node.dataset.segmentType.length > 0
  );
}

function getChildTextLength(node: ChildNode): number {
  if (node.nodeName === 'BR') {
    return 1;
  }

  if (!(node instanceof HTMLElement)) {
    return node.textContent?.length || 0;
  }

  if (isSegmentElement(node)) {
    return node.dataset.rawText?.length || 0;
  }

  return Array.from(node.childNodes).reduce((total, child) => total + getChildTextLength(child), 0);
}

function getSerializedLength(root: HTMLDivElement): number {
  return Array.from(root.childNodes).reduce((total, child) => total + getChildTextLength(child), 0);
}

function getCursorIndex(root: HTMLDivElement): number {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return 0;
  }

  const range = selection.getRangeAt(0);
  const { startContainer, startOffset } = range;

  if (!root.contains(startContainer)) {
    return 0;
  }

  let offset = 0;

  const directChildFromNode = (node: Node | null): ChildNode | null => {
    let current: Node | null = node;
    while (current && current.parentNode !== root) {
      current = current.parentNode;
    }
    return current instanceof Node ? (current as ChildNode) : null;
  };

  if (startContainer === root) {
    for (let index = 0; index < startOffset; index += 1) {
      const child = root.childNodes[index];
      if (child) {
        offset += getChildTextLength(child);
      }
    }
    return offset;
  }

  const directChild = directChildFromNode(startContainer);
  if (!directChild) {
    return 0;
  }

  for (const child of Array.from(root.childNodes)) {
    if (child === directChild) {
      break;
    }
    offset += getChildTextLength(child);
  }

  if (isSegmentElement(directChild)) {
    const element = directChild as HTMLElement;
    const tokenLength = element.dataset.rawText?.length || 0;
    return startOffset <= 0 ? offset : offset + tokenLength;
  }

  if (startContainer.nodeType === Node.TEXT_NODE) {
    return offset + startOffset;
  }

  if (startContainer instanceof HTMLElement) {
    const walker = document.createTreeWalker(startContainer, NodeFilter.SHOW_TEXT);
    let textNode = walker.nextNode();
    while (textNode) {
      if (textNode === range.startContainer) {
        return offset + startOffset;
      }
      offset += textNode.textContent?.length || 0;
      textNode = walker.nextNode();
    }
  }

  return offset;
}

function setCursorIndex(root: HTMLDivElement, index: number): void {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const targetIndex = Math.max(0, Math.min(index, getSerializedLength(root)));
  let remaining = targetIndex;
  const range = document.createRange();

  const children = Array.from(root.childNodes);
  for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
    const child = children[childIndex]!;
    const childLength = getChildTextLength(child);

    if (isSegmentElement(child)) {
      if (remaining <= 0) {
        range.setStart(root, childIndex);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      if (remaining <= childLength) {
        range.setStart(root, childIndex + 1);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      remaining -= childLength;
      continue;
    }

    if (remaining <= childLength) {
      const textNode =
        child.nodeType === Node.TEXT_NODE
          ? child
          : child.firstChild && child.firstChild.nodeType === Node.TEXT_NODE
            ? child.firstChild
            : child;
      range.setStart(textNode, remaining);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }

    remaining -= childLength;
  }

  range.selectNodeContents(root);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function serializeEditorValue(root: HTMLDivElement): string {
  const serializeNode = (node: ChildNode): string => {
    if (node.nodeName === 'BR') {
      return '\n';
    }

    if (!(node instanceof HTMLElement)) {
      return node.textContent || '';
    }

    if (isSegmentElement(node)) {
      return node.dataset.rawText || '';
    }

    return Array.from(node.childNodes)
      .map((child) => serializeNode(child))
      .join('');
  };

  return Array.from(root.childNodes)
    .map((child) => serializeNode(child))
    .join('');
}

function createMentionNode(path: string, rawText: string): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.dataset.segmentType = 'mention';
  chip.dataset.rawText = rawText;
  chip.dataset.mentionPath = path;
  chip.contentEditable = 'false';
  chip.spellcheck = false;
  chip.title = path;
  chip.className =
    'mx-[1px] inline-flex max-w-[240px] select-none items-center gap-1 rounded-md border px-1.5 py-0.5 align-baseline text-[12px] leading-none';
  chip.style.borderColor = 'var(--composer-mention-chip-border)';
  chip.style.backgroundColor = 'var(--composer-mention-chip-bg)';
  chip.style.color = 'var(--composer-mention-chip-text)';

  const icon = document.createElement('img');
  icon.src = getFileTypeIconUrl(basenameOfPath(path));
  icon.alt = '';
  icon.setAttribute('aria-hidden', 'true');
  icon.className = 'h-3.5 w-3.5 shrink-0';
  icon.loading = 'lazy';
  icon.onerror = () => {
    icon.remove();
  };

  const label = document.createElement('span');
  label.className = 'truncate font-mono text-[11px]';
  label.textContent = `@${basenameOfPath(path)}`;

  chip.append(icon, label);
  return chip;
}

function createAgentMentionNode(label: string, rawText: string): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.dataset.segmentType = 'mention';
  chip.dataset.rawText = rawText;
  chip.dataset.mentionPath = rawText.replace(/^@/, '');
  chip.contentEditable = 'false';
  chip.spellcheck = false;
  chip.title = label;
  chip.className =
    'mx-[1px] inline-flex max-w-[220px] select-none items-center gap-1 rounded-md border px-1.5 py-0.5 align-baseline text-[12px] leading-none';
  chip.style.borderColor = 'var(--composer-chip-border)';
  chip.style.backgroundColor = 'var(--composer-chip-bg)';
  chip.style.color = 'var(--composer-chip-text)';

  const icon = document.createElement('span');
  icon.className =
    'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-[var(--accent-light)] text-[10px] font-semibold text-[var(--accent)]';
  icon.textContent = '@';
  icon.setAttribute('aria-hidden', 'true');

  const text = document.createElement('span');
  text.className = 'truncate font-mono text-[11px]';
  text.textContent = rawText;

  chip.append(icon, text);
  return chip;
}

function createSlashNode(kind: SlashSegmentKind, name: string, rawText: string): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.dataset.segmentType = 'slash';
  chip.dataset.slashKind = kind;
  chip.dataset.rawText = rawText;
  chip.dataset.slashName = name;
  chip.contentEditable = 'false';
  chip.spellcheck = false;
  chip.title = rawText;
  chip.className =
    'mx-[1px] inline-flex max-w-[240px] select-none items-center gap-1 rounded-md border px-1.5 py-0.5 align-baseline text-[12px] leading-none';
  chip.style.borderColor =
    kind === 'skill' ? 'var(--composer-skill-chip-border)' : 'var(--composer-chip-border)';
  chip.style.backgroundColor =
    kind === 'skill' ? 'var(--composer-skill-chip-bg)' : 'var(--composer-chip-bg)';
  chip.style.color =
    kind === 'skill' ? 'var(--composer-skill-chip-text)' : 'var(--composer-chip-text)';

  const iconBox = document.createElement('span');
  iconBox.className = 'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center';
  iconBox.setAttribute('aria-hidden', 'true');
  iconBox.innerHTML =
    kind === 'skill'
      ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z"/><path d="m7 16.5-4.74-2.85"/><path d="m7 16.5 5-3"/><path d="M7 16.5v5.17"/><path d="M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z"/><path d="m17 16.5-5-3"/><path d="m17 16.5 4.74-2.85"/><path d="M17 16.5v5.17"/><path d="M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z"/><path d="M12 8 7.26 5.15"/><path d="m12 8 4.74-2.85"/><path d="M12 13.5V8"/></svg>'
      : '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/></svg>';

  const label = document.createElement('span');
  label.className = 'truncate font-mono text-[11px]';
  label.textContent = rawText;

  chip.append(iconBox, label);
  return chip;
}

function renderSegments(
  root: HTMLDivElement,
  value: string,
  slashContext?: SlashTokenContext,
  agentMentionLabels?: Record<string, string>
): void {
  const segments: PromptSegment[] = splitPromptIntoComposerSegments(value, slashContext);
  root.replaceChildren();

  for (const segment of segments) {
    if (segment.type === 'text') {
      root.append(document.createTextNode(segment.text));
      continue;
    }

    if (segment.type === 'mention') {
      const agentLabel = agentMentionLabels?.[normalizeAgentMentionHandle(segment.path)];
      if (agentLabel) {
        root.append(createAgentMentionNode(agentLabel, segment.text));
        continue;
      }
      root.append(createMentionNode(segment.path, segment.text));
      continue;
    }

    root.append(createSlashNode(segment.kind, segment.name, segment.text));
  }
}

function removeMentionAdjacentToCursor(
  value: string,
  cursorIndex: number,
  key: 'Backspace' | 'Delete'
): { value: string; cursorIndex: number } | null {
  const mentions = extractProjectFileMentions(value);
  for (const mention of mentions) {
    if (key === 'Backspace' && cursorIndex === mention.end) {
      return {
        value: `${value.slice(0, mention.start)}${value.slice(mention.end)}`,
        cursorIndex: mention.start,
      };
    }

    if (key === 'Delete' && cursorIndex === mention.start) {
      return {
        value: `${value.slice(0, mention.start)}${value.slice(mention.end)}`,
        cursorIndex: mention.start,
      };
    }
  }

  return null;
}

function replaceRange(
  value: string,
  start: number,
  end: number,
  text: string
): { value: string; cursorIndex: number } {
  const nextValue = `${value.slice(0, start)}${text}${value.slice(end)}`;
  return {
    value: nextValue,
    cursorIndex: start + text.length,
  };
}

export const ComposerPromptEditor = forwardRef<
  ComposerPromptEditorHandle,
  {
    value: string;
    cursorIndex: number;
    onChange: (value: string, cursorIndex: number) => void;
    onPasteText?: (context: ComposerPasteContext) => boolean | void | Promise<boolean | void>;
    onPasteImages?: (images: ComposerPasteImage[]) => boolean | void | Promise<boolean | void>;
    onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
    onCompositionStart?: () => void;
    onCompositionEnd?: () => void;
    placeholder?: string;
    disabled?: boolean;
    autoFocus?: boolean;
    className?: string;
    slashContext?: SlashTokenContext;
    agentMentionLabels?: Record<string, string>;
  }
>(function ComposerPromptEditor(props, ref) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const isApplyingSelectionRef = useRef(false);
  const lastRenderedSlashContextRef = useRef<SlashTokenContext | undefined>(undefined);
  const lastRenderedAgentMentionLabelsRef = useRef<Record<string, string> | undefined>(undefined);
  const displayHasValue = useMemo(() => props.value.length > 0, [props.value]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        editorRef.current?.focus();
      },
      setCursorIndex: (index: number) => {
        if (editorRef.current) {
          setCursorIndex(editorRef.current, index);
        }
      },
    }),
    []
  );

  useEffect(() => {
    if (props.autoFocus && editorRef.current) {
      editorRef.current.focus();
      setCursorIndex(editorRef.current, props.cursorIndex);
    }
  }, [props.autoFocus, props.cursorIndex]);

  useLayoutEffect(() => {
    if (!editorRef.current) {
      return;
    }

    const slashContextChanged = lastRenderedSlashContextRef.current !== props.slashContext;
    const agentMentionLabelsChanged =
      lastRenderedAgentMentionLabelsRef.current !== props.agentMentionLabels;
    if (
      serializeEditorValue(editorRef.current) !== props.value ||
      slashContextChanged ||
      agentMentionLabelsChanged
    ) {
      renderSegments(editorRef.current, props.value, props.slashContext, props.agentMentionLabels);
      lastRenderedSlashContextRef.current = props.slashContext;
      lastRenderedAgentMentionLabelsRef.current = props.agentMentionLabels;
    }

    if (document.activeElement !== editorRef.current) {
      return;
    }

    isApplyingSelectionRef.current = true;
    setCursorIndex(editorRef.current, props.cursorIndex);
    queueMicrotask(() => {
      isApplyingSelectionRef.current = false;
    });
  }, [props.agentMentionLabels, props.cursorIndex, props.value, props.slashContext]);

  const handleInput = () => {
    if (!editorRef.current || isApplyingSelectionRef.current) {
      return;
    }

    const nextValue = serializeEditorValue(editorRef.current);
    const nextCursor = getCursorIndex(editorRef.current);
    props.onChange(nextValue, nextCursor);
  };

  const handleSelect = () => {
    if (!editorRef.current || isApplyingSelectionRef.current) {
      return;
    }

    const nextCursor = getCursorIndex(editorRef.current);
    if (nextCursor !== props.cursorIndex) {
      props.onChange(props.value, nextCursor);
    }
  };

  const insertTextAtCursor = (text: string) => {
    const next = replaceRange(props.value, props.cursorIndex, props.cursorIndex, text);
    props.onChange(next.value, next.cursorIndex);
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (props.disabled) return;

    const imageFiles: File[] = [];
    const dt = event.clipboardData;
    if (dt) {
      if (dt.files && dt.files.length > 0) {
        for (let i = 0; i < dt.files.length; i += 1) {
          const f = dt.files.item(i);
          if (f && /^image\/(png|jpe?g)$/i.test(f.type)) {
            imageFiles.push(f);
          }
        }
      }
      if (imageFiles.length === 0 && dt.items && dt.items.length > 0) {
        for (let i = 0; i < dt.items.length; i += 1) {
          const item = dt.items[i];
          if (item.kind === 'file' && /^image\/(png|jpe?g)$/i.test(item.type)) {
            const f = item.getAsFile();
            if (f) imageFiles.push(f);
          }
        }
      }
    }

    if (imageFiles.length > 0 && props.onPasteImages) {
      event.preventDefault();
      void Promise.all(
        imageFiles.map(async (file) => ({
          mimeType: file.type.toLowerCase(),
          data: new Uint8Array(await file.arrayBuffer()),
          name: file.name || undefined,
        }))
      ).then((images) => {
        const handled = props.onPasteImages?.(images);
        void handled;
      });
      return;
    }

    const text = event.clipboardData.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const context = {
      text: normalized,
      start: props.cursorIndex,
      end: props.cursorIndex,
    };
    const handled = props.onPasteText?.(context);
    if (handled instanceof Promise) {
      void handled;
      return;
    }
    if (handled === true) {
      return;
    }
    insertTextAtCursor(normalized);
  };

  return (
    <div className="relative">
      {!displayHasValue && props.placeholder ? (
        <div className="pointer-events-none absolute inset-x-5 top-4 text-[14px] text-[var(--text-muted)]">
          {props.placeholder}
        </div>
      ) : null}
      <div
        ref={editorRef}
        contentEditable={!props.disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        spellCheck={false}
        className={`${props.className ?? ''} whitespace-pre-wrap break-words [overflow-wrap:anywhere]`}
        onInput={handleInput}
        onPaste={handlePaste}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && event.shiftKey) {
            event.preventDefault();
            insertTextAtCursor('\n');
            return;
          }

          const selection = window.getSelection();
          const collapsed = selection?.isCollapsed ?? true;
          if (collapsed && (event.key === 'Backspace' || event.key === 'Delete')) {
            const mentionRemoval = removeMentionAdjacentToCursor(
              props.value,
              props.cursorIndex,
              event.key
            );
            if (mentionRemoval) {
              event.preventDefault();
              props.onChange(mentionRemoval.value, mentionRemoval.cursorIndex);
              return;
            }

            if (props.slashContext) {
              const slashRemoval = removeLeadingSlashTokenAdjacentToCursor(
                props.value,
                props.cursorIndex,
                event.key,
                props.slashContext
              );
              if (slashRemoval) {
                event.preventDefault();
                props.onChange(slashRemoval.value, slashRemoval.cursorIndex);
                return;
              }
            }
          }

          props.onKeyDown?.(event);
        }}
        onMouseUp={handleSelect}
        onKeyUp={handleSelect}
        onFocus={() => {
          if (editorRef.current) {
            setCursorIndex(editorRef.current, props.cursorIndex);
          }
        }}
        onCompositionStart={() => {
          props.onCompositionStart?.();
        }}
        onCompositionEnd={() => {
          props.onCompositionEnd?.();
          handleInput();
        }}
      />
    </div>
  );
});

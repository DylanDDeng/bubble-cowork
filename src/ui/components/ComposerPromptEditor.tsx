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
import {
  extractProjectFileMentions,
  splitPromptIntoProjectFileSegments,
} from '../utils/project-file-mentions';

export interface ComposerPromptEditorHandle {
  focus: () => void;
  setCursorIndex: (index: number) => void;
}

function basenameOfPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || path;
}

function getChildTextLength(node: ChildNode): number {
  if (node.nodeName === 'BR') {
    return 1;
  }

  if (!(node instanceof HTMLElement)) {
    return node.textContent?.length || 0;
  }

  if (node.dataset.segmentType === 'mention') {
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

  if (directChild instanceof HTMLElement && directChild.dataset.segmentType === 'mention') {
    const tokenLength = directChild.dataset.rawText?.length || 0;
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

    if (child instanceof HTMLElement && child.dataset.segmentType === 'mention') {
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

    if (node.dataset.segmentType === 'mention') {
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
    'mx-[1px] inline-flex max-w-[240px] select-none items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 align-baseline text-[12px] leading-none text-[var(--text-primary)]';

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

function renderSegments(root: HTMLDivElement, value: string): void {
  const segments = splitPromptIntoProjectFileSegments(value);
  root.replaceChildren();

  for (const segment of segments) {
    if (segment.type === 'text') {
      root.append(document.createTextNode(segment.text));
      continue;
    }

    root.append(createMentionNode(segment.path, segment.text));
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
    onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
    onCompositionStart?: () => void;
    onCompositionEnd?: () => void;
    placeholder?: string;
    disabled?: boolean;
    autoFocus?: boolean;
    className?: string;
  }
>(function ComposerPromptEditor(props, ref) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const isApplyingSelectionRef = useRef(false);
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

    if (serializeEditorValue(editorRef.current) !== props.value) {
      renderSegments(editorRef.current, props.value);
    }

    if (document.activeElement !== editorRef.current) {
      return;
    }

    isApplyingSelectionRef.current = true;
    setCursorIndex(editorRef.current, props.cursorIndex);
    queueMicrotask(() => {
      isApplyingSelectionRef.current = false;
    });
  }, [props.cursorIndex, props.value]);

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
    const text = event.clipboardData.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    insertTextAtCursor(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
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
            const removal = removeMentionAdjacentToCursor(
              props.value,
              props.cursorIndex,
              event.key
            );
            if (removal) {
              event.preventDefault();
              props.onChange(removal.value, removal.cursorIndex);
              return;
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

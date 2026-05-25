import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bold,
  CheckSquare,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Italic,
  Link,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Strikethrough,
  Table,
  Undo2,
} from './icons';
import {
  Editor,
  commandsCtx,
  defaultValueCtx,
  editorViewCtx,
  rootCtx,
} from '@milkdown/kit/core';
import type { EditorView as ProseEditorView, NodeViewConstructor } from '@milkdown/kit/prose/view';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import {
  createCodeBlockCommand,
  imageSchema,
  insertImageCommand,
  liftListItemCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  toggleStrongCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from '@milkdown/kit/preset/commonmark';
import {
  gfm,
  insertTableCommand,
  toggleStrikethroughCommand,
} from '@milkdown/kit/preset/gfm';
import { history } from '@milkdown/kit/plugin/history';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { replaceAll } from '@milkdown/kit/utils';
import { $prose, $view } from '@milkdown/utils';
import { undo, redo } from '@milkdown/kit/prose/history';
import { projectMarkdownCodeBlockView } from './ProjectMarkdownCodeBlockView';
import '@milkdown/kit/prose/view/style/prosemirror.css';

export type MarkdownOutlineItem = {
  id: string;
  level: number;
  text: string;
  pos: number;
};

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

type FrontmatterParts = {
  frontmatter: string;
  body: string;
};

type ProjectMarkdownEditorProps = {
  value: string;
  cwd: string;
  filePath: string;
  fileName: string;
  hideTitleBar?: boolean;
  saveState: SaveState;
  saveError: string | null;
  externalChange: boolean;
  onChange: (next: string) => void;
  onSave: () => void;
  onReloadExternal: () => void;
  onKeepLocal: () => void;
};

const headingFlashKey = new PluginKey<DecorationSet>('aegisMarkdownHeadingFlash');
const HEADING_FLASH_META = 'aegis-markdown-heading-flash';
const OUTLINE_TARGET_MIN_TOP_OFFSET_PX = 72;
const OUTLINE_TARGET_MAX_TOP_OFFSET_PX = 140;
const OUTLINE_TARGET_VIEWPORT_RATIO = 0.16;
const MARKDOWN_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);
const MARKDOWN_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

function splitFrontmatter(markdown: string): FrontmatterParts {
  const text = String(markdown || '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) {
    return { frontmatter: '', body: text };
  }

  const closeMatch = text.slice(4).match(/\n---[ \t]*(?:\n|$)/);
  if (!closeMatch || closeMatch.index === undefined) {
    return { frontmatter: '', body: text };
  }

  const end = 4 + closeMatch.index + closeMatch[0].length;
  return {
    frontmatter: text.slice(0, end).replace(/\n?$/, '\n'),
    body: text.slice(end).replace(/^\n/, ''),
  };
}

function combineFrontmatter(frontmatter: string, body: string): string {
  const normalizedBody = String(body || '').replace(/\r\n/g, '\n');
  if (!frontmatter) return normalizedBody;
  return `${frontmatter}${normalizedBody.replace(/^\n+/, '')}`;
}

function formatBreadcrumb(cwd: string, filePath: string): string {
  const normalizedCwd = cwd.replace(/\\/g, '/').replace(/\/$/, '');
  const normalizedPath = filePath.replace(/\\/g, '/');
  const relativePath = normalizedPath.startsWith(`${normalizedCwd}/`)
    ? normalizedPath.slice(normalizedCwd.length + 1)
    : normalizedPath;
  const parts = relativePath.split('/').filter(Boolean);
  parts.pop();
  if (parts.length === 0) return '';
  return parts.slice(-3).join(' / ');
}

function normalizeAssetSrc(cwd: string, filePath: string, src: string): string {
  const trimmed = src.trim();
  if (!trimmed || /^(https?:|data:|blob:|file:|mailto:)/i.test(trimmed)) return trimmed;

  const normalizedCwd = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedFilePath = filePath.replace(/\\/g, '/');
  const baseParts = normalizedFilePath.split('/');
  baseParts.pop();
  const baseDir = baseParts.join('/');
  const baseDirIsAbsolute = baseDir.startsWith('/') || /^[A-Za-z]:\//.test(baseDir);
  const joined = trimmed.startsWith('/')
    ? trimmed
    : baseDirIsAbsolute
      ? [baseDir, trimmed].filter(Boolean).join('/')
      : [normalizedCwd, baseDir, trimmed].filter(Boolean).join('/');

  try {
    return `file://${encodeURI(joined.replace(/\\/g, '/'))}`;
  } catch {
    return trimmed;
  }
}

function isRemoteOrInlineAssetSrc(src: string): boolean {
  return /^(https?:|data:|blob:|mailto:)/i.test(src.trim());
}

function getFileExtension(fileName: string): string {
  const match = fileName.toLowerCase().match(/\.[^.\\/]+$/);
  return match?.[0] || '';
}

function isSupportedMarkdownImageFile(file: File): boolean {
  const mimeType = file.type.toLowerCase();
  if (mimeType && MARKDOWN_IMAGE_MIME_TYPES.has(mimeType)) return true;
  return MARKDOWN_IMAGE_EXTENSIONS.has(getFileExtension(file.name));
}

function getImageFilesFromTransfer(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) return [];

  const files = Array.from(dataTransfer.files || []).filter(isSupportedMarkdownImageFile);
  if (files.length > 0) return files;

  return Array.from(dataTransfer.items || [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file && isSupportedMarkdownImageFile(file)));
}

function collectOutlineItems(view: ProseEditorView): MarkdownOutlineItem[] {
  const items: MarkdownOutlineItem[] = [];

  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return;
    items.push({
      id: `heading-${pos}`,
      level: typeof node.attrs.level === 'number' ? node.attrs.level : 1,
      text: node.textContent.trim() || 'Untitled',
      pos,
    });
  });

  return items;
}

function scrollHeadingIntoOutlinePosition(
  view: ProseEditorView,
  host: HTMLElement | null,
  headingPos: number
) {
  const scroller = host?.closest<HTMLElement>('.aegis-md-main');
  const node = view.nodeDOM(headingPos);
  const headingElement = node instanceof HTMLElement
    ? node
    : node instanceof Text
      ? node.parentElement
      : null;

  if (!scroller || !headingElement) return;

  const scrollerRect = scroller.getBoundingClientRect();
  const headingRect = headingElement.getBoundingClientRect();
  const topOffset = Math.min(
    OUTLINE_TARGET_MAX_TOP_OFFSET_PX,
    Math.max(OUTLINE_TARGET_MIN_TOP_OFFSET_PX, scroller.clientHeight * OUTLINE_TARGET_VIEWPORT_RATIO)
  );
  const nextScrollTop = scroller.scrollTop + headingRect.top - scrollerRect.top - topOffset;
  const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);

  scroller.scrollTo({
    top: Math.min(maxScrollTop, Math.max(0, nextScrollTop)),
    behavior: 'smooth',
  });
}

const trailingParagraphPlugin = $prose(() => {
  return new Plugin({
    appendTransaction: (_transactions, _oldState, newState) => {
      const lastNode = newState.doc.lastChild;
      if (!lastNode || lastNode.type.name !== 'paragraph') {
        return newState.tr.insert(newState.doc.content.size, newState.schema.nodes.paragraph.create());
      }
      return null;
    },
  });
});

const headingFlashPlugin = $prose(() => {
  return new Plugin<DecorationSet>({
    key: headingFlashKey,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, value) => {
        const meta = tr.getMeta(HEADING_FLASH_META) as
          | { type: 'flash'; pos: number }
          | { type: 'clear' }
          | undefined;

        if (meta?.type === 'clear') return DecorationSet.empty;
        if (meta?.type === 'flash') {
          const node = tr.doc.nodeAt(meta.pos);
          if (!node || node.type.name !== 'heading') return DecorationSet.empty;
          return DecorationSet.create(tr.doc, [
            Decoration.node(meta.pos, meta.pos + node.nodeSize, {
              class: 'aegis-md-heading-flash',
            }),
          ]);
        }

        if (!tr.docChanged) return value;
        return value.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations: (state) => headingFlashKey.getState(state),
    },
  });
});

function createImageView(cwd: string, filePath: string) {
  return $view(imageSchema.node, (): NodeViewConstructor => {
    return (node) => {
      const img = document.createElement('img');
      let loadRequestId = 0;
      let destroyed = false;

      const loadImage = async (src: string) => {
        const requestId = ++loadRequestId;
        const trimmed = src.trim();
        img.removeAttribute('data-error');
        if (!trimmed) {
          img.removeAttribute('src');
          return;
        }
        if (isRemoteOrInlineAssetSrc(trimmed)) {
          img.src = trimmed;
          return;
        }

        const reader = window.electron.readMarkdownImageAsset;
        if (typeof reader === 'function') {
          const result = await reader(cwd, filePath, trimmed);
          if (destroyed || requestId !== loadRequestId) return;
          if (result?.ok && result.dataUrl) {
            img.src = result.dataUrl;
            return;
          }
          img.dataset.error = result?.message || 'Unable to load image.';
          img.removeAttribute('src');
          return;
        }

        img.src = normalizeAssetSrc(cwd, filePath, trimmed);
      };

      img.className = 'aegis-md-image';
      img.alt = String(node.attrs.alt || '');
      img.title = String(node.attrs.title || '');
      void loadImage(String(node.attrs.src || ''));
      return {
        dom: img,
        update: (nextNode: ProseNode) => {
          if (nextNode.type !== node.type) return false;
          img.alt = String(nextNode.attrs.alt || '');
          img.title = String(nextNode.attrs.title || '');
          void loadImage(String(nextNode.attrs.src || ''));
          return true;
        },
        destroy: () => {
          destroyed = true;
          loadRequestId += 1;
        },
        ignoreMutation: () => true,
      };
    };
  });
}

function insertImageIntoView(view: ProseEditorView, src: string, alt: string) {
  const imageNode = view.state.schema.nodes.image;
  if (!imageNode) return;
  const tr = view.state.tr
    .replaceSelectionWith(imageNode.create({ src, alt, title: '' }))
    .scrollIntoView();
  view.dispatch(tr);
  view.focus();
}

function createImageInputPlugin(
  insertFiles: (view: ProseEditorView, files: File[]) => Promise<void>
) {
  return $prose(() => {
    return new Plugin({
      props: {
        handlePaste: (view, event) => {
          const files = getImageFilesFromTransfer(event.clipboardData);
          if (files.length === 0) return false;
          event.preventDefault();
          void insertFiles(view, files);
          return true;
        },
        handleDrop: (view, event, _slice, moved) => {
          if (moved) return false;
          const files = getImageFilesFromTransfer(event.dataTransfer);
          if (files.length === 0) return false;
          event.preventDefault();
          const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
          if (coords) {
            view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(coords.pos))));
          }
          void insertFiles(view, files);
          return true;
        },
      },
    });
  });
}

function nodeIsActive(view: ProseEditorView | null, nodeName: string, attrs?: Record<string, unknown>): boolean {
  if (!view) return false;
  const { $from } = view.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name !== nodeName) continue;
    if (!attrs) return true;
    return Object.entries(attrs).every(([key, value]) => node.attrs[key] === value);
  }
  return false;
}

function markIsActive(view: ProseEditorView | null, markName: string): boolean {
  if (!view) return false;
  const { state } = view;
  const mark = state.schema.marks[markName];
  if (!mark) return false;
  const { from, to, empty } = state.selection;
  if (empty) return Boolean(mark.isInSet(state.storedMarks || state.selection.$from.marks()));
  let active = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (mark.isInSet(node.marks)) active = true;
  });
  return active;
}

function ToolbarButton({
  title,
  active = false,
  disabled = false,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`aegis-md-toolbar-button${active ? ' active' : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(event) => {
        event.preventDefault();
        if (!disabled) onClick();
      }}
    >
      {children}
    </button>
  );
}

export function ProjectMarkdownEditor({
  value,
  cwd,
  filePath,
  fileName,
  hideTitleBar = false,
  saveState,
  saveError,
  externalChange,
  onChange,
  onSave,
  onReloadExternal,
  onKeepLocal,
}: ProjectMarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const viewRef = useRef<ProseEditorView | null>(null);
  const currentFullMarkdownRef = useRef(value);
  const frontmatterRef = useRef(splitFrontmatter(value).frontmatter);
  const outlineItemsRef = useRef<MarkdownOutlineItem[]>([]);
  const headingFlashTimerRef = useRef<number | null>(null);
  const outlineCloseTimerRef = useRef<number | null>(null);
  const [outlineItems, setOutlineItems] = useState<MarkdownOutlineItem[]>([]);
  const [activeOutlineId, setActiveOutlineId] = useState<string | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [editorFocused, setEditorFocused] = useState(false);
  const [, forceToolbarState] = useState(0);
  const breadcrumb = useMemo(() => formatBreadcrumb(cwd, filePath), [cwd, filePath]);

  const runCommand = useCallback(<T,>(key: { id: string } | unknown, payload?: T) => {
    const editor = editorRef.current;
    if (!editor) return false;
    return editor.action((ctx) => ctx.get(commandsCtx).call(key as never, payload as never));
  }, []);

  const focusEditor = useCallback(() => {
    const view = viewRef.current;
    view?.focus();
  }, []);

  const replaceSelectionWithText = useCallback((text: string, from?: number, to?: number) => {
    const view = viewRef.current;
    if (!view) return;
    const selection = view.state.selection;
    const replaceFrom = typeof from === 'number' ? from : selection.from;
    const replaceTo = typeof to === 'number' ? to : selection.to;
    const tr = view.state.tr.insertText(text, replaceFrom, replaceTo);
    const nextPos = Math.min(replaceFrom + text.length, tr.doc.content.size);
    view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(nextPos))).scrollIntoView());
    view.focus();
  }, []);

  const refreshDerivedUi = useCallback((view: ProseEditorView) => {
    const nextOutline = collectOutlineItems(view);
    outlineItemsRef.current = nextOutline;
    setOutlineItems(nextOutline);

    const activeCandidates = nextOutline.filter((item) => item.pos <= view.state.selection.from);
    const active = activeCandidates[activeCandidates.length - 1] || nextOutline[0] || null;
    setActiveOutlineId(active?.id || null);
    forceToolbarState((count) => count + 1);
  }, []);

  const refreshCurrentEditorUi = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    refreshDerivedUi(view);
  }, [refreshDerivedUi]);

  const openOutline = useCallback(() => {
    if (outlineCloseTimerRef.current) {
      window.clearTimeout(outlineCloseTimerRef.current);
      outlineCloseTimerRef.current = null;
    }
    setOutlineOpen(true);
  }, []);

  const queueCloseOutline = useCallback(() => {
    if (outlineCloseTimerRef.current) {
      window.clearTimeout(outlineCloseTimerRef.current);
    }
    outlineCloseTimerRef.current = window.setTimeout(() => {
      setOutlineOpen(false);
      outlineCloseTimerRef.current = null;
    }, 180);
  }, []);

  const toggleBulletList = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const command = nodeIsActive(view, 'bullet_list')
      ? liftListItemCommand.key
      : wrapInBulletListCommand.key;
    runCommand(command);
    window.setTimeout(refreshCurrentEditorUi, 0);
  }, [refreshCurrentEditorUi, runCommand]);

  const toggleOrderedList = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const command = nodeIsActive(view, 'ordered_list')
      ? liftListItemCommand.key
      : wrapInOrderedListCommand.key;
    runCommand(command);
    window.setTimeout(refreshCurrentEditorUi, 0);
  }, [refreshCurrentEditorUi, runCommand]);

  const jumpToOutlineItem = useCallback((item: MarkdownOutlineItem) => {
    const view = viewRef.current;
    if (!view) return;
    const pos = Math.min(item.pos + 1, view.state.doc.content.size);
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.near(view.state.doc.resolve(pos)))
        .setMeta(HEADING_FLASH_META, { type: 'flash', pos: item.pos })
    );
    view.focus();
    window.requestAnimationFrame(() => {
      const currentView = viewRef.current;
      if (currentView) {
        scrollHeadingIntoOutlinePosition(currentView, hostRef.current, item.pos);
      }
    });
    setActiveOutlineId(item.id);

    if (headingFlashTimerRef.current) {
      window.clearTimeout(headingFlashTimerRef.current);
    }
    headingFlashTimerRef.current = window.setTimeout(() => {
      const currentView = viewRef.current;
      if (currentView) {
        currentView.dispatch(currentView.state.tr.setMeta(HEADING_FLASH_META, { type: 'clear' }));
      }
      headingFlashTimerRef.current = null;
    }, 1100);
  }, []);

  const insertImage = useCallback(async () => {
    const result = await window.electron.selectMarkdownImageAsset?.(cwd, filePath);
    if (!result?.ok || !result.relativePath) return;
    runCommand(insertImageCommand.key, {
      src: result.relativePath,
      alt: result.name || 'Image',
      title: '',
    });
    focusEditor();
  }, [cwd, filePath, focusEditor, runCommand]);

  const promptLink = useCallback(() => {
    const href = window.prompt('Link URL');
    if (!href) return;
    runCommand(toggleLinkCommand.key, { href });
    focusEditor();
  }, [focusEditor, runCommand]);

  useEffect(() => {
    const root = hostRef.current;
    if (!root) return;

    const parts = splitFrontmatter(value);
    frontmatterRef.current = parts.frontmatter;
    currentFullMarkdownRef.current = value;
    setEditorFocused(false);
    let disposed = false;

    const insertImageFiles = async (view: ProseEditorView, files: File[]) => {
      const createAsset = window.electron.createMarkdownImageAsset;
      if (typeof createAsset !== 'function') return;

      for (const file of files) {
        try {
          const data = new Uint8Array(await file.arrayBuffer());
          const result = await createAsset(cwd, filePath, file.name || 'image', file.type, data);
          if (!result?.ok || !result.relativePath) continue;
          insertImageIntoView(view, result.relativePath, result.name || file.name || 'Image');
        } catch (error) {
          console.warn('Failed to insert Markdown image asset:', error);
        }
      }
      refreshDerivedUi(view);
    };

    const setup = async () => {
      const editor = await Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, root);
          ctx.set(defaultValueCtx, parts.body);
          const listeners = ctx.get(listenerCtx);
          listeners.markdownUpdated((innerCtx, markdown) => {
            const next = combineFrontmatter(frontmatterRef.current, markdown);
            currentFullMarkdownRef.current = next;
            onChange(next);
            refreshDerivedUi(innerCtx.get(editorViewCtx));
          });
          listeners.focus((innerCtx) => {
            setEditorFocused(true);
            refreshDerivedUi(innerCtx.get(editorViewCtx));
          });
          listeners.blur(() => {
            setEditorFocused(false);
            forceToolbarState((count) => count + 1);
          });
        })
        .use(commonmark)
        .use(gfm)
        .use(history)
        .use(listener)
        .use(createImageInputPlugin(insertImageFiles))
        .use(clipboard)
        .use(trailingParagraphPlugin)
        .use(headingFlashPlugin)
        .use(createImageView(cwd, filePath))
        .use(projectMarkdownCodeBlockView)
        .create();

      if (disposed) {
        await editor.destroy();
        return;
      }

      editorRef.current = editor;
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        viewRef.current = view;
        refreshDerivedUi(view);
      });
    };

    void setup();

    return () => {
      disposed = true;
      const editor = editorRef.current;
      editorRef.current = null;
      viewRef.current = null;
      setEditorFocused(false);
      if (editor) void editor.destroy();
      root.innerHTML = '';
      if (headingFlashTimerRef.current) {
        window.clearTimeout(headingFlashTimerRef.current);
        headingFlashTimerRef.current = null;
      }
    };
  }, [cwd, filePath, refreshDerivedUi]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (value === currentFullMarkdownRef.current) return;

    const parts = splitFrontmatter(value);
    frontmatterRef.current = parts.frontmatter;
    currentFullMarkdownRef.current = value;
    editor.action(replaceAll(parts.body));
    editor.action((ctx) => refreshDerivedUi(ctx.get(editorViewCtx)));
  }, [refreshDerivedUi, value]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        onSave();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onSave]);

  useEffect(() => {
    return () => {
      if (outlineCloseTimerRef.current) {
        window.clearTimeout(outlineCloseTimerRef.current);
      }
    };
  }, []);

  const view = viewRef.current;
  const showActiveFormatting = editorFocused;
  const active = {
    strong: showActiveFormatting && markIsActive(view, 'strong'),
    emphasis: showActiveFormatting && markIsActive(view, 'emphasis'),
    inlineCode: showActiveFormatting && markIsActive(view, 'inlineCode'),
    strike: showActiveFormatting && markIsActive(view, 'strike_through'),
    h1: showActiveFormatting && nodeIsActive(view, 'heading', { level: 1 }),
    h2: showActiveFormatting && nodeIsActive(view, 'heading', { level: 2 }),
    h3: showActiveFormatting && nodeIsActive(view, 'heading', { level: 3 }),
    bullet: showActiveFormatting && nodeIsActive(view, 'bullet_list'),
    ordered: showActiveFormatting && nodeIsActive(view, 'ordered_list'),
    quote: showActiveFormatting && nodeIsActive(view, 'blockquote'),
    codeBlock: showActiveFormatting && nodeIsActive(view, 'code_block'),
  };

  return (
    <div className={`aegis-md-editor${hideTitleBar ? ' title-hidden' : ''}`}>
      {!hideTitleBar && (
        <div className="aegis-md-editor-top drag-region">
          <div className="aegis-md-title-cluster">
            <span className="aegis-md-file-badge" aria-hidden="true">M+</span>
            <div className="aegis-md-title-main">
              <div className="aegis-md-title-line">
                <span className="aegis-md-file-name" title={filePath}>{fileName}</span>
              </div>
              {breadcrumb && <div className="aegis-md-breadcrumb" title={breadcrumb}>{breadcrumb}</div>}
            </div>
          </div>
        </div>
      )}

      <div className="aegis-md-toolbar" aria-label="Markdown formatting toolbar">
        <ToolbarButton title="Undo" onClick={() => { viewRef.current && undo(viewRef.current.state, viewRef.current.dispatch); focusEditor(); }}>
          <Undo2 className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Redo" onClick={() => { viewRef.current && redo(viewRef.current.state, viewRef.current.dispatch); focusEditor(); }}>
          <Redo2 className="h-4 w-4" />
        </ToolbarButton>
        <span className="aegis-md-toolbar-separator" />
        <ToolbarButton title="Bold" active={active.strong} onClick={() => runCommand(toggleStrongCommand.key)}>
          <Bold className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Italic" active={active.emphasis} onClick={() => runCommand(toggleEmphasisCommand.key)}>
          <Italic className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Strikethrough" active={active.strike} onClick={() => runCommand(toggleStrikethroughCommand.key)}>
          <Strikethrough className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Inline code" active={active.inlineCode} onClick={() => runCommand(toggleInlineCodeCommand.key)}>
          <Code className="h-4 w-4" />
        </ToolbarButton>
        <span className="aegis-md-toolbar-separator" />
        <ToolbarButton title="Heading 1" active={active.h1} onClick={() => runCommand(wrapInHeadingCommand.key, 1)}>
          <Heading1 className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Heading 2" active={active.h2} onClick={() => runCommand(wrapInHeadingCommand.key, 2)}>
          <Heading2 className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Heading 3" active={active.h3} onClick={() => runCommand(wrapInHeadingCommand.key, 3)}>
          <Heading3 className="h-4 w-4" />
        </ToolbarButton>
        <span className="aegis-md-toolbar-separator" />
        <ToolbarButton title="Bullet list" active={active.bullet} onClick={toggleBulletList}>
          <List className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Numbered list" active={active.ordered} onClick={toggleOrderedList}>
          <ListOrdered className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Task list" onClick={() => replaceSelectionWithText('- [ ] ')}>
          <CheckSquare className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Quote" active={active.quote} onClick={() => runCommand(wrapInBlockquoteCommand.key)}>
          <Quote className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Code block" active={active.codeBlock} onClick={() => runCommand(createCodeBlockCommand.key)}>
          <Code className="h-4 w-4" />
        </ToolbarButton>
        <span className="aegis-md-toolbar-separator" />
        <ToolbarButton title="Table" onClick={() => runCommand(insertTableCommand.key, { row: 3, col: 3 })}>
          <Table className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Link" onClick={promptLink}>
          <Link className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Image" onClick={() => void insertImage()}>
          <ImageIcon className="h-4 w-4" />
        </ToolbarButton>
      </div>

      {externalChange && (
        <div className="aegis-md-conflict">
          <span>The file changed on disk while this document was open.</span>
          <button type="button" onClick={onReloadExternal}>Reload disk version</button>
          <button type="button" onClick={onKeepLocal}>Keep my edits</button>
        </div>
      )}

      {saveState === 'error' && saveError && (
        <div className="aegis-md-error">{saveError}</div>
      )}

      <div className="aegis-md-main">
        <div className="aegis-md-canvas">
          <div
            ref={hostRef}
            className="aegis-md-milkdown-root"
            onMouseUp={refreshCurrentEditorUi}
            onKeyUp={refreshCurrentEditorUi}
          />
        </div>

        {outlineItems.length > 0 && (
          <aside
            className={`aegis-md-outline${outlineOpen ? ' is-open' : ''}`}
            aria-label="Document outline"
          >
            <button
              type="button"
              className="aegis-md-outline-trigger"
              title="Show outline"
              aria-label="Show outline"
              aria-expanded={outlineOpen}
              onMouseEnter={openOutline}
              onMouseLeave={queueCloseOutline}
              onFocus={openOutline}
              onBlur={queueCloseOutline}
            >
              {outlineItems.map((item) => (
                <span
                  key={`outline-trigger-${item.id}`}
                  className={`level-${item.level}${activeOutlineId === item.id ? ' active' : ''}`}
                />
              ))}
            </button>
            <div
              className="aegis-md-outline-content"
              onMouseEnter={openOutline}
              onMouseLeave={queueCloseOutline}
            >
              <div className="aegis-md-outline-list">
                {outlineItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`level-${item.level}${activeOutlineId === item.id ? ' active' : ''}`}
                    onClick={() => jumpToOutlineItem(item)}
                    title={item.text}
                  >
                    {item.text}
                  </button>
                ))}
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

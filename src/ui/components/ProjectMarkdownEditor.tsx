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
  Save,
  Star,
  Strikethrough,
  Table,
  Undo2,
} from 'lucide-react';
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
  isDirty: boolean;
  saveState: SaveState;
  saveError: string | null;
  lastSavedAt: number | null;
  externalChange: boolean;
  onChange: (next: string) => void;
  onSave: () => void;
  onReloadExternal: () => void;
  onKeepLocal: () => void;
};

const headingFlashKey = new PluginKey<DecorationSet>('aegisMarkdownHeadingFlash');
const HEADING_FLASH_META = 'aegis-markdown-heading-flash';

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

function formatSaveLabel(saveState: SaveState, isDirty: boolean, lastSavedAt: number | null): string {
  if (saveState === 'saving') return 'Saving...';
  if (saveState === 'error') return 'Save failed';
  if (isDirty) return 'Modified';
  if (!lastSavedAt) return 'Saved';

  const seconds = Math.max(1, Math.round((Date.now() - lastSavedAt) / 1000));
  if (seconds < 60) return `Saved ${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `Saved ${minutes}m ago`;
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

  const baseParts = filePath.split(/[\\/]/);
  baseParts.pop();
  const baseDir = baseParts.join('/');
  const joined = trimmed.startsWith('/')
    ? trimmed
    : [cwd.replace(/\/$/, ''), baseDir, trimmed].filter(Boolean).join('/');

  try {
    return `file://${encodeURI(joined.replace(/\\/g, '/'))}`;
  } catch {
    return trimmed;
  }
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
      img.className = 'aegis-md-image';
      img.alt = String(node.attrs.alt || '');
      img.title = String(node.attrs.title || '');
      img.src = normalizeAssetSrc(cwd, filePath, String(node.attrs.src || ''));
      return {
        dom: img,
        update: (nextNode: ProseNode) => {
          if (nextNode.type !== node.type) return false;
          img.alt = String(nextNode.attrs.alt || '');
          img.title = String(nextNode.attrs.title || '');
          img.src = normalizeAssetSrc(cwd, filePath, String(nextNode.attrs.src || ''));
          return true;
        },
      };
    };
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
  isDirty,
  saveState,
  saveError,
  lastSavedAt,
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
  const [outlineItems, setOutlineItems] = useState<MarkdownOutlineItem[]>([]);
  const [activeOutlineId, setActiveOutlineId] = useState<string | null>(null);
  const [, forceToolbarState] = useState(0);
  const saveLabel = formatSaveLabel(saveState, isDirty, lastSavedAt);
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

  const jumpToOutlineItem = useCallback((item: MarkdownOutlineItem) => {
    const view = viewRef.current;
    if (!view) return;
    const pos = Math.min(item.pos + 1, view.state.doc.content.size);
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.near(view.state.doc.resolve(pos)))
        .scrollIntoView()
        .setMeta(HEADING_FLASH_META, { type: 'flash', pos: item.pos })
    );
    view.focus();
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
    let disposed = false;

    const setup = async () => {
      const editor = await Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, root);
          ctx.set(defaultValueCtx, parts.body);
          ctx.get(listenerCtx).markdownUpdated((innerCtx, markdown) => {
            const next = combineFrontmatter(frontmatterRef.current, markdown);
            currentFullMarkdownRef.current = next;
            onChange(next);
            refreshDerivedUi(innerCtx.get(editorViewCtx));
          });
        })
        .use(commonmark)
        .use(gfm)
        .use(history)
        .use(listener)
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
      if (editor) void editor.destroy();
      root.innerHTML = '';
      if (headingFlashTimerRef.current) {
        window.clearTimeout(headingFlashTimerRef.current);
        headingFlashTimerRef.current = null;
      }
    };
  }, [cwd, filePath]);

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

  const view = viewRef.current;
  const active = {
    strong: markIsActive(view, 'strong'),
    emphasis: markIsActive(view, 'emphasis'),
    inlineCode: markIsActive(view, 'inlineCode'),
    strike: markIsActive(view, 'strike_through'),
    h1: nodeIsActive(view, 'heading', { level: 1 }),
    h2: nodeIsActive(view, 'heading', { level: 2 }),
    h3: nodeIsActive(view, 'heading', { level: 3 }),
    bullet: nodeIsActive(view, 'bullet_list'),
    ordered: nodeIsActive(view, 'ordered_list'),
    quote: nodeIsActive(view, 'blockquote'),
    codeBlock: nodeIsActive(view, 'code_block'),
  };

  return (
    <div className="aegis-md-editor">
      <div className="aegis-md-editor-top">
        <div className="aegis-md-title-cluster">
          <span className="aegis-md-file-badge" aria-hidden="true">M+</span>
          <div className="aegis-md-title-main">
            <div className="aegis-md-title-line">
              <span className="aegis-md-file-name" title={filePath}>{fileName}</span>
              <button
                type="button"
                className="aegis-md-favorite-button"
                title="Favorite"
                aria-label="Favorite document"
              >
                <Star className="h-3.5 w-3.5" />
              </button>
            </div>
            {breadcrumb && <div className="aegis-md-breadcrumb" title={breadcrumb}>{breadcrumb}</div>}
          </div>
        </div>
        <div className="aegis-md-save-cluster">
          <span className={`aegis-md-save-state ${isDirty ? 'dirty' : ''}`}>{saveLabel}</span>
          <button
            type="button"
            className="aegis-md-save-button"
            onClick={onSave}
            disabled={saveState === 'saving' || !isDirty}
            title="Save document"
          >
            <Save className="h-4 w-4" />
            Save
          </button>
        </div>
      </div>

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
        <ToolbarButton title="Bullet list" active={active.bullet} onClick={() => runCommand(wrapInBulletListCommand.key)}>
          <List className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Numbered list" active={active.ordered} onClick={() => runCommand(wrapInOrderedListCommand.key)}>
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
          <div ref={hostRef} className="aegis-md-milkdown-root" />
        </div>

        <aside className="aegis-md-outline">
          <div className="aegis-md-outline-title">Outline</div>
          {outlineItems.length === 0 ? (
            <div className="aegis-md-outline-empty">Add headings to build an outline.</div>
          ) : (
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
          )}
        </aside>
      </div>
    </div>
  );
}

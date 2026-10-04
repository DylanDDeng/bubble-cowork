import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Compartment, EditorSelection, EditorState, Prec, StateEffect, StateField, Transaction, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
  type DecorationSet,
} from '@codemirror/view';
import {
  syntaxTree,
  ensureSyntaxTree,
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import {
  defaultKeymap,
  history,
  historyKeymap,
} from '@codemirror/commands';
import {
  ChevronDown,
  ChevronUp,
  Plus,
  X,
} from './icons';
import { toast } from 'sonner';
import { useAppStore } from '../store/useAppStore';
import { OutlineRail } from './OutlineRail';
import { livePreviewMath, MarkdownRenderedWidget } from './markdown-live-preview-widgets';
import { createMediaSourceButton, mediaSourceIsActive, moveThroughMedia, type MediaSourceRange } from './markdown-media-interaction';
import { collectHtmlPreviews, isMarkdownVideo, MarkdownVideoWidget, markdownWikiEmbeds, type VideoPreview } from './markdown-html-preview';
import {
  BulletWidget,
  CalloutTitleWidget,
  calloutLabel,
  findNoteInTree,
  headingSlug,
  isLocalMarkdownLink,
  markdownHighlight,
  markdownWikiLinks,
  noteLinkCandidates,
  parseCalloutHeader,
  parseTableAlignments,
  parseWikiLink,
  renderTableCellText,
  splitTableRow,
  type TableAlignment,
  type TableCellSource,
} from './markdown-obsidian-syntax';
import './markdown-live-preview.css';

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

type MarkdownMetadataFieldKind = 'array' | 'boolean' | 'number' | 'text';

type MarkdownMetadataField = {
  key: string;
  value: string;
  kind: MarkdownMetadataFieldKind;
  items: string[];
  arrayStyle: 'inline' | 'list' | null;
  line: number;
};

type ProjectMarkdownEditorProps = {
  value: string;
  cwd: string;
  filePath: string;
  fileName: string;
  sourceMode?: boolean;
  scrollTarget?: { line: number; token: number } | null;
  hideTitleBar?: boolean;
  windowControlsInset?: boolean;
  saveState: SaveState;
  saveError: string | null;
  onChange: (next: string) => void;
  onSave: () => void;
  onRegisterBridge?: (bridge: ProjectMarkdownEditorBridge | null) => void;
};

export type ProjectMarkdownEditorBridge = {
  flush: () => void;
  isComposing: () => boolean;
  getViewState: () => ProjectEditorViewState | null;
  restoreViewState: (state: ProjectEditorViewState | null | undefined) => void;
};

export type ProjectEditorViewState = {
  selectionFrom: number;
  selectionTo: number;
  scrollTop: number;
};

type PendingLocalMarkdownValue = {
  latestValue: string;
  localValues: Set<string>;
};

type MarkdownToolbarState = {
  strong: boolean;
  emphasis: boolean;
  inlineCode: boolean;
  strike: boolean;
  h1: boolean;
  h2: boolean;
  h3: boolean;
  bullet: boolean;
  ordered: boolean;
  task: boolean;
  quote: boolean;
  codeBlock: boolean;
};

type MarkdownCodeBlock = {
  from: number;
  to: number;
  startLine: number;
  endLine: number;
  language: string;
  code: string;
  terminated: boolean;
};

type MarkdownTableBlock = {
  from: number;
  to: number;
  startLine: number;
  endLine: number;
  rows: string[][];
};

type MarkdownImageMatch = {
  from: number;
  to: number;
  alt: string;
  src: string;
};

type MarkdownFrontmatterBlock = {
  from: number;
  to: number;
  startLine: number;
  endLine: number;
  frontmatter: string;
};

type MeasuredMarkdownWidgetElement = HTMLElement & {
  __aegisMarkdownResizeObserver?: ResizeObserver;
  __aegisMarkdownWidgetDisposed?: boolean;
};

type MarkdownImageSourceResult = { ok: true; src: string } | { ok: false; message: string };

type MarkdownImageSourceCacheEntry = {
  expiresAt: number;
  promise: Promise<MarkdownImageSourceResult>;
  result?: MarkdownImageSourceResult;
};

const updateListenerFacet = EditorView.updateListener;
const markdownFocusEffect = StateEffect.define<boolean>();
const markdownFocusField = StateField.define<boolean>({ create: () => false, update: (value, tr) => tr.effects.find(e => e.is(markdownFocusEffect))?.value ?? value });
const markdownHeadingFlashEffect = StateEffect.define<number | null>();
const markdownPointerSelectingEffect = StateEffect.define<boolean>();
const METADATA_VISIBLE_ROWS = 8;
const OUTLINE_TARGET_MIN_TOP_OFFSET_PX = 72;
const OUTLINE_TARGET_MAX_TOP_OFFSET_PX = 140;
const OUTLINE_TARGET_VIEWPORT_RATIO = 0.16;
const MARKDOWN_SELECTION_AUTOSCROLL_MARGIN_PX = 56;
const MARKDOWN_SELECTION_AUTOSCROLL_MAX_STEP_PX = 42;
const MARKDOWN_SELECTION_AUTOSCROLL_MIN_STEP_PX = 8;
const MARKDOWN_IMAGE_SOURCE_CACHE_TTL_MS = 5 * 60 * 1000;
const MARKDOWN_IMAGE_SOURCE_CACHE_MAX_ENTRIES = 192;
const URL_CANDIDATE_RE = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
const TRAILING_URL_PUNCTUATION_RE = /[.,;:!?，。！？；：、)\]}）】》]+$/u;
const MARKDOWN_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);
const MARKDOWN_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const EMPTY_TOOLBAR_STATE: MarkdownToolbarState = {
  strong: false,
  emphasis: false,
  inlineCode: false,
  strike: false,
  h1: false,
  h2: false,
  h3: false,
  bullet: false,
  ordered: false,
  task: false,
  quote: false,
  codeBlock: false,
};
const markdownImageSourceCache = new Map<string, MarkdownImageSourceCacheEntry>();

type LivePreviewDecorationState = {
  decorations: DecorationSet;
  pointerSelecting: boolean;
};

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

function stripYamlQuote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseYamlArrayItems(value: string): string[] {
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((item) => stripYamlQuote(item.trim()))
    .filter(Boolean);
}

function formatYamlScalar(value: string, kind: MarkdownMetadataFieldKind = 'text'): string {
  const trimmed = value.trim();
  if (kind === 'boolean') return trimmed.toLowerCase() === 'true' ? 'true' : 'false';
  if (kind === 'number' && /^-?\d+(?:\.\d+)?$/.test(trimmed)) return trimmed;
  if (!trimmed) return '""';
  if (/^(true|false|null|~|-?\d|\[|\{)/i.test(trimmed) || /[:#\n]/.test(trimmed)) {
    return JSON.stringify(trimmed);
  }
  return trimmed;
}

function formatYamlInlineArray(items: string[]): string {
  return `[${items.map((item) => JSON.stringify(item.trim())).join(', ')}]`;
}

function detectMetadataKind(value: string, items: string[]): MarkdownMetadataFieldKind {
  const trimmed = value.trim();
  if (items.length > 0 || /^\[[\s\S]*\]$/.test(trimmed)) return 'array';
  if (/^(true|false)$/i.test(trimmed)) return 'boolean';
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return 'number';
  return 'text';
}

function parseMarkdownMetadata(frontmatter: string): MarkdownMetadataField[] {
  if (!frontmatter) return [];
  const lines = frontmatter.replace(/\r\n/g, '\n').split('\n');
  const fields: MarkdownMetadataField[] = [];
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  const contentLines = lines[0]?.trim() === '---' && closingIndex > 0
    ? lines.slice(1, closingIndex)
    : lines;

  contentLines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || /^\s/.test(line)) return;

    const match = /^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/.exec(line);
    if (!match) return;

    const rawValue = match[2] ?? '';
    const listItems: string[] = [];
    if (!rawValue.trim()) {
      for (let nextIndex = index + 1; nextIndex < contentLines.length; nextIndex += 1) {
        const listMatch = /^\s*-\s+(.+)$/.exec(contentLines[nextIndex]);
        if (!listMatch) break;
        listItems.push(stripYamlQuote(listMatch[1]));
      }
    }

    const items = /^\[[\s\S]*\]$/.test(rawValue.trim())
      ? parseYamlArrayItems(rawValue)
      : listItems;
    const kind = detectMetadataKind(rawValue, items);
    const value = kind === 'array' ? items.join(', ') : stripYamlQuote(rawValue);

    fields.push({
      key: match[1],
      value,
      kind,
      items,
      arrayStyle: kind === 'array' ? (rawValue.trim() ? 'inline' : 'list') : null,
      line: index + 2,
    });
  });

  return fields;
}

function updateMarkdownMetadataValue(
  frontmatter: string,
  field: MarkdownMetadataField,
  nextValue: string
): string {
  const lines = frontmatter.replace(/\r\n/g, '\n').split('\n');
  const targetIndex = field.line - 1;
  if (targetIndex <= 0 || targetIndex >= lines.length) return frontmatter;

  const nextLines = [...lines];
  nextLines[targetIndex] = `${field.key}: ${formatYamlScalar(nextValue, field.kind)}`;
  return nextLines.join('\n');
}

function updateMarkdownMetadataArray(
  frontmatter: string,
  field: MarkdownMetadataField,
  nextItems: string[]
): string {
  const lines = frontmatter.replace(/\r\n/g, '\n').split('\n');
  const targetIndex = field.line - 1;
  if (targetIndex <= 0 || targetIndex >= lines.length) return frontmatter;

  const normalizedItems = nextItems.map((item) => item.trim()).filter(Boolean);
  const closingIndex = lines.findIndex((line, index) => index > targetIndex && line.trim() === '---');
  const blockEnd = closingIndex > targetIndex ? closingIndex : lines.length;
  let removeTo = targetIndex + 1;
  while (removeTo < blockEnd && /^\s*-\s+/.test(lines[removeTo])) {
    removeTo += 1;
  }

  const nextLines = [...lines];
  if (field.arrayStyle === 'list') {
    nextLines.splice(
      targetIndex,
      removeTo - targetIndex,
      `${field.key}:`,
      ...normalizedItems.map((item) => `  - ${formatYamlScalar(item)}`)
    );
  } else {
    nextLines.splice(
      targetIndex,
      removeTo - targetIndex,
      `${field.key}: ${formatYamlInlineArray(normalizedItems)}`
    );
  }
  return nextLines.join('\n');
}

function MarkdownMetadataCard({
  fields,
  expanded,
  onToggleExpanded,
  onUpdateValue,
  onUpdateArray,
}: {
  fields: MarkdownMetadataField[];
  expanded: boolean;
  onToggleExpanded: () => void;
  onUpdateValue: (field: MarkdownMetadataField, value: string) => void;
  onUpdateArray: (field: MarkdownMetadataField, items: string[]) => void;
}) {
  const [arrayDrafts, setArrayDrafts] = useState<Record<string, string>>({});
  if (fields.length === 0) return null;

  const visibleFields = expanded ? fields : fields.slice(0, METADATA_VISIBLE_ROWS);
  const hasMore = fields.length > METADATA_VISIBLE_ROWS;

  return (
    <section className="aegis-mdx-metadata-card aegis-md-editor-metadata" aria-label="Metadata">
      <div className="aegis-mdx-metadata-title">Metadata</div>
      <div className="aegis-mdx-metadata-grid">
        {visibleFields.map((field) => (
          <div key={`${field.key}-${field.line}`} className="aegis-mdx-metadata-row">
            <span className="aegis-mdx-metadata-key" title={field.key}>
              {field.key}
            </span>
            {field.kind === 'array' ? (
              <div className="aegis-mdx-metadata-chips" aria-label={field.key}>
                {field.items.map((item, index) => {
                  return (
                    <span
                      key={`${field.key}-${field.line}-${index}`}
                      className="aegis-mdx-metadata-chip aegis-mdx-metadata-chip-editable"
                    >
                      <input
                        value={item}
                        aria-label={`${field.key} ${index + 1}`}
                        onChange={(event) => {
                          const nextItems = [...field.items];
                          nextItems[index] = event.target.value;
                          onUpdateArray(field, nextItems);
                        }}
                      />
                      <button
                        type="button"
                        className="aegis-mdx-metadata-chip-remove"
                        aria-label={`Remove ${item}`}
                        onClick={() => onUpdateArray(field, field.items.filter((_, itemIndex) => itemIndex !== index))}
                      >
                        <X className="h-3 w-3" aria-hidden="true" />
                      </button>
                    </span>
                  );
                })}
                <span className="aegis-mdx-metadata-chip aegis-mdx-metadata-chip-add">
                  <input
                    value={arrayDrafts[`${field.key}-${field.line}`] || ''}
                    placeholder="Add"
                    aria-label={`Add ${field.key}`}
                    onChange={(event) => {
                      const draftKey = `${field.key}-${field.line}`;
                      setArrayDrafts((current) => ({ ...current, [draftKey]: event.target.value }));
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return;
                      event.preventDefault();
                      const draftKey = `${field.key}-${field.line}`;
                      const nextItem = (arrayDrafts[draftKey] || '').trim();
                      if (!nextItem) return;
                      onUpdateArray(field, [...field.items, nextItem]);
                      setArrayDrafts((current) => ({ ...current, [draftKey]: '' }));
                    }}
                  />
                  <button
                    type="button"
                    className="aegis-mdx-metadata-chip-remove"
                    aria-label={`Add ${field.key}`}
                    onClick={() => {
                      const draftKey = `${field.key}-${field.line}`;
                      const nextItem = (arrayDrafts[draftKey] || '').trim();
                      if (!nextItem) return;
                      onUpdateArray(field, [...field.items, nextItem]);
                      setArrayDrafts((current) => ({ ...current, [draftKey]: '' }));
                    }}
                  >
                    <Plus className="h-3 w-3" aria-hidden="true" />
                  </button>
                </span>
              </div>
            ) : field.kind === 'boolean' ? (
              <label className="aegis-mdx-metadata-boolean">
                <input
                  type="checkbox"
                  checked={field.value.trim().toLowerCase() === 'true'}
                  onChange={(event) => onUpdateValue(field, event.target.checked ? 'true' : 'false')}
                />
                <span>{field.value.trim().toLowerCase() === 'true' ? 'true' : 'false'}</span>
              </label>
            ) : (
              <input
                className={`aegis-mdx-metadata-input kind-${field.kind}`}
                type="text"
                inputMode={field.kind === 'number' ? 'decimal' : undefined}
                value={field.value}
                aria-label={field.key}
                onChange={(event) => onUpdateValue(field, event.target.value)}
              />
            )}
          </div>
        ))}
      </div>
      {hasMore ? (
        <button
          type="button"
          className="aegis-mdx-metadata-toggle"
          onClick={onToggleExpanded}
        >
          {expanded ? 'Show less' : 'Show more'}
          {expanded ? (
            <ChevronUp className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      ) : null}
    </section>
  );
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

function getMarkdownImageSourceCacheKey(cwd: string, filePath: string, src: string): string {
  return [
    cwd.replace(/\\/g, '/').replace(/\/+$/, ''),
    filePath.replace(/\\/g, '/'),
    src.trim(),
  ].join('\0');
}

function getMarkdownImageSourceCacheEntry(key: string): MarkdownImageSourceCacheEntry | null {
  const entry = markdownImageSourceCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    markdownImageSourceCache.delete(key);
    return null;
  }
  return entry;
}

function rememberMarkdownImageSourceCacheEntry(
  key: string,
  entry: MarkdownImageSourceCacheEntry
): MarkdownImageSourceCacheEntry {
  markdownImageSourceCache.set(key, entry);
  while (markdownImageSourceCache.size > MARKDOWN_IMAGE_SOURCE_CACHE_MAX_ENTRIES) {
    const oldestKey = markdownImageSourceCache.keys().next().value;
    if (!oldestKey) break;
    markdownImageSourceCache.delete(oldestKey);
  }
  return entry;
}

function getCachedMarkdownImageSource(cwd: string, filePath: string, src: string): MarkdownImageSourceResult | null {
  const key = getMarkdownImageSourceCacheKey(cwd, filePath, src);
  return getMarkdownImageSourceCacheEntry(key)?.result ?? null;
}

async function fetchLocalMarkdownImageSource(
  cwd: string,
  filePath: string,
  src: string
): Promise<MarkdownImageSourceResult> {
  const resolver = window.electron?.resolveMarkdownImageAssetUrl;
  if (typeof resolver === 'function') {
    const result = await resolver(cwd, filePath, src);
    if (result?.ok && result.url) {
      return { ok: true, src: result.url };
    }
    if (!window.electron?.readMarkdownImageAsset) {
      return { ok: false, message: result?.message || 'Unable to load local image.' };
    }
  }

  const reader = window.electron?.readMarkdownImageAsset;
  if (typeof reader === 'function') {
    const result = await reader(cwd, filePath, src);
    if (result?.ok && result.dataUrl) {
      return { ok: true, src: result.dataUrl };
    }
    return { ok: false, message: result?.message || 'Unable to load local image.' };
  }

  return { ok: true, src: normalizeAssetSrc(cwd, filePath, src) };
}

function loadLocalMarkdownImageSource(
  cwd: string,
  filePath: string,
  src: string
): Promise<MarkdownImageSourceResult> {
  const key = getMarkdownImageSourceCacheKey(cwd, filePath, src);
  const cached = getMarkdownImageSourceCacheEntry(key);
  if (cached) return cached.promise;

  const entry: MarkdownImageSourceCacheEntry = {
    expiresAt: Date.now() + MARKDOWN_IMAGE_SOURCE_CACHE_TTL_MS,
    promise: Promise.resolve({ ok: false, message: 'Image load has not started.' }),
  };
  entry.promise = fetchLocalMarkdownImageSource(cwd, filePath, src)
    .then((result) => {
      if (!result.ok) {
        entry.expiresAt = Date.now() + 15_000;
      }
      entry.result = result;
      return result;
    })
    .catch((error) => {
      const result = {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      } satisfies MarkdownImageSourceResult;
      entry.expiresAt = Date.now() + 15_000;
      entry.result = result;
      return result;
    });
  return rememberMarkdownImageSourceCacheEntry(key, entry).promise;
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

function trimMatchedUrl(rawUrl: string): string {
  return rawUrl.replace(TRAILING_URL_PUNCTUATION_RE, '');
}

function normalizeExternalMarkdownUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  const candidate = /^www\./i.test(trimmed) ? `https://${trimmed}` : trimmed;
  if (!/^https?:\/\//i.test(candidate)) return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function findClosestElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function jumpToMarkdownHeading(view: EditorView, heading: string): boolean {
  let decoded = heading;
  try { decoded = decodeURIComponent(heading); } catch { /* keep the raw anchor */ }
  const wanted = headingSlug(decoded);
  for (let i = 1; i <= view.state.doc.lines; i++) {
    const line = view.state.doc.line(i);
    const match = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line.text);
    if (!match || headingSlug(match[1]) !== wanted) continue;
    view.dispatch({ selection: EditorSelection.cursor(line.from), effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
    scrollEditorPositionIntoMainView(view, view.dom, line.from);
    view.focus();
    return true;
  }
  return false;
}

/** Open a wiki or relative Markdown link in the Files panel, or jump within this note. */
function openMarkdownNoteLink(view: EditorView, cwd: string, filePath: string, target: string, heading: string, kind: 'wiki' | 'markdown'): boolean {
  if (!target.trim()) return heading ? jumpToMarkdownHeading(view, heading) : false;
  const candidates = noteLinkCandidates(cwd, filePath, target, kind);
  const { projectTree, openProjectFileInRightPanel } = useAppStore.getState();
  const path = findNoteInTree(projectTree, candidates, target, kind) ?? candidates[0];
  if (!path) return false;
  openProjectFileInRightPanel({ cwd, path });
  return true;
}

function openMarkdownExternalUrl(rawUrl: string): boolean {
  const url = normalizeExternalMarkdownUrl(rawUrl);
  if (!url) return false;

  const opener = window.electron?.openExternalUrl;
  if (typeof opener === 'function') {
    void opener(url)
      .then((result) => {
        if (!result?.ok) {
          toast.error(`Failed to open link: ${result?.message || url}`);
        }
      })
      .catch((error) => {
        toast.error(`Failed to open link: ${error instanceof Error ? error.message : String(error)}`);
      });
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
  return true;
}

function findFrontmatterBlock(state: EditorState): MarkdownFrontmatterBlock | null {
  if (state.doc.lines < 2) return null;
  const firstLine = state.doc.line(1);
  if (firstLine.text.trim() !== '---') return null;

  for (let lineNumber = 2; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    if (line.text.trim() !== '---') continue;
    return {
      from: firstLine.from,
      to: line.to,
      startLine: 1,
      endLine: lineNumber,
      frontmatter: state.sliceDoc(firstLine.from, line.to),
    };
  }
  return null;
}

function frontmatterBlockIsActive(state: EditorState, block: MarkdownFrontmatterBlock): boolean {
  return state.selection.ranges.some((range) => (
    (range.from > block.from && range.from < block.to)
    || (range.to > block.from && range.to < block.to)
    || (!range.empty && range.from <= block.from && range.to >= block.to)
  ));
}

function collectOutlineItemsFromDoc(state: EditorState): MarkdownOutlineItem[] {
  const items: MarkdownOutlineItem[] = [];
  let inFrontmatter = false;
  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    const text = line.text;
    if (lineNumber === 1 && text.trim() === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (text.trim() === '---') inFrontmatter = false;
      continue;
    }
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(text);
    if (!match) continue;
    const rawText = match[2]
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[`*_~]/g, '')
      .trim();
    items.push({
      id: `heading-${line.from}`,
      level: match[1].length,
      text: rawText || 'Untitled',
      pos: line.from,
    });
  }
  return items;
}

function scanCodeBlocks(state: EditorState): MarkdownCodeBlock[] {
  const blocks: MarkdownCodeBlock[] = [];
  let lineNumber = 1;
  while (lineNumber <= state.doc.lines) {
    const line = state.doc.line(lineNumber);
    const open = /^ {0,3}```\s*([A-Za-z0-9_+.-]*)\s*$/.exec(line.text);
    if (!open) {
      lineNumber += 1;
      continue;
    }

    const startLine = lineNumber;
    const startFrom = line.from;
    const language = open[1] || '';
    const codeLines: string[] = [];
    let endLine = -1;
    let to = line.to;
    let scanLine = lineNumber + 1;

    while (scanLine <= state.doc.lines) {
      const nextLine = state.doc.line(scanLine);
      if (/^ {0,3}```\s*$/.test(nextLine.text)) {
        endLine = scanLine;
        to = nextLine.to;
        break;
      }
      codeLines.push(nextLine.text);
      scanLine += 1;
    }

    if (endLine === -1) {
      // Unterminated fence — the normal state while the user is still typing the
      // block (before the closing ``` exists). Treat it as the opening line only
      // so it never swallows / hides the rest of the document, and resume scanning
      // from the next line instead of consuming everything to EOF.
      blocks.push({
        from: startFrom,
        to: line.to,
        startLine,
        endLine: startLine,
        language,
        code: '',
        terminated: false,
      });
      lineNumber = startLine + 1;
      continue;
    }

    blocks.push({
      from: startFrom,
      to,
      startLine,
      endLine,
      language,
      code: codeLines.join('\n'),
      terminated: true,
    });
    lineNumber = endLine + 1;
  }
  return blocks;
}

function parseMarkdownTableRow(text: string): string[] {
  const trimmed = text.trim().replace(/^\||\|$/g, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isMarkdownTableSeparator(text: string): boolean {
  const cells = parseMarkdownTableRow(text);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function scanTableBlocks(state: EditorState): MarkdownTableBlock[] {
  const blocks: MarkdownTableBlock[] = [];
  let lineNumber = 1;
  while (lineNumber < state.doc.lines) {
    const headerLine = state.doc.line(lineNumber);
    const separatorLine = state.doc.line(lineNumber + 1);
    if (!headerLine.text.includes('|') || !isMarkdownTableSeparator(separatorLine.text)) {
      lineNumber += 1;
      continue;
    }

    const rows = [parseMarkdownTableRow(headerLine.text)];
    const startLine = lineNumber;
    let endLine = lineNumber + 1;
    let to = separatorLine.to;
    lineNumber += 2;

    while (lineNumber <= state.doc.lines) {
      const rowLine = state.doc.line(lineNumber);
      if (!rowLine.text.includes('|') || !rowLine.text.trim()) break;
      rows.push(parseMarkdownTableRow(rowLine.text));
      endLine = lineNumber;
      to = rowLine.to;
      lineNumber += 1;
    }

    blocks.push({
      from: headerLine.from,
      to,
      startLine,
      endLine,
      rows,
    });
  }
  return blocks;
}

function isRangeActive(state: EditorState, from: number, to: number): boolean {
  return !!state.field(markdownFocusField, false) && state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

function lineIsActive(state: EditorState, lineFrom: number, lineTo: number): boolean {
  return state.selection.ranges.some((range) => range.from <= lineTo && range.to >= lineFrom);
}

function isMarkdownHorizontalRule(text: string): boolean {
  return /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(text);
}

function selectionTouchesSourceRange(state: EditorState, from: number, to: number): boolean {
  if (!state.field(markdownFocusField, false)) return false;
  return state.selection.ranges.some((range) => {
    if (range.empty) {
      // Edge-inclusive: a bare caret sitting exactly at `to` (the position right
      // after a marker the user just typed, e.g. the closing backtick of `code`)
      // counts as touching the construct, so its markers stay raw until the caret
      // actually leaves — matching Obsidian's live preview and avoiding the reflow
      // that previously jumped the caret away from the just-typed glyph.
      return range.from >= from && range.from <= to;
    }
    return range.from <= to && range.to >= from;
  });
}

function findCodeBlockAt(state: EditorState, pos: number): MarkdownCodeBlock | null {
  return scanCodeBlocks(state).find((block) => pos >= block.from && pos <= block.to) || null;
}

function hasClosingFenceBelow(state: EditorState, lineNumber: number): boolean {
  for (let n = lineNumber + 1; n <= state.doc.lines; n += 1) {
    if (/^ {0,3}```\s*$/.test(state.doc.line(n).text)) return true;
  }
  return false;
}

function findImageInLine(text: string, lineFrom: number): MarkdownImageMatch | null {
  const imageMatch = /!\[([^\]\n]*)\]\(([^)\s]+)\)/.exec(text.trim());
  if (!imageMatch) return null;
  const leading = text.length - text.trimStart().length;
  const matchStart = text.indexOf(imageMatch[0]);
  return {
    from: lineFrom + Math.max(matchStart, leading),
    to: lineFrom + Math.max(matchStart, leading) + imageMatch[0].length,
    alt: imageMatch[1] || '',
    src: imageMatch[2] || '',
  };
}

function replaceRange(view: EditorView, from: number, to: number, insert: string, selectionPos?: number) {
  view.dispatch({
    changes: { from, to, insert },
    selection: EditorSelection.cursor(selectionPos ?? from + insert.length),
    scrollIntoView: true,
  });
  view.focus();
}

function scrollEditorPositionIntoMainView(view: EditorView, host: HTMLElement | null, pos: number) {
  const scroller = host?.closest<HTMLElement>('.aegis-md-main');
  if (!scroller) return;

  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const coords = view.coordsAtPos(pos, 1) || view.coordsAtPos(pos, -1);
      if (!coords) return;
      const scrollerRect = scroller.getBoundingClientRect();
      const topOffset = Math.min(
        OUTLINE_TARGET_MAX_TOP_OFFSET_PX,
        Math.max(OUTLINE_TARGET_MIN_TOP_OFFSET_PX, scroller.clientHeight * OUTLINE_TARGET_VIEWPORT_RATIO)
      );
      const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const nextScrollTop = scroller.scrollTop + coords.top - scrollerRect.top - topOffset;
      scroller.scrollTo({
        top: Math.min(maxScrollTop, Math.max(0, nextScrollTop)),
        behavior: 'auto',
      });
    });
  });
}

function normalizeLineSelection(state: EditorState) {
  const range = state.selection.main;
  return {
    fromLine: state.doc.lineAt(range.from),
    toLine: state.doc.lineAt(range.to),
  };
}

function formatSelectedLines(view: EditorView, formatter: (lineText: string, lineIndex: number) => string) {
  const { state } = view;
  const { fromLine, toLine } = normalizeLineSelection(state);
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  for (let lineNumber = fromLine.number; lineNumber <= toLine.number; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    changes.push({ from: line.from, to: line.to, insert: formatter(line.text, lineNumber - fromLine.number) });
  }
  view.dispatch({ changes, scrollIntoView: true });
  view.focus();
}

function toggleInlineWrap(view: EditorView, markerStart: string, markerEnd = markerStart, placeholder = '') {
  view.dispatch(
    view.state.changeByRange((range) => {
      const selected = view.state.sliceDoc(range.from, range.to);
      const insertText = selected
        ? `${markerStart}${selected}${markerEnd}`
        : `${markerStart}${placeholder}${markerEnd}`;
      const cursor = selected
        ? range.from + insertText.length
        : range.from + markerStart.length + placeholder.length;
      return {
        changes: { from: range.from, to: range.to, insert: insertText },
        range: EditorSelection.cursor(cursor),
      };
    })
  );
  view.focus();
}

function toggleHeading(view: EditorView, level: 1 | 2 | 3) {
  formatSelectedLines(view, (lineText) => {
    const stripped = lineText.replace(/^#{1,6}\s+/, '');
    const current = /^(#{1,6})\s+/.exec(lineText);
    if (current?.[1]?.length === level) return stripped;
    return `${'#'.repeat(level)} ${stripped}`;
  });
}

function toggleLinePrefix(view: EditorView, kind: 'bullet' | 'ordered' | 'task' | 'quote') {
  formatSelectedLines(view, (lineText, index) => {
    const indent = lineText.match(/^\s*/)?.[0] || '';
    const body = lineText
      .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\s*\d+\.\s+/, '')
      .replace(/^\s*>\s+/, '');
    if (kind === 'bullet') return `${indent}- ${body}`;
    if (kind === 'ordered') return `${indent}${index + 1}. ${body}`;
    if (kind === 'task') return `${indent}- [ ] ${body}`;
    return `${indent}> ${body}`;
  });
}

function insertCodeBlock(view: EditorView) {
  const selection = view.state.selection.main;
  const selected = view.state.sliceDoc(selection.from, selection.to);
  const insert = selected ? `\`\`\`\n${selected}\n\`\`\`` : '```\n\n```';
  const cursor = selected ? selection.from + insert.length : selection.from + 4;
  replaceRange(view, selection.from, selection.to, insert, cursor);
}

function insertTable(view: EditorView) {
  const table = '| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |';
  const selection = view.state.selection.main;
  replaceRange(view, selection.from, selection.to, table, selection.from + 2);
}

function insertLink(view: EditorView, href: string) {
  view.dispatch(
    view.state.changeByRange((range) => {
      const selected = view.state.sliceDoc(range.from, range.to) || 'Link';
      const insert = `[${selected}](${href})`;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(range.from + insert.length),
      };
    })
  );
  view.focus();
}

function insertImageMarkdown(view: EditorView, src: string, alt: string) {
  const selection = view.state.selection.main;
  const insert = `![${alt || 'Image'}](${src})`;
  replaceRange(view, selection.from, selection.to, insert);
}

function toggleTaskAt(view: EditorView, from: number, to: number, checked: boolean) {
  view.dispatch({
    changes: { from, to, insert: checked ? '[ ]' : '[x]' },
    selection: EditorSelection.cursor(to),
  });
  view.focus();
}

class TaskCheckboxWidget extends WidgetType {
  constructor(
    private readonly checked: boolean,
    private readonly from: number,
    private readonly to: number
  ) {
    super();
  }

  eq(other: TaskCheckboxWidget) {
    return other.checked === this.checked && other.from === this.from && other.to === this.to;
  }

  toDOM(view: EditorView) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'aegis-cm-task-checkbox';
    input.checked = this.checked;
    input.addEventListener('mousedown', (event) => event.preventDefault());
    input.addEventListener('click', (event) => {
      event.preventDefault();
      toggleTaskAt(view, this.from, this.to, this.checked);
    });
    return input;
  }

  ignoreEvent() {
    return false;
  }
}

abstract class MeasuredBlockWidget extends WidgetType {
  destroy(dom: HTMLElement) {
    destroyMeasuredMarkdownBlock(dom);
  }
}

function requestMarkdownWidgetMeasure(view: EditorView, element?: MeasuredMarkdownWidgetElement) {
  if (!view.dom.isConnected || element?.__aegisMarkdownWidgetDisposed) return;
  view.requestMeasure();
  window.requestAnimationFrame(() => {
    if (view.dom.isConnected && !element?.__aegisMarkdownWidgetDisposed) {
      view.requestMeasure();
    }
  });
}

function createMeasuredMarkdownBlock<K extends keyof HTMLElementTagNameMap>(
  view: EditorView,
  tagName: K,
  className: string,
  sourcePos: number
): HTMLElementTagNameMap[K] & MeasuredMarkdownWidgetElement {
  const element = document.createElement(tagName) as HTMLElementTagNameMap[K] & MeasuredMarkdownWidgetElement;
  element.className = `aegis-cm-block-widget ${className}`;
  element.dataset.sourcePos = String(sourcePos);

  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => requestMarkdownWidgetMeasure(view, element));
    observer.observe(element);
    element.__aegisMarkdownResizeObserver = observer;
  }

  return element;
}

function destroyMeasuredMarkdownBlock(dom: HTMLElement) {
  const element = dom as MeasuredMarkdownWidgetElement;
  element.__aegisMarkdownWidgetDisposed = true;
  element.__aegisMarkdownResizeObserver?.disconnect();
}

class ImagePreviewWidget extends MeasuredBlockWidget {
  constructor(
    private readonly cwd: string,
    private readonly filePath: string,
    private readonly src: string,
    private readonly alt: string,
    private readonly sourcePos: number
  ) {
    super();
  }

  eq(other: ImagePreviewWidget) {
    return other.cwd === this.cwd
      && other.filePath === this.filePath
      && other.src === this.src
      && other.alt === this.alt
      && other.sourcePos === this.sourcePos;
  }

  updateDOM(dom: HTMLElement, _view: EditorView, previous: ImagePreviewWidget) {
    if (this.cwd !== previous.cwd || this.filePath !== previous.filePath || this.src !== previous.src) return false;
    dom.dataset.sourcePos = String(this.sourcePos);
    const img = dom.querySelector('img');
    if (img) { img.alt = this.alt; img.title = this.alt; }
    return true;
  }

  toDOM(view: EditorView) {
    const container = createMeasuredMarkdownBlock(view, 'span', 'aegis-cm-image-widget', this.sourcePos);
    const edit = createMediaSourceButton(view, container, 'image');

    const requestMeasure = () => requestMarkdownWidgetMeasure(view, container);

    const status = document.createElement('span');
    status.className = 'aegis-cm-image-status';
    status.textContent = 'Loading image...';
    container.append(status, edit);

    const showError = (message: string) => {
      if (container.__aegisMarkdownWidgetDisposed) return;
      container.dataset.error = 'true';
      status.textContent = message;
      container.replaceChildren(status, edit);
      requestMeasure();
    };

    const renderImage = (src: string) => {
      if (container.__aegisMarkdownWidgetDisposed) return;
      container.innerHTML = '';
      delete container.dataset.error;
      delete container.dataset.fluid;
      const img = document.createElement('img');
      img.src = src;
      img.alt = this.alt;
      img.title = this.alt;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('load', () => {
        // An SVG with only a viewBox has no intrinsic width, so the fit-content frame collapses it to 0px.
        const frameWidth = container.parentElement?.clientWidth ?? 0;
        if (img.naturalWidth > 0 && frameWidth > 0 && img.clientWidth === 0) {
          container.dataset.fluid = 'true';
        }
        requestMeasure();
      }, { once: true });
      img.addEventListener('error', () => showError('Image failed to load.'));
      container.append(img, edit);
      requestMeasure();
      if (img.complete) {
        requestMeasure();
      }
    };

    const trimmed = this.src.trim();
    if (!trimmed) {
      showError('Missing image path.');
    } else if (isRemoteOrInlineAssetSrc(trimmed)) {
      renderImage(trimmed);
    } else {
      const cached = getCachedMarkdownImageSource(this.cwd, this.filePath, trimmed);
      if (cached?.ok) {
        renderImage(cached.src);
      } else if (cached) {
        showError(cached.message);
      } else {
        void loadLocalMarkdownImageSource(this.cwd, this.filePath, trimmed)
          .then((result) => {
            if (result.ok) {
              renderImage(result.src);
            } else {
              showError(result.message);
            }
          });
      }
    }

    return container;
  }

  ignoreEvent() {
    return true;
  }
}

class CodeBlockPreviewWidget extends MeasuredBlockWidget {
  constructor(
    private readonly language: string,
    private readonly code: string,
    private readonly sourcePos: number
  ) {
    super();
  }

  eq(other: CodeBlockPreviewWidget) {
    return other.language === this.language && other.code === this.code && other.sourcePos === this.sourcePos;
  }

  toDOM(view: EditorView) {
    const wrapper = createMeasuredMarkdownBlock(view, 'div', 'aegis-cm-code-widget', this.sourcePos);
    const frame = document.createElement('div');
    frame.className = 'aegis-cm-code-frame';

    const header = document.createElement('div');
    header.className = 'aegis-cm-code-header';

    const label = document.createElement('span');
    label.className = 'aegis-cm-code-language-label';
    label.textContent = this.language || 'text';
    header.appendChild(label);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'aegis-cm-code-copy';
    button.textContent = 'Copy';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void navigator.clipboard.writeText(this.code).then(() => {
        button.textContent = 'Copied';
        window.setTimeout(() => {
          button.textContent = 'Copy';
        }, 1100);
      });
    });
    header.appendChild(button);
    frame.appendChild(header);

    const body = document.createElement('pre');
    body.className = 'aegis-cm-code-body';
    const code = document.createElement('code');
    code.textContent = this.code || '';
    body.appendChild(code);
    frame.appendChild(body);
    wrapper.appendChild(frame);

    frame.addEventListener('click', () => {
      view.dispatch({
        selection: EditorSelection.cursor(this.sourcePos),
        effects: EditorView.scrollIntoView(this.sourcePos, { y: 'center' }),
      });
      view.focus();
    });
    return wrapper;
  }

  ignoreEvent() {
    return false;
  }
}

class HorizontalRulePreviewWidget extends MeasuredBlockWidget {
  constructor(private readonly sourcePos: number) {
    super();
  }

  eq(other: HorizontalRulePreviewWidget) {
    return other.sourcePos === this.sourcePos;
  }

  toDOM(view: EditorView) {
    const wrapper = createMeasuredMarkdownBlock(
      view,
      'div',
      'aegis-cm-horizontal-rule',
      this.sourcePos
    );
    wrapper.setAttribute('role', 'separator');
    const rule = document.createElement('span');
    rule.className = 'aegis-cm-horizontal-rule-line';
    wrapper.appendChild(rule);
    wrapper.addEventListener('click', () => {
      view.dispatch({ selection: EditorSelection.cursor(this.sourcePos) });
      view.focus();
    });
    return wrapper;
  }

  ignoreEvent() {
    return false;
  }
}

class TablePreviewWidget extends MeasuredBlockWidget {
  constructor(
    private readonly rows: TableCellSource[][],
    private readonly alignments: TableAlignment[],
    private readonly sourcePos: number
  ) {
    super();
  }

  eq(other: TablePreviewWidget) {
    return other.sourcePos === this.sourcePos
      && JSON.stringify(other.rows) === JSON.stringify(this.rows)
      && other.alignments.join() === this.alignments.join();
  }

  toDOM(view: EditorView) {
    const wrapper = createMeasuredMarkdownBlock(view, 'div', 'aegis-cm-table-widget', this.sourcePos);
    const table = document.createElement('table');
    const columns = Math.max(...this.rows.map(row => row.length));
    this.rows.forEach((row, rowIndex) => {
      const tr = document.createElement('tr');
      for (let column = 0; column < columns; column++) {
        const cell = row[column];
        const el = document.createElement(rowIndex === 0 ? 'th' : 'td');
        el.textContent = cell ? renderTableCellText(cell.text) : '';
        const align = this.alignments[column];
        if (align) el.style.textAlign = align;
        // Like Obsidian, clicking a cell puts the caret in that cell's source.
        const target = cell?.from ?? this.sourcePos;
        el.addEventListener('mousedown', (event) => {
          event.preventDefault();
          view.dispatch({ selection: EditorSelection.cursor(target) });
          view.focus();
        });
        tr.appendChild(el);
      }
      table.appendChild(tr);
    });
    wrapper.appendChild(table);
    return wrapper;
  }

  // The cell's mousedown swaps this widget for its source; CodeMirror must
  // not also start a pointer selection on the DOM that was just replaced.
  ignoreEvent(event: Event) {
    return event.type === 'mousedown';
  }
}

class FrontmatterPreviewWidget extends MeasuredBlockWidget {
  private readonly fields: MarkdownMetadataField[];

  constructor(
    private readonly frontmatter: string,
    private readonly editPos: number
  ) {
    super();
    this.fields = parseMarkdownMetadata(frontmatter);
  }

  eq(other: FrontmatterPreviewWidget) {
    return other.frontmatter === this.frontmatter && other.editPos === this.editPos;
  }

  toDOM(view: EditorView) {
    const section = createMeasuredMarkdownBlock(
      view,
      'section',
      'aegis-mdx-metadata-card aegis-md-editor-metadata aegis-cm-frontmatter-widget',
      this.editPos
    );
    section.setAttribute('aria-label', 'Metadata');

    const title = document.createElement('div');
    title.className = 'aegis-mdx-metadata-title';
    title.textContent = 'Metadata';
    section.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'aegis-mdx-metadata-grid';
    section.appendChild(grid);

    this.fields.forEach((field) => {
      const row = document.createElement('div');
      row.className = 'aegis-mdx-metadata-row';

      const key = document.createElement('span');
      key.className = 'aegis-mdx-metadata-key';
      key.title = field.key;
      key.textContent = field.key;
      row.appendChild(key);

      if (field.kind === 'array') {
        const chips = document.createElement('div');
        chips.className = 'aegis-mdx-metadata-chips';
        chips.setAttribute('aria-label', field.key);
        field.items.forEach((item) => {
          const chip = document.createElement('span');
          chip.className = 'aegis-mdx-metadata-chip';
          chip.textContent = item;
          chips.appendChild(chip);
        });
        row.appendChild(chips);
      } else {
        const value = document.createElement('span');
        value.className = `aegis-mdx-metadata-value kind-${field.kind}`;
        value.textContent = field.value;
        row.appendChild(value);
      }

      grid.appendChild(row);
    });

    if (this.fields.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'aegis-mdx-metadata-value';
      empty.textContent = 'No metadata';
      grid.appendChild(empty);
    }

    section.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const pos = Math.min(this.editPos, view.state.doc.length);
      view.dispatch({
        selection: EditorSelection.cursor(pos),
        effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      });
      view.focus();
    });
    return section;
  }

  ignoreEvent() {
    return false;
  }
}

function addHiddenRange(decorations: Array<Range<Decoration>>, from: number, to: number) {
  if (to > from) {
    decorations.push(Decoration.replace({ inclusive: false }).range(from, to));
  }
}

type Range<T> = {
  from: number;
  to: number;
  value: T;
};

function addInlineMarkdownDecorations(
  state: EditorState,
  lineFrom: number,
  lineText: string,
  decorations: Array<Range<Decoration>>,
  activeLine = false
) {
  const markdownLinkRanges: Array<{ from: number; to: number }> = [];
  const heading = /^(#{1,6})\s+/.exec(lineText);
  if (heading) {
    const level = heading[1].length;
    decorations.push(
      Decoration.line({
        class: `aegis-cm-heading-line level-${level} ${activeLine ? 'is-source' : 'is-preview'}`,
      }).range(lineFrom)
    );
    if (!activeLine) {
      addHiddenRange(decorations, lineFrom, lineFrom + heading[0].length);
    }
  }

  const blockquote = /^(\s*>\s?)/.exec(lineText);
  if (blockquote) {
    decorations.push(
      Decoration.line({
        class: `aegis-cm-blockquote-line${activeLine ? ' is-source' : ''}`,
      }).range(lineFrom)
    );
    if (!activeLine) {
      addHiddenRange(decorations, lineFrom, lineFrom + blockquote[0].length);
    }
  }

  const task = /^(\s*[-*+]\s+)(\[[ xX]\])\s+/.exec(lineText);
  if (task && !activeLine) {
    const from = lineFrom + task[1].length;
    decorations.push(
      Decoration.replace({
        widget: new TaskCheckboxWidget(/[xX]/.test(task[2]), from, from + task[2].length),
        inclusive: false,
      }).range(from, from + task[2].length)
    );
  }

  const linkRe = /(?<!!)\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let linkMatch: RegExpExecArray | null;
  while ((linkMatch = linkRe.exec(lineText)) !== null) {
    const full = linkMatch[0];
    const label = linkMatch[1];
    const href = linkMatch[2];
    const start = lineFrom + linkMatch.index;
    const labelStart = start + 1;
    const labelEnd = labelStart + label.length;
    const urlStart = labelEnd + 2;
    const end = start + full.length;
    markdownLinkRanges.push({ from: start, to: end });
    if (selectionTouchesSourceRange(state, start, end)) continue;
    addHiddenRange(decorations, start, labelStart);
    addHiddenRange(decorations, labelEnd, urlStart);
    addHiddenRange(decorations, urlStart, end);
    decorations.push(Decoration.mark({
      class: 'aegis-cm-link',
      attributes: { 'data-aegis-url': href },
    }).range(labelStart, labelEnd));
  }

  const inlineCodeRe = /`([^`\n]*)`/g;
  let codeMatch: RegExpExecArray | null;
  while ((codeMatch = inlineCodeRe.exec(lineText)) !== null) {
    const start = lineFrom + codeMatch.index;
    const contentStart = start + 1;
    const contentEnd = contentStart + codeMatch[1].length;
    if (selectionTouchesSourceRange(state, start, contentEnd + 1)) {
      decorations.push(
        Decoration.mark({ class: 'aegis-cm-inline-code aegis-cm-inline-code-source' })
          .range(start, contentEnd + 1)
      );
      continue;
    }
    addHiddenRange(decorations, start, contentStart);
    addHiddenRange(decorations, contentEnd, contentEnd + 1);
    if (contentEnd > contentStart) {
      decorations.push(Decoration.mark({ class: 'aegis-cm-inline-code' }).range(contentStart, contentEnd));
    }
  }

  const strongRe = /(\*\*|__)([^*\n_]+)\1/g;
  let strongMatch: RegExpExecArray | null;
  while ((strongMatch = strongRe.exec(lineText)) !== null) {
    const marker = strongMatch[1];
    const start = lineFrom + strongMatch.index;
    const contentStart = start + marker.length;
    const contentEnd = contentStart + strongMatch[2].length;
    if (selectionTouchesSourceRange(state, start, contentEnd + marker.length)) continue;
    addHiddenRange(decorations, start, contentStart);
    addHiddenRange(decorations, contentEnd, contentEnd + marker.length);
    decorations.push(Decoration.mark({ class: 'aegis-cm-strong' }).range(contentStart, contentEnd));
  }

  const emphasisRe = /(^|[^\*])\*([^*\n]+)\*/g;
  let emphasisMatch: RegExpExecArray | null;
  while ((emphasisMatch = emphasisRe.exec(lineText)) !== null) {
    const offset = emphasisMatch[1] ? 1 : 0;
    const start = lineFrom + emphasisMatch.index + offset;
    const contentStart = start + 1;
    const contentEnd = contentStart + emphasisMatch[2].length;
    if (selectionTouchesSourceRange(state, start, contentEnd + 1)) continue;
    addHiddenRange(decorations, start, contentStart);
    addHiddenRange(decorations, contentEnd, contentEnd + 1);
    decorations.push(Decoration.mark({ class: 'aegis-cm-emphasis' }).range(contentStart, contentEnd));
  }

  const strikeRe = /~~([^~\n]+)~~/g;
  let strikeMatch: RegExpExecArray | null;
  while ((strikeMatch = strikeRe.exec(lineText)) !== null) {
    const start = lineFrom + strikeMatch.index;
    const contentStart = start + 2;
    const contentEnd = contentStart + strikeMatch[1].length;
    if (selectionTouchesSourceRange(state, start, contentEnd + 2)) continue;
    addHiddenRange(decorations, start, contentStart);
    addHiddenRange(decorations, contentEnd, contentEnd + 2);
    decorations.push(Decoration.mark({ class: 'aegis-cm-strike' }).range(contentStart, contentEnd));
  }

  URL_CANDIDATE_RE.lastIndex = 0;
  let urlMatch: RegExpExecArray | null;
  while ((urlMatch = URL_CANDIDATE_RE.exec(lineText)) !== null) {
    const url = trimMatchedUrl(urlMatch[0]);
    if (!normalizeExternalMarkdownUrl(url)) continue;
    const from = lineFrom + urlMatch.index;
    const to = from + url.length;
    if (markdownLinkRanges.some((range) => from >= range.from && from < range.to)) {
      continue;
    }
    decorations.push(Decoration.mark({
      class: 'aegis-cm-link',
      attributes: { 'data-aegis-url': url },
    }).range(from, to));
  }
}

function buildLivePreviewDecorations(state: EditorState, cwd: string, filePath: string): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];
  const tree = ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state);
  const frontmatter = findFrontmatterBlock(state);
  const focused = !!state.field(markdownFocusField, false);
  const hide = (from: number, to: number) => { if (to > from) decorations.push(Decoration.replace({}).range(from, to)); };
  const mark = (from: number, to: number, className: string, attributes?: Record<string, string>) => { if (to > from) decorations.push(Decoration.mark({ class: className, attributes }).range(from, to)); };
  const line = (pos: number, className: string, attributes?: Record<string, string>) => decorations.push(Decoration.line({ class: className, attributes }).range(state.doc.lineAt(pos).from));
  const html = collectHtmlPreviews(state, tree);
  const quoteDepths = new Map<number, number>();
  const renderedVideos = html.videos.filter(video => video.from >= (frontmatter?.to ?? 0));
  const renderMedia = (from: number, to: number, block: boolean, widget: WidgetType) => {
    // Reuse the preview at the end of its source in both modes. Only the source
    // text toggles, so editing cannot collapse or reload the media.
    const mediaSource = block ? { from, to } : undefined;
    if (mediaSourceIsActive(state, from, to)) {
      decorations.push(Decoration.widget({ block, side: 1, widget, mediaSource }).range(to));
    } else {
      decorations.push(Decoration.replace({ block, widget, mediaSource }).range(from, to));
    }
  };
  const renderVideo = (video: VideoPreview) => {
    const block = !state.sliceDoc(state.doc.lineAt(video.from).from, video.from).trim()
      && !state.sliceDoc(video.to, state.doc.lineAt(video.to).to).trim();
    renderMedia(video.from, video.to, block, new MarkdownVideoWidget(cwd, filePath, video));
  };
  for (const video of renderedVideos) renderVideo(video);
  for (const underline of html.underlines) {
    if (underline.from < (frontmatter?.to ?? 0)) continue;
    if (renderedVideos.some(video => underline.from >= video.from && underline.to <= video.to)) continue;
    mark(underline.openEnd, underline.closeStart, 'bubble-md-underline');
    if (!isRangeActive(state, underline.from, underline.to)) {
      hide(underline.from, underline.openEnd);
      hide(underline.closeStart, underline.to);
    }
  }
  if (frontmatter && !isRangeActive(state, frontmatter.from, frontmatter.to)) {
    decorations.push(Decoration.replace({ block: true, widget: new FrontmatterPreviewWidget(frontmatter.frontmatter, frontmatter.from + 4) }).range(frontmatter.from, frontmatter.to));
  }
  tree.iterate({ enter(ref) {
    const node = ref.node, name = node.name, parent = node.parent;
    if (frontmatter && node.from < frontmatter.to && name !== 'Document') return false;
    if (renderedVideos.some(video => node.from >= video.from && node.to <= video.to)) return false;
    if (/^(ATX|Setext)Heading/.test(name)) {
      line(node.from, `aegis-cm-heading-line level-${name.slice(-1)}`);
    }
    if (name === 'FencedCode') {
      const fences = node.getChildren('CodeMark');
      if (fences.length !== 2) return false;
      const languageNode = node.getChild('CodeInfo');
      const language = languageNode ? state.sliceDoc(languageNode.from, languageNode.to).trim() : '';
      const first = state.doc.lineAt(node.from), last = state.doc.lineAt(node.to);
      for (let i = first.number; i <= last.number; i++) {
        const current = state.doc.line(i);
        line(current.from, `bubble-md-code-line${i === first.number ? ' is-first' : ''}${i === last.number ? ' is-last' : ''}`, i === first.number ? { 'data-language': language } : undefined);
      }
      // Fences remain hidden in live preview; the code itself stays editable.
      hide(first.from, first.to); hide(last.from, last.to);
      return false;
    }
    if (name === 'CodeBlock' || name === 'HTMLBlock') return false;
    if (name === 'Escape' && !isRangeActive(state, node.from, node.to)) {
      hide(node.from, node.from + 1);
      mark(node.from + 1, node.to, 'bubble-md-escaped');
      return false;
    }
    if (name === 'MathBlock' || name === 'MathInline') {
      if (!isRangeActive(state, node.from, node.to)) decorations.push(Decoration.replace({ block: name === 'MathBlock', widget: new MarkdownRenderedWidget(state.sliceDoc(node.from, node.to), node.from, name === 'MathBlock') }).range(node.from, node.to));
      return false;
    }
    if (name === 'WikiEmbed') {
      const [src, label] = state.doc.sliceString(node.from + 3, node.to - 2).split('|');
      if (isMarkdownVideo(src)) renderVideo({ from: node.from, to: node.to, sources: [src.trim()], label: label || src });
      else if (/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(src)) {
        const block = state.doc.lineAt(node.from).text.trim() === state.doc.sliceString(node.from, node.to);
        renderMedia(node.from, node.to, block, new ImagePreviewWidget(cwd, filePath, src.trim(), label || src, node.from));
      }
      return false;
    }
    if (name === 'Image') {
      const url = node.getChild('URL');
      if (url) {
        const src = state.sliceDoc(url.from, url.to).replace(/^<|>$/g, '');
        const alt = state.sliceDoc(node.from, node.to).match(/^!\[([^\]]*)\]/)?.[1] ?? '';
        const only = state.doc.lineAt(node.from).text.trim() === state.sliceDoc(node.from, node.to);
        if (isMarkdownVideo(src)) renderVideo({ from: node.from, to: node.to, sources: [src], label: alt || 'Video preview' });
        else renderMedia(node.from, node.to, only, new ImagePreviewWidget(cwd, filePath, src, alt, node.from));
      }
      return false;
    }
    if (name === 'Table') {
      // Like Obsidian: an aligned table until the caret enters it, then the
      // raw rows. Tables nested in quotes or lists keep their source.
      const first = state.doc.lineAt(node.from), last = state.doc.lineAt(node.to);
      const standalone = !state.sliceDoc(first.from, node.from).trim();
      if (!standalone || isRangeActive(state, node.from, node.to)) {
        for (let i = first.number; i <= last.number; i++) line(state.doc.line(i).from, 'bubble-md-table-source');
        return;
      }
      const rows: TableCellSource[][] = [];
      let alignments: TableAlignment[] = [];
      for (let i = first.number; i <= last.number; i++) {
        const current = state.doc.line(i);
        if (i === first.number + 1) alignments = parseTableAlignments(current.text);
        else rows.push(splitTableRow(current.text, current.from));
      }
      decorations.push(Decoration.replace({ block: true, widget: new TablePreviewWidget(rows, alignments, first.from) }).range(first.from, last.to));
      return false;
    }
    if (name === 'HorizontalRule') { line(node.from, 'bubble-md-horizontal-rule'); hide(node.from, node.to); return false; }
    if (name === 'Blockquote' && parent?.name !== 'Blockquote') {
      const first = state.doc.lineAt(node.from), last = state.doc.lineAt(node.to);
      const callout = parseCalloutHeader(first.text);
      for (let i = first.number; i <= last.number; i++) {
        const className = callout
          ? `aegis-cm-blockquote-line bubble-md-callout${i === first.number ? ' is-callout-title' : ''}${i === last.number ? ' is-callout-last' : ''}`
          : 'aegis-cm-blockquote-line';
        line(state.doc.line(i).from, className, callout ? { 'data-callout': callout.type } : undefined);
      }
      if (callout && !(focused && lineIsActive(state, first.from, first.to))) {
        const from = first.from + callout.markerFrom, to = first.from + callout.markerTo;
        if (callout.title) hide(from, to);
        else decorations.push(Decoration.replace({ widget: new CalloutTitleWidget(calloutLabel(callout.type)) }).range(from, to));
      }
    }
    if ((name === 'BulletList' || name === 'OrderedList') && parent?.name !== 'ListItem') {
      for (let i = state.doc.lineAt(node.from).number; i <= state.doc.lineAt(node.to).number; i++) line(state.doc.line(i).from, 'bubble-md-list-line');
    }
    if (name === 'ListMark' && parent?.name === 'ListItem') {
      // Obsidian draws `-` as a dot and drops it before a checkbox; the
      // marker returns while the caret touches it.
      const to = node.to + (state.sliceDoc(node.to, node.to + 1) === ' ' ? 1 : 0);
      const active = focused && state.selection.ranges.some(range => range.from <= to && range.to >= node.from);
      if (!active) {
        if (parent.getChild('Task')) hide(node.from, to);
        else if (parent.parent?.name === 'BulletList') decorations.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
      }
    }
    if (name === 'QuoteMark') {
      let depth = 0;
      for (let ancestor = parent; ancestor; ancestor = ancestor.parent) if (ancestor.name === 'Blockquote') depth++;
      const quoteLine = state.doc.lineAt(node.from);
      quoteDepths.set(quoteLine.from, Math.max(quoteDepths.get(quoteLine.from) ?? 0, depth));
      // Every level hides its `>` unless the caret is on that line.
      if (!(focused && lineIsActive(state, quoteLine.from, quoteLine.to))) {
        hide(node.from, node.to + (/\s/.test(state.sliceDoc(node.to, node.to + 1)) ? 1 : 0));
      }
    }
    if (name === 'Highlight') mark(node.from, node.to, 'bubble-md-highlight');
    if (name === 'WikiLink') {
      const parts = parseWikiLink(state.sliceDoc(node.from, node.to), node.from);
      if (parts) {
        mark(parts.labelFrom, parts.labelTo, 'aegis-cm-link bubble-md-wikilink', {
          'data-aegis-wiki-target': parts.target,
          'data-aegis-wiki-heading': parts.heading,
        });
        if (!isRangeActive(state, node.from, node.to)) {
          hide(node.from, parts.labelFrom);
          hide(parts.labelTo, node.to);
        }
      }
      return false;
    }
    if (name === 'TaskMarker' && !isRangeActive(state, node.from, node.to)) decorations.push(Decoration.replace({ widget: new TaskCheckboxWidget(/x/i.test(state.sliceDoc(node.from, node.to)), node.from, node.to) }).range(node.from, node.to));
    const styles: Record<string, string> = { StrongEmphasis: 'aegis-cm-strong', Emphasis: 'aegis-cm-emphasis', Strikethrough: 'aegis-cm-strike', InlineCode: 'aegis-cm-inline-code' };
    if (styles[name]) mark(node.from, node.to, styles[name]);
    if (name === 'Link' || name === 'Autolink') {
      const url = node.getChild('URL');
      if (url) mark(node.from, node.to, 'aegis-cm-link', { 'data-aegis-url': state.sliceDoc(url.from, url.to) });
    }
    if (name === 'URL' && parent?.name !== 'Link' && parent?.name !== 'Autolink') {
      mark(node.from, node.to, 'aegis-cm-link', { 'data-aegis-url': state.sliceDoc(node.from, node.to) });
    }
    const marker = name === 'HeaderMark' || name === 'EmphasisMark' || name === 'StrikethroughMark' || name === 'HighlightMark' || (name === 'CodeMark' && parent?.name === 'InlineCode') || ((name === 'LinkMark' || name === 'URL') && parent?.name === 'Link' && !parent.getChild('LinkTitle')) || (name === 'LinkMark' && parent?.name === 'Autolink');
    if (marker && parent) {
      const to = node.to + (name === 'HeaderMark' && state.sliceDoc(node.to, node.to + 1) === ' ' ? 1 : 0);
      // Like Obsidian, a heading shows its `#` while the caret is on it.
      const active = focused && state.selection.ranges.some(range => name === 'HeaderMark'
        ? range.from <= parent.to && range.to >= parent.from
        : range.from < parent.to && range.to > parent.from);
      if (!active) hide(node.from, to);
    }
  } });
  for (const [lineFrom, depth] of quoteDepths) {
    if (depth > 1) line(lineFrom, 'aegis-cm-blockquote-nested', { style: `--quote-depth: ${depth}` });
  }
  const flashPos = state.field(headingFlashField, false);
  if (typeof flashPos === 'number') line(Math.min(flashPos, state.doc.length), 'aegis-cm-heading-flash');
  return Decoration.set(decorations, true);
}

const headingFlashField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(markdownHeadingFlashEffect)) return effect.value;
    }
    return value;
  },
});

function createLivePreviewDecorationsField(cwd: string, filePath: string): StateField<LivePreviewDecorationState> {
  return StateField.define<LivePreviewDecorationState>({
    create(state) {
      return {
        decorations: buildLivePreviewDecorations(state, cwd, filePath),
        pointerSelecting: false,
      };
    },
    update(value, transaction) {
      const pointerSelectingEffect = transaction.effects.find((effect) => effect.is(markdownPointerSelectingEffect));
      const nextPointerSelecting = pointerSelectingEffect
        ? pointerSelectingEffect.value
        : value.pointerSelecting;

      if (nextPointerSelecting) {
        return {
          decorations: transaction.docChanged
            ? buildLivePreviewDecorations(transaction.state, cwd, filePath)
            : value.decorations.map(transaction.changes),
          pointerSelecting: true,
        };
      }

      if (value.pointerSelecting !== nextPointerSelecting) {
        return {
          decorations: buildLivePreviewDecorations(transaction.state, cwd, filePath),
          pointerSelecting: false,
        };
      }

      const shouldRebuild = transaction.docChanged
        || transaction.selection
        || transaction.effects.some((effect) => effect.is(markdownHeadingFlashEffect) || effect.is(markdownFocusEffect));
      if (shouldRebuild) {
        return {
          decorations: buildLivePreviewDecorations(transaction.state, cwd, filePath),
          pointerSelecting: false,
        };
      }
      return {
        decorations: value.decorations.map(transaction.changes),
        pointerSelecting: false,
      };
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  });
}

class PointerStablePreviewPlugin {
  private selecting = false;
  private selectionAnchor: number | null = null;
  private pointerClientX = 0;
  private pointerClientY = 0;
  private autoscrollFrame: number | null = null;
  private readonly abortController = new AbortController();

  constructor(private readonly view: EditorView) {
    const doc = view.dom.ownerDocument;
    const win = doc.defaultView;
    const listenerOptions = { signal: this.abortController.signal };
    doc.addEventListener('mousemove', this.handleDocumentMouseMove, listenerOptions);
    doc.addEventListener('mouseup', this.endPointerSelection, listenerOptions);
    doc.addEventListener('pointerup', this.endPointerSelection, listenerOptions);
    doc.addEventListener('pointercancel', this.endPointerSelection, listenerOptions);
    doc.addEventListener('touchmove', this.handleDocumentTouchMove, listenerOptions);
    doc.addEventListener('touchend', this.endPointerSelection, listenerOptions);
    doc.addEventListener('touchcancel', this.endPointerSelection, listenerOptions);
    win?.addEventListener('blur', this.endPointerSelection, listenerOptions);
  }

  startMouseSelection(event: MouseEvent) {
    if (event.button !== 0) return false;
    this.startPointerSelection(event.clientX, event.clientY);
    return false;
  }

  startTouchSelection(event: TouchEvent) {
    const touch = event.touches[0] || event.changedTouches[0];
    if (touch) {
      this.startPointerSelection(touch.clientX, touch.clientY);
    }
    return false;
  }

  endLocalPointerSelection() {
    this.endPointerSelection();
    return false;
  }

  destroy() {
    this.selecting = false;
    this.selectionAnchor = null;
    this.cancelAutoscroll();
    this.abortController.abort();
  }

  private startPointerSelection(clientX: number, clientY: number) {
    this.pointerClientX = clientX;
    this.pointerClientY = clientY;
    this.selectionAnchor = this.view.posAtCoords({ x: clientX, y: clientY }, false);
    if (this.selecting) return;
    this.selecting = true;
    this.view.dispatch({ effects: markdownPointerSelectingEffect.of(true) });
    this.requestAutoscrollFrame();
  }

  private endPointerSelection = () => {
    if (!this.selecting) return;
    this.selecting = false;
    this.selectionAnchor = null;
    this.cancelAutoscroll();
    const selection = this.view.state.selection.main;
    const scroller = this.view.dom.closest<HTMLElement>('.aegis-md-main');
    const before = selection.empty ? this.view.coordsAtPos(selection.head)?.top : undefined;
    this.view.dispatch({ effects: markdownPointerSelectingEffect.of(false) });
    // Revealing/hiding a media source row above the clicked paragraph must not
    // pull that paragraph out from underneath the mouse on pointer release.
    if (scroller && before !== undefined) this.view.requestMeasure({
      key: this,
      read: view => view.state.selection.main.eq(selection) ? view.coordsAtPos(selection.head)?.top : undefined,
      write: after => {
        if (after !== undefined && Math.abs(after - before) > 1) scroller.scrollTop += after - before;
      },
    });
  };

  private handleDocumentMouseMove = (event: MouseEvent) => {
    if (!this.selecting) return;
    if (event.buttons === 0) {
      this.endPointerSelection();
      return;
    }
    this.pointerClientX = event.clientX;
    this.pointerClientY = event.clientY;
    this.requestAutoscrollFrame();
  };

  private handleDocumentTouchMove = (event: TouchEvent) => {
    if (!this.selecting) return;
    const touch = event.touches[0] || event.changedTouches[0];
    if (!touch) return;
    this.pointerClientX = touch.clientX;
    this.pointerClientY = touch.clientY;
    this.requestAutoscrollFrame();
  };

  private requestAutoscrollFrame() {
    if (this.autoscrollFrame !== null) return;
    const win = this.view.dom.ownerDocument.defaultView;
    if (!win) return;
    this.autoscrollFrame = win.requestAnimationFrame(this.runAutoscroll);
  }

  private cancelAutoscroll() {
    if (this.autoscrollFrame === null) return;
    const win = this.view.dom.ownerDocument.defaultView;
    if (win) {
      win.cancelAnimationFrame(this.autoscrollFrame);
    }
    this.autoscrollFrame = null;
  }

  private runAutoscroll = () => {
    this.autoscrollFrame = null;
    if (!this.selecting) return;

    const scroller = this.view.dom.closest<HTMLElement>('.aegis-md-main');
    if (!scroller) return;

    const rect = scroller.getBoundingClientRect();
    const delta = this.getVerticalAutoscrollDelta(rect);
    if (delta === 0) return;

    const previousScrollTop = scroller.scrollTop;
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = Math.min(maxScrollTop, Math.max(0, previousScrollTop + delta));

    if (scroller.scrollTop !== previousScrollTop) {
      this.extendSelectionToPointer();
      this.requestAutoscrollFrame();
    }
  };

  private getVerticalAutoscrollDelta(rect: DOMRect) {
    const { pointerClientY } = this;
    if (pointerClientY < rect.top + MARKDOWN_SELECTION_AUTOSCROLL_MARGIN_PX) {
      const distance = rect.top + MARKDOWN_SELECTION_AUTOSCROLL_MARGIN_PX - pointerClientY;
      return -this.getAutoscrollStep(distance);
    }
    if (pointerClientY > rect.bottom - MARKDOWN_SELECTION_AUTOSCROLL_MARGIN_PX) {
      const distance = pointerClientY - (rect.bottom - MARKDOWN_SELECTION_AUTOSCROLL_MARGIN_PX);
      return this.getAutoscrollStep(distance);
    }
    return 0;
  }

  private getAutoscrollStep(distance: number) {
    return Math.min(
      MARKDOWN_SELECTION_AUTOSCROLL_MAX_STEP_PX,
      Math.max(MARKDOWN_SELECTION_AUTOSCROLL_MIN_STEP_PX, Math.ceil(distance * 0.62))
    );
  }

  private extendSelectionToPointer() {
    if (this.selectionAnchor === null) return;
    const head = this.view.posAtCoords(
      { x: this.pointerClientX, y: this.pointerClientY },
      false
    );
    this.view.dispatch({
      selection: EditorSelection.range(this.selectionAnchor, head),
      annotations: Transaction.userEvent.of('select.pointer'),
    });
  }
}

function createPointerStablePreviewExtension(): Extension {
  return ViewPlugin.fromClass(PointerStablePreviewPlugin, {
    eventHandlers: {
      mousedown(event) {
        return this.startMouseSelection(event);
      },
      mouseup() {
        return this.endLocalPointerSelection();
      },
      touchstart(event) {
        return this.startTouchSelection(event);
      },
      touchend() {
        return this.endLocalPointerSelection();
      },
      touchcancel() {
        return this.endLocalPointerSelection();
      },
    },
  });
}

function createLivePreviewExtension(cwd: string, filePath: string): Extension {
  const previews = createLivePreviewDecorationsField(cwd, filePath);
  const moveMedia = (view: EditorView, forward: boolean) => {
    const media: MediaSourceRange[] = [];
    const decorations = view.state.field(previews).decorations;
    for (let cursor = decorations.iter(); cursor.value; cursor.next()) {
      if (cursor.value.spec.mediaSource) media.push(cursor.value.spec.mediaSource);
    }
    return moveThroughMedia(view, forward, media);
  };
  return [
    headingFlashField,
    markdownFocusField,
    EditorView.focusChangeEffect.of((_view, focused) => markdownFocusEffect.of(focused)),
    previews,
    Prec.high(keymap.of([
      { key: 'ArrowDown', run: view => moveMedia(view, true) },
      { key: 'ArrowUp', run: view => moveMedia(view, false) },
    ])),
    createPointerStablePreviewExtension(),
    EditorView.domEventHandlers({
      click: (event, view) => {
        const element = findClosestElement(event.target);
        const wiki = element?.closest<HTMLElement>('[data-aegis-wiki-target]');
        const link = wiki ? null : element?.closest<HTMLElement>('[data-aegis-url]');
        let handled = false;
        if (wiki) {
          handled = openMarkdownNoteLink(view, cwd, filePath, wiki.dataset.aegisWikiTarget || '', wiki.dataset.aegisWikiHeading || '', 'wiki');
        } else if (link?.dataset.aegisUrl) {
          const href = link.dataset.aegisUrl;
          const hashIndex = href.indexOf('#');
          handled = openMarkdownExternalUrl(href)
            || (href.startsWith('#') && openMarkdownNoteLink(view, cwd, filePath, '', href.slice(1), 'markdown'))
            || (isLocalMarkdownLink(href) && openMarkdownNoteLink(
              view, cwd, filePath,
              hashIndex >= 0 ? href.slice(0, hashIndex) : href,
              hashIndex >= 0 ? href.slice(hashIndex + 1) : '',
              'markdown'
            ));
        }
        if (!handled) return false;
        event.preventDefault();
        event.stopPropagation();
        return true;
      },
    }),
  ];
}

function createImageInputExtension(
  insertFiles: (view: EditorView, files: File[]) => Promise<void>
): Extension {
  return EditorView.domEventHandlers({
    paste: (event, view) => {
      const files = getImageFilesFromTransfer(event.clipboardData);
      if (files.length === 0) return false;
      event.preventDefault();
      void insertFiles(view, files);
      return true;
    },
    drop: (event, view) => {
      const files = getImageFilesFromTransfer(event.dataTransfer);
      if (files.length === 0) return false;
      event.preventDefault();
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (typeof pos === 'number') {
        view.dispatch({ selection: EditorSelection.cursor(pos) });
      }
      void insertFiles(view, files);
      return true;
    },
    compositionstart: () => false,
    compositionend: () => false,
  });
}

function createMarkdownInputPairsExtension(): Extension {
  return EditorView.inputHandler.of((view, from, to, text) => {
    if (text !== '`') return false;
    const line = view.state.doc.lineAt(from);
    const beforeCursor = view.state.sliceDoc(line.from, from);
    const afterCursor = view.state.sliceDoc(to, line.to);

    if (
      from === to
      && /^(\s*)``$/.test(beforeCursor)
      && afterCursor.trim() === ''
    ) {
      const indent = /^(\s*)/.exec(beforeCursor)?.[1] || '';
      const insert = `${indent}\`\`\`\n${indent}\n${indent}\`\`\``;
      view.dispatch({
        changes: { from: line.from, to: line.to, insert },
        selection: EditorSelection.cursor(line.from + `${indent}\`\`\`\n${indent}`.length),
        annotations: Transaction.userEvent.of('input.type'),
      });
      return true;
    }

    if (from === to && view.state.sliceDoc(to, to + 1) === '`') {
      view.dispatch({
        selection: EditorSelection.cursor(to + 1),
        scrollIntoView: true,
        annotations: Transaction.userEvent.of('select'),
      });
      return true;
    }

    const selected = view.state.sliceDoc(from, to);
    if (!selected) {
      view.dispatch({
        changes: { from, to, insert: '``' },
        selection: EditorSelection.cursor(from + 1),
        annotations: Transaction.userEvent.of('input.type'),
      });
      return true;
    }
    if (selected.includes('\n')) return false;
    const insert = `\`${selected}\``;
    view.dispatch({
      changes: { from, to, insert },
      selection: EditorSelection.cursor(from + insert.length),
      annotations: Transaction.userEvent.of('input.type'),
    });
    return true;
  });
}

function createMarkdownShortcuts(onSave: () => void): Extension {
  return keymap.of([
    {
      key: 'Mod-s',
      run: () => {
        onSave();
        return true;
      },
      preventDefault: true,
    },
    {
      key: 'Mod-b',
      run: (view) => {
        toggleInlineWrap(view, '**', '**', 'bold');
        return true;
      },
      preventDefault: true,
    },
    {
      key: 'Mod-i',
      run: (view) => {
        toggleInlineWrap(view, '*', '*', 'italic');
        return true;
      },
      preventDefault: true,
    },
    {
      key: 'Enter',
      run: (view) => {
        const { state } = view;
        const selection = state.selection.main;
        if (!selection.empty) return false;
        const line = state.doc.lineAt(selection.from);
        const beforeCursor = state.sliceDoc(line.from, selection.from);

        const fence = /^(\s*)```([A-Za-z0-9_+.-]*)$/.exec(beforeCursor);
        if (fence && selection.from === line.to && !hasClosingFenceBelow(state, line.number)) {
          const indent = fence[1] || '';
          const language = fence[2] || '';
          const replacement = `${indent}\`\`\`${language}\n${indent}\n${indent}\`\`\``;
          replaceRange(view, line.from, line.to, replacement, line.from + `${indent}\`\`\`${language}\n${indent}`.length);
          return true;
        }

        const task = /^(\s*[-*+]\s+\[[ xX]\]\s*)(.*)$/.exec(line.text);
        if (task) {
          if (!task[2].trim()) {
            replaceRange(view, line.from, line.to, '');
            return true;
          }
          replaceRange(view, selection.from, selection.from, `\n${task[1].replace(/\[[xX]\]/, '[ ]')}`);
          return true;
        }

        const bullet = /^(\s*[-*+]\s+)(.*)$/.exec(line.text);
        if (bullet) {
          if (!bullet[2].trim()) {
            replaceRange(view, line.from, line.to, '');
            return true;
          }
          replaceRange(view, selection.from, selection.from, `\n${bullet[1]}`);
          return true;
        }

        const ordered = /^(\s*)(\d+)\.\s+(.*)$/.exec(line.text);
        if (ordered) {
          if (!ordered[3].trim()) {
            replaceRange(view, line.from, line.to, '');
            return true;
          }
          replaceRange(view, selection.from, selection.from, `\n${ordered[1]}${Number(ordered[2]) + 1}. `);
          return true;
        }

        const quote = /^(\s*>\s+)(.*)$/.exec(line.text);
        if (quote) {
          if (!quote[2].trim()) {
            replaceRange(view, line.from, line.to, '');
            return true;
          }
          replaceRange(view, selection.from, selection.from, `\n${quote[1]}`);
          return true;
        }
        return false;
      },
    },
    {
      key: 'Backspace',
      run: (view) => {
        const { state } = view;
        const selection = state.selection.main;
        if (!selection.empty) return false;
        const line = state.doc.lineAt(selection.from);
        if (selection.from !== line.to) return false;
        if (/^\s*(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s+|[-*+]\s+\[[ xX]\]\s+)$/.test(line.text)) {
          replaceRange(view, line.from, line.to, '');
          return true;
        }
        return false;
      },
    },
    {
      key: 'Tab',
      run: (view) => {
        const { state } = view;
        view.dispatch(
          state.changeByRange((range) => {
            const fromLine = state.doc.lineAt(range.from);
            const toLine = state.doc.lineAt(range.to);
            const changes: Array<{ from: number; insert: string }> = [];
            for (let lineNumber = fromLine.number; lineNumber <= toLine.number; lineNumber += 1) {
              const line = state.doc.line(lineNumber);
              changes.push({ from: line.from, insert: '  ' });
            }
            return { changes, range: EditorSelection.range(range.from + 2, range.to + (changes.length * 2)) };
          })
        );
        return true;
      },
      preventDefault: true,
    },
    {
      key: 'Shift-Tab',
      run: (view) => {
        const { state } = view;
        const { fromLine, toLine } = normalizeLineSelection(state);
        const changes: Array<{ from: number; to: number; insert: string }> = [];
        for (let lineNumber = fromLine.number; lineNumber <= toLine.number; lineNumber += 1) {
          const line = state.doc.line(lineNumber);
          const leading = /^ {1,2}/.exec(line.text);
          if (leading) {
            changes.push({ from: line.from, to: line.from + leading[0].length, insert: '' });
          }
        }
        if (changes.length === 0) return false;
        view.dispatch({ changes });
        return true;
      },
      preventDefault: true,
    },
    ...historyKeymap,
    ...defaultKeymap,
  ]);
}

function deriveToolbarState(view: EditorView | null): MarkdownToolbarState {
  if (!view) return EMPTY_TOOLBAR_STATE;
  const line = view.state.doc.lineAt(view.state.selection.main.from);
  const text = line.text;
  const codeBlock = Boolean(findCodeBlockAt(view.state, view.state.selection.main.from));
  return {
    strong: /\*\*[^*]+\*\*/.test(text) || /__[^_]+__/.test(text),
    emphasis: /(^|[^\*])\*[^*\n]+\*/.test(text),
    inlineCode: /`[^`\n]+`/.test(text),
    strike: /~~[^~]+~~/.test(text),
    h1: /^#\s+/.test(text),
    h2: /^##\s+/.test(text),
    h3: /^###\s+/.test(text),
    bullet: /^\s*[-*+]\s+/.test(text) && !/^\s*[-*+]\s+\[[ xX]\]\s+/.test(text),
    ordered: /^\s*\d+\.\s+/.test(text),
    task: /^\s*[-*+]\s+\[[ xX]\]\s+/.test(text),
    quote: /^\s*>\s+/.test(text),
    codeBlock,
  };
}

export function ProjectMarkdownEditor({
  value,
  cwd,
  filePath,
  fileName,
  sourceMode = false,
  scrollTarget,
  hideTitleBar = false,
  windowControlsInset = false,
  saveState,
  saveError,
  onChange,
  onSave,
  onRegisterBridge,
}: ProjectMarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const currentFullMarkdownRef = useRef(value);
  const pendingLocalValueRef = useRef<PendingLocalMarkdownValue | null>(null);
  const onSaveRef = useRef(onSave);
  const applyingPropValueRef = useRef(false);
  const composingInputRef = useRef(false);
  const composingMarkdownRef = useRef<string | null>(null);
  const compositionFlushTimerRef = useRef<number | null>(null);
  const headingFlashTimerRef = useRef<number | null>(null);
  const previewCompartment = useRef(new Compartment());
  const [outlineItems, setOutlineItems] = useState<MarkdownOutlineItem[]>([]);
  const [activeOutlineId, setActiveOutlineId] = useState<string | null>(null);
  const outlineRailItems = useMemo(() => {
    const parents: MarkdownOutlineItem[] = [];
    return outlineItems.map(item => {
      while (parents.length && parents[parents.length - 1].level >= item.level) parents.pop();
      const entry = { id: item.id, title: item.text, summary: parents.at(-1)?.text };
      parents.push(item);
      return entry;
    });
  }, [outlineItems]);
  const [editorFocused, setEditorFocused] = useState(false);
  const [active, setActive] = useState<MarkdownToolbarState>(EMPTY_TOOLBAR_STATE);
  const breadcrumb = useMemo(() => formatBreadcrumb(cwd, filePath), [cwd, filePath]);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  const emitLocalChange = useCallback((next: string) => {
    const pending = pendingLocalValueRef.current;
    if (pending) {
      pending.latestValue = next;
      pending.localValues.add(next);
    } else {
      pendingLocalValueRef.current = {
        latestValue: next,
        localValues: new Set([next]),
      };
    }
    currentFullMarkdownRef.current = next;
    onChange(next);
  }, [onChange]);

  const refreshDerivedUi = useCallback((view: EditorView) => {
    const nextOutline = collectOutlineItemsFromDoc(view.state);
    setOutlineItems(nextOutline);
    const cursor = view.state.selection.main.from;
    const activeCandidates = nextOutline.filter((item) => item.pos <= cursor);
    const activeHeading = activeCandidates[activeCandidates.length - 1] || nextOutline[0] || null;
    setActiveOutlineId(activeHeading?.id || null);
    setActive(deriveToolbarState(view));
  }, []);

  const refreshCurrentEditorUi = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    refreshDerivedUi(view);
  }, [refreshDerivedUi]);

  const flushComposedMarkdown = useCallback(() => {
    const next = composingMarkdownRef.current;
    composingMarkdownRef.current = null;
    if (next === null) return;
    emitLocalChange(next);
    const view = viewRef.current;
    if (view) refreshDerivedUi(view);
  }, [emitLocalChange, refreshDerivedUi]);

  const flushPendingMarkdownToParent = useCallback(() => {
    if (compositionFlushTimerRef.current) {
      window.clearTimeout(compositionFlushTimerRef.current);
      compositionFlushTimerRef.current = null;
    }
    composingInputRef.current = false;
    const view = viewRef.current;
    if (view) {
      const markdown = view.state.sliceDoc();
      if (markdown !== currentFullMarkdownRef.current) {
        emitLocalChange(markdown);
      }
    }
    flushComposedMarkdown();
  }, [emitLocalChange, flushComposedMarkdown]);

  const scheduleCompositionFlush = useCallback(() => {
    if (compositionFlushTimerRef.current) {
      window.clearTimeout(compositionFlushTimerRef.current);
    }
    compositionFlushTimerRef.current = window.setTimeout(() => {
      compositionFlushTimerRef.current = null;
      composingInputRef.current = false;
      flushComposedMarkdown();
    }, 0);
  }, [flushComposedMarkdown]);

  const isComposing = useCallback(() => composingInputRef.current, []);

  const getViewState = useCallback((): ProjectEditorViewState | null => {
    const view = viewRef.current;
    if (!view) return null;
    const selection = view.state.selection.main;
    const scroller = hostRef.current?.closest<HTMLElement>('.aegis-md-main');
    return {
      selectionFrom: selection.from,
      selectionTo: selection.to,
      scrollTop: scroller?.scrollTop || 0,
    };
  }, []);

  const restoreViewState = useCallback((state: ProjectEditorViewState | null | undefined) => {
    const view = viewRef.current;
    if (!view || !state) return;
    const selectionFrom = Math.max(0, Math.min(state.selectionFrom, view.state.doc.length));
    const selectionTo = Math.max(selectionFrom, Math.min(state.selectionTo, view.state.doc.length));
    view.dispatch({
      selection: EditorSelection.range(selectionFrom, selectionTo),
    });
    window.requestAnimationFrame(() => {
      const scroller = hostRef.current?.closest<HTMLElement>('.aegis-md-main');
      if (scroller) {
        scroller.scrollTop = Math.max(0, state.scrollTop);
      }
      view.requestMeasure();
    });
  }, []);

  useEffect(() => {
    onRegisterBridge?.({
      flush: flushPendingMarkdownToParent,
      isComposing,
      getViewState,
      restoreViewState,
    });
    return () => onRegisterBridge?.(null);
  }, [flushPendingMarkdownToParent, getViewState, isComposing, onRegisterBridge, restoreViewState]);

  const applyFullMarkdownChange = useCallback((next: string) => {
    const view = viewRef.current;
    if (!view) {
      emitLocalChange(next);
      return;
    }
    const current = view.state.sliceDoc();
    if (current === next) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next },
      scrollIntoView: true,
    });
  }, [emitLocalChange]);

  const jumpToOutlineItem = useCallback((item: MarkdownOutlineItem) => {
    const view = viewRef.current;
    if (!view) return;
    const pos = Math.min(item.pos, view.state.doc.length);
    view.dispatch({
      selection: EditorSelection.cursor(pos),
      effects: [
        EditorView.scrollIntoView(pos, { y: 'center' }),
        markdownHeadingFlashEffect.of(pos),
      ],
    });
    scrollEditorPositionIntoMainView(view, hostRef.current, pos);
    view.focus();
    setActiveOutlineId(item.id);

    if (headingFlashTimerRef.current) {
      window.clearTimeout(headingFlashTimerRef.current);
    }
    headingFlashTimerRef.current = window.setTimeout(() => {
      const currentView = viewRef.current;
      if (currentView) {
        currentView.dispatch({ effects: markdownHeadingFlashEffect.of(null) });
      }
      headingFlashTimerRef.current = null;
    }, 1100);
  }, []);

  useEffect(() => {
    const root = hostRef.current;
    if (!root) return;

    currentFullMarkdownRef.current = value;
    pendingLocalValueRef.current = null;
    applyingPropValueRef.current = false;
    composingInputRef.current = false;
    composingMarkdownRef.current = null;
    if (compositionFlushTimerRef.current) {
      window.clearTimeout(compositionFlushTimerRef.current);
      compositionFlushTimerRef.current = null;
    }
    setEditorFocused(false);

    const insertImageFiles = async (view: EditorView, files: File[]) => {
      const createAsset = window.electron.createMarkdownImageAsset;
      if (typeof createAsset !== 'function') return;

      for (const file of files) {
        try {
          const data = new Uint8Array(await file.arrayBuffer());
          const result = await createAsset(cwd, filePath, file.name || 'image', file.type, data);
          if (!result?.ok || !result.relativePath) continue;
          insertImageMarkdown(view, result.relativePath, result.name || file.name || 'Image');
        } catch (error) {
          console.warn('Failed to insert Markdown image asset:', error);
        }
      }
      refreshDerivedUi(view);
    };

    const updateListener = updateListenerFacet.of((update) => {
      const markdown = update.state.sliceDoc();
      if (update.focusChanged) {
        setEditorFocused(update.view.hasFocus);
      }
      if (update.docChanged) {
        if (applyingPropValueRef.current) {
          composingMarkdownRef.current = null;
          currentFullMarkdownRef.current = markdown;
        } else if (composingInputRef.current || update.view.composing) {
          composingMarkdownRef.current = markdown;
          currentFullMarkdownRef.current = markdown;
        } else {
          composingMarkdownRef.current = null;
          emitLocalChange(markdown);
        }
      }
      if (update.docChanged || update.selectionSet || update.focusChanged) {
        refreshDerivedUi(update.view);
      }
    });

    const compositionHandlers = EditorView.domEventHandlers({
      compositionstart: () => {
        composingInputRef.current = true;
        if (compositionFlushTimerRef.current) {
          window.clearTimeout(compositionFlushTimerRef.current);
          compositionFlushTimerRef.current = null;
        }
        return false;
      },
      compositionend: () => {
        scheduleCompositionFlush();
        return false;
      },
    });

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      drawSelection(),
      bracketMatching(),
      indentOnInput(),
      history(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [livePreviewMath, markdownWikiEmbeds, markdownWikiLinks, markdownHighlight] }),
      createMarkdownShortcuts(() => onSaveRef.current()),
      createMarkdownInputPairsExtension(),
      createImageInputExtension(insertImageFiles),
      previewCompartment.current.of(sourceMode ? [] : createLivePreviewExtension(cwd, filePath)),
      compositionHandlers,
      updateListener,
      EditorView.lineWrapping,
      EditorState.tabSize.of(2),
      EditorState.lineSeparator.of(value.includes('\r\n') ? '\r\n' : '\n'),
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': { overflow: 'visible' },
      }),
    ];

    const state = EditorState.create({
      doc: value,
      extensions,
    });
    const view = new EditorView({ state, parent: root });
    viewRef.current = view;
    refreshDerivedUi(view);

    return () => {
      flushPendingMarkdownToParent();
      view.destroy();
      viewRef.current = null;
      setEditorFocused(false);
      root.innerHTML = '';
      if (headingFlashTimerRef.current) {
        window.clearTimeout(headingFlashTimerRef.current);
        headingFlashTimerRef.current = null;
      }
      if (compositionFlushTimerRef.current) {
        window.clearTimeout(compositionFlushTimerRef.current);
        compositionFlushTimerRef.current = null;
      }
      composingInputRef.current = false;
      composingMarkdownRef.current = null;
    };
  }, [
    cwd,
    emitLocalChange,
    filePath,
    flushPendingMarkdownToParent,
    refreshDerivedUi,
    scheduleCompositionFlush,
  ]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const scroll = hostRef.current?.closest<HTMLElement>('.aegis-md-main');
    const top = scroll?.scrollTop ?? 0;
    view.dispatch({ effects: previewCompartment.current.reconfigure(sourceMode ? [] : createLivePreviewExtension(cwd, filePath)) });
    if (scroll) scroll.scrollTop = top;
    view.requestMeasure();
  }, [sourceMode, cwd, filePath]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !scrollTarget) return;
    const pos = view.state.doc.line(Math.max(1, Math.min(scrollTarget.line, view.state.doc.lines))).from;
    scrollEditorPositionIntoMainView(view, hostRef.current, pos);
  }, [scrollTarget]);

  useEffect(() => {
    const view = viewRef.current;
    const pending = pendingLocalValueRef.current;
    if (pending) {
      if (value === pending.latestValue) {
        pendingLocalValueRef.current = null;
        return;
      }

      if (pending.localValues.has(value)) {
        return;
      }

      pendingLocalValueRef.current = null;
    }

    if (!view) {
      currentFullMarkdownRef.current = value;
      return;
    }
    const current = view.state.sliceDoc();
    if (value === current) {
      currentFullMarkdownRef.current = value;
      return;
    }

    applyingPropValueRef.current = true;
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        annotations: Transaction.userEvent.of('external-reload'),
      });
      currentFullMarkdownRef.current = value;
      refreshDerivedUi(view);
    } finally {
      applyingPropValueRef.current = false;
    }
  }, [refreshDerivedUi, value]);

  const toolbarActive = editorFocused ? active : EMPTY_TOOLBAR_STATE;

  return (
    <div
      data-markdown-editor-mode={sourceMode ? 'source' : 'live'}
      className={`aegis-md-editor bubble-md-live${sourceMode ? ' is-source-mode' : ''}${hideTitleBar ? ' title-hidden' : ''}${
        windowControlsInset ? ' window-controls-inset' : ''
      }`}
    >
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

      {saveState === 'error' && saveError && (
        <div className="aegis-md-error">{saveError}</div>
      )}

      <div className="aegis-md-viewport">
        <div className="aegis-md-main">
          <div className="aegis-md-canvas">
            <div
              ref={hostRef}
              className="aegis-md-codemirror-root"
              onMouseUp={refreshCurrentEditorUi}
              onKeyUp={refreshCurrentEditorUi}
            />
          </div>
        </div>
        {!sourceMode && outlineItems.length > 0 && (
          <OutlineRail
            label="Document outline"
            activeId={activeOutlineId}
            items={outlineRailItems}
            onNavigate={id => {
              const item = outlineItems.find(entry => entry.id === id);
              if (item) jumpToOutlineItem(item);
            }}
          />
        )}
      </div>
    </div>
  );
}

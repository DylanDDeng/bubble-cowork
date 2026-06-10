import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorSelection, EditorState, StateEffect, StateField, Transaction, type Extension } from '@codemirror/state';
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
  ChevronUp,
  Plus,
  X,
} from './icons';
import { toast } from 'sonner';

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

function getMetadataChipToneClass(value: string): string {
  const normalized = value.trim();
  if (!normalized) return '';
  let hash = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = (hash * 31 + normalized.charCodeAt(index)) >>> 0;
  }
  return `aegis-mdx-metadata-chip-tone-${hash % 4}`;
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
      <div className="aegis-mdx-metadata-title">Meta</div>
      <div className="aegis-mdx-metadata-grid">
        {visibleFields.map((field) => (
          <div key={`${field.key}-${field.line}`} className="aegis-mdx-metadata-row">
            <span className="aegis-mdx-metadata-key" title={field.key}>
              {field.key}
            </span>
            {field.kind === 'array' ? (
              <div className="aegis-mdx-metadata-chips" aria-label={field.key}>
                {field.items.map((item, index) => {
                  const toneClass = getMetadataChipToneClass(item);
                  return (
                    <span
                      key={`${field.key}-${field.line}-${index}`}
                      className={`aegis-mdx-metadata-chip aegis-mdx-metadata-chip-editable${toneClass ? ` ${toneClass}` : ''}`}
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

function openMarkdownExternalUrl(rawUrl: string): boolean {
  const url = normalizeExternalMarkdownUrl(rawUrl);
  if (!url) return false;

  const opener = window.electron?.openExternalUrl;
  if (typeof opener === 'function') {
    void opener(url)
      .then((result) => {
        if (!result?.ok) {
          toast.error(`打开链接失败: ${result?.message || url}`);
        }
      })
      .catch((error) => {
        toast.error(`打开链接失败: ${error instanceof Error ? error.message : String(error)}`);
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
  return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

function lineIsActive(state: EditorState, lineFrom: number, lineTo: number): boolean {
  return state.selection.ranges.some((range) => range.from <= lineTo && range.to >= lineFrom);
}

function selectionTouchesSourceRange(state: EditorState, from: number, to: number): boolean {
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
    const coords = view.coordsAtPos(pos, 1) || view.coordsAtPos(pos, -1);
    const scrollerRect = scroller.getBoundingClientRect();
    const contentRect = view.contentDOM.getBoundingClientRect();
    const lineBlock = view.lineBlockAt(pos);
    const targetTop = coords?.top ?? contentRect.top + lineBlock.top;
    const topOffset = Math.min(
      OUTLINE_TARGET_MAX_TOP_OFFSET_PX,
      Math.max(OUTLINE_TARGET_MIN_TOP_OFFSET_PX, scroller.clientHeight * OUTLINE_TARGET_VIEWPORT_RATIO)
    );
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const nextScrollTop = scroller.scrollTop + targetTop - scrollerRect.top - topOffset;
    scroller.scrollTo({
      top: Math.min(maxScrollTop, Math.max(0, nextScrollTop)),
      behavior: 'smooth',
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

  toDOM(view: EditorView) {
    const container = createMeasuredMarkdownBlock(view, 'span', 'aegis-cm-image-widget', this.sourcePos);
    container.tabIndex = 0;

    const requestMeasure = () => requestMarkdownWidgetMeasure(view, container);

    const status = document.createElement('span');
    status.className = 'aegis-cm-image-status';
    status.textContent = 'Loading image...';
    container.appendChild(status);

    const showError = (message: string) => {
      if (container.__aegisMarkdownWidgetDisposed) return;
      container.dataset.error = 'true';
      status.textContent = message;
      container.replaceChildren(status);
      requestMeasure();
    };

    const renderImage = (src: string) => {
      if (container.__aegisMarkdownWidgetDisposed) return;
      container.innerHTML = '';
      delete container.dataset.error;
      const img = document.createElement('img');
      img.src = src;
      img.alt = this.alt;
      img.title = this.alt;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('load', requestMeasure, { once: true });
      img.addEventListener('error', () => showError('Image failed to load.'));
      container.appendChild(img);
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

    container.addEventListener('click', (event) => {
      const target = findClosestElement(event.target);
      if (!target?.closest('img, .aegis-cm-image-status')) return;
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({
        selection: EditorSelection.cursor(this.sourcePos),
        effects: EditorView.scrollIntoView(this.sourcePos, { y: 'center' }),
      });
      view.focus();
    });
    return container;
  }

  ignoreEvent() {
    return false;
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

class TablePreviewWidget extends MeasuredBlockWidget {
  constructor(
    private readonly rows: string[][],
    private readonly sourcePos: number
  ) {
    super();
  }

  eq(other: TablePreviewWidget) {
    return JSON.stringify(other.rows) === JSON.stringify(this.rows) && other.sourcePos === this.sourcePos;
  }

  toDOM(view: EditorView) {
    const wrapper = createMeasuredMarkdownBlock(view, 'div', 'aegis-cm-table-widget', this.sourcePos);
    const table = document.createElement('table');
    this.rows.forEach((row, rowIndex) => {
      const tr = document.createElement('tr');
      row.forEach((cell) => {
        const el = document.createElement(rowIndex === 0 ? 'th' : 'td');
        el.textContent = cell;
        tr.appendChild(el);
      });
      table.appendChild(tr);
    });
    wrapper.appendChild(table);
    table.addEventListener('click', () => {
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
    title.textContent = 'Meta';
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
          const toneClass = getMetadataChipToneClass(item);
          chip.className = `aegis-mdx-metadata-chip${toneClass ? ` ${toneClass}` : ''}`;
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
  const frontmatter = findFrontmatterBlock(state);
  const codeBlocks = scanCodeBlocks(state);
  const tableBlocks = scanTableBlocks(state);
  const blockLines = new Set<number>();

  if (frontmatter && !frontmatterBlockIsActive(state, frontmatter)) {
    for (let line = frontmatter.startLine; line <= frontmatter.endLine; line += 1) blockLines.add(line);
    decorations.push(Decoration.replace({
      widget: new FrontmatterPreviewWidget(frontmatter.frontmatter, frontmatter.from + 4),
      block: true,
    }).range(frontmatter.from, frontmatter.to));
  }

  for (const block of codeBlocks) {
    if (!block.terminated) {
      // Keep the literal ``` visible as plain text while the fence is still open
      // (Obsidian-style); a block only collapses once it has a closing ```. This
      // prevents an in-progress fence from folding the rest of the document.
      blockLines.add(block.startLine);
      continue;
    }
    for (let line = block.startLine; line <= block.endLine; line += 1) blockLines.add(line);
    if (isRangeActive(state, block.from, block.to)) {
      for (let lineNumber = block.startLine; lineNumber <= block.endLine; lineNumber += 1) {
        const line = state.doc.line(lineNumber);
        const boundaryClass = lineNumber === block.startLine
          ? ' is-first'
          : lineNumber === block.endLine
            ? ' is-last'
            : '';
        const markerClass = lineNumber === block.startLine || lineNumber === block.endLine ? ' is-marker' : '';
        decorations.push(
          Decoration.line({ class: `aegis-cm-code-source-line${boundaryClass}${markerClass}` }).range(line.from)
        );
      }
      continue;
    }
    decorations.push(Decoration.replace({
      widget: new CodeBlockPreviewWidget(block.language, block.code, block.from),
      block: true,
    }).range(block.from, block.to));
  }

  for (const table of tableBlocks) {
    for (let line = table.startLine; line <= table.endLine; line += 1) blockLines.add(line);
    if (isRangeActive(state, table.from, table.to)) continue;
    decorations.push(Decoration.replace({
      widget: new TablePreviewWidget(table.rows, table.from),
      block: true,
    }).range(table.from, table.to));
  }

  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    if (blockLines.has(lineNumber)) continue;
    const line = state.doc.line(lineNumber);
    const activeLine = lineIsActive(state, line.from, line.to);

    const image = findImageInLine(line.text, line.from);
    if (image && line.text.trim() === `![${image.alt}](${image.src})`) {
      if (!activeLine) {
        decorations.push(Decoration.replace({
          widget: new ImagePreviewWidget(cwd, filePath, image.src, image.alt, image.from),
          block: true,
        }).range(image.from, image.to));
      }
      continue;
    }

    addInlineMarkdownDecorations(state, line.from, line.text, decorations, activeLine);
  }

  const flashPos = state.field(headingFlashField, false);
  if (typeof flashPos === 'number') {
    const line = state.doc.lineAt(flashPos);
    decorations.push(Decoration.line({ class: 'aegis-cm-heading-flash' }).range(line.from));
  }

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
        || transaction.effects.some((effect) => effect.is(markdownHeadingFlashEffect));
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
    this.view.dispatch({ effects: markdownPointerSelectingEffect.of(false) });
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
  return [
    headingFlashField,
    createLivePreviewDecorationsField(cwd, filePath),
    createPointerStablePreviewExtension(),
    EditorView.domEventHandlers({
      click: (event) => {
        const element = findClosestElement(event.target);
        const link = element?.closest<HTMLElement>('[data-aegis-url]');
        if (!link?.dataset.aegisUrl) return false;
        if (!openMarkdownExternalUrl(link.dataset.aegisUrl)) return false;
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
  const outlineCloseTimerRef = useRef<number | null>(null);
  const headingFlashTimerRef = useRef<number | null>(null);
  const [outlineItems, setOutlineItems] = useState<MarkdownOutlineItem[]>([]);
  const [activeOutlineId, setActiveOutlineId] = useState<string | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
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
      const markdown = view.state.doc.toString();
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

  const applyFullMarkdownChange = useCallback((next: string) => {
    const view = viewRef.current;
    if (!view) {
      emitLocalChange(next);
      return;
    }
    const current = view.state.doc.toString();
    if (current === next) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: next },
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
      const markdown = update.state.doc.toString();
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
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      createMarkdownShortcuts(() => onSaveRef.current()),
      createMarkdownInputPairsExtension(),
      createImageInputExtension(insertImageFiles),
      createLivePreviewExtension(cwd, filePath),
      compositionHandlers,
      updateListener,
      EditorView.lineWrapping,
      EditorState.tabSize.of(2),
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
    const current = view.state.doc.toString();
    if (value === current) {
      currentFullMarkdownRef.current = value;
      return;
    }

    applyingPropValueRef.current = true;
    try {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
        annotations: Transaction.userEvent.of('external-reload'),
      });
      currentFullMarkdownRef.current = value;
      refreshDerivedUi(view);
    } finally {
      applyingPropValueRef.current = false;
    }
  }, [refreshDerivedUi, value]);

  useEffect(() => {
    return () => {
      if (outlineCloseTimerRef.current) {
        window.clearTimeout(outlineCloseTimerRef.current);
      }
    };
  }, []);

  const toolbarActive = editorFocused ? active : EMPTY_TOOLBAR_STATE;

  return (
    <div
      className={`aegis-md-editor${hideTitleBar ? ' title-hidden' : ''}${
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

      <div className="aegis-md-main">
        <div className="aegis-md-canvas">
          <div
            ref={hostRef}
            className="aegis-md-codemirror-root"
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
              onClick={() => setOutlineOpen((current) => !current)}
            >
              {outlineItems.slice(0, 8).map((item) => (
                <span
                  key={item.id}
                  className={`${item.id === activeOutlineId ? 'active' : ''} level-${item.level}`}
                  title={item.text}
                  aria-hidden="true"
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
                    type="button"
                    key={item.id}
                    className={`level-${item.level}${item.id === activeOutlineId ? ' active' : ''}`}
                    onClick={() => jumpToOutlineItem(item)}
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

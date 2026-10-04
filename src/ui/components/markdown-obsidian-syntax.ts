import { WidgetType } from '@codemirror/view';
import type { MarkdownConfig } from '@lezer/markdown';

// Obsidian syntax that CommonMark/GFM does not parse: ==highlight== and
// [[wiki links]]. Both participate in the parser so they never match inside
// code spans or fenced code.

const EQUALS = 61;
const BRACKET = 91;

export const markdownHighlight: MarkdownConfig = {
  defineNodes: ['Highlight', 'HighlightMark'],
  parseInline: [{
    name: 'Highlight',
    before: 'Emphasis',
    parse(cx, next, pos) {
      if (next !== EQUALS || cx.char(pos + 1) !== EQUALS) return -1;
      const match = /^==(?![\s=])((?:[^\n=]|=(?!=))*?[^\s=])==/.exec(cx.slice(pos, cx.end));
      if (!match) return -1;
      const end = pos + match[0].length;
      return cx.addElement(cx.elt('Highlight', pos, end, [
        cx.elt('HighlightMark', pos, pos + 2),
        cx.elt('HighlightMark', end - 2, end),
      ]));
    },
  }],
};

export const markdownWikiLinks: MarkdownConfig = {
  defineNodes: ['WikiLink'],
  parseInline: [{
    name: 'WikiLink',
    before: 'Link',
    parse(cx, next, pos) {
      if (next !== BRACKET || cx.char(pos + 1) !== BRACKET) return -1;
      const match = /^\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]/.exec(cx.slice(pos, cx.end));
      return match ? cx.addElement(cx.elt('WikiLink', pos, pos + match[0].length)) : -1;
    },
  }],
};

export type WikiLinkParts = {
  /** File part of the target; empty for same-note heading links like [[#Intro]]. */
  target: string;
  heading: string;
  /** Visible text: the alias, else the target as written. */
  label: string;
  /** Source offset where the visible label starts and ends. */
  labelFrom: number;
  labelTo: number;
};

export function parseWikiLink(source: string, from: number): WikiLinkParts | null {
  const match = /^\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]$/.exec(source);
  if (!match) return null;
  const [, rawTarget, alias] = match;
  const hashIndex = rawTarget.indexOf('#');
  const target = (hashIndex >= 0 ? rawTarget.slice(0, hashIndex) : rawTarget).trim();
  const heading = hashIndex >= 0 ? rawTarget.slice(hashIndex + 1).trim() : '';
  if (alias !== undefined) {
    const labelFrom = from + 2 + rawTarget.length + 1;
    return { target, heading, label: alias, labelFrom, labelTo: labelFrom + alias.length };
  }
  return { target, heading, label: rawTarget, labelFrom: from + 2, labelTo: from + 2 + rawTarget.length };
}

/** `> [!note]+ Optional title` on the first line of a blockquote. */
export function parseCalloutHeader(lineText: string): { type: string; markerFrom: number; markerTo: number; title: string } | null {
  const match = /^(\s*>\s*)(\[!([A-Za-z][\w-]*)\][+-]?)(\s*)(.*)$/.exec(lineText);
  if (!match) return null;
  const [, prefix, marker, type, space, title] = match;
  return {
    type: type.toLowerCase(),
    markerFrom: prefix.length,
    markerTo: prefix.length + marker.length + space.length,
    title: title.trim(),
  };
}

export class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'bubble-md-bullet';
    el.setAttribute('aria-hidden', 'true');
    return el;
  }
  ignoreEvent() { return false; }
}

export class CalloutTitleWidget extends WidgetType {
  constructor(readonly label: string) { super(); }
  eq(other: CalloutTitleWidget) { return other.label === this.label; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'bubble-md-callout-label';
    el.textContent = this.label;
    return el;
  }
  ignoreEvent() { return false; }
}

export function calloutLabel(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

export type TableCellSource = { text: string; from: number };
export type TableAlignment = 'left' | 'center' | 'right' | null;

/** Split a GFM table row into trimmed cells with their source offsets. */
export function splitTableRow(text: string, lineFrom: number): TableCellSource[] {
  const cells: TableCellSource[] = [];
  let start = 0;
  let end = text.length;
  const leading = /^\s*\|/.exec(text);
  if (leading) start = leading[0].length;
  const trailing = /\|\s*$/.exec(text.slice(start));
  if (trailing) end = start + trailing.index;
  let cellStart = start;
  for (let i = start; i <= end; i++) {
    if (i < end && text[i] === '\\') { i++; continue; }
    if (i === end || text[i] === '|') {
      const raw = text.slice(cellStart, i);
      const offset = raw.length - raw.trimStart().length;
      cells.push({ text: raw.trim(), from: lineFrom + cellStart + offset });
      cellStart = i + 1;
    }
  }
  return cells;
}

export function parseTableAlignments(delimiterRow: string): TableAlignment[] {
  return splitTableRow(delimiterRow, 0).map(({ text }) => {
    const left = text.startsWith(':');
    const right = text.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
  });
}

/** Plain-text rendering of a cell's inline Markdown for the table preview. */
export function renderTableCellText(source: string): string {
  return source
    .replace(/\\\|/g, '|')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/==(.+?)==/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

function normalizePosixPath(path: string): string {
  const absolute = path.startsWith('/');
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `${absolute ? '/' : ''}${parts.join('/')}`;
}

function joinPosixPath(base: string, relative: string): string {
  return normalizePosixPath(`${base.replace(/\/+$/, '')}/${relative}`);
}

function dirnamePosix(path: string): string {
  const normalized = normalizePosixPath(path);
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}

/** True for link targets that point at another file rather than the web or a same-note anchor. */
export function isLocalMarkdownLink(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//') || /^www\./i.test(trimmed)) return false;
  return true;
}

/**
 * Candidate absolute paths for a note link, most specific first. Wiki targets
 * without an extension name a Markdown note; Markdown link paths are used as
 * written. Paths starting with `/` are project-root relative, as in Obsidian.
 */
export function noteLinkCandidates(cwd: string, filePath: string, target: string, kind: 'wiki' | 'markdown'): string[] {
  let decoded = target.trim();
  try { decoded = decodeURI(decoded); } catch { /* keep the raw target */ }
  const withExtension = kind === 'wiki' && !/\.[A-Za-z0-9]+$/.test(decoded) ? `${decoded}.md` : decoded;
  const root = normalizePosixPath(cwd);
  const file = filePath.startsWith('/') ? filePath : joinPosixPath(root, filePath);
  if (withExtension.startsWith('/')) return [joinPosixPath(root, withExtension)];
  const candidates = [joinPosixPath(dirnamePosix(file), withExtension), joinPosixPath(root, withExtension)];
  // `../` must not climb out of the project through the root fallback.
  const inside = (path: string) => path === root || path.startsWith(`${root}/`);
  return candidates.filter((path, index) => candidates.indexOf(path) === index && (index === 0 || inside(path)));
}

type TreeNode = { name: string; path: string; kind: 'file' | 'dir'; children?: TreeNode[] };

/** Resolve a link against the loaded project tree; null when the tree has no match. */
export function findNoteInTree(tree: TreeNode | null | undefined, candidates: string[], target: string, kind: 'wiki' | 'markdown'): string | null {
  if (!tree) return null;
  const files: string[] = [];
  const walk = (node: TreeNode) => {
    if (node.kind === 'file') files.push(normalizePosixPath(node.path));
    node.children?.forEach(walk);
  };
  walk(tree);
  const exact = candidates.find(candidate => files.includes(candidate));
  if (exact) return exact;
  // Obsidian resolves a bare wiki name anywhere in the vault.
  if (kind !== 'wiki' || target.includes('/')) return null;
  const name = (/\.[A-Za-z0-9]+$/.test(target) ? target : `${target}.md`).toLowerCase();
  return files.find(path => path.slice(path.lastIndexOf('/') + 1).toLowerCase() === name) ?? null;
}

/** GitHub-style heading slug, used to match `#anchor` links to headings. */
export function headingSlug(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
}

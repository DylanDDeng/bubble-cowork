import type { EditorState } from '@codemirror/state';
import { EditorView, WidgetType } from '@codemirror/view';
import { createMediaSourceButton } from './markdown-media-interaction';
import { siteRootPathCandidates } from '../../shared/site-root-path';
import type { Tree } from '@lezer/common';
import type { MarkdownConfig } from '@lezer/markdown';

export const markdownWikiEmbeds: MarkdownConfig = {
  defineNodes: ['WikiEmbed'],
  parseInline: [{ name: 'WikiEmbed', before: 'Link', parse(cx, next, pos) {
    if (next !== 33) return -1;
    const match = /^!\[\[([^\]\n]+)\]\]/.exec(cx.slice(pos, cx.end));
    return match ? cx.addElement(cx.elt('WikiEmbed', pos, pos + match[0].length)) : -1;
  } }],
};

type SourceRange = { from: number; to: number };
export type VideoPreview = SourceRange & { sources: string[]; label: string; poster?: string };
export type UnderlinePreview = SourceRange & { openEnd: number; closeStart: number };

export function isMarkdownVideo(src: string) {
  return /\.(mp4|webm|mov)(?:[?#]|$)/i.test(src.trim());
}

function parseVideo(source: string, from: number, to: number): VideoPreview | null {
  // Read a small attribute allowlist from inert HTML; never insert author HTML.
  const doc = new DOMParser().parseFromString(source, 'text/html');
  const video = doc.querySelector('video');
  if (!video) return null;
  const sources = video.hasAttribute('src')
    ? [video.getAttribute('src')!]
    : Array.from(video.querySelectorAll(':scope > source')).map(el => el.getAttribute('src') || '');
  const usable = sources.map(src => src.trim()).filter(Boolean);
  if (!usable.length) return null;
  return { from, to, sources: usable, label: video.getAttribute('title') || 'Video preview', poster: video.getAttribute('poster') || undefined };
}

export function collectHtmlPreviews(state: EditorState, tree: Tree) {
  const underlines: UnderlinePreview[] = [];
  const videos: VideoPreview[] = [];
  const openTags: Array<SourceRange & { name: string; parent: number }> = [];
  tree.iterate({ enter({ node }) {
    if (['FencedCode', 'CodeBlock', 'InlineCode'].includes(node.name)) return false;
    if (node.name === 'HTMLBlock') {
      const source = state.doc.sliceString(node.from, node.to);
      if (/^\s*<video\b/i.test(source)) {
        const match = /^\s*(<video\b[^>]*>[\s\S]*?<\/video\s*>)/i.exec(source);
        if (match) {
          const start = node.from + match[0].indexOf('<');
          const video = parseVideo(match[1], start, node.from + match[0].length);
          if (video) videos.push(video);
        }
      }
      return false;
    }
    if (node.name !== 'HTMLTag') return;
    const tag = /^<(\/)?(u|video)\b[^>]*>$/i.exec(state.doc.sliceString(node.from, node.to));
    if (!tag) return;
    const name = tag[2].toLowerCase(), parent = node.parent?.from ?? 0;
    if (!tag[1]) {
      openTags.push({ from: node.from, to: node.to, name, parent });
      return;
    }
    let index = openTags.length - 1;
    while (index >= 0 && !(openTags[index].name === name && openTags[index].parent === parent)) index--;
    if (index < 0) return;
    const [open] = openTags.splice(index, 1);
    if (name === 'u') underlines.push({ from: open.from, to: node.to, openEnd: open.to, closeStart: node.from });
    else {
      const video = parseVideo(state.doc.sliceString(open.from, node.to), open.from, node.to);
      if (video) videos.push(video);
    }
  } });
  return { underlines, videos };
}

async function resolveMedia(cwd: string, filePath: string, src: string, kind: 'video' | 'image'): Promise<string> {
  if (/^https?:\/\//i.test(src)) return src;
  if (/^data:/i.test(src) && new RegExp(`^data:${kind}/`, 'i').test(src)) return src;
  if (/^[a-z][a-z\d+.-]*:/i.test(src) && !/^file:/i.test(src) && !/^[a-z]:[\\/]/i.test(src)) throw Error('Unsupported media URL.');
  let target: string;
  if (/^file:/i.test(src)) {
    const url = new URL(src);
    if (url.hostname && url.hostname !== 'localhost') throw Error('Unsupported file host.');
    target = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:\/)/, '$1');
  } else {
    // Local paths are resolved relative to the document. IPC validates project access.
    let decoded = src;
    try { decoded = decodeURIComponent(src); } catch { /* a literal % in the file name */ }
    decoded = decoded.replace(/\\/g, '/');
    target = /^(?:\/|[a-z]:\/)/i.test(decoded) ? decoded : `${filePath.replace(/\\/g, '/').replace(/[^/]*$/, '')}${decoded}`;
  }
  let message: string | undefined;
  const read = async (candidate: string) => {
    const result = await window.electron.readProjectFilePreview(cwd, candidate) as { kind: string; previewUrl?: string; dataUrl?: string; message?: string };
    const url = kind === 'video' ? result.previewUrl : result.dataUrl;
    if (result.kind === kind && url) return url;
    message ??= result.message;
    return null;
  };
  for (const candidate of siteRootPathCandidates(cwd, target)) {
    const url = await read(candidate);
    if (url) return url;
  }
  // Like Obsidian, a bare name such as ![[clip.mp4]] may live anywhere in the vault.
  const bareName = !/^file:/i.test(src) && !/[\\/]/.test(src.trim());
  if (bareName) {
    const found = await window.electron.findProjectFileByName?.(cwd, src.trim());
    const url = found ? await read(found) : null;
    if (url) return url;
  }
  throw Error(message || `Unable to load ${kind}.`);
}

type VideoElement = HTMLElement & { disposeMedia?: () => void };
export class MarkdownVideoWidget extends WidgetType {
  constructor(readonly cwd: string, readonly filePath: string, readonly video: VideoPreview) { super(); }
  eq(other: MarkdownVideoWidget) { return this.cwd === other.cwd && this.filePath === other.filePath && JSON.stringify(this.video) === JSON.stringify(other.video); }
  updateDOM(dom: HTMLElement, _view: EditorView, previous: MarkdownVideoWidget) {
    if (this.cwd !== previous.cwd || this.filePath !== previous.filePath
      || JSON.stringify(this.video.sources) !== JSON.stringify(previous.video.sources)
      || this.video.poster !== previous.video.poster) return false;
    dom.dataset.sourcePos = String(this.video.from);
    dom.querySelector('video')?.setAttribute('aria-label', this.video.label);
    return true;
  }
  toDOM(view: EditorView) {
    const container: VideoElement = document.createElement('span');
    container.className = 'bubble-md-video-widget';
    container.dataset.sourcePos = String(this.video.from);
    const video = document.createElement('video');
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.setAttribute('aria-label', this.video.label);
    const status = document.createElement('span');
    status.className = 'bubble-md-video-status';
    status.textContent = 'Loading video…';
    status.setAttribute('role', 'status');
    const edit = createMediaSourceButton(view, container, 'video');
    container.append(video, edit, status);
    let disposed = false;
    const measure = () => { if (!disposed && view.dom.isConnected) view.requestMeasure(); };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    const fail = (message: string) => { if (!disposed) { status.hidden = false; status.textContent = message; measure(); } };
    video.addEventListener('loadedmetadata', () => { status.hidden = true; measure(); });
    video.addEventListener('error', () => fail('Unable to load or decode this video. Edit its source or open it in your system player.'));
    void Promise.allSettled(this.video.sources.map(src => resolveMedia(this.cwd, this.filePath, src, 'video'))).then(results => {
      if (disposed) return;
      const sources = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      if (!sources.length) { fail('Video could not be loaded. Check the file path or URL.'); return; }
      let failedSources = 0;
      for (const src of sources) {
        const source = document.createElement('source');
        source.src = src;
        source.addEventListener('error', () => {
          if (++failedSources === sources.length) fail('Unable to load or decode this video. Check its path and format.');
        });
        video.append(source);
      }
      video.load();
      measure();
    });
    if (this.video.poster) void resolveMedia(this.cwd, this.filePath, this.video.poster, 'image').then(src => { if (!disposed) video.poster = src; }).catch(() => {});
    container.disposeMedia = () => {
      disposed = true;
      observer.disconnect();
      video.pause();
      video.removeAttribute('src');
      video.replaceChildren();
      video.load();
    };
    return container;
  }
  destroy(dom: HTMLElement) { (dom as VideoElement).disposeMedia?.(); }
  // Player controls must not move the editor caret or reveal Markdown source.
  ignoreEvent() { return true; }
}

import { EditorSelection } from '@codemirror/state';
import { EditorView, WidgetType } from '@codemirror/view';
import type { MarkdownConfig } from '@lezer/markdown';
import 'katex/dist/katex.min.css';

/** Math participates in the parser, so dollars inside code never become math. */
export const livePreviewMath: MarkdownConfig = {
  defineNodes: [{ name: 'MathBlock', block: true }, 'MathInline', 'MathContent'],
  parseBlock: [{
    name: 'MathBlock', before: 'FencedCode',
    parse(cx, line) {
      const opener = line.text.slice(line.pos).trim();
      if (opener !== '$$' && opener !== '\\[') return false;
      const from = cx.lineStart + line.pos;
      const close = opener === '$$' ? '$$' : '\\]';
      const children = [];
      while (cx.nextLine()) {
        if (line.text.trim() === close) { cx.nextLine(); break; }
        children.push(cx.elt('MathContent', cx.lineStart + line.pos, cx.lineStart + line.text.length));
      }
      cx.addElement(cx.elt('MathBlock', from, cx.prevLineEnd(), children));
      return true;
    },
    endLeaf: (_cx, line) => ['$$', '\\['].includes(line.text.slice(line.pos).trim()),
  }],
  parseInline: [{
    name: 'MathInline', before: 'Escape',
    parse(cx, next, pos) {
      if (next !== 36 && next !== 92) return -1;
      const rest = cx.slice(pos, cx.end);
      const match = /^(?:\$\$([^\n]+?)\$\$|\$([^\s$](?:[^\n$]*?[^\s$])?)\$(?!\d)|\\\(([^\n]+?)\\\))/.exec(rest);
      if (!match) return -1;
      return cx.addElement(cx.elt('MathInline', pos, pos + match[0].length));
    },
  }],
};

export class MarkdownRenderedWidget extends WidgetType {
  constructor(readonly source: string, readonly from: number, readonly block: boolean) { super(); }
  eq(other: MarkdownRenderedWidget) { return this.source === other.source && this.from === other.from && this.block === other.block; }
  toDOM(view: EditorView) {
    const el = document.createElement(this.block ? 'div' : 'span');
    el.className = 'bubble-md-rendered bubble-md-math';
    el.setAttribute('aria-label', 'Math preview');
    el.textContent = this.source;
    el.addEventListener('mousedown', event => {
      event.preventDefault();
      view.dispatch({ selection: EditorSelection.cursor(this.from + 1) });
      view.focus();
    });
    const render = async () => {
      const { default: katex } = await import('katex');
      const math = this.source.replace(/^(?:\$\$?|\\\[|\\\()/, '').replace(/(?:\$\$?|\\\]|\\\))$/, '');
      return katex.renderToString(math, { displayMode: this.block || this.source.startsWith('$$'), throwOnError: false, strict: 'ignore', trust: false });
    };
    void render().then(html => {
      if (!el.isConnected) return;
      el.innerHTML = html;
      view.requestMeasure();
    }).catch(() => { /* Invalid in-progress math keeps its source visible. */ });
    return el;
  }
  ignoreEvent() { return false; }
}

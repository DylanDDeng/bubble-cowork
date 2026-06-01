/**
 * WeChat (公众号) markdown export — 「黑红刊刻风」(black-red imprint).
 *
 * Source of truth: wechat-markdown-note/src/core/aiPrompts.ts
 *   const BLACK_RED_IMPRINT_SYSTEM_PROMPT = `...`
 *
 * Hard requirements from that spec (we follow them verbatim):
 *   - All CSS lives INLINE on each element. WeChat strips <style> tags and
 *     class-based styles, so there is no other way to land the look.
 *   - Body text MUST be 14px / line-height 1.85 / letter-spacing 1px / #222.
 *   - Container MUST be max-width 700px, padding 22px 20px.
 *   - H1 (article title) is NOT rendered in the body — the WeChat editor
 *     shows the article title separately. We use it only for <title>.
 *   - Section header (H2) is "Section NN" red tag + title + 48% gradient
 *     structure line (black → deep red → transparent).
 *   - Blockquote left border is BLACK #111, 3px.
 *   - Code block has a black top bar (CODE label + lang name) over a paper-
 *     white content area, wrapped in a 1px black border, 8px rounded.
 *   - Tip/Note cards (:::tip / :::note) get a 4px red left border on a
 *     warm off-white background.
 *   - End Note (:::endnote) gets the "End Note" red tag + 收束句 + 副小字.
 *   - Four inline emphasis styles: ==text== (浅红底), !!text!! (浅黄底),
 *     ++text++ (方法名暖橙).
 *   - A 14px vertical placeholder is inserted between blocks to keep
 *     sections from sticking together.
 *   - At the very end, append the WeChat editor magic marker so the editor
 *     keeps the imported style.
 *
 * The output is a complete HTML document (DOCTYPE + <html> + <head> +
 * <body>). The <title> walks through H1 → H2 → ... → H6 → first non-empty
 * line → "Document" so we always have a sensible title.
 */

export type WeChatCopyResult =
  | { ok: true; html: string; bytes: number }
  | { ok: false; error: string };

export type WeChatThemeId = 'bubblebrain' | 'lapis';

// ----- Design tokens (verbatim from BLACK_RED_IMPRINT_SYSTEM_PROMPT) -------

const BUBBLEBRAIN_FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC'," +
  "'Hiragino Sans GB','Microsoft YaHei',sans-serif";

const LAPIS_FONT_STACK =
  "'Inter','Helvetica Neue',Helvetica,Arial,'PingFang SC'," +
  "'Hiragino Sans GB','Microsoft YaHei',sans-serif";

let FONT_STACK = BUBBLEBRAIN_FONT_STACK;

const MONO_STACK =
  "'SFMono-Regular',Menlo,Consolas,'Courier New',monospace";

const SERIF_STACK =
  "'Source Serif Pro','Source Han Serif SC','Noto Serif SC'," +
  "'Songti SC','SimSun',Georgia,'Times New Roman',serif";

type WeChatThemeColors = Record<
  | 'pageBg'
  | 'cardBg'
  | 'codeBarBg'
  | 'text'
  | 'textBody'
  | 'textSoft'
  | 'textDim'
  | 'textMuted'
  | 'textCaption'
  | 'textItalic'
  | 'red'
  | 'redBright'
  | 'redTagText'
  | 'redCardBg'
  | 'redCardBorder'
  | 'redCardText'
  | 'redHighlightBg'
  | 'redHighlightText'
  | 'yellowHighlightBg'
  | 'border'
  | 'codeBorder'
  | 'shadow',
  string
>;

const BUBBLEBRAIN_COLORS: WeChatThemeColors = {
  // surfaces
  pageBg: '#fbfaf8', // 骨白
  cardBg: '#fffdfb', // 纸白
  codeBarBg: '#161616', // 黑
  // text
  text: '#181818',
  textBody: '#222222',
  textSoft: '#1f1f1f',
  textDim: '#2a2a2a',
  textMuted: '#5b4b4d',
  textCaption: '#6a4b4d',
  textItalic: '#5f5355',
  // brand (warm orange)
  red: '#F87B02',
  redBright: '#FF8E1A',
  redTagText: '#fff5ea',
  redCardBg: '#3a2410',
  redCardBorder: '#5a3a1f',
  redCardText: '#f0e0c8',
  redHighlightBg: '#3a2410',
  redHighlightText: '#FFB04A',
  // misc
  yellowHighlightBg: '#fff1bf',
  border: '#d9d0d1',
  codeBorder: '#1a1a1a',
  shadow: 'rgba(17,17,17,0.05)',
} as const;

const LAPIS_COLORS: WeChatThemeColors = {
  // surfaces
  pageBg: '#F7F9FC',
  cardBg: '#ffffff',
  codeBarBg: '#161626',
  // text
  text: '#0A0A0A',
  textBody: '#0A0A0A',
  textSoft: '#111111',
  textDim: '#2A3344',
  textMuted: '#5A6478',
  textCaption: '#6B7280',
  textItalic: '#4B5563',
  // brand (international Swiss blue)
  red: '#0033A0',
  redBright: '#0033A0',
  redTagText: '#ffffff',
  redCardBg: '#F4F7FC',
  redCardBorder: '#D8E2F3',
  redCardText: '#0A0A0A',
  redHighlightBg: '#E7EEF9',
  redHighlightText: '#C2410C',
  // misc
  yellowHighlightBg: '#FFF4CC',
  border: '#D8E2F3',
  codeBorder: '#111827',
  shadow: 'rgba(0,51,160,0.06)',
} as const;

interface WeChatThemeRuntime {
  id: WeChatThemeId;
  htmlName: string;
  fontStack: string;
  colors: WeChatThemeColors;
  useSerifForHeadingNumbers: boolean;
}

const WECHAT_THEMES: Record<WeChatThemeId, WeChatThemeRuntime> = {
  bubblebrain: {
    id: 'bubblebrain',
    htmlName: 'bubblebrain',
    fontStack: BUBBLEBRAIN_FONT_STACK,
    colors: BUBBLEBRAIN_COLORS,
    useSerifForHeadingNumbers: true,
  },
  lapis: {
    id: 'lapis',
    htmlName: 'lapis',
    fontStack: LAPIS_FONT_STACK,
    colors: LAPIS_COLORS,
    useSerifForHeadingNumbers: false,
  },
};

let currentTheme = WECHAT_THEMES.bubblebrain;
let C = currentTheme.colors;

function resolveWechatTheme(themeId: WeChatThemeId = 'bubblebrain'): WeChatThemeRuntime {
  return WECHAT_THEMES[themeId] ?? WECHAT_THEMES.bubblebrain;
}

function withWechatTheme<T>(themeId: WeChatThemeId | undefined, render: () => T): T {
  const previousTheme = currentTheme;
  const previousColors = C;
  const previousFontStack = FONT_STACK;
  currentTheme = resolveWechatTheme(themeId);
  C = currentTheme.colors;
  FONT_STACK = currentTheme.fontStack;
  try {
    return render();
  } finally {
    currentTheme = previousTheme;
    C = previousColors;
    FONT_STACK = previousFontStack;
  }
}

// ----- Block-level parser ---------------------------------------------------
//
// Walks the markdown line-by-line, grouping into block tokens. The token list
// is then rendered to HTML. This is more robust than per-element regexes.

type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'codeblock'; lang: string; code: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'blockquote'; lines: string[] }
  | { kind: 'hr' }
  | { kind: 'container'; sub: 'tip' | 'note' | 'endnote'; lines: string[] }
  | { kind: 'break' };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;

  // Strip YAML front matter at the very top of the document. We require:
  //   1. The first non-blank line is exactly `---`.
  //   2. A closing `---` line appears later on its own line.
  //   3. Nothing else is rendered before that closing fence.
  // This is the same shape that Jekyll / Hugo / Hexo / Obsidian use.
  if (i < lines.length && /^\s*---\s*$/.test(lines[i])) {
    let j = i + 1;
    while (j < lines.length && !/^\s*---\s*$/.test(lines[j])) j++;
    if (j < lines.length) {
      // Skip the opening fence, the YAML body, and the closing fence,
      // plus any blank lines immediately after.
      i = j + 1;
      while (i < lines.length && /^\s*$/.test(lines[i])) i++;
    }
  }

  // Markdown blank lines separate blocks; they should not become visible
  // <br/> elements in the copied WeChat HTML. Hard line breaks inside
  // paragraphs are still represented by the mdast `break` node and are
  // rendered by renderMdastInline().
  const flushBreak = () => {};

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, '');

    // Blank line — don't emit a block, just remember the gap.
    if (/^\s*$/.test(line)) {
      // Blank line: end the current paragraph/block only.
      i++;
      continue;
    }

    // Some pasted/exported Markdown files contain literal HTML line-break
    // tags as standalone lines. Treat those like source blank lines too;
    // otherwise they become visible "<br />" text paragraphs in WeChat.
    if (/^<br\s*\/?>$/i.test(line.trim())) {
      i++;
      continue;
    }

    // Fenced code block ```lang\n...\n```
    const fence = /^```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] || '';
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      flushBreak();
      out.push({ kind: 'codeblock', lang, code: buf.join('\n') });
      continue;
    }

    // Container block (黑红刊刻风 tip / note / endnote).
    //   :::tip
    //   line 1
    //   line 2
    //   :::
    const open = /^:::\s*(tip|note|endnote)\s*$/i.exec(line);
    if (open) {
      const sub = open[1].toLowerCase() as 'tip' | 'note' | 'endnote';
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^:::\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing :::
      flushBreak();
      out.push({ kind: 'container', sub, lines: buf });
      continue;
    }

    // ATX heading
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushBreak();
      out.push({
        kind: 'heading',
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        text: heading[2],
      });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(\s*[-*_]){3,}\s*$/.test(line)) {
      flushBreak();
      out.push({ kind: 'hr' });
      i++;
      continue;
    }

    // Blockquote — one or more consecutive `> ` lines
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      flushBreak();
      out.push({ kind: 'blockquote', lines: buf });
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      flushBreak();
      out.push({ kind: 'ol', items });
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      flushBreak();
      out.push({ kind: 'ul', items });
      continue;
    }

    // Paragraph: gather until blank line / block-start
    const para: string[] = [line];
    i++;
    while (i < lines.length) {
      const peek = lines[i];
      if (
        /^\s*$/.test(peek) ||
        /^#{1,6}\s+/.test(peek) ||
        /^```/.test(peek) ||
        /^:::\s*(tip|note|endnote)\s*$/i.test(peek) ||
        /^:::\s*$/.test(peek) ||
        /^\s*[-*+]\s+/.test(peek) ||
        /^\s*\d+\.\s+/.test(peek) ||
        /^\s*>\s?/.test(peek) ||
        /^(\s*[-*_]){3,}\s*$/.test(peek)
      ) {
        break;
      }
      para.push(peek);
      i++;
    }
    const text = para.join(' ').trim();
    if (text) {
      flushBreak();
      out.push({ kind: 'paragraph', text });
    }
  }

  return out;
}

function collapseBreakRuns(html: string): string {
  // The renderer can emit several consecutive <br/> tags when a markdown
  // paragraph has trailing spaces on every line, or when a user types
  // literal "<br/>" markers into the source. WeChat's editor faithfully
  // pastes them all, which produces visible "walls" of empty lines.
  // Collapse any run of <br/> (with optional surrounding whitespace and
  // the placeholder we use for blank lines) down to a single <br/>.
  return html
    .replace(/(?:<br\s*\/?>(?:\s|<p>&nbsp;<\/p>)*){2,}/gi, '<br/>')
    .replace(/(?:<p>&nbsp;<\/p>\s*){2,}/gi, '<p>&nbsp;</p>');
}

// ----- Inline parser --------------------------------------------------------
//
// Order matters: code is stashed first so its content is never re-escaped;
// then images, links, bold, italic, strike, then hard line breaks.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInline(src: string): string {
  // 1. Stash inline code so its content escapes once and never gets
  //    re-processed by the other inline rules.
  const codeStash: string[] = [];
  let working = src.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const idx = codeStash.length;
    codeStash.push(inlineCodeHtml(escapeHtml(code)));
    return `\u0000CODE${idx}\u0000`;
  });

  // 2. Escape remaining HTML
  working = escapeHtml(working);

  // 3. Special 黑红刊刻风 emphasis (run BEFORE bold/italic so the markers
  //    don't collide with ** / __ / * / _).
  //    ==...==  → 关键句 (浅红底, weight 600)
  //    !!...!!  → 警示 / 转折 (浅黄底, weight 600)
  //    ++...++  → 方法名 / 操作项 (暖橙文字, weight 700)
  working = working.replace(
    /==([^=\n][^\n]*?)==/g,
    (_m, t: string) => highlightRedHtml(t),
  );
  working = working.replace(
    /!!([^!\n][^\n]*?)!!/g,
    (_m, t: string) => highlightYellowHtml(t),
  );
  working = working.replace(
    /\+\+([^\+\n][^\n]*?)\+\+/g,
    (_m, t: string) => methodNameHtml(t),
  );

  // 4. Images — ![alt](src)
  working = working.replace(
    /!\[([^\]]*)\]\(([^)\s]+)\)/g,
    (_m, alt: string, srcUrl: string) => imageHtml(srcUrl, alt),
  );

  // 5. Links — [text](href)
  working = working.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, text: string, href: string) => linkHtml(href, text),
  );

  // 6. Bold (** or __) — non-greedy. Per spec, bold uses 近黑 + weight 700
  //    and does NOT get letter-spacing.
  working = working.replace(
    /\*\*(.+?)\*\*|__(.+?)__/g,
    (_m, a: string, b: string) => strongHtml(a || b),
  );

  // 7. Italic (* or _) — non-greedy. Per spec, italic uses 暖深灰 #5f5355.
  working = working.replace(
    /\*(.+?)\*|_(.+?)_/g,
    (_m, a: string, b: string) => emHtml(a || b),
  );

  // 8. Strike ~~text~~
  working = working.replace(/~~(.+?)~~/g, (_m, t: string) => strikeHtml(t));

  // 9. Hard line breaks (two trailing spaces) → <br>
  working = working.replace(/(?:  \n)+/g, '<br/>\n');

  // 10. Restore inline code stashes
  working = working.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx: string) => {
    return codeStash[Number(idx)] ?? '';
  });

  return working;
}

// ----- Inline element builders ---------------------------------------------

function inlineCodeHtml(escaped: string): string {
  return (
    `<code style="font-family:${MONO_STACK};font-size:13px;` +
    `background:#f5efea;color:${C.red};padding:1px 6px;` +
    `border-radius:3px;">` +
    escaped +
    `</code>`
  );
}

function escapeAttr(value: string): string {
  // Escape `& " < >` for safe use inside an HTML attribute. We must
  // be careful: remark/mdast hands us URLs and alt text that are
  // ALREADY HTML-escaped (e.g. `&` -> `&amp;`). A naive
  // `.replace(/&/g, '&amp;')` would then turn `&amp;` into
  // `&amp;amp;`, which browsers and the WeChat editor decode back
  // to the literal string `&amp;` — breaking any URL whose query
  // string contains `&` and any alt text that mentions `&`. So this
  // function is IDEMPOTENT: it never re-escapes a `&` that is already
  // part of a valid HTML entity (named, decimal, or hex). It still
  // escapes `&` that is a bare ampersand (e.g. inside a URL query).
  return value
    .replace(/&(?!(?:amp|quot|lt|gt|apos|nbsp|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function imageHtml(srcUrl: string, alt: string): string {
  const safeSrc = escapeAttr(srcUrl);
  const safeAlt = escapeAttr(alt);
  return (
    `<img src="${safeSrc}" alt="${safeAlt}" data-aegis-image="1" ` +
    `style="display:block;width:100%;margin:24px 0;border-radius:6px;` +
    `border:1px solid ${C.border};" />`
  );
}

function linkHtml(href: string, text: string): string {
  return (
    `<a href="${href}" target="_blank" rel="noopener" ` +
    `style="color:${C.textSoft};text-decoration:none;` +
    `border-bottom:1.5px solid ${C.redBright};` +
    `padding-bottom:1px;font-weight:600;">` +
    text +
    `</a>`
  );
}

function strongHtml(text: string): string {
  // Bold is rendered WITHOUT the body's letter-spacing:1px; the spec is
  // explicit that 1px tracking is for continuous prose, not for short
  // emphatic spans like titles, labels, or bolded words.
  return `<strong style="color:${C.red};font-weight:700;">${text}</strong>`;
}

function emHtml(text: string): string {
  return `<em style="color:${C.textItalic};font-style:italic;">${text}</em>`;
}

function strikeHtml(text: string): string {
  return (
    `<s style="color:${C.textCaption};` +
    `text-decoration:line-through;">${text}</s>`
  );
}

// 黑红刊刻风 强调系统 — three of the four emphasis styles from the
// prompt. (The fourth — 核心概念 下划线 — overlaps with our link style
// and is left to the link/strong renderers.)
function highlightRedHtml(text: string): string {
  if (currentTheme.id === 'lapis') {
    return `<span style="color:${C.redHighlightText};font-weight:700;">${text}</span>`;
  }

  // 关键句: 深棕底条 #3a2410, 浅亮橙文字 #FFB04A,
  // 圆角 3px, weight 600, 1px padding.
  return (
    `<span style="background:${C.redHighlightBg};` +
    `color:${C.redHighlightText};font-weight:600;` +
    `padding:1px 4px;border-radius:3px;">${text}</span>`
  );
}

function highlightYellowHtml(text: string): string {
  // 警示 / 转折: 浅黄底条 #fff1bf, 圆角 3px, weight 600
  return (
    `<span style="background:${C.yellowHighlightBg};` +
    `color:${C.text};font-weight:600;` +
    `padding:1px 4px;border-radius:3px;">${text}</span>`
  );
}

function methodNameHtml(text: string): string {
  // 方法名 / 操作项: 暖橙文字 #F87B02, weight 700
  return (
    `<span style="color:${C.red};font-weight:700;">${text}</span>`
  );
}

// ----- Block renderer -------------------------------------------------------

interface RenderState {
  h2Counter: number; // 0-based, formatted as "01" / "02" / ...
}

function renderBlock(b: Block, state: RenderState): string {
  switch (b.kind) {
    case 'heading': {
      const inner = renderInline(b.text);
      // H1: per spec ("不要输出文章标题、刊头、封面标题区块") we DO NOT
      // render H1 in the body — the WeChat editor shows the article
      // title separately. H1 is still used (only) for <title> extraction.
      if (b.level === 1) return '';
      if (b.level === 2) {
        state.h2Counter += 1;
        return h2SectionHtml(inner, state.h2Counter);
      }
      if (b.level === 3) return h3SubsectionHtml(inner);
      if (b.level === 4) return h4SubSubsectionHtml(inner);
      if (b.level === 5) return h5MinorHtml(inner);
      return h6MinorHtml(inner);
    }
    case 'paragraph': {
      return paragraphHtml(b.text);
    }
    case 'codeblock': {
      return codeBlockHtml(b.lang, b.code);
    }
    case 'ul': {
      return ulHtml(b.items);
    }
    case 'ol': {
      return olHtml(b.items);
    }
    case 'blockquote': {
      return blockquoteHtml(b.lines);
    }
    case 'hr': {
      return hrHtml();
    }
    case 'container': {
      if (b.sub === 'tip') return tipCardHtml(b.lines);
      if (b.sub === 'note') return noteCardHtml(b.lines);
      return endNoteHtml(b.lines);
    }
    case 'break': {
      return breakHtml();
    }
  }
}

// ----- Block element builders ----------------------------------------------

/**
 * 将 inner HTML 文本节点中的数字串包成 <span style="font-family:SERIF_STACK">,
 * 用于标题中"印出数字"的刊刻感. 状态机区分 tag 内外, 不污染属性值.
 */
function wrapNumbersInSerif(html: string): string {
  let out = '';
  let inTag = false;
  let buf = '';
  const flush = () => {
    out += buf.replace(
      /(\d+)/g,
      `<span style="font-family:${SERIF_STACK};">$1</span>`
    );
    buf = '';
  };
  for (let i = 0; i < html.length; i++) {
    const ch = html[i];
    if (ch === '<') {
      flush();
      inTag = true;
      out += ch;
    } else if (ch === '>') {
      inTag = false;
      out += ch;
    } else if (inTag) {
      out += ch;
    } else {
      buf += ch;
    }
  }
  flush();
  return out;
}

function h2SectionHtml(inner: string, n: number): string {
  if (currentTheme.id === 'lapis') return h2LapisSectionHtml(inner);
  const tag = `Section ${String(n).padStart(2, '0')}`;
  return (
    `<div style="margin:42px 0 22px;">` +
    `<div style="display:flex;align-items:baseline;gap:10px;` +
    `flex-wrap:wrap;margin-bottom:10px;">` +
    `<span style="display:inline-block;padding:2px 8px;` +
    `background:${C.red};color:${C.redTagText};font-size:12px;` +
    `line-height:1.4;letter-spacing:1px;font-weight:700;` +
    `text-transform:uppercase;">${tag}</span>` +
    `<span style="font-family:${FONT_STACK};font-size:18px;` +
    `line-height:1.4;font-weight:700;color:#111111;` +
    `letter-spacing:0.3px;">${formatHeadingInner(inner)}</span>` +
    `</div>` +
    `<div style="width:48%;height:2px;` +
    `background:linear-gradient(90deg,#111111 0%,${C.red} 62%,` +
    `rgba(143,29,34,0.12) 100%);"></div>` +
    `</div>`
  );
}

function h2LapisSectionHtml(inner: string): string {
  return (
    `<div style="margin:42px 0 22px;">` +
    `<h2 style="font-family:${FONT_STACK};font-size:20px;` +
    `line-height:1.35;font-weight:800;color:${C.text};` +
    `letter-spacing:-0.2px;margin:0 0 10px;">${formatHeadingInner(inner)}</h2>` +
    `<div style="width:100%;height:1px;background:${C.red};"></div>` +
    `</div>`
  );
}

function h3SubsectionHtml(inner: string): string {
  if (currentTheme.id === 'lapis') {
    return (
      `<h3 style="font-family:${FONT_STACK};font-size:16px;` +
      `font-weight:800;color:${C.textSoft};line-height:1.5;` +
      `margin:28px 0 12px;letter-spacing:0.1px;` +
      `display:flex;align-items:center;gap:8px;">` +
      `<span style="display:inline-block;color:${C.red};font-size:12px;` +
      `line-height:1;flex-shrink:0;">■</span>` +
      `${formatHeadingInner(inner)}</h3>`
    );
  }
  // H3 三级: 红 1px 左边框 + 近黑 #1f1f1f + 16px / weight 700. 比 H2 收敛
  // 但仍带橙色触点, 维持刊刻风的色系节奏.
  return (
    `<h3 style="font-family:${FONT_STACK};font-size:16px;` +
    `font-weight:700;color:#1f1f1f;line-height:1.5;` +
    `margin:28px 0 12px;letter-spacing:0.3px;` +
    `padding-left:10px;border-left:2px solid ${C.red};">${formatHeadingInner(inner)}</h3>`
  );
}

function h4SubSubsectionHtml(inner: string): string {
  if (currentTheme.id === 'lapis') {
    return (
      `<h4 style="font-family:${FONT_STACK};font-size:15px;` +
      `font-weight:800;color:${C.textSoft};line-height:1.5;` +
      `margin:22px 0 10px;padding-left:10px;` +
      `border-left:3px solid ${C.red};letter-spacing:0.1px;">` +
      `${formatHeadingInner(inner)}</h4>`
    );
  }
  // H4 四级: 仅 15px 近黑文字, 不再带色块, 用 0.5em 红小方块作 bullet.
  return (
    `<h4 style="font-family:${FONT_STACK};font-size:15px;` +
    `font-weight:700;color:#1f1f1f;line-height:1.5;` +
    `margin:22px 0 10px;display:flex;align-items:center;` +
    `gap:8px;letter-spacing:0.3px;">` +
    `<span style="display:inline-block;width:6px;height:6px;` +
    `background:${C.red};border-radius:50%;` +
    `flex-shrink:0;"></span>${formatHeadingInner(inner)}</h4>`
  );
}

function h5MinorHtml(inner: string): string {
  // H5 五级: 14px + 0.3em 短红线, 视觉更轻, 用在子小节.
  return (
    `<h5 style="font-family:${FONT_STACK};font-size:14px;` +
    `font-weight:700;color:#1f1f1f;line-height:1.5;` +
    `margin:18px 0 8px;display:flex;align-items:center;` +
    `gap:8px;">` +
    `<span style="display:inline-block;width:14px;height:2px;` +
    `background:${C.red};flex-shrink:0;"></span>${formatHeadingInner(inner)}</h5>`
  );
}

function h6MinorHtml(inner: string): string {
  if (currentTheme.id === 'lapis') {
    return (
      `<h6 style="font-family:${FONT_STACK};font-size:13px;` +
      `font-weight:700;color:${C.textMuted};line-height:1.5;` +
      `margin:18px 0 8px;display:flex;align-items:center;` +
      `gap:6px;letter-spacing:0.2px;">` +
      `<span style="display:inline-block;color:${C.red};font-size:18px;` +
      `line-height:1;flex-shrink:0;">·</span>${formatHeadingInner(inner)}</h6>`
    );
  }
  // H6 六级: 13px + 灰底小标签, 用于最末级附注.
  return (
    `<h6 style="font-family:${FONT_STACK};font-size:13px;` +
    `font-weight:600;color:${C.textMuted};line-height:1.5;` +
    `margin:18px 0 8px;display:flex;align-items:center;` +
    `gap:6px;">` +
    `<span style="display:inline-block;width:6px;height:6px;` +
    `background:${C.textMuted};transform:rotate(45deg);` +
    `flex-shrink:0;"></span>${formatHeadingInner(inner)}</h6>`
  );
}

function formatHeadingInner(inner: string): string {
  return currentTheme.useSerifForHeadingNumbers ? wrapNumbersInSerif(inner) : inner;
}

function paragraphHtml(text: string): string {
  return (
    `<p style="margin:16px 0;color:${C.textBody};font-size:15px;` +
    `line-height:1.85;letter-spacing:1px;">` +
    collapseBreakRuns(renderInline(text)) +
    `</p>`
  );
}

function codeBlockHtml(lang: string, code: string): string {
  const langLabel = lang
    ? `<span style="font-family:${MONO_STACK};font-size:12px;` +
      `line-height:1.3;color:#d8b9bc;text-transform:uppercase;` +
      `letter-spacing:0.5px;">${escapeHtml(lang)}</span>`
    : '';
  return (
    `<section style="margin:22px 0;border:1px solid ${C.codeBorder};` +
    `border-radius:8px;overflow:hidden;background:${C.cardBg};` +
    `box-shadow:0 10px 20px ${C.shadow};">` +
    `<div style="display:flex;align-items:center;` +
    `justify-content:space-between;padding:10px 12px;` +
    `background:${C.codeBarBg};">` +
    `<span style="font-size:12px;line-height:1.3;` +
    `letter-spacing:1.2px;color:#f6eaea;font-weight:700;` +
    `text-transform:uppercase;">Code</span>` +
    langLabel +
    `</div>` +
    `<pre style="margin:0;padding:14px 16px;background:${C.cardBg};` +
    `overflow-x:auto;"><code style="font-family:${MONO_STACK};` +
    `font-size:14px;line-height:1.8;color:#171717;` +
    `white-space:pre;">` +
    escapeHtml(code) +
    `</code></pre></section>`
  );
}

function ulHtml(items: string[]): string {
  // The bullet is an inline-block span sitting in the natural text flow.
  // We avoid position:absolute on the bullet — the WeChat editor can
  // sometimes clip absolutely-positioned spans that extend past the li
  // box (e.g. when the editor normalises margins), and that shows up as
  // a missing or misplaced dot.
  const lis = items
    .map(
      (t) =>
        `<li style="font-family:${FONT_STACK};font-size:15px;` +
        `line-height:1.85;color:${C.textBody};margin:6px 0;` +
        `letter-spacing:1px;list-style:none;">` +
        `<span style="display:inline-block;color:${C.red};` +
        `font-weight:700;margin-right:6px;">·</span>` +
        renderInline(t) +
        `</li>`,
    )
    .join('');
  return `<ul style="margin:14px 0;padding:0;list-style:none;">${lis}</ul>`;
}

function olHtml(items: string[]): string {
  const lis = items
    .map(
      (t, idx) =>
        `<li style="font-family:${FONT_STACK};font-size:15px;` +
        `line-height:1.85;color:${C.textBody};margin:6px 0;` +
        `letter-spacing:1px;list-style:none;">` +
        `<span style="display:inline-block;color:${C.red};` +
        `font-weight:700;margin-right:8px;min-width:22px;">` +
        `${String(idx + 1).padStart(2, '0')}.</span>` +
        renderInline(t) +
        `</li>`,
    )
    .join('');
  return `<ol style="margin:14px 0;padding:0;list-style:none;">${lis}</ol>`;
}

function blockquoteHtml(lines: string[]): string {
  const inner = lines.map(renderInline).join('<br/>');
  return (
    `<blockquote style="margin:24px 0;padding:8px 0 8px 16px;` +
    `border-left:3px solid #111111;">` +
    `<p style="margin:0;color:${C.textDim};font-size:15px;` +
    `line-height:1.9;letter-spacing:1px;">${inner}</p>` +
    `</blockquote>`
  );
}

function hrHtml(): string {
  return (
    `<hr style="border:none;margin:36px auto;height:2px;width:42%;` +
    `background:linear-gradient(90deg,${C.text} 0%,${C.red} 62%,` +
    `rgba(143,29,34,0.12) 100%);" />`
  );
}

function breakHtml(): string {
  // 14px 占位 — from BLACK_RED_IMPRINT_SYSTEM_PROMPT:
  //   "14px 占位：<p style="margin:0;height:14px;line-height:14px;">&nbsp;</p>"
  // We use &nbsp; rather than space so the placeholder always has
  // height even if the editor strips empty text.
  return (
    `<p style="margin:0;height:14px;line-height:14px;">&nbsp;</p>`
  );
}

// ----- Container blocks (黑红刊刻风 tip / note / endnote) -------------------

function tipCardHtml(lines: string[]): string {
  // 提示卡: 背景 #fff7f7, 边框 1px #ead9db, 左边框 4px #8f1d22,
  // padding 14px 16px, 内部 14px 颜色 #2b1d1f 行高 1.85.
  // We add a small "提示 / TIP" tag at the top.
  const inner = lines.map(renderInline).join('<br/>');
  return (
    `<section style="margin:22px 0;padding:14px 16px;` +
    `background:${C.redCardBg};border:1px solid ${C.redCardBorder};` +
    `border-left:4px solid ${C.red};border-radius:4px;">` +
    `<div style="font-family:${FONT_STACK};font-size:12px;` +
    `font-weight:700;letter-spacing:1.5px;` +
    `color:${C.red};text-transform:uppercase;margin-bottom:6px;">` +
    `提示` +
    `</div>` +
    `<p style="margin:0;font-family:${FONT_STACK};font-size:15px;` +
    `line-height:1.85;letter-spacing:1px;color:${C.redCardText};">${inner}</p>` +
    `</section>`
  );
}

function noteCardHtml(lines: string[]): string {
  // Note uses the same 提示卡 visual language but with a 备注 / NOTE label.
  // It's distinguishable from tip by its label, so users can decide which
  // one fits the content.
  const inner = lines.map(renderInline).join('<br/>');
  return (
    `<section style="margin:22px 0;padding:14px 16px;` +
    `background:${C.redCardBg};border:1px solid ${C.redCardBorder};` +
    `border-left:4px solid ${C.red};border-radius:4px;">` +
    `<div style="font-family:${FONT_STACK};font-size:12px;` +
    `font-weight:700;letter-spacing:1.5px;` +
    `color:${C.red};text-transform:uppercase;margin-bottom:6px;">` +
    `备注` +
    `</div>` +
    `<p style="margin:0;font-family:${FONT_STACK};font-size:15px;` +
    `line-height:1.85;letter-spacing:1px;color:${C.redCardText};">${inner}</p>` +
    `</section>`
  );
}

function endNoteHtml(lines: string[]): string {
  // 结尾收束. The spec says:
  //   1. 顶部一个 "End Note" 橙色 section 标签
  //   2. 一句收束话 (18px, weight 700, color #111)
  //   3. 后续一行小字 (14px, color #5b4b4d)
  // The container accepts up to two non-blank lines: the first becomes
  // the 收束句, the second becomes the 副小字. Extra lines are joined
  // onto the 副小字.
  const cleaned = lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const headline = cleaned[0] ?? '';
  const sub = cleaned.slice(1).join(' ') ?? '';
  return (
    `<section style="margin:48px 0 12px;">` +
    `<span style="display:inline-block;padding:2px 8px;` +
    `background:${C.red};color:${C.redTagText};font-size:12px;` +
    `line-height:1.4;letter-spacing:1px;font-weight:700;` +
    `text-transform:uppercase;margin-bottom:14px;">` +
    `End Note` +
    `</span>` +
    `<p style="margin:8px 0 6px;font-family:${FONT_STACK};` +
    `font-size:18px;font-weight:700;line-height:1.5;` +
    `color:#111111;letter-spacing:0.5px;">` +
    renderInline(headline) +
    `</p>` +
    (sub
      ? `<p style="margin:0;font-family:${FONT_STACK};font-size:15px;` +
        `line-height:1.85;color:${C.textMuted};letter-spacing:1px;">` +
        renderInline(sub) +
        `</p>`
      : ``) +
    `<div style="width:48%;height:2px;margin-top:18px;` +
    `background:linear-gradient(90deg,#111111 0%,${C.red} 62%,` +
    `rgba(143,29,34,0.12) 100%);"></div>` +
    `</section>`
  );
}

// ----- Container + footer ---------------------------------------------------

/**
 * The WeChat editor magic marker. It tells the WeChat editor to apply the
 * user-imported style (the "3" value) so the pasted content keeps its
 * formatting. Per BLACK_RED_IMPRINT_SYSTEM_PROMPT:
 *   "文末必须包含：<p style="display: none;">
 *      <mp-style-type data-value="3"></mp-style-type>
 *    </p>"
 */
const WECHAT_STYLE_MARKER =
  `<p style="display: none;"><mp-style-type data-value="3"></mp-style-type></p>`;

/**
 * Convert markdown to a self-contained WeChat-friendly HTML string using
 * the 「黑红刊刻风」 fixed template. All styles are inline so the result
 * survives the WeChat editor paste.
 *
 * The output is a complete HTML document (DOCTYPE + <html> + <head> +
 * <body>) so it can be opened directly in a browser, dropped into an
 * HTML preview tool, or pasted into the WeChat editor. The <title> walks
 * through H1 → H2 → ... → H6 → first non-empty content line → "Document".
 *
 * YAML front matter at the top of the markdown is stripped and never
 * rendered.
 */
function extractDocumentTitle(blocks: Block[]): string {
  for (let level = 1; level <= 6; level += 1) {
    const heading = blocks.find(
      (b): b is Extract<Block, { kind: 'heading' }> =>
        b.kind === 'heading' && b.level === level,
    );
    const text = heading?.text.trim();
    if (text) return text;
  }

  const firstContent = blocks.find((b) => {
    if (b.kind === 'paragraph') return b.text.trim().length > 0;
    if (b.kind === 'blockquote') return b.lines.some((l) => l.trim());
    if (b.kind === 'container') return b.lines.some((l) => l.trim());
    if (b.kind === 'ul' || b.kind === 'ol') return b.items.some((l) => l.trim());
    if (b.kind === 'codeblock') return b.code.trim().length > 0;
    return false;
  });

  if (!firstContent) return 'Document';
  if (firstContent.kind === 'paragraph') return firstContent.text.trim();
  if (firstContent.kind === 'blockquote' || firstContent.kind === 'container') {
    return firstContent.lines.find((l) => l.trim())?.trim() ?? 'Document';
  }
  if (firstContent.kind === 'ul' || firstContent.kind === 'ol') {
    return firstContent.items.find((l) => l.trim())?.trim() ?? 'Document';
  }
  if (firstContent.kind === 'codeblock') return firstContent.code.trim().split('\n')[0] ?? 'Document';
  return 'Document';
}

function renderWechatBody(markdown: string): string {
  const blocks = parseBlocks(markdown);
  const state: RenderState = { h2Counter: 0 };
  return blocks.map((b) => renderBlock(b, state)).join('\n');
}

function markdownToWechatHtmlFragment(
  markdown: string,
  themeId: WeChatThemeId = 'bubblebrain',
): string {
  return withWechatTheme(themeId, () => {
    const body = renderWechatBody(markdown);
    return (
      `<section data-aegis-wechat-theme="${currentTheme.htmlName}" ` +
      `style="font-family:${FONT_STACK};background:${C.pageBg};` +
    `color:${C.text};max-width:700px;margin:0 auto;` +
    `padding:22px 20px;font-size:15px;line-height:1.85;">` +
      body +
      WECHAT_STYLE_MARKER +
      `</section>`
    );
  });
}

export function markdownToWechatHtml(
  markdown: string,
  themeId: WeChatThemeId = 'bubblebrain',
): string {
  const blocks = parseBlocks(markdown);
  const title = extractDocumentTitle(blocks);

  const fragment = markdownToWechatHtmlFragment(markdown, themeId);

  return (
    `<!DOCTYPE html>\n` +
    `<html lang="zh-CN">\n` +
    `<head>\n` +
    `<meta charset="UTF-8">\n` +
    `<title>${escapeHtml(title)}</title>\n` +
    `</head>\n` +
    `<body>\n` +
    fragment +
    `\n</body>\n` +
    `</html>`
  );
}

/**
 * Copy the WeChat-flavored HTML for the given markdown to the clipboard.
 * Returns a tagged result so the caller can surface a success/error toast.
 *
 * Strategy order (each step falls through to the next on failure):
 *
 *  1. contenteditable + execCommand('copy')  ← the canonical "copy rich
 *     text from a web view" technique. Chromium computes both the
 *     text/html and text/plain flavors from the selected range and
 *     pushes them onto the OS clipboard. This is the most reliable
 *     path inside Electron renderers, where navigator.clipboard
 *     permissioning and the secure-context check can be flaky.
 *
 *  2. navigator.clipboard.write with text/html only. We intentionally
 *     do NOT set text/plain=markdown here. When both flavors are
 *     present, some Chromium-based editors (notably the 公众号
 *     editor) read text/plain and end up pasting the raw markdown
 *     source instead of the styled HTML. Sending only text/html forces
 *     the editor to take the rich path.
 *
 *  3. navigator.clipboard.writeText(html). Last-resort. Pastes the
 *     HTML string as plain text — not what the user wanted, but at
 *     least something is on the clipboard.
 */
export async function copyMarkdownAsWechatHtml(
  markdown: string,
  themeId: WeChatThemeId = 'bubblebrain',
): Promise<WeChatCopyResult> {
  const html = markdownToWechatHtml(markdown, themeId);
  const clipboardHtml = markdownToWechatHtmlFragment(markdown, themeId);

  // 1. Prefer the modern Clipboard API. For clipboard text/html, write the
  // WeChat body fragment rather than a full <!doctype><html><body> document.
  // Rich-text editors normally paste fragments; full documents are commonly
  // sanitized into plain structure before inline styles are preserved.
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      const item = new ClipboardItem({
        'text/html': new Blob([clipboardHtml], { type: 'text/html' }),
        'text/plain': new Blob([markdown], { type: 'text/plain' }),
      });
      await navigator.clipboard.write([item]);
      return { ok: true, html, bytes: html.length };
    }
  } catch (err) {
    void err;
  }

  // 2. Fallback: contenteditable + execCommand. This helps in environments
  // where clipboard.write is blocked by browser/Electron security policy.
  try {
    if (copyViaContentEditable(clipboardHtml)) {
      return { ok: true, html, bytes: html.length };
    }
  } catch (err) {
    void err;
  }

  // 3. writeText fallback (HTML written as text)
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(html);
      return { ok: true, html, bytes: html.length };
    }
  } catch (err) {
    void err;
  }

  return {
    ok: false,
    error: '所有剪贴板写入路径都不可用(可能被浏览器/Electron 安全策略禁用)',
  };
}

/**
 * Place HTML into a hidden contentEditable element, select it, and ask
 * the browser to copy it. Chromium converts the selection into the
 * text/html + text/plain pair that the OS clipboard expects, and
 * downstream apps (including the 公众号 editor) read text/html first.
 */
function copyViaContentEditable(html: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;

  const container = document.createElement('div');
  container.contentEditable = 'true';
  container.innerHTML = html;
  // Off-screen, invisible, non-interactive. The element still has to
  // be in the layout tree for the Range selection to be valid.
  container.style.position = 'fixed';
  container.style.top = '0';
  container.style.left = '-10000px';
  container.style.width = '1px';
  container.style.height = '1px';
  container.style.padding = '0';
  container.style.margin = '0';
  container.style.border = '0';
  container.style.opacity = '0';
  container.style.pointerEvents = 'none';
  // Disable spell-check on the off-screen element so the browser
  // doesn't briefly underline text in the user's view.
  container.setAttribute('spellcheck', 'false');
  document.body.appendChild(container);

  const range = document.createRange();
  range.selectNodeContents(container);

  const selection = window.getSelection();
  if (!selection) {
    document.body.removeChild(container);
    return false;
  }
  selection.removeAllRanges();
  selection.addRange(range);

  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }

  selection.removeAllRanges();
  document.body.removeChild(container);
  return ok;
}

/**
 * Ranking for the sidebar command palette. Every candidate field is graded
 * against the whole query phrase (exact > leading > anywhere), each grade maps
 * to a weight from the tables below, and a candidate's weight decides its
 * place. Multi-word queries additionally match a message that contains every
 * word. Pure functions only, so the palette stays a thin view.
 */

export interface PaletteAction {
  id: string;
  label: string;
  description: string;
  keywords?: readonly string[];
  shortcut?: string | null;
}

export interface PaletteProject {
  /** The project's working directory; the palette hands it back on open. */
  id: string;
  name: string;
  cwd: string;
  sessionCount: number;
  lastUpdatedAt: number;
}

export interface PaletteThread {
  id: string;
  title: string;
  projectName: string;
  updatedAt: number;
  /** Visible message text, only for sessions whose history is loaded. */
  texts: readonly string[];
}

export type ThreadHitSource = 'title' | 'message' | 'project';

export interface ThreadHit {
  thread: PaletteThread;
  source: ThreadHitSource;
  /** A window of the best matching message, for message hits. */
  excerpt: string | null;
  /** How many messages matched, whatever the hit source. */
  messageHits: number;
}

export interface PaletteResults {
  actions: PaletteAction[];
  threads: ThreadHit[];
  projects: PaletteProject[];
}

export const RECENT_THREAD_COUNT = 5;
export const THREAD_RESULT_LIMIT = 8;
export const PROJECT_RESULT_LIMIT = 6;
export const EXCERPT_LENGTH = 88;
const EXCERPT_LEAD = 28;

type Grade = 'exact' | 'leading' | 'anywhere';
type WeightTable = Partial<Record<Grade, number>>;

const ACTION_LABEL: WeightTable = { exact: 140, leading: 120, anywhere: 100 };
const ACTION_KEYWORD: WeightTable = { exact: 110, anywhere: 90 };
const ACTION_DESCRIPTION: WeightTable = { anywhere: 70 };
const PROJECT_NAME: WeightTable = { exact: 150, leading: 130, anywhere: 105 };
const PROJECT_CWD: WeightTable = { anywhere: 70 };
const THREAD_TITLE: WeightTable = { exact: 170, leading: 145, anywhere: 125 };
const THREAD_MESSAGE: WeightTable = { exact: 165, leading: 155, anywhere: 145 };
const THREAD_MESSAGE_ALL_WORDS = 132;
const THREAD_PROJECT: WeightTable = { leading: 80, anywhere: 65 };

interface Query {
  phrase: string;
  words: string[];
}

function fold(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function parseQuery(raw: string): Query {
  const phrase = fold(raw);
  return { phrase, words: phrase ? phrase.split(' ') : [] };
}

const GRADE_TESTS: Array<[Grade, (folded: string, phrase: string) => boolean]> = [
  ['exact', (folded, phrase) => folded === phrase],
  ['leading', (folded, phrase) => folded.startsWith(phrase)],
  ['anywhere', (folded, phrase) => folded.includes(phrase)],
];

/** The strongest grade the table weighs that `value` satisfies; an exact hit also counts as leading and anywhere. */
function weigh(table: WeightTable, value: string, phrase: string): number {
  const folded = fold(value);
  if (!folded || !phrase) return 0;
  for (const [grade, test] of GRADE_TESTS) {
    if (table[grade] !== undefined && test(folded, phrase)) return table[grade];
  }
  return 0;
}

function bestOf(...weights: number[]): number {
  return Math.max(0, ...weights);
}

type Ranked<T> = { item: T; weight: number; order: number };

/** Highest weight first; `tieBreak` orders equal weights, then input order. */
function rank<T>(entries: Ranked<T>[], tieBreak: (a: T, b: T) => number, limit = Infinity): T[] {
  return entries
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || tieBreak(a.item, b.item) || a.order - b.order)
    .slice(0, limit)
    .map((entry) => entry.item);
}

export function searchActions(actions: readonly PaletteAction[], rawQuery: string): PaletteAction[] {
  const { phrase } = parseQuery(rawQuery);
  if (!phrase) return [...actions];
  return rank(
    actions.map((action, order) => ({
      item: action,
      order,
      weight: bestOf(
        weigh(ACTION_LABEL, action.label, phrase),
        ...(action.keywords ?? []).map((keyword) => weigh(ACTION_KEYWORD, keyword, phrase)),
        weigh(ACTION_DESCRIPTION, action.description, phrase)
      ),
    })),
    () => 0
  );
}

export function searchProjects(
  projects: readonly PaletteProject[],
  rawQuery: string,
  limit = PROJECT_RESULT_LIMIT
): PaletteProject[] {
  const { phrase } = parseQuery(rawQuery);
  if (!phrase) return [];
  return rank(
    projects.map((project, order) => ({
      item: project,
      order,
      weight: bestOf(weigh(PROJECT_NAME, project.name, phrase), weigh(PROJECT_CWD, project.cwd, phrase)),
    })),
    (a, b) => b.lastUpdatedAt - a.lastUpdatedAt || a.name.localeCompare(b.name),
    limit
  );
}

// Folding every message on each keystroke is the palette's hot path; keep the
// folded copy until a thread's history changes.
const foldedTexts = new Map<string, { source: readonly string[]; folded: string[] }>();

function foldThreadTexts(thread: PaletteThread): string[] {
  const cached = foldedTexts.get(thread.id);
  if (cached && cached.source === thread.texts) return cached.folded;
  if (cached && cached.source.length === thread.texts.length && cached.source.every((text, i) => text === thread.texts[i])) {
    cached.source = thread.texts;
    return cached.folded;
  }
  const folded = thread.texts.map(fold);
  foldedTexts.set(thread.id, { source: thread.texts, folded });
  return folded;
}

function scoreMessages(thread: PaletteThread, query: Query): { weight: number; best: number; hits: number } {
  let weight = 0;
  let best = -1;
  let hits = 0;
  foldThreadTexts(thread).forEach((text, index) => {
    if (!text) return;
    let w = weigh(THREAD_MESSAGE, text, query.phrase);
    if (!w && query.words.length > 1 && query.words.every((word) => text.includes(word))) {
      w = THREAD_MESSAGE_ALL_WORDS;
    }
    if (!w) return;
    hits += 1;
    if (w > weight) {
      weight = w;
      best = index;
    }
  });
  return { weight, best, hits };
}

export function searchThreads(
  threads: readonly PaletteThread[],
  rawQuery: string,
  limit = THREAD_RESULT_LIMIT
): ThreadHit[] {
  const query = parseQuery(rawQuery);
  if (!query.phrase) {
    return [...threads]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, RECENT_THREAD_COUNT)
      .map((thread) => ({ thread, source: 'title', excerpt: null, messageHits: 0 }));
  }

  const entries: Ranked<ThreadHit>[] = threads.map((thread, order) => {
    const messages = scoreMessages(thread, query);
    // A thread is reported by its strongest kind of evidence: its title,
    // then what was said in it, then the project it belongs to.
    const title = weigh(THREAD_TITLE, thread.title, query.phrase);
    const hit = (source: ThreadHitSource, weight: number, excerpt: string | null) => ({
      item: { thread, source, excerpt, messageHits: messages.hits },
      order,
      weight,
    });
    if (title) return hit('title', title, null);
    if (messages.weight) {
      return hit('message', messages.weight, excerptAround(thread.texts[messages.best], query));
    }
    return hit('project', weigh(THREAD_PROJECT, thread.projectName, query.phrase), null);
  });

  return rank(
    entries,
    (a, b) => b.thread.updatedAt - a.thread.updatedAt || a.thread.title.length - b.thread.title.length,
    limit
  );
}

export function searchPalette(
  input: { actions: readonly PaletteAction[]; projects: readonly PaletteProject[]; threads: readonly PaletteThread[] },
  rawQuery: string
): PaletteResults {
  return {
    actions: searchActions(input.actions, rawQuery),
    threads: searchThreads(input.threads, rawQuery),
    projects: searchProjects(input.projects, rawQuery),
  };
}

export function isEmptyResult(results: PaletteResults): boolean {
  return results.actions.length + results.threads.length + results.projects.length === 0;
}

/**
 * A fixed-length window of `text` that shows the match with some lead-in.
 * Falls back to the earliest single word when the phrase spans a line break
 * or other whitespace that folding collapsed.
 */
export function excerptAround(text: string, rawQuery: string | Query): string {
  const query = typeof rawQuery === 'string' ? parseQuery(rawQuery) : rawQuery;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= EXCERPT_LENGTH) return flat;

  const lower = flat.toLowerCase();
  let at = query.phrase ? lower.indexOf(query.phrase) : -1;
  if (at < 0) {
    const positions = query.words.map((word) => lower.indexOf(word)).filter((index) => index >= 0);
    at = positions.length ? Math.min(...positions) : 0;
  }

  const from = Math.max(0, Math.min(at - EXCERPT_LEAD, flat.length - EXCERPT_LENGTH));
  const to = Math.min(flat.length, from + EXCERPT_LENGTH);
  return `${from > 0 ? '…' : ''}${flat.slice(from, to).trim()}${to < flat.length ? '…' : ''}`;
}

export interface MarkedSpan {
  text: string;
  marked: boolean;
}

/** Splits `text` into spans, marking every case-insensitive occurrence of a query word. */
export function markQueryWords(text: string, rawQuery: string): MarkedSpan[] {
  const words = [...new Set(parseQuery(rawQuery).words)].sort((a, b) => b.length - a.length);
  if (!words.length || !text) return text ? [{ text, marked: false }] : [];

  const lower = text.toLowerCase();
  const spans: MarkedSpan[] = [];
  let plainStart = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const word = words.find((candidate) => lower.startsWith(candidate, cursor));
    if (!word) {
      cursor += 1;
      continue;
    }
    if (cursor > plainStart) spans.push({ text: text.slice(plainStart, cursor), marked: false });
    spans.push({ text: text.slice(cursor, cursor + word.length), marked: true });
    cursor += word.length;
    plainStart = cursor;
  }
  if (plainStart < text.length) spans.push({ text: text.slice(plainStart), marked: false });
  return spans;
}

/** Compact age for result rows: minutes, hours, days for a week, then a date. */
export function formatAge(timestamp: number | undefined, now = Date.now()): string {
  if (!timestamp) return '';
  const minutes = (now - timestamp) / 60_000;
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.max(1, Math.round(hours))}h`;
  const days = Math.max(1, Math.round(hours / 24));
  if (days <= 7) return `${days}d`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(timestamp);
}

export function threadHitLabel(hit: Pick<ThreadHit, 'source' | 'messageHits'>): string | null {
  if (hit.source === 'project') return 'Project match';
  if (hit.source !== 'message') return null;
  return hit.messageHits > 1 ? `${hit.messageHits} chat hits` : 'Chat match';
}

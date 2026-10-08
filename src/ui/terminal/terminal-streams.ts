/**
 * The data paths around one embedded terminal, kept free of xterm and DOM so
 * they can be tested with a fake clock:
 *  - OutputQueue: everything shown in the terminal, in arrival order. Batched
 *    per frame while the terminal is on screen, held (with a bounded tail)
 *    while it is not.
 *  - SizeSync: tells the pty about grid size changes, debounced and
 *    deduplicated, and forgets a size the backend refused.
 *  - Input helpers: drop terminal report sequences and split large pastes
 *    into writes the backend accepts.
 */

export interface Clock {
  now(): number;
  frame(run: () => void): number;
  cancelFrame(handle: number): void;
  delay(run: () => void, ms: number): number;
  cancelDelay(handle: number): void;
}

export const browserClock: Clock = {
  now: () => performance.now(),
  frame: (run) => window.requestAnimationFrame(run),
  cancelFrame: (handle) => window.cancelAnimationFrame(handle),
  delay: (run, ms) => window.setTimeout(run, ms),
  cancelDelay: (handle) => window.clearTimeout(handle),
};

export interface OutputQueueLimits {
  /** Write at once when this much is waiting, without waiting for a frame. */
  burst: number;
  /** Longest a chunk may wait for a frame while on screen. */
  maxLatencyMs: number;
  /** Characters kept while off screen; older output is dropped. */
  heldTail: number;
}

const DEFAULT_LIMITS: OutputQueueLimits = { burst: 256 * 1024, maxLatencyMs: 50, heldTail: 512 * 1024 };
const RESET_ATTRIBUTES = '\x1b[0m';
// When trimming held output, prefer cutting at a line start within this
// distance so the kept tail does not begin inside an escape sequence.
const TRIM_LINE_SEARCH = 8 * 1024;

export class OutputQueue {
  private chunks: string[] = [];
  private length = 0;
  private onScreen = false;
  private frameHandle: number | null = null;
  private latencyHandle: number | null = null;

  constructor(
    private readonly write: (data: string) => void,
    private readonly clock: Clock = browserClock,
    private readonly limits: OutputQueueLimits = DEFAULT_LIMITS
  ) {}

  get pending(): number {
    return this.length;
  }

  push(data: string): void {
    if (!data) return;
    this.chunks.push(data);
    this.length += data.length;
    if (!this.onScreen) {
      if (this.length > this.limits.heldTail) this.keepTail();
      return;
    }
    if (this.length >= this.limits.burst) {
      this.drain();
      return;
    }
    this.arm();
  }

  /** On screen, output flows; off screen, it is held until shown again. */
  setOnScreen(onScreen: boolean): void {
    this.onScreen = onScreen;
    if (onScreen) this.drain();
    else this.disarm();
  }

  drain(): void {
    this.disarm();
    if (!this.length) return;
    const data = this.chunks.length === 1 ? this.chunks[0] : this.chunks.join('');
    this.chunks = [];
    this.length = 0;
    this.write(data);
  }

  discard(): void {
    this.disarm();
    this.chunks = [];
    this.length = 0;
  }

  private arm(): void {
    if (this.frameHandle === null) this.frameHandle = this.clock.frame(() => this.drain());
    if (this.latencyHandle === null) this.latencyHandle = this.clock.delay(() => this.drain(), this.limits.maxLatencyMs);
  }

  private disarm(): void {
    if (this.frameHandle !== null) this.clock.cancelFrame(this.frameHandle);
    if (this.latencyHandle !== null) this.clock.cancelDelay(this.latencyHandle);
    this.frameHandle = null;
    this.latencyHandle = null;
  }

  private keepTail(): void {
    const joined = this.chunks.join('');
    let start = joined.length - this.limits.heldTail;
    const lineBreak = joined.indexOf('\n', start);
    if (lineBreak >= 0 && lineBreak - start <= TRIM_LINE_SEARCH) start = lineBreak + 1;
    const tail = RESET_ATTRIBUTES + joined.slice(start);
    this.chunks = [tail];
    this.length = tail.length;
  }
}

export interface GridSize {
  cols: number;
  rows: number;
}

const sameSize = (a: GridSize | null, b: GridSize | null) => !!a && !!b && a.cols === b.cols && a.rows === b.rows;

export class SizeSync {
  private acknowledged: GridSize | null = null;
  private queued: GridSize | null = null;
  private timer: number | null = null;

  constructor(
    /** Resolves true when the backend accepted the size. */
    private readonly send: (size: GridSize) => Promise<boolean>,
    private readonly canSend: () => boolean,
    private readonly clock: Clock = browserClock,
    private readonly debounceMs = 120
  ) {}

  request(size: GridSize): void {
    if (sameSize(size, this.queued)) return;
    if (!this.queued && sameSize(size, this.acknowledged)) return;
    this.queued = size;
    if (this.timer !== null) this.clock.cancelDelay(this.timer);
    this.timer = this.clock.delay(() => this.flush(), this.debounceMs);
  }

  /** Forget everything, e.g. when a new backend session starts. */
  reset(): void {
    if (this.timer !== null) this.clock.cancelDelay(this.timer);
    this.timer = null;
    this.queued = null;
    this.acknowledged = null;
  }

  private flush(): void {
    this.timer = null;
    const size = this.queued;
    this.queued = null;
    if (!size || !this.canSend()) return;
    this.acknowledged = size;
    const forget = () => {
      if (sameSize(this.acknowledged, size)) this.acknowledged = null;
    };
    this.send(size).then((ok) => (ok ? undefined : forget()), forget);
  }
}

// Replies xterm generates on its own (focus reports, device attributes,
// bracketed-paste mode echoes) that must not reach the shell as input.
const TERMINAL_REPORTS = new Set(['\x1b[I', '\x1b[O', '\x1b[?1;2c', '\x1b[?6c', '\x1b[?2004h', '\x1b[?2004l']);

export function isTerminalReport(data: string): boolean {
  return TERMINAL_REPORTS.has(data);
}

/** Splits input into pieces of at most `max` characters without breaking a surrogate pair. */
export function splitInput(data: string, max: number): string[] {
  if (data.length <= max) return data ? [data] : [];
  const pieces: string[] = [];
  let offset = 0;
  while (offset < data.length) {
    let end = Math.min(data.length, offset + max);
    const code = data.charCodeAt(end - 1);
    if (end < data.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
    pieces.push(data.slice(offset, end));
    offset = end;
  }
  return pieces;
}

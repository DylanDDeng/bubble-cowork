import { ClipboardAddon } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { ImageAddon } from '@xterm/addon-image';
import { LigaturesAddon } from '@xterm/addon-ligatures';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import {
  MAX_TERMINAL_WRITE_LENGTH,
  type TerminalActivityEvent,
  type TerminalAgentKind,
  type TerminalEvent,
  type TerminalOpenResult,
  type TerminalSessionSnapshot,
} from '../../shared/terminal';
import { terminalFontStack, terminalPalette } from './terminal-theme';
import { browserClock, isTerminalReport, OutputQueue, SizeSync, splitInput, type Clock } from './terminal-streams';

export interface TerminalHooks {
  onActivity?: (event: TerminalActivityEvent) => void;
  onExit?: (exitCode: number | null, exitSignal: number | string | null) => void;
  onError?: (message: string) => void;
}

/** What the UI wants a terminal tab to be. */
export interface TerminalSpec {
  key: string;
  /** Owning scope (a session or panel); terminals are torn down per scope. */
  scope: string;
  tabId: string;
  cwd: string;
  agent: TerminalAgentKind;
  /** Typed once after the shell starts, unless the backend supplies one. */
  launch?: string | null;
  /** Grey line shown after the shell starts. */
  notice?: string | null;
  hooks?: TerminalHooks;
}

export interface TerminalView {
  visible: boolean;
  active: boolean;
}

export type TerminalBridge = Pick<ElectronAPI['terminal'], 'open' | 'write' | 'resize' | 'clear' | 'close'>;

export interface TerminalEnvironment {
  bridge: TerminalBridge;
  clock?: Clock;
  /** WebGL is skipped for the app's lifetime once it has failed. */
  webglUsable(): boolean;
  webglFailed(): void;
}

type Connection = 'idle' | 'opening' | 'open' | 'exited';

const MIN_REFIT_SPACING_MS = 64;
const RESYNC_AFTER_REPLAY_MS = 250;
const LAUNCH_DELAY_MS = 80;
// Keep each write comfortably under the backend's per-call limit.
const INPUT_PIECE = MAX_TERMINAL_WRITE_LENGTH - 1024;
const DISABLE_FOCUS_REPORTING = '\x1b[?1004l';

const dim = (text: string) => `\x1b[90m${text}\x1b[0m\r\n`;

export class ManagedTerminal {
  private spec: TerminalSpec;
  private readonly xterm: Terminal;
  private readonly fitter = new FitAddon();
  private readonly finder = new SearchAddon();
  private readonly clock: Clock;
  private readonly output: OutputQueue;
  private readonly size: SizeSync;
  private webgl: WebglAddon | null = null;
  private webglPending: number | null = null;
  private container: HTMLDivElement | null = null;
  private view: TerminalView = { visible: false, active: false };
  private connection: Connection = 'idle';
  private openSerial = 0;
  private replayedWhileOpening = false;
  private launched = false;
  private inputTail: Promise<unknown> = Promise.resolve();
  private refitHandle: { frame: number | null; delay: number | null } = { frame: null, delay: null };
  private lastRefitAt = -Infinity;
  private resyncHandle: number | null = null;
  private destroyed = false;

  constructor(spec: TerminalSpec, private readonly env: TerminalEnvironment) {
    this.spec = spec;
    this.clock = env.clock ?? browserClock;
    this.xterm = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: terminalFontStack(),
      fontSize: 12,
      fontWeight: 400,
      fontWeightBold: 700,
      letterSpacing: 0,
      lineHeight: 1.45,
      customGlyphs: true,
      theme: terminalPalette(),
      scrollback: 5000,
      convertEol: true,
    });
    for (const addon of [new Unicode11Addon(), this.fitter, this.finder, new ClipboardAddon(), new ImageAddon()]) {
      this.xterm.loadAddon(addon);
    }
    this.xterm.unicode.activeVersion = '11';
    this.xterm.onData((data) => this.type(data));
    this.output = new OutputQueue((data) => this.xterm.write(data), this.clock);
    this.size = new SizeSync(
      (grid) =>
        this.env.bridge
          .resize({ threadId: this.spec.scope, terminalId: this.spec.tabId, ...grid })
          .then((result) => result.ok),
      () => this.connection === 'open',
      this.clock
    );
  }

  get key(): string {
    return this.spec.key;
  }

  get scope(): string {
    return this.spec.scope;
  }

  /** On screen and the tab the user is looking at. */
  get presenting(): boolean {
    return !!this.container && this.view.visible && this.view.active;
  }

  mount(container: HTMLDivElement, view: TerminalView): void {
    if (this.destroyed) return;
    this.container = container;
    if (!this.xterm.element) {
      this.xterm.open(container);
      this.clock.frame(() => {
        try {
          if (!this.destroyed) this.xterm.loadAddon(new LigaturesAddon());
        } catch {
          // Ligatures are cosmetic; fonts without them still render.
        }
      });
    } else if (this.xterm.element.parentElement !== container) {
      container.appendChild(this.xterm.element);
    }
    this.show(view);
    this.clock.frame(() => this.clock.frame(() => this.refit(true)));
    this.connect();
  }

  unmount(): void {
    const element = this.xterm.element;
    if (element && this.container && element.parentElement === this.container) element.remove();
    this.container = null;
    this.cancelRefit();
    this.show({ visible: false, active: false });
  }

  show(view: TerminalView): void {
    const wasPresenting = this.presenting;
    this.view = view;
    if (this.xterm.element) this.xterm.element.style.display = view.active ? '' : 'none';
    this.output.setOnScreen(this.presenting);
    if (!this.presenting) {
      this.dropWebgl();
      return;
    }
    this.loadWebgl();
    this.scheduleRefit();
    if (!wasPresenting) this.xterm.focus();
  }

  update(spec: TerminalSpec): void {
    const reconnect = spec.cwd !== this.spec.cwd || spec.agent !== this.spec.agent;
    this.spec = spec;
    this.xterm.options.theme = terminalPalette();
    this.xterm.options.fontFamily = terminalFontStack();
    if (!reconnect) return;
    this.openSerial += 1;
    this.connection = 'idle';
    this.launched = false;
    this.size.reset();
    this.output.discard();
    this.xterm.reset();
    if (this.container) this.connect();
  }

  receive(event: TerminalEvent): void {
    switch (event.type) {
      case 'output':
        this.output.push(event.data);
        return;
      case 'started':
      case 'restarted':
        if (this.connection === 'opening') this.replayedWhileOpening = true;
        this.replay(event.snapshot);
        return;
      case 'cleared':
        this.output.discard();
        this.xterm.reset();
        return;
      case 'exited':
        this.connection = 'exited';
        this.spec.hooks?.onExit?.(event.exitCode, event.exitSignal);
        this.output.push(dim(`[Process exited${typeof event.exitCode === 'number' ? `: ${event.exitCode}` : ''}]`));
        return;
      case 'error':
        this.spec.hooks?.onError?.(event.message);
        this.output.push(dim(event.message));
        return;
      case 'activity':
        this.spec.hooks?.onActivity?.(event);
        return;
    }
  }

  focus(): void {
    this.xterm.focus();
    this.scheduleRefit();
  }

  /** Refit to the container now, optionally redrawing every glyph. */
  refit(redraw = false): void {
    if (!this.presenting || !this.container?.isConnected) return;
    this.lastRefitAt = this.clock.now();
    const buffer = this.xterm.buffer.active;
    const followingOutput = buffer.viewportY >= buffer.baseY;
    if (redraw) this.webgl?.clearTextureAtlas();
    try {
      this.fitter.fit();
    } catch {
      return;
    }
    if (followingOutput) this.xterm.scrollToBottom();
    if (redraw) this.xterm.refresh(0, this.xterm.rows - 1);
    this.size.request({ cols: this.xterm.cols, rows: this.xterm.rows });
  }

  /** Coalesces refits into one per frame, at most every MIN_REFIT_SPACING_MS. */
  scheduleRefit(): void {
    if (this.refitHandle.frame !== null || this.refitHandle.delay !== null) return;
    const wait = Math.max(0, MIN_REFIT_SPACING_MS - (this.clock.now() - this.lastRefitAt));
    this.refitHandle.delay = this.clock.delay(() => {
      this.refitHandle.delay = null;
      this.refitHandle.frame = this.clock.frame(() => {
        this.refitHandle.frame = null;
        this.refit();
      });
    }, wait);
  }

  find(query: string): boolean {
    return query ? this.finder.findNext(query) : false;
  }

  selection(): string {
    return this.xterm.getSelection().trimEnd();
  }

  clear(): void {
    this.output.discard();
    this.xterm.reset();
    void this.env.bridge.clear({ threadId: this.spec.scope, terminalId: this.spec.tabId }).catch(() => undefined);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.openSerial += 1;
    this.unmount();
    this.size.reset();
    this.output.discard();
    if (this.resyncHandle !== null) this.clock.cancelDelay(this.resyncHandle);
    if (this.webglPending !== null) this.clock.cancelFrame(this.webglPending);
    void this.env.bridge.close({ threadId: this.spec.scope, terminalId: this.spec.tabId }).catch(() => undefined);
    this.xterm.dispose();
  }

  private connect(): void {
    if (this.connection !== 'idle' || this.destroyed) return;
    this.connection = 'opening';
    this.replayedWhileOpening = false;
    const serial = ++this.openSerial;
    this.output.push(dim('Starting terminal...'));
    const settle = (result: TerminalOpenResult) => {
      if (serial !== this.openSerial) return;
      if (!result.ok) {
        this.fail(result.message);
        return;
      }
      // A fresh shell already replayed through its `started` event.
      if (!this.replayedWhileOpening) this.replay(result.snapshot);
      if (this.connection !== 'open') return;
      this.xterm.write(DISABLE_FOCUS_REPORTING);
      this.refit(true);
      if (this.spec.notice) this.output.push(dim(this.spec.notice));
      const launch = result.launchCommand || this.spec.launch;
      if (launch && !this.launched) {
        this.launched = true;
        this.clock.delay(() => {
          if (serial === this.openSerial && this.connection === 'open') this.send(`${launch}\r`);
        }, LAUNCH_DELAY_MS);
      }
    };
    this.env.bridge
      .open({
        threadId: this.spec.scope,
        terminalId: this.spec.tabId,
        cwd: this.spec.cwd,
        cols: this.xterm.cols,
        rows: this.xterm.rows,
        agentKind: this.spec.agent,
      })
      .then(settle, (error: unknown) => {
        if (serial === this.openSerial) this.fail(error instanceof Error ? error.message : String(error));
      });
  }

  private fail(message: string): void {
    // Back to idle so the next mount tries again.
    this.connection = 'idle';
    this.spec.hooks?.onError?.(message);
    this.output.push(dim(message));
  }

  private replay(snapshot: TerminalSessionSnapshot): void {
    this.output.discard();
    this.xterm.reset();
    this.connection = snapshot.status === 'exited' ? 'exited' : 'open';
    if (snapshot.history) this.xterm.write(snapshot.history);
    if (this.resyncHandle !== null) this.clock.cancelDelay(this.resyncHandle);
    this.resyncHandle = this.clock.delay(() => {
      this.resyncHandle = null;
      this.refit(true);
    }, RESYNC_AFTER_REPLAY_MS);
  }

  private type(data: string): void {
    if (isTerminalReport(data) || this.connection !== 'open') return;
    this.send(data);
  }

  /** Sends input in order, split into pieces the backend accepts. */
  private send(data: string): void {
    const { scope, tabId } = this.spec;
    for (const piece of splitInput(data, INPUT_PIECE)) {
      this.inputTail = this.inputTail
        .then(() => this.env.bridge.write({ threadId: scope, terminalId: tabId, data: piece }))
        .catch(() => undefined);
    }
  }

  private loadWebgl(): void {
    if (this.webgl || this.webglPending !== null || !this.env.webglUsable()) return;
    this.webglPending = this.clock.frame(() => {
      this.webglPending = null;
      if (!this.presenting || this.webgl || !this.env.webglUsable()) return;
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          this.dropWebgl();
          this.xterm.refresh(0, this.xterm.rows - 1);
        });
        this.xterm.loadAddon(addon);
        this.webgl = addon;
      } catch {
        this.env.webglFailed();
      }
    });
  }

  private dropWebgl(): void {
    if (this.webglPending !== null) {
      this.clock.cancelFrame(this.webglPending);
      this.webglPending = null;
    }
    const addon = this.webgl;
    this.webgl = null;
    try {
      addon?.dispose();
    } catch {
      // Already torn down with its GL context.
    }
  }

  private cancelRefit(): void {
    if (this.refitHandle.frame !== null) this.clock.cancelFrame(this.refitHandle.frame);
    if (this.refitHandle.delay !== null) this.clock.cancelDelay(this.refitHandle.delay);
    this.refitHandle = { frame: null, delay: null };
  }
}

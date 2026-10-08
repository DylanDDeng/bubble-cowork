import { buildTerminalRuntimeKey, type TerminalEvent } from '../../shared/terminal';
import { ManagedTerminal, type TerminalEnvironment, type TerminalSpec, type TerminalView } from './managed-terminal';
import { browserClock, type Clock } from './terminal-streams';

export type { TerminalHooks, TerminalSpec, TerminalView } from './managed-terminal';

export const terminalKey = (scope: string, tabId: string) => buildTerminalRuntimeKey(scope, tabId);

const RECOVERY_SETTLE_MS = 120;

/**
 * Owns every embedded terminal by key. One subscription to the backend's
 * event stream fans events out by key, and one set of window listeners
 * refits whatever is on screen after the app regains focus or visibility
 * (GPU surfaces can come back stale).
 */
export class TerminalHost {
  private readonly terminals = new Map<string, ManagedTerminal>();
  private stopListening: (() => void) | null = null;
  private webglBroken = false;

  constructor(
    private readonly bridge: () => ElectronAPI['terminal'] = () => window.electron.terminal,
    private readonly clock: Clock = browserClock
  ) {}

  mount(spec: TerminalSpec, view: TerminalView, container: HTMLDivElement): void {
    let terminal = this.terminals.get(spec.key);
    if (terminal) terminal.update(spec);
    else {
      terminal = new ManagedTerminal(spec, this.environment());
      this.terminals.set(spec.key, terminal);
      this.listen();
    }
    terminal.mount(container, view);
  }

  update(spec: TerminalSpec): void {
    this.terminals.get(spec.key)?.update(spec);
  }

  show(key: string, view: TerminalView): void {
    this.terminals.get(key)?.show(view);
  }

  unmount(key: string): void {
    this.terminals.get(key)?.unmount();
  }

  destroy(key: string): void {
    const terminal = this.terminals.get(key);
    if (!terminal) return;
    this.terminals.delete(key);
    terminal.destroy();
    if (!this.terminals.size) this.quiet();
  }

  destroyScope(scope: string): void {
    for (const terminal of [...this.terminals.values()]) {
      if (terminal.scope === scope) this.destroy(terminal.key);
    }
  }

  focus(key: string): void {
    this.terminals.get(key)?.focus();
  }

  refit(key: string, redraw = false): void {
    this.terminals.get(key)?.refit(redraw);
  }

  find(key: string, query: string): boolean {
    return this.terminals.get(key)?.find(query) ?? false;
  }

  selection(key: string): string {
    return this.terminals.get(key)?.selection() ?? '';
  }

  clear(key: string): void {
    this.terminals.get(key)?.clear();
  }

  private environment(): TerminalEnvironment {
    return {
      bridge: this.bridge(),
      clock: this.clock,
      webglUsable: () => !this.webglBroken,
      webglFailed: () => {
        this.webglBroken = true;
      },
    };
  }

  private readonly dispatch = (event: TerminalEvent) => {
    this.terminals.get(terminalKey(event.threadId, event.terminalId))?.receive(event);
  };

  private readonly recover = () => {
    if (document.visibilityState === 'hidden') return;
    for (const terminal of this.terminals.values()) {
      if (!terminal.presenting) continue;
      this.clock.frame(() => terminal.refit(true));
      this.clock.delay(() => terminal.refit(true), RECOVERY_SETTLE_MS);
    }
  };

  private listen(): void {
    if (this.stopListening) return;
    const unsubscribe = this.bridge().onEvent(this.dispatch);
    window.addEventListener('focus', this.recover);
    document.addEventListener('visibilitychange', this.recover);
    this.stopListening = () => {
      unsubscribe();
      window.removeEventListener('focus', this.recover);
      document.removeEventListener('visibilitychange', this.recover);
    };
  }

  private quiet(): void {
    this.stopListening?.();
    this.stopListening = null;
  }
}

export const terminalHost = new TerminalHost();

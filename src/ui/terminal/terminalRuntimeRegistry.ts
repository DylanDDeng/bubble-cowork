import { SearchAddon } from '@xterm/addon-search';
import { Terminal } from '@xterm/xterm';

import {
  attachRuntimeToContainer,
  clearRuntime,
  createRuntimeEntry,
  detachRuntimeFromContainer,
  disposeRuntimeEntry,
  focusRuntime,
  resizeRuntime,
  searchRuntime,
  syncRuntimeConfig,
  updateRuntimeViewState,
} from './terminalRuntime';
import type {
  TerminalRuntimeConfig,
  TerminalRuntimeEntry,
  TerminalRuntimeViewState,
} from './terminalRuntimeTypes';
import { buildTerminalRuntimeKey } from './terminalRuntimeTypes';

export { buildTerminalRuntimeKey, type TerminalRuntimeCallbacks } from './terminalRuntimeTypes';

class TerminalRuntimeRegistry {
  private entries = new Map<string, TerminalRuntimeEntry>();

  attach(
    config: TerminalRuntimeConfig,
    viewState: TerminalRuntimeViewState,
    container: HTMLDivElement
  ): { terminal: Terminal; searchAddon: SearchAddon } {
    let entry = this.entries.get(config.runtimeKey);
    if (!entry) {
      entry = createRuntimeEntry(config);
      this.entries.set(config.runtimeKey, entry);
    } else {
      syncRuntimeConfig(entry, config);
    }

    attachRuntimeToContainer(entry, viewState, container);
    return {
      terminal: entry.terminal,
      searchAddon: entry.searchAddon,
    };
  }

  syncConfig(runtimeKey: string, config: TerminalRuntimeConfig): void {
    const entry = this.entries.get(runtimeKey);
    if (!entry) return;
    syncRuntimeConfig(entry, config);
  }

  setViewState(runtimeKey: string, viewState: TerminalRuntimeViewState): void {
    const entry = this.entries.get(runtimeKey);
    if (!entry) return;
    updateRuntimeViewState(entry, viewState);
  }

  detach(runtimeKey: string): void {
    const entry = this.entries.get(runtimeKey);
    if (!entry) return;
    detachRuntimeFromContainer(entry);
  }

  dispose(runtimeKey: string): void {
    const entry = this.entries.get(runtimeKey);
    if (!entry) return;
    disposeRuntimeEntry(entry);
    this.entries.delete(runtimeKey);
  }

  disposeTerminal(threadId: string, terminalId: string): void {
    this.dispose(buildTerminalRuntimeKey(threadId, terminalId));
  }

  disposeThread(threadId: string): void {
    for (const runtimeKey of [...this.entries.keys()]) {
      if (runtimeKey.startsWith(`${threadId}::`)) {
        this.dispose(runtimeKey);
      }
    }
  }

  focus(runtimeKey: string): void {
    const entry = this.entries.get(runtimeKey);
    if (!entry) return;
    focusRuntime(entry);
  }

  resize(runtimeKey: string, options?: { clearTextureAtlas?: boolean; refresh?: boolean }): void {
    const entry = this.entries.get(runtimeKey);
    if (!entry) return;
    resizeRuntime(entry, options);
  }

  search(runtimeKey: string, query: string): boolean {
    const entry = this.entries.get(runtimeKey);
    if (!entry) return false;
    return searchRuntime(entry, query);
  }

  clear(runtimeKey: string): void {
    const entry = this.entries.get(runtimeKey);
    if (!entry) return;
    clearRuntime(entry);
  }
}

export const terminalRuntimeRegistry = new TerminalRuntimeRegistry();

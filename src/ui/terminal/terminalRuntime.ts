import { ClipboardAddon } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { ImageAddon } from '@xterm/addon-image';
import { LigaturesAddon } from '@xterm/addon-ligatures';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import type { TerminalEventPayload, TerminalSessionSnapshot } from '../../shared/terminal';
import { getTerminalFontFamily, terminalThemeFromApp, writeSystemMessage } from './terminalRuntimeAppearance';
import { suppressQueryResponses } from './suppressQueryResponses';
import type {
  TerminalRuntimeConfig,
  TerminalRuntimeEntry,
  TerminalRuntimeViewState,
} from './terminalRuntimeTypes';

const ENABLE_TERMINAL_WEBGL = true;
const VISUAL_RESIZE_MIN_INTERVAL_MS = 64;
const BACKEND_RESIZE_DEBOUNCE_MS = 120;
const WRITE_BATCH_SIZE_LIMIT = 262_144;
const WRITE_BATCH_MAX_LATENCY_MS = 50;
const OPEN_SNAPSHOT_RECONCILE_DELAY_MS = 250;

let suggestedRendererType: 'webgl' | 'dom' | undefined;

function api() {
  return window.electron.terminal;
}

function clearPendingWrites(entry: TerminalRuntimeEntry): void {
  if (entry.writeRafHandle !== null) {
    window.cancelAnimationFrame(entry.writeRafHandle);
    entry.writeRafHandle = null;
  }
  if (entry.writeFlushTimeout !== null) {
    window.clearTimeout(entry.writeFlushTimeout);
    entry.writeFlushTimeout = null;
  }
  entry.pendingWrites.length = 0;
  entry.pendingWriteLength = 0;
}

function clearDeferredWrites(entry: TerminalRuntimeEntry): void {
  entry.deferredWrites.length = 0;
  entry.deferredWriteLength = 0;
}

function flushPendingWrites(entry: TerminalRuntimeEntry): void {
  if (entry.writeRafHandle !== null) {
    window.cancelAnimationFrame(entry.writeRafHandle);
    entry.writeRafHandle = null;
  }
  if (entry.writeFlushTimeout !== null) {
    window.clearTimeout(entry.writeFlushTimeout);
    entry.writeFlushTimeout = null;
  }
  if (entry.pendingWrites.length === 0) {
    entry.pendingWriteLength = 0;
    return;
  }
  const combined = entry.pendingWrites.join('');
  entry.pendingWrites.length = 0;
  entry.pendingWriteLength = 0;
  entry.terminal.write(combined);
}

function scheduleWrite(entry: TerminalRuntimeEntry, data: string): void {
  if (!entry.container || !entry.viewState.isVisible) {
    entry.deferredWrites.push(data);
    entry.deferredWriteLength += data.length;
    if (entry.deferredWriteLength > WRITE_BATCH_SIZE_LIMIT * 2) {
      const combined = entry.deferredWrites.join('');
      entry.deferredWrites = [combined.slice(-WRITE_BATCH_SIZE_LIMIT * 2)];
      entry.deferredWriteLength = entry.deferredWrites[0].length;
    }
    return;
  }

  entry.pendingWrites.push(data);
  entry.pendingWriteLength += data.length;
  if (entry.pendingWriteLength >= WRITE_BATCH_SIZE_LIMIT) {
    flushPendingWrites(entry);
    return;
  }

  if (entry.writeRafHandle === null) {
    entry.writeRafHandle = window.requestAnimationFrame(() => {
      entry.writeRafHandle = null;
      flushPendingWrites(entry);
    });
  }
  if (entry.writeFlushTimeout === null) {
    entry.writeFlushTimeout = window.setTimeout(() => {
      entry.writeFlushTimeout = null;
      flushPendingWrites(entry);
    }, WRITE_BATCH_MAX_LATENCY_MS);
  }
}

function flushDeferredWrites(entry: TerminalRuntimeEntry): void {
  if (entry.deferredWrites.length === 0) {
    entry.deferredWriteLength = 0;
    return;
  }
  const combined = entry.deferredWrites.join('');
  clearDeferredWrites(entry);
  scheduleWrite(entry, combined);
}

function clearBackendResizeTimer(entry: TerminalRuntimeEntry): void {
  if (entry.resizeDispatchTimer !== null) {
    window.clearTimeout(entry.resizeDispatchTimer);
    entry.resizeDispatchTimer = null;
  }
}

function flushPendingResize(entry: TerminalRuntimeEntry): void {
  const pendingResize = entry.pendingResize;
  if (!pendingResize || !entry.backendOpen || entry.backendExited) return;

  entry.pendingResize = null;
  entry.lastSentResize = pendingResize;
  void api()
    .resize({
      threadId: entry.threadId,
      terminalId: entry.terminalId,
      cols: pendingResize.cols,
      rows: pendingResize.rows,
    })
    .catch(() => {
      const current = entry.lastSentResize;
      if (current && current.cols === pendingResize.cols && current.rows === pendingResize.rows) {
        entry.lastSentResize = null;
      }
    });
}

function queueBackendResize(entry: TerminalRuntimeEntry, cols: number, rows: number): void {
  const lastSentResize = entry.lastSentResize;
  const pendingResize = entry.pendingResize;
  if (
    (lastSentResize && lastSentResize.cols === cols && lastSentResize.rows === rows) ||
    (pendingResize && pendingResize.cols === cols && pendingResize.rows === rows)
  ) {
    return;
  }
  entry.pendingResize = { cols, rows };
  clearBackendResizeTimer(entry);
  entry.resizeDispatchTimer = window.setTimeout(() => {
    entry.resizeDispatchTimer = null;
    flushPendingResize(entry);
  }, BACKEND_RESIZE_DEBOUNCE_MS);
}

function clearTextureAtlas(entry: TerminalRuntimeEntry): void {
  try {
    entry.webglAddon?.clearTextureAtlas();
  } catch {
    // ignore renderer recovery failures
  }
}

function refresh(entry: TerminalRuntimeEntry): void {
  clearTextureAtlas(entry);
  try {
    entry.terminal.refresh(0, Math.max(0, entry.terminal.rows - 1));
  } catch {
    // ignore refresh failures
  }
}

function runTerminalResize(
  entry: TerminalRuntimeEntry,
  options?: { clearTextureAtlas?: boolean; refresh?: boolean; dispatchBackend?: boolean }
): void {
  if (!entry.container || !entry.viewState.isVisible) return;

  const { clearTextureAtlas: shouldClearTexture = false, refresh: shouldRefresh = false, dispatchBackend = true } =
    options ?? {};
  const wasAtBottom = entry.terminal.buffer.active.viewportY >= entry.terminal.buffer.active.baseY;

  if (shouldClearTexture) {
    clearTextureAtlas(entry);
  }

  try {
    entry.fitAddon.fit();
  } catch {
    return;
  }
  if (wasAtBottom) {
    entry.terminal.scrollToBottom();
  }
  if (dispatchBackend) {
    queueBackendResize(entry, entry.terminal.cols, entry.terminal.rows);
  }
  if (shouldRefresh) {
    refresh(entry);
  }
}

function cancelScheduledVisualResize(entry: TerminalRuntimeEntry): void {
  if (entry.visualResizeFrame !== null) {
    window.cancelAnimationFrame(entry.visualResizeFrame);
    entry.visualResizeFrame = null;
  }
  if (entry.visualResizeTimer !== null) {
    window.clearTimeout(entry.visualResizeTimer);
    entry.visualResizeTimer = null;
  }
}

function scheduleVisualResize(entry: TerminalRuntimeEntry): void {
  if (!entry.viewState.isVisible || entry.visualResizeTimer !== null) return;

  const now = Date.now();
  const remaining = Math.max(0, VISUAL_RESIZE_MIN_INTERVAL_MS - (now - entry.lastVisualResizeAt));
  const run = () => {
    entry.visualResizeTimer = null;
    if (entry.visualResizeFrame !== null) {
      window.cancelAnimationFrame(entry.visualResizeFrame);
    }
    entry.visualResizeFrame = window.requestAnimationFrame(() => {
      entry.visualResizeFrame = null;
      entry.lastVisualResizeAt = Date.now();
      runTerminalResize(entry);
    });
  };

  if (remaining === 0) {
    run();
    return;
  }
  entry.visualResizeTimer = window.setTimeout(run, remaining);
}

function disposeWebglAddon(entry: TerminalRuntimeEntry): void {
  if (entry.webglLoadFrame !== null) {
    window.cancelAnimationFrame(entry.webglLoadFrame);
    entry.webglLoadFrame = null;
  }
  try {
    entry.webglAddon?.dispose();
  } catch {
    // ignore
  }
  entry.webglAddon = null;
}

function maybeLoadWebglAddon(entry: TerminalRuntimeEntry): void {
  if (
    !ENABLE_TERMINAL_WEBGL ||
    suggestedRendererType === 'dom' ||
    entry.webglAddon ||
    entry.webglLoadFrame !== null ||
    !entry.container ||
    !entry.viewState.isVisible ||
    !entry.viewState.isActive
  ) {
    return;
  }

  entry.webglLoadFrame = window.requestAnimationFrame(() => {
    entry.webglLoadFrame = null;
    if (
      !ENABLE_TERMINAL_WEBGL ||
      suggestedRendererType === 'dom' ||
      entry.webglAddon ||
      !entry.container ||
      !entry.viewState.isVisible ||
      !entry.viewState.isActive ||
      !entry.terminal.element?.isConnected
    ) {
      return;
    }

    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        if (entry.webglAddon === webglAddon) {
          entry.webglAddon = null;
        }
        webglAddon.dispose();
        refresh(entry);
      });
      entry.terminal.loadAddon(webglAddon);
      entry.webglAddon = webglAddon;
      refresh(entry);
    } catch {
      suggestedRendererType = 'dom';
      entry.webglAddon = null;
    }
  });
}

function startVisibilityRecovery(entry: TerminalRuntimeEntry): void {
  if (!entry.container || !entry.viewState.isVisible || entry.visibilityCleanup) return;

  let recoveryFrame = 0;
  let throttleTimer: number | null = null;
  let lastRunAt = 0;
  const run = () => {
    const now = Date.now();
    if (now - lastRunAt < 150) return;
    lastRunAt = now;
    runTerminalResize(entry, { clearTextureAtlas: true, refresh: true });
  };
  const schedule = () => {
    if (recoveryFrame) window.cancelAnimationFrame(recoveryFrame);
    recoveryFrame = window.requestAnimationFrame(() => {
      recoveryFrame = 0;
      run();
      if (throttleTimer !== null) window.clearTimeout(throttleTimer);
      throttleTimer = window.setTimeout(run, 120);
    });
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') schedule();
  };
  const onFocus = () => schedule();

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onFocus);
  entry.visibilityCleanup = () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onFocus);
    if (recoveryFrame) window.cancelAnimationFrame(recoveryFrame);
    if (throttleTimer !== null) window.clearTimeout(throttleTimer);
    entry.visibilityCleanup = null;
  };
}

function stopVisibilityRecovery(entry: TerminalRuntimeEntry): void {
  entry.visibilityCleanup?.();
}

function resetForSnapshotReplay(entry: TerminalRuntimeEntry): void {
  clearPendingWrites(entry);
  clearDeferredWrites(entry);
  entry.terminal.write('\x1bc');
}

function replaySnapshotHistory(entry: TerminalRuntimeEntry, snapshot: TerminalSessionSnapshot): void {
  resetForSnapshotReplay(entry);
  entry.backendOpen = true;
  entry.backendExited = snapshot.status === 'exited';
  entry.terminal.write(snapshot.history);
  entry.callbacks.onSnapshot?.(snapshot);
  window.setTimeout(() => {
    runTerminalResize(entry, { clearTextureAtlas: true, refresh: true });
  }, OPEN_SNAPSHOT_RECONCILE_DELAY_MS);
}

function handleRuntimeEvent(entry: TerminalRuntimeEntry, event: TerminalEventPayload): void {
  if (event.threadId !== entry.threadId || event.terminalId !== entry.terminalId) return;
  entry.callbacks.onEvent?.(event);

  if (event.type === 'output') {
    scheduleWrite(entry, event.data);
    return;
  }
  if (event.type === 'started' || event.type === 'restarted') {
    replaySnapshotHistory(entry, event.snapshot);
    return;
  }
  if (event.type === 'cleared') {
    resetForSnapshotReplay(entry);
    return;
  }
  if (event.type === 'exited') {
    entry.backendExited = true;
    entry.callbacks.onExit?.(event.exitCode, event.exitSignal);
    writeSystemMessage(
      entry.terminal,
      `[Process exited${typeof event.exitCode === 'number' ? `: ${event.exitCode}` : ''}]`
    );
    return;
  }
  if (event.type === 'error') {
    entry.callbacks.onError?.(event.message);
    writeSystemMessage(entry.terminal, event.message);
    return;
  }
  if (event.type === 'activity') {
    entry.callbacks.onActivity?.(event);
  }
}

function openBackend(entry: TerminalRuntimeEntry): void {
  if (entry.backendOpen || entry.backendExited) return;
  entry.backendOpen = true;
  writeSystemMessage(entry.terminal, 'Starting terminal...');

  void api()
    .open({
      threadId: entry.threadId,
      terminalId: entry.terminalId,
      cwd: entry.cwd,
      cols: entry.terminal.cols,
      rows: entry.terminal.rows,
      agentKind: entry.agentKind,
    })
    .then((result) => {
      if (!result.ok) {
        entry.backendOpen = false;
        entry.callbacks.onError?.(result.message);
        writeSystemMessage(entry.terminal, result.message);
        return;
      }

      replaySnapshotHistory(entry, result.snapshot);
      entry.terminal.write('\x1b[?1004l');
      flushDeferredWrites(entry);
      runTerminalResize(entry, { clearTextureAtlas: true, refresh: true });

      const command = result.launchCommand || entry.initialCommand;
      if (entry.initialNotice) {
        writeSystemMessage(entry.terminal, entry.initialNotice);
      }
      if (command && !entry.launchCommandSent) {
        entry.launchCommandSent = true;
        window.setTimeout(() => {
          void api().write({
            threadId: entry.threadId,
            terminalId: entry.terminalId,
            data: `${command}\r`,
          });
        }, 80);
      }
    })
    .catch((error) => {
      entry.backendOpen = false;
      const message = error instanceof Error ? error.message : 'Failed to start terminal.';
      entry.callbacks.onError?.(message);
      writeSystemMessage(entry.terminal, message);
    });
}

export function createRuntimeEntry(config: TerminalRuntimeConfig): TerminalRuntimeEntry {
  const terminal = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    fontFamily: getTerminalFontFamily(),
    fontSize: 12,
    fontWeight: 400,
    fontWeightBold: 700,
    letterSpacing: 0,
    lineHeight: 1.45,
    customGlyphs: true,
    theme: terminalThemeFromApp(),
    scrollback: 5000,
    convertEol: true,
  });
  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  const unicodeAddon = new Unicode11Addon();
  const clipboardAddon = new ClipboardAddon();
  const imageAddon = new ImageAddon();

  terminal.loadAddon(unicodeAddon);
  terminal.unicode.activeVersion = '11';
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);
  terminal.loadAddon(clipboardAddon);
  terminal.loadAddon(imageAddon);

  const entry: TerminalRuntimeEntry = {
    runtimeKey: config.runtimeKey,
    threadId: config.threadId,
    terminalId: config.terminalId,
    cwd: config.cwd,
    agentKind: config.agentKind,
    initialCommand: config.initialCommand || null,
    initialNotice: config.initialNotice || null,
    callbacks: config.callbacks || {},
    terminal,
    fitAddon,
    searchAddon,
    unicodeAddon,
    ligaturesAddon: null,
    clipboardAddon,
    imageAddon,
    webglAddon: null,
    webglLoadFrame: null,
    dataDisposable: null,
    eventDispose: null,
    container: null,
    viewState: { isVisible: false, isActive: false },
    opened: false,
    backendOpen: false,
    backendExited: false,
    launchCommandSent: false,
    pendingWrites: [],
    pendingWriteLength: 0,
    writeRafHandle: null,
    writeFlushTimeout: null,
    deferredWrites: [],
    deferredWriteLength: 0,
    pendingResize: null,
    lastSentResize: null,
    resizeDispatchTimer: null,
    visualResizeFrame: null,
    visualResizeTimer: null,
    lastVisualResizeAt: 0,
    visibilityCleanup: null,
  };

  entry.dataDisposable = terminal.onData((data) => {
    if (suppressQueryResponses(data) || !entry.backendOpen || entry.backendExited) return;
    void api().write({
      threadId: entry.threadId,
      terminalId: entry.terminalId,
      data,
    });
  });
  entry.eventDispose = api().onEvent((event) => handleRuntimeEvent(entry, event));

  return entry;
}

export function syncRuntimeConfig(entry: TerminalRuntimeEntry, config: TerminalRuntimeConfig): void {
  entry.callbacks = config.callbacks || {};
  entry.initialNotice = config.initialNotice || null;
  if (entry.initialCommand !== config.initialCommand) {
    entry.initialCommand = config.initialCommand || null;
  }
  if (entry.cwd !== config.cwd || entry.agentKind !== config.agentKind) {
    entry.cwd = config.cwd;
    entry.agentKind = config.agentKind;
    entry.backendOpen = false;
    entry.backendExited = false;
    entry.launchCommandSent = false;
    resetForSnapshotReplay(entry);
    openBackend(entry);
  }
  entry.terminal.options.theme = terminalThemeFromApp();
  entry.terminal.options.fontFamily = getTerminalFontFamily();
}

export function attachRuntimeToContainer(
  entry: TerminalRuntimeEntry,
  viewState: TerminalRuntimeViewState,
  container: HTMLDivElement
): void {
  entry.container = container;
  entry.viewState = viewState;

  if (!entry.opened) {
    entry.terminal.open(container);
    entry.opened = true;
    window.requestAnimationFrame(() => {
      if (!entry.terminal.element?.isConnected) return;
      try {
        const ligaturesAddon = new LigaturesAddon();
        entry.terminal.loadAddon(ligaturesAddon);
        entry.ligaturesAddon = ligaturesAddon;
      } catch {
        // ignore optional font shaping failures
      }
    });
  } else if (entry.terminal.element && entry.terminal.element.parentElement !== container) {
    container.appendChild(entry.terminal.element);
  }

  openBackend(entry);
  updateRuntimeViewState(entry, viewState);
  flushDeferredWrites(entry);
  window.requestAnimationFrame(() => {
    runTerminalResize(entry, { clearTextureAtlas: true, refresh: true });
    window.requestAnimationFrame(() => {
      runTerminalResize(entry, { clearTextureAtlas: true, refresh: true });
    });
  });
}

export function updateRuntimeViewState(entry: TerminalRuntimeEntry, viewState: TerminalRuntimeViewState): void {
  entry.viewState = viewState;
  if (entry.terminal.element) {
    entry.terminal.element.style.display = viewState.isActive ? 'block' : 'none';
  }

  if (viewState.isVisible && viewState.isActive) {
    maybeLoadWebglAddon(entry);
    startVisibilityRecovery(entry);
    flushDeferredWrites(entry);
    scheduleVisualResize(entry);
    entry.terminal.focus();
  } else {
    disposeWebglAddon(entry);
    stopVisibilityRecovery(entry);
  }
}

export function detachRuntimeFromContainer(entry: TerminalRuntimeEntry): void {
  cancelScheduledVisualResize(entry);
  clearBackendResizeTimer(entry);
  disposeWebglAddon(entry);
  stopVisibilityRecovery(entry);
  if (entry.terminal.element?.parentElement) {
    entry.terminal.element.parentElement.removeChild(entry.terminal.element);
  }
  entry.container = null;
  entry.viewState = { isVisible: false, isActive: false };
}

export function disposeRuntimeEntry(entry: TerminalRuntimeEntry): void {
  clearPendingWrites(entry);
  clearDeferredWrites(entry);
  cancelScheduledVisualResize(entry);
  clearBackendResizeTimer(entry);
  disposeWebglAddon(entry);
  stopVisibilityRecovery(entry);
  entry.dataDisposable?.dispose();
  entry.eventDispose?.();
  entry.ligaturesAddon?.dispose();
  entry.unicodeAddon.dispose();
  entry.clipboardAddon?.dispose();
  entry.imageAddon?.dispose();
  void api().close({ threadId: entry.threadId, terminalId: entry.terminalId });
  entry.terminal.dispose();
}

export function focusRuntime(entry: TerminalRuntimeEntry): void {
  entry.terminal.focus();
  scheduleVisualResize(entry);
}

export function resizeRuntime(
  entry: TerminalRuntimeEntry,
  options?: { clearTextureAtlas?: boolean; refresh?: boolean }
): void {
  runTerminalResize(entry, {
    clearTextureAtlas: options?.clearTextureAtlas ?? true,
    refresh: options?.refresh ?? true,
  });
}

export function searchRuntime(entry: TerminalRuntimeEntry, query: string): boolean {
  if (!query) return false;
  return entry.searchAddon.findNext(query, { decorations: true });
}

export function clearRuntime(entry: TerminalRuntimeEntry): void {
  resetForSnapshotReplay(entry);
  void api().clear({ threadId: entry.threadId, terminalId: entry.terminalId });
}

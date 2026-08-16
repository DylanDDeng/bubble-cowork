// Browser Use service: agent-driven automation of the session's built-in
// browser (Codex-parity browser use, visible + background phases).
//
// Design mirrors what the Codex app ships:
//   - the agent drives the SAME tab the user sees; while the panel is closed,
//     that tab is laid out in a hidden host and attaches when the panel opens;
//   - navigation is gated by the session's existing permission pipeline, so
//     Allow/Block decisions and per-origin remembers work uniformly for
//     every provider;
//   - interaction primitives are cua-level (coordinates) plus a DOM-snapshot
//     addressing mode with stable per-snapshot node ids (dom_cua parity).
//
// The service lives in the main process next to BrowserManager and is exposed
// to agents through per-provider MCP wiring (see browser-use-mcp.ts).

import type { BrowserAgentTarget, BrowserManager } from '../browserManager';
import type { WebContents } from 'electron';

export const BROWSER_USE_SERVER_NAME = 'aegis-browser';

export interface BrowserUseSnapshotLink {
  href: string;
  text: string;
}

export interface BrowserUseDomNode {
  /** Stable within one snapshot; pass back as node_id. */
  id: number;
  role: string;
  text: string;
  tag: string;
  /** Center of the element in CSS pixels (viewport coordinates). */
  x: number;
  y: number;
  w: number;
  h: number;
  href?: string;
}

export interface BrowserUseSnapshot {
  snapshotId: string;
  url: string;
  title: string;
  viewportWidth: number;
  viewportHeight: number;
  scrollX: number;
  scrollY: number;
  nodes: BrowserUseDomNode[];
  textPreview: string;
}

const MAX_NODES = 220;
const TEXT_PREVIEW_LIMIT = 8000;

export interface BrowserUseDeadlines {
  restoreMs: number;
  navigationMs: number;
  commandMs: number;
  settleMs: number;
}

export const DEFAULT_BROWSER_USE_DEADLINES: BrowserUseDeadlines = {
  restoreMs: 15_000,
  navigationMs: 15_000,
  commandMs: 20_000,
  settleMs: 20_000,
};

export interface BrowserUseRunOptions {
  signal?: AbortSignal;
  deadlines?: Partial<BrowserUseDeadlines>;
}

const actionQueues = new Map<string, Promise<void>>();
const sessionAbortControllers = new Map<string, AbortController>();

function browserUseErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new Error('Browser action was cancelled.');
}

function combineAbortSignals(signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  for (const source of signals) {
    if (!source) continue;
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    const onAbort = () => controller.abort(source.reason);
    source.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => source.removeEventListener('abort', onAbort));
  }
  return {
    signal: controller.signal,
    cleanup: () => cleanups.splice(0).forEach((cleanup) => cleanup()),
  };
}

function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
  onTimeout?: () => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () =>
      finish(() => {
        try {
          onTimeout?.();
        } finally {
          reject(new Error('Browser action was cancelled.'));
        }
      });
    const timer = setTimeout(() => {
      finish(() => {
        try {
          onTimeout?.();
        } finally {
          reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
        }
      });
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
  });
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return withDeadline(
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
    ms + 50,
    'Browser settle delay',
    signal
  );
}

function stopLoading(webContents: WebContents): void {
  try {
    if (!webContents.isDestroyed() && webContents.isLoading()) webContents.stop();
  } catch {
    // The renderer may have disappeared between the liveness check and stop.
  }
}

/** Event-driven page readiness shared by visible and detached runtimes. */
export function waitForBrowserPageReady(
  webContents: WebContents,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (webContents.isDestroyed()) return Promise.reject(new Error('The browser tab was destroyed.'));
  if (!webContents.isLoading()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      webContents.removeListener('did-stop-loading', onReady);
      webContents.removeListener('did-finish-load', onReady);
      webContents.removeListener('did-fail-load', onFail);
      webContents.removeListener('render-process-gone', onRendererGone);
      webContents.removeListener('destroyed', onDestroyed);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onReady = () => finish(resolve);
    const onFail = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      _validatedURL: string,
      isMainFrame: boolean
    ) => {
      if (!isMainFrame || errorCode === -3) return;
      finish(() => reject(new Error(`Page load failed: ${errorDescription} (${errorCode}).`)));
    };
    const onRendererGone = () =>
      finish(() => reject(new Error('The browser renderer stopped unexpectedly.')));
    const onDestroyed = () => finish(() => reject(new Error('The browser tab was destroyed.')));
    const onAbort = () => {
      stopLoading(webContents);
      finish(() => reject(new Error('Browser action was cancelled.')));
    };
    const timer = setTimeout(() => {
      stopLoading(webContents);
      finish(() => reject(new Error(`Page readiness timed out after ${timeoutMs}ms.`)));
    }, timeoutMs);
    webContents.once('did-stop-loading', onReady);
    webContents.once('did-finish-load', onReady);
    webContents.on('did-fail-load', onFail);
    webContents.once('render-process-gone', onRendererGone);
    webContents.once('destroyed', onDestroyed);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** Collect the interactable-DOM snapshot for a live webContents. */
export async function captureDomSnapshot(webContents: WebContents): Promise<BrowserUseSnapshot> {
  const raw = (await webContents.executeJavaScript(
    `(() => {
      const interactive = [
        'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
        '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
        '[role="checkbox"]', '[role="switch"]', '[role="textbox"]',
        '[contenteditable="true"]', '[onclick]', '[tabindex]:not([tabindex="-1"])',
      ].join(',');
      const nodes = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let el;
      let nextId = 1;
      while ((el = walker.nextNode())) {
        const matches = el.matches(interactive);
        const isLabel = !matches && el.tagName === 'LABEL';
        if (!matches && !isLabel) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) continue;
        const role = el.getAttribute('role') || (el.tagName === 'A' ? 'link' : el.tagName.toLowerCase());
        const aria = el.getAttribute('aria-label');
        const text = ((aria || el.innerText || el.value || el.placeholder || '') + '')
          .replace(/\\s+/g, ' ').trim().slice(0, 140);
        nodes.push({
          id: nextId++,
          role,
          tag: el.tagName.toLowerCase(),
          text,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          href: el.tagName === 'A' ? el.href || undefined : undefined,
        });
        if (nodes.length >= ${MAX_NODES}) break;
      }
      const body = document.body;
      return {
        url: location.href,
        title: document.title || '',
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        scrollX: scrollX,
        scrollY: scrollY,
        nodes,
        textPreview: (body ? body.innerText : '').slice(0, ${TEXT_PREVIEW_LIMIT}),
      };
    })()`,
    true
  )) as Omit<BrowserUseSnapshot, 'snapshotId'>;

  return {
    ...raw,
    nodes: raw.nodes ?? [],
    snapshotId: `snap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

/**
 * Resolve a node_id against a snapshot to CURRENT viewport CSS pixels.
 * Node coords were captured relative to the viewport at snapshot time
 * (getBoundingClientRect semantics), so if the page scrolled since, the
 * delta between snapshot-time and current scroll is applied. sendInputEvent
 * expects viewport coordinates — this must NEVER return document coords.
 */
export function resolveNodePoint(
  snapshot: BrowserUseSnapshot,
  nodeId: number,
  currentScrollX = 0,
  currentScrollY = 0
): { x: number; y: number } | null {
  const node = snapshot.nodes.find((entry) => entry.id === nodeId);
  if (!node) return null;
  return {
    x: node.x + (snapshot.scrollX ?? 0) - currentScrollX,
    y: node.y + (snapshot.scrollY ?? 0) - currentScrollY,
  };
}

export interface BrowserUseActionInput {
  sessionId: string;
  action: 'click' | 'type' | 'scroll' | 'navigate' | 'snapshot' | 'read' | 'key';
  url?: string;
  x?: number;
  y?: number;
  nodeId?: number;
  snapshotId?: string;
  text?: string;
  key?: string;
  direction?: 'up' | 'down';
  amount?: number;
}

export interface BrowserUseActionResult {
  ok: boolean;
  message: string;
  snapshot?: BrowserUseSnapshot;
  text?: string;
}

/** Snapshot cache: last snapshot per (sessionId, tabId) for node addressing. */
const lastSnapshots = new Map<string, BrowserUseSnapshot>();

function cacheKey(sessionId: string, tabId: string): string {
  return `${sessionId}:${tabId}`;
}

export function rememberSnapshot(sessionId: string, tabId: string, snapshot: BrowserUseSnapshot): void {
  lastSnapshots.set(cacheKey(sessionId, tabId), snapshot);
  if (lastSnapshots.size > 32) {
    // Drop the oldest entry (Map preserves insertion order).
    const oldest = lastSnapshots.keys().next().value;
    if (oldest !== undefined) lastSnapshots.delete(oldest);
  }
}

export function getRememberedSnapshot(sessionId: string, tabId: string): BrowserUseSnapshot | null {
  return lastSnapshots.get(cacheKey(sessionId, tabId)) ?? null;
}

const KEY_ALIASES: Record<string, string> = {
  enter: 'Return',
  return: 'Return',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
};

function normalizeKey(key: string): string {
  return KEY_ALIASES[key.trim().toLowerCase()] ?? key.trim();
}

/** Ask the renderer to reveal Browser Use. The action does not depend on the
 * renderer responding: BrowserManager can run the same tab detached. */
export type BrowserUsePanelOpener = (sessionId: string) => Promise<void>;

let panelOpener: BrowserUsePanelOpener | null = null;

export function setBrowserUsePanelOpener(opener: BrowserUsePanelOpener | null): void {
  panelOpener = opener;
}

export async function runBrowserUseAction(
  manager: BrowserManager,
  input: BrowserUseActionInput,
  options: BrowserUseRunOptions = {}
): Promise<BrowserUseActionResult> {
  const previous = actionQueues.get(input.sessionId) ?? Promise.resolve();
  let currentTail: Promise<void>;
  const task = previous
    .catch(() => undefined)
    .then(async (): Promise<BrowserUseActionResult> => {
      let sessionController = sessionAbortControllers.get(input.sessionId);
      if (!sessionController || sessionController.signal.aborted) {
        sessionController = new AbortController();
        sessionAbortControllers.set(input.sessionId, sessionController);
      }
      const combined = combineAbortSignals([sessionController.signal, options.signal]);
      const deadlines = { ...DEFAULT_BROWSER_USE_DEADLINES, ...options.deadlines };
      try {
        throwIfAborted(combined.signal);
        // Reveal on a best-effort basis while acquiring the same tab
        // immediately for detached/background execution.
        if (panelOpener) void panelOpener(input.sessionId).catch(() => {});
        const target = manager.acquireAgentTarget(input.sessionId);
        await withDeadline(
          target.restore,
          deadlines.restoreMs,
          'Browser tab restore',
          combined.signal,
          () => stopLoading(target.webContents)
        );
        return await manager.withAgentActivity(input.sessionId, () =>
          runBrowserUseActionInner(input, target, combined.signal, deadlines)
        );
      } catch (error) {
        return { ok: false, message: browserUseErrorMessage(error) };
      } finally {
        combined.cleanup();
      }
    });
  currentTail = task.then(
    () => undefined,
    () => undefined
  );
  actionQueues.set(input.sessionId, currentTail);
  try {
    return await task;
  } finally {
    if (actionQueues.get(input.sessionId) === currentTail) {
      actionQueues.delete(input.sessionId);
    }
  }
}

async function runBrowserUseActionInner(
  input: BrowserUseActionInput,
  target: BrowserAgentTarget,
  signal: AbortSignal,
  deadlines: BrowserUseDeadlines
): Promise<BrowserUseActionResult> {
  const { tabId, webContents } = target;
  throwIfAborted(signal);
  if (webContents.isDestroyed()) return { ok: false, message: 'The browser tab was destroyed.' };

  try {
    switch (input.action) {
      case 'navigate': {
        if (!input.url) return { ok: false, message: 'url is required for navigate.' };
        // http(s) only: file:// origins resolve to "null" (breaking consent)
        // and other schemes are not web-browse targets.
        let parsed: URL;
        try {
          parsed = new URL(input.url);
        } catch {
          return { ok: false, message: `Invalid URL: ${input.url}` };
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return { ok: false, message: `Only http/https URLs can be opened (${parsed.protocol}).` };
        }
        // Navigation consent is enforced by the MCP layer (permission card);
        // this function performs the mechanical navigation only.
        await withDeadline(
          webContents.loadURL(input.url),
          deadlines.navigationMs,
          'Navigation',
          signal,
          () => stopLoading(webContents)
        );
        await waitForBrowserPageReady(webContents, deadlines.navigationMs, signal);
        return { ok: true, message: `Navigated to ${input.url}.` };
      }
      case 'snapshot': {
        const snapshot = await withDeadline(
          captureDomSnapshot(webContents),
          deadlines.commandMs,
          'Snapshot',
          signal
        );
        rememberSnapshot(input.sessionId, tabId, snapshot);
        return {
          ok: true,
          message: `Snapshot of ${snapshot.url}: ${snapshot.nodes.length} interactive elements.`,
          snapshot,
        };
      }
      case 'read': {
        const snapshot = await withDeadline(
          captureDomSnapshot(webContents),
          deadlines.commandMs,
          'Page read',
          signal
        );
        return {
          ok: true,
          message: `Read ${snapshot.url}.`,
          text: snapshot.textPreview || '(empty page)',
          snapshot,
        };
      }
      case 'click': {
        let x = input.x;
        let y = input.y;
        if (typeof input.nodeId === 'number' && input.snapshotId) {
          const snapshot = getRememberedSnapshot(input.sessionId, tabId);
          if (!snapshot || snapshot.snapshotId !== input.snapshotId) {
            return {
              ok: false,
              message: 'Stale snapshot. Take a new snapshot before addressing nodes.',
            };
          }
          // Read the CURRENT scroll so viewport coords re-base correctly
          // when the page scrolled since the snapshot.
          const current = await readScrollPosition(webContents, signal, deadlines.commandMs);
          const point = resolveNodePoint(
            snapshot,
            input.nodeId,
            current.scrollX,
            current.scrollY
          );
          if (!point) return { ok: false, message: `Node ${input.nodeId} not found in the snapshot.` };
          x = point.x;
          y = point.y;
        }
        if (typeof x !== 'number' || typeof y !== 'number') {
          return { ok: false, message: 'Provide x/y or nodeId+snapshotId for click.' };
        }
        // sendInputEvent expects viewport coordinates for visible content.
        webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        await waitForSettled(webContents, signal, deadlines.settleMs);
        return { ok: true, message: `Clicked (${x}, ${y}).` };
      }
      case 'type': {
        if (!input.text) return { ok: false, message: 'text is required for type.' };
        // Focus the point first (if provided), then insert the text.
        if (typeof input.x === 'number' && typeof input.y === 'number') {
          webContents.sendInputEvent({ type: 'mouseDown', x: input.x, y: input.y, button: 'left', clickCount: 1 });
          webContents.sendInputEvent({ type: 'mouseUp', x: input.x, y: input.y, button: 'left', clickCount: 1 });
        }
        for (const ch of input.text) {
          webContents.sendInputEvent({ type: 'char', keyCode: ch });
        }
        await waitForSettled(webContents, signal, deadlines.settleMs);
        return { ok: true, message: `Typed ${input.text.length} characters.` };
      }
      case 'key': {
        if (!input.key) return { ok: false, message: 'key is required for key.' };
        const keyCode = normalizeKey(input.key);
        webContents.sendInputEvent({ type: 'keyDown', keyCode });
        webContents.sendInputEvent({ type: 'keyUp', keyCode });
        await waitForSettled(webContents, signal, deadlines.settleMs);
        return { ok: true, message: `Pressed ${keyCode}.` };
      }
      case 'scroll': {
        const direction = input.direction === 'up' ? -1 : 1;
        const amount = Math.min(Math.max(input.amount ?? 600, 50), 5000);
        const x = input.x ?? 0;
        const y = input.y ?? 0;
        webContents.sendInputEvent({
          type: 'mouseWheel',
          x,
          y,
          deltaX: 0,
          deltaY: direction * amount,
        });
        await waitForSettled(webContents, signal, deadlines.settleMs);
        return { ok: true, message: `Scrolled ${direction === -1 ? 'up' : 'down'} by ${amount}px.` };
      }
      default:
        return { ok: false, message: `Unknown action: ${input.action}` };
    }
  } catch (error) {
    return { ok: false, message: browserUseErrorMessage(error) };
  }
}

/** Let synchronous handlers run, then wait for an event-driven navigation if
 * the interaction started one. */
async function waitForSettled(
  webContents: WebContents,
  signal: AbortSignal,
  timeoutMs: number
): Promise<void> {
  await abortableDelay(80, signal);
  if (webContents.isLoading()) {
    await waitForBrowserPageReady(webContents, timeoutMs, signal);
  }
}

/** Current page scroll, for re-basing snapshot viewport coordinates. */
async function readScrollPosition(
  webContents: WebContents,
  signal: AbortSignal,
  timeoutMs: number
): Promise<{ scrollX: number; scrollY: number }> {
  try {
    return (await withDeadline(
      webContents.executeJavaScript(
        '({ scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) })',
        true
      ),
      timeoutMs,
      'Scroll position read',
      signal
    )) as { scrollX: number; scrollY: number };
  } catch {
    return { scrollX: 0, scrollY: 0 };
  }
}

/** Cancel in-flight/queued work and release a detached backend at turn end,
 * Stop, Delete or app shutdown. A later turn lazily gets a fresh controller. */
export function finishBrowserUseTurn(manager: BrowserManager, sessionId: string): void {
  sessionAbortControllers.get(sessionId)?.abort(new Error('Browser turn ended.'));
  sessionAbortControllers.delete(sessionId);
  for (const key of [...lastSnapshots.keys()]) {
    if (key.startsWith(`${sessionId}:`)) lastSnapshots.delete(key);
  }
  manager.releaseAgentSession(sessionId);
}

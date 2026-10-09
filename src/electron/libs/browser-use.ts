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

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserAgentTarget, BrowserManager } from '../browserManager';
import { nativeImage, type NativeImage, type WebContents } from 'electron';

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

export type BrowserUseAction =
  | 'navigate'
  | 'back'
  | 'forward'
  | 'screenshot'
  | 'snapshot'
  | 'read'
  | 'click'
  | 'hover'
  | 'type'
  | 'select'
  | 'key'
  | 'scroll'
  | 'wait'
  | 'tabs';

export interface BrowserUseActionInput {
  /** The chat session; its main browser tab unless `tab` names another. */
  sessionId: string;
  action: BrowserUseAction;
  tab?: string;
  url?: string;
  x?: number;
  y?: number;
  nodeId?: number;
  snapshotId?: string;
  text?: string;
  clear?: boolean;
  value?: string;
  key?: string;
  direction?: 'up' | 'down';
  amount?: number;
  timeoutMs?: number;
}

export interface BrowserUseScreenshot {
  base64: string;
  mimeType: string;
  width: number;
  height: number;
  /** Image pixels per viewport CSS pixel (1 unless the viewport was large). */
  scale: number;
  path: string;
  url: string;
}

export interface BrowserUseTabInfo {
  tab: string;
  title: string;
  url: string;
  current: boolean;
}

export interface BrowserUseActionResult {
  ok: boolean;
  message: string;
  snapshot?: BrowserUseSnapshot;
  text?: string;
  screenshot?: BrowserUseScreenshot;
  tabs?: BrowserUseTabInfo[];
}

/** Snapshot cache: last snapshot per (browser session, page) for node addressing. */
const lastSnapshots = new Map<string, BrowserUseSnapshot>();

function cacheKey(browserSessionId: string, tabId: string): string {
  return `${browserSessionId}:${tabId}`;
}

export function rememberSnapshot(browserSessionId: string, tabId: string, snapshot: BrowserUseSnapshot): void {
  lastSnapshots.set(cacheKey(browserSessionId, tabId), snapshot);
  if (lastSnapshots.size > 32) {
    // Drop the oldest entry (Map preserves insertion order).
    const oldest = lastSnapshots.keys().next().value;
    if (oldest !== undefined) lastSnapshots.delete(oldest);
  }
}

export function getRememberedSnapshot(browserSessionId: string, tabId: string): BrowserUseSnapshot | null {
  return lastSnapshots.get(cacheKey(browserSessionId, tabId)) ?? null;
}

const KEY_ALIASES: Record<string, string> = {
  enter: 'Return',
  return: 'Return',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  space: 'Space',
  ' ': 'Space',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
};

const MODIFIER_ALIASES: Record<string, 'control' | 'meta' | 'alt' | 'shift'> = {
  ctrl: 'control',
  control: 'control',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
};

function normalizeKey(key: string): string {
  return KEY_ALIASES[key.trim().toLowerCase()] ?? key.trim();
}

/** "enter", "shift+tab", "cmd+a" → the key and its modifiers. */
export function parseKeyChord(chord: string): { keyCode: string; modifiers: Array<'control' | 'meta' | 'alt' | 'shift'> } {
  const parts = chord.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) return { keyCode: normalizeKey(chord), modifiers: [] };
  const modifiers: Array<'control' | 'meta' | 'alt' | 'shift'> = [];
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (modifier && !modifiers.includes(modifier)) modifiers.push(modifier);
  }
  return { keyCode: normalizeKey(parts[parts.length - 1]), modifiers };
}

/** Ask the renderer to reveal Browser Use. The action does not depend on the
 * renderer responding: BrowserManager can run the same tab detached. */
export type BrowserUsePanelOpener = (sessionId: string, tab: string) => Promise<void>;

let panelOpener: BrowserUsePanelOpener | null = null;

export function setBrowserUsePanelOpener(opener: BrowserUsePanelOpener | null): void {
  panelOpener = opener;
}

// ===== Screenshots =====

/** Longest image edge sent to models; larger viewports are scaled down. */
const SCREENSHOT_MAX_EDGE = 1568;
const SCREENSHOT_JPEG_QUALITY = 75;
/** Screenshots kept on disk per chat; older ones are deleted. */
const SCREENSHOTS_KEPT = 12;
let screenshotSequence = 0;

function screenshotRoot(): string {
  return process.env.AEGIS_BROWSER_SCREENSHOT_DIR || join(tmpdir(), 'aegis-browser-shots');
}

function screenshotDir(sessionId: string): string {
  return join(screenshotRoot(), sessionId.replace(/[^\w.-]/g, '_'));
}

async function saveScreenshot(sessionId: string, bytes: Buffer): Promise<string> {
  const dir = screenshotDir(sessionId);
  await mkdir(dir, { recursive: true });
  screenshotSequence += 1;
  const name = `shot-${Date.now()}-${String(screenshotSequence).padStart(4, '0')}.jpg`;
  const file = join(dir, name);
  await writeFile(file, bytes);
  const shots = (await readdir(dir)).filter((entry) => entry.startsWith('shot-')).sort();
  await Promise.all(
    shots.slice(0, Math.max(0, shots.length - SCREENSHOTS_KEPT)).map((entry) => rm(join(dir, entry), { force: true }))
  );
  return file;
}

/** A deleted chat's screenshots go with it. */
export async function forgetBrowserUseScreenshots(sessionId: string): Promise<void> {
  await rm(screenshotDir(sessionId), { recursive: true, force: true });
}

/**
 * The page's pixels. A page on screen (or shown before) captures directly; a
 * page an agent drives with the panel closed sits in a never-shown window that
 * has no display surface, so Chromium's own screenshot command renders it.
 */
async function capturePixels(webContents: WebContents): Promise<NativeImage> {
  try {
    const image = await webContents.capturePage(undefined, { stayHidden: true });
    if (!image.isEmpty()) return image;
  } catch {
    // No display surface: fall through to the DevTools protocol.
  }
  const { data } = (await sendDevtoolsCommand(webContents, 'Page.captureScreenshot', { format: 'png' })) as {
    data: string;
  };
  return nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
}

/** One DevTools protocol command, attaching only for its duration (and
 * leaving an existing attachment alone). */
async function sendDevtoolsCommand(
  webContents: WebContents,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const devtools = webContents.debugger;
  const attachedHere = !devtools.isAttached();
  if (attachedHere) devtools.attach('1.3');
  try {
    return await devtools.sendCommand(method, params);
  } finally {
    if (attachedHere && devtools.isAttached()) devtools.detach();
  }
}

async function captureScreenshot(
  sessionId: string,
  webContents: WebContents,
  signal: AbortSignal,
  timeoutMs: number
): Promise<BrowserUseScreenshot> {
  const viewport = (await withDeadline(
    webContents.executeJavaScript('({ width: innerWidth, height: innerHeight, url: location.href })', true),
    timeoutMs,
    'Viewport read',
    signal
  )) as { width: number; height: number; url: string };
  await hideAgentPointer(webContents);
  const image = await withDeadline(capturePixels(webContents), timeoutMs, 'Screenshot', signal);
  if (image.isEmpty()) throw new Error('The page has not painted anything to capture yet.');
  const scale = Math.min(1, SCREENSHOT_MAX_EDGE / Math.max(viewport.width, viewport.height, 1));
  const width = Math.max(1, Math.round(viewport.width * scale));
  const height = Math.max(1, Math.round(viewport.height * scale));
  const bytes = image.resize({ width, height, quality: 'good' }).toJPEG(SCREENSHOT_JPEG_QUALITY);
  const path = await saveScreenshot(sessionId, bytes);
  return {
    base64: bytes.toString('base64'),
    mimeType: 'image/jpeg',
    width,
    height,
    scale: Math.round(scale * 1000) / 1000,
    path,
    url: viewport.url,
  };
}

// ===== Agent pointer =====

/** Isolated world for Aegis's own in-page UI: the page can neither see nor
 * remove its globals, and the pointer never touches the page's scripts. */
const AEGIS_WORLD_ID = 1919;
const POINTER_ID = '__aegis_agent_pointer';

/** Shows where the agent is about to act, when the user can see the page. */
async function showAgentPointer(webContents: WebContents, x: number, y: number, kind: 'click' | 'hover' | 'type'): Promise<void> {
  const ring = kind === 'click' ? '0 0 0 10px rgba(59,130,246,0.18)' : '0 0 0 4px rgba(59,130,246,0.15)';
  const code = `(() => {
    let el = document.getElementById(${JSON.stringify(POINTER_ID)});
    const fresh = !el;
    if (!el) {
      el = document.createElement('div');
      el.id = ${JSON.stringify(POINTER_ID)};
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = 'position:fixed;left:0;top:0;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;' +
        'border:2px solid #3b82f6;background:rgba(59,130,246,0.2);pointer-events:none;z-index:2147483647;opacity:0;' +
        'transition:transform 220ms cubic-bezier(0.22,1,0.36,1),opacity 300ms ease,box-shadow 300ms ease;';
      document.documentElement.appendChild(el);
    }
    if (fresh) { el.style.transition = 'none'; el.style.transform = 'translate(${x}px, ${y}px)'; void el.offsetWidth; el.style.transition = ''; }
    el.style.transform = 'translate(${x}px, ${y}px)';
    el.style.opacity = '1';
    el.style.boxShadow = ${JSON.stringify(ring)};
    clearTimeout(window.__aegisPointerTimer);
    window.__aegisPointerTimer = setTimeout(() => { el.style.opacity = '0'; }, 1600);
    return true;
  })()`;
  await webContents.executeJavaScriptInIsolatedWorld(AEGIS_WORLD_ID, [{ code }]).catch(() => undefined);
}

/** Takes the pointer off the page before a screenshot. */
async function hideAgentPointer(webContents: WebContents): Promise<void> {
  const code = `(() => { const el = document.getElementById(${JSON.stringify(POINTER_ID)}); if (el) el.remove(); return true; })()`;
  await webContents.executeJavaScriptInIsolatedWorld(AEGIS_WORLD_ID, [{ code }]).catch(() => undefined);
}

/** Time for the pointer to travel before the input lands, so it reads as cause → effect. */
const POINTER_TRAVEL_MS = 220;

// ===== Actions =====

function resolveTab(
  manager: BrowserManager,
  input: BrowserUseActionInput
): { browserSessionId: string; tab: string } | { error: string } {
  const tab = input.tab?.trim() || 'main';
  if (tab === 'main') return { browserSessionId: input.sessionId, tab };
  const found = manager.agentTabs(input.sessionId).find((entry) => entry.tab === tab);
  return found
    ? { browserSessionId: found.browserSessionId, tab }
    : { error: `Unknown tab "${tab}". Use the tabs action to list this chat's browser tabs.` };
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
        const resolved = resolveTab(manager, input);
        if ('error' in resolved) return { ok: false, message: resolved.error };
        if (input.action === 'tabs') {
          const tabs = manager.agentTabs(input.sessionId).map((entry) => ({
            tab: entry.tab,
            title: entry.title,
            url: entry.url,
            current: entry.tab === resolved.tab,
          }));
          return { ok: true, message: `${tabs.length} browser tab${tabs.length === 1 ? '' : 's'} in this chat.`, tabs };
        }
        // Reveal on a best-effort basis while acquiring the same tab
        // immediately for detached/background execution.
        if (panelOpener) void panelOpener(input.sessionId, resolved.tab).catch(() => {});
        const target = manager.acquireAgentTarget(resolved.browserSessionId);
        await withDeadline(
          target.restore,
          deadlines.restoreMs,
          'Browser tab restore',
          combined.signal,
          () => stopLoading(target.webContents)
        );
        return await manager.withAgentActivity(resolved.browserSessionId, () =>
          runBrowserUseActionInner(input, resolved.browserSessionId, target, combined.signal, deadlines)
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

/** The viewport point an action targets: a snapshot node (re-based on the
 * current scroll) or explicit x/y. A string explains why there is none. */
async function resolvePoint(
  input: BrowserUseActionInput,
  browserSessionId: string,
  tabId: string,
  webContents: WebContents,
  signal: AbortSignal,
  timeoutMs: number
): Promise<{ x: number; y: number } | string | null> {
  if (typeof input.nodeId === 'number') {
    if (!input.snapshotId) return 'snapshot_id is required with node_id.';
    const snapshot = getRememberedSnapshot(browserSessionId, tabId);
    if (!snapshot || snapshot.snapshotId !== input.snapshotId) {
      return 'Stale snapshot. Take a new snapshot before addressing nodes.';
    }
    // Read the CURRENT scroll so viewport coords re-base correctly when the
    // page scrolled since the snapshot.
    const current = await readScrollPosition(webContents, signal, timeoutMs);
    const point = resolveNodePoint(snapshot, input.nodeId, current.scrollX, current.scrollY);
    return point ?? `Node ${input.nodeId} not found in the snapshot.`;
  }
  if (typeof input.x === 'number' && typeof input.y === 'number') return { x: Math.round(input.x), y: Math.round(input.y) };
  return null;
}

function clickAt(webContents: WebContents, x: number, y: number): void {
  // sendInputEvent expects viewport coordinates for visible content.
  webContents.sendInputEvent({ type: 'mouseMove', x, y });
  webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
}

const SELECT_SCRIPT = `((x, y, wanted) => {
  let el = document.elementFromPoint(x, y);
  if (el && el.tagName === 'LABEL' && el.control) el = el.control;
  while (el && el.tagName !== 'SELECT') el = el.parentElement;
  if (!el) return { ok: false, message: 'No <select> element at that point. Use click for custom dropdowns.' };
  const options = [...el.options];
  const label = (option) => (option.label || option.text || '').trim();
  const target = wanted.trim();
  const match = options.find((o) => o.value === wanted)
    || options.find((o) => label(o) === target)
    || options.find((o) => label(o).toLowerCase() === target.toLowerCase());
  if (!match) {
    return { ok: false, message: 'No option "' + wanted + '". Options: ' + options.slice(0, 40).map((o) => label(o) || o.value).join(', ') };
  }
  if (match.disabled) return { ok: false, message: 'Option "' + (label(match) || match.value) + '" is disabled.' };
  el.focus();
  // The native setter, so frameworks that track the value see the change.
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, match.value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, message: 'Selected "' + (label(match) || match.value) + '".' };
})`;

// Scrolls the container under the point (the page when nothing under it
// scrolls). Done in the page because Chromium runs no wheel scrolling for a
// page that isn't being drawn, as an agent's page with the panel closed.
const SCROLL_SCRIPT = `((x, y, dy) => {
  const page = document.scrollingElement || document.documentElement;
  const scrolls = (el) => {
    const overflow = getComputedStyle(el).overflowY;
    return /(auto|scroll|overlay)/.test(overflow) && el.scrollHeight > el.clientHeight + 1;
  };
  let el = document.elementFromPoint(x, y);
  while (el && el !== document.body && el !== document.documentElement && !scrolls(el)) el = el.parentElement;
  const target = el && el !== document.body && el !== document.documentElement ? el : page;
  const before = target.scrollTop;
  target.scrollBy({ top: dy, behavior: 'instant' });
  return {
    moved: Math.round(target.scrollTop - before),
    top: Math.round(target.scrollTop),
    max: Math.round(target.scrollHeight - target.clientHeight),
    page: target === page,
  };
})`;

const WAIT_POLL_MS = 200;

async function runBrowserUseActionInner(
  input: BrowserUseActionInput,
  browserSessionId: string,
  target: BrowserAgentTarget,
  signal: AbortSignal,
  deadlines: BrowserUseDeadlines
): Promise<BrowserUseActionResult> {
  const { tabId, webContents } = target;
  throwIfAborted(signal);
  if (webContents.isDestroyed()) return { ok: false, message: 'The browser tab was destroyed.' };
  const point = () => resolvePoint(input, browserSessionId, tabId, webContents, signal, deadlines.commandMs);

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
      case 'back':
      case 'forward': {
        const history = webContents.navigationHistory;
        const back = input.action === 'back';
        if (back ? !history.canGoBack() : !history.canGoForward()) {
          return { ok: false, message: back ? 'There is no earlier page in this tab.' : 'There is no later page in this tab.' };
        }
        if (back) history.goBack();
        else history.goForward();
        await waitForSettled(webContents, signal, deadlines.navigationMs);
        return { ok: true, message: `Went ${input.action} to ${webContents.getURL()}.` };
      }
      case 'screenshot': {
        const screenshot = await captureScreenshot(input.sessionId, webContents, signal, deadlines.commandMs);
        return { ok: true, message: `Captured ${screenshot.url}.`, screenshot };
      }
      case 'snapshot': {
        const snapshot = await withDeadline(
          captureDomSnapshot(webContents),
          deadlines.commandMs,
          'Snapshot',
          signal
        );
        rememberSnapshot(browserSessionId, tabId, snapshot);
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
      case 'click':
      case 'hover': {
        const at = await point();
        if (typeof at === 'string') return { ok: false, message: at };
        if (!at) return { ok: false, message: `Provide x/y or node_id + snapshot_id for ${input.action}.` };
        if (target.visible) {
          await showAgentPointer(webContents, at.x, at.y, input.action === 'click' ? 'click' : 'hover');
          await abortableDelay(POINTER_TRAVEL_MS, signal);
        }
        if (input.action === 'click') clickAt(webContents, at.x, at.y);
        // Chromium drops synthetic mouse moves for a page that isn't on
        // screen; the protocol's input path delivers them either way.
        else await sendDevtoolsCommand(webContents, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
        await waitForSettled(webContents, signal, deadlines.settleMs);
        return { ok: true, message: `${input.action === 'click' ? 'Clicked' : 'Hovered'} (${at.x}, ${at.y}).` };
      }
      case 'type': {
        const text = input.text ?? '';
        if (!text && !input.clear) return { ok: false, message: 'text is required for type (or clear: true to empty the field).' };
        // Focus the field first when one is named.
        const at = await point();
        if (typeof at === 'string') return { ok: false, message: at };
        if (at) {
          if (target.visible) {
            await showAgentPointer(webContents, at.x, at.y, 'type');
            await abortableDelay(POINTER_TRAVEL_MS, signal);
          }
          clickAt(webContents, at.x, at.y);
          await abortableDelay(50, signal);
        }
        if (input.clear) webContents.selectAll();
        // insertText goes through the editing pipeline like an IME commit, so
        // controlled inputs see real input events and any script works.
        if (text) await webContents.insertText(text);
        else {
          webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
          webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
        }
        await waitForSettled(webContents, signal, deadlines.settleMs);
        return {
          ok: true,
          message: text ? `Typed ${text.length} characters${input.clear ? ' in place of the field contents' : ''}.` : 'Cleared the field.',
        };
      }
      case 'select': {
        if (input.value === undefined) return { ok: false, message: 'value is required for select.' };
        const at = await point();
        if (typeof at === 'string') return { ok: false, message: at };
        if (!at) return { ok: false, message: 'Provide node_id + snapshot_id (or x/y) of the <select> element.' };
        const outcome = (await withDeadline(
          webContents.executeJavaScript(`${SELECT_SCRIPT}(${at.x}, ${at.y}, ${JSON.stringify(input.value)})`, true),
          deadlines.commandMs,
          'Select',
          signal
        )) as { ok: boolean; message: string };
        if (outcome.ok) await waitForSettled(webContents, signal, deadlines.settleMs);
        return outcome;
      }
      case 'key': {
        if (!input.key) return { ok: false, message: 'key is required for key.' };
        const { keyCode, modifiers } = parseKeyChord(input.key);
        webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
        if (keyCode === 'Space' && !modifiers.length) webContents.sendInputEvent({ type: 'char', keyCode: ' ' });
        webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
        await waitForSettled(webContents, signal, deadlines.settleMs);
        return { ok: true, message: `Pressed ${[...modifiers, keyCode].join('+')}.` };
      }
      case 'scroll': {
        const direction = input.direction === 'up' ? -1 : 1;
        const amount = Math.min(Math.max(input.amount ?? 600, 50), 5000);
        let at = await point();
        if (typeof at === 'string') return { ok: false, message: at };
        if (!at) {
          // The middle of the viewport, not its corner.
          const size = (await withDeadline(
            webContents.executeJavaScript('({ width: innerWidth, height: innerHeight })', true),
            deadlines.commandMs,
            'Viewport read',
            signal
          )) as { width: number; height: number };
          at = { x: Math.round(size.width / 2), y: Math.round(size.height / 2) };
        }
        const outcome = (await withDeadline(
          webContents.executeJavaScript(`${SCROLL_SCRIPT}(${at.x}, ${at.y}, ${direction * amount})`, true),
          deadlines.commandMs,
          'Scroll',
          signal
        )) as { moved: number; top: number; max: number; page: boolean };
        await waitForSettled(webContents, signal, deadlines.settleMs);
        const where = `${outcome.page ? 'the page' : 'the scrollable area'} is at ${outcome.top} of ${outcome.max}px`;
        if (!outcome.moved) {
          return { ok: true, message: `Nothing scrolled: already at the ${direction === -1 ? 'top' : 'bottom'} (${where}).` };
        }
        return { ok: true, message: `Scrolled ${direction === -1 ? 'up' : 'down'} by ${Math.abs(outcome.moved)}px; ${where}.` };
      }
      case 'wait': {
        if (!input.text) {
          const ms = Math.min(Math.max(input.amount ?? 1000, 0), 10_000);
          await abortableDelay(ms, signal);
          return { ok: true, message: `Waited ${ms}ms.` };
        }
        const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 5000, 100), 20_000);
        const deadline = Date.now() + timeoutMs;
        const probe = `(() => { const body = document.body; return !!body && body.innerText.includes(${JSON.stringify(input.text)}); })()`;
        for (;;) {
          throwIfAborted(signal);
          const found = webContents.isLoading()
            ? false
            : ((await withDeadline(webContents.executeJavaScript(probe, true), deadlines.commandMs, 'Wait', signal)) as boolean);
          if (found) return { ok: true, message: `"${input.text}" is on the page.` };
          if (Date.now() >= deadline) {
            return { ok: false, message: `"${input.text}" did not appear within ${timeoutMs}ms.` };
          }
          await abortableDelay(WAIT_POLL_MS, signal);
        }
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

/** Cancel in-flight/queued work and release the chat's detached tabs at turn
 * end, Stop, Delete or app shutdown. A later turn lazily gets a fresh controller. */
export function finishBrowserUseTurn(manager: BrowserManager, sessionId: string): void {
  sessionAbortControllers.get(sessionId)?.abort(new Error('Browser turn ended.'));
  sessionAbortControllers.delete(sessionId);
  for (const key of [...lastSnapshots.keys()]) {
    if (key.startsWith(`${sessionId}:`)) lastSnapshots.delete(key);
  }
  manager.releaseAgentChat(sessionId);
}

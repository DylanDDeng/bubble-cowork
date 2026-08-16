// Browser Use service: agent-driven automation of the session's built-in
// browser (Codex-parity browser use, Phase 1).
//
// Design mirrors what the Codex app ships:
//   - the agent drives the SAME visible tabs the user sees (no hidden page
//     for Phase 1 — every action lands where the user can watch it);
//   - navigation is gated by the session's existing permission pipeline, so
//     Allow/Block decisions and per-origin remembers work uniformly for
//     every provider;
//   - interaction primitives are cua-level (coordinates) plus a DOM-snapshot
//     addressing mode with stable per-snapshot node ids (dom_cua parity).
//
// The service lives in the main process next to BrowserManager and is exposed
// to agents through per-provider MCP wiring (see browser-use-mcp.ts).

import type { BrowserManager } from '../browserManager';
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

/**
 * Execute one browser-use action against the ACTIVE tab of a session's
 * built-in browser. The tab must be live (not suspended): the manager keeps
 * at least the active tab live while the panel is open.
 */
export async function runBrowserUseAction(
  manager: BrowserManager,
  input: BrowserUseActionInput
): Promise<BrowserUseActionResult> {
  // Wrap the whole action in the agent-activity mark so the panel badge is
  // up for exactly the action's lifetime (Codex-parity visible browsing).
  return manager.withAgentActivity(input.sessionId, () =>
    runBrowserUseActionInner(manager, input)
  );
}

async function runBrowserUseActionInner(
  manager: BrowserManager,
  input: BrowserUseActionInput
): Promise<BrowserUseActionResult> {
  const state = manager.getState({ sessionId: input.sessionId });
  const tabId = state.activeTabId;
  if (!tabId) {
    return { ok: false, message: 'No active browser tab. Open the browser panel first.' };
  }
  const webContents = manager.getLiveWebContents(input.sessionId, tabId);
  if (!webContents) {
    return { ok: false, message: 'The browser tab is suspended. Reopen the browser panel and retry.' };
  }

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
        try {
          await webContents.loadURL(input.url);
        } catch (error) {
          return {
            ok: false,
            message: `Navigation failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        return { ok: true, message: `Navigated to ${input.url}.` };
      }
      case 'snapshot': {
        const snapshot = await captureDomSnapshot(webContents);
        rememberSnapshot(input.sessionId, tabId, snapshot);
        return {
          ok: true,
          message: `Snapshot of ${snapshot.url}: ${snapshot.nodes.length} interactive elements.`,
          snapshot,
        };
      }
      case 'read': {
        const snapshot = await captureDomSnapshot(webContents);
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
          const current = await readScrollPosition(webContents);
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
        await waitForSettled(webContents);
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
        await waitForSettled(webContents);
        return { ok: true, message: `Typed ${input.text.length} characters.` };
      }
      case 'key': {
        if (!input.key) return { ok: false, message: 'key is required for key.' };
        const keyCode = normalizeKey(input.key);
        webContents.sendInputEvent({ type: 'keyDown', keyCode });
        webContents.sendInputEvent({ type: 'keyUp', keyCode });
        await waitForSettled(webContents);
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
        await waitForSettled(webContents);
        return { ok: true, message: `Scrolled ${direction === -1 ? 'up' : 'down'} by ${amount}px.` };
      }
      default:
        return { ok: false, message: `Unknown action: ${input.action}` };
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Small settle window so navigation/render effects become observable. */
function waitForSettled(_webContents: WebContents): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 220));
}

/** Current page scroll, for re-basing snapshot viewport coordinates. */
async function readScrollPosition(webContents: WebContents): Promise<{ scrollX: number; scrollY: number }> {
  try {
    return (await webContents.executeJavaScript(
      '({ scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) })',
      true
    )) as { scrollX: number; scrollY: number };
  } catch {
    return { scrollX: 0, scrollY: 0 };
  }
}

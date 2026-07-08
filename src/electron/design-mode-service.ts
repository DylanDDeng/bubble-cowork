// Design-mode orchestration: inspector injection & polling, selection state,
// and the Apply transaction (write → strip preview → settle → classify →
// rollback/keep). Pure logic lives in libs/design-writeback/; this module
// owns fs + webContents side effects.
import { realpathSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { sep } from 'path';
import type { WebContents } from 'electron';
import { browserManager } from './browserManager';
import { INSPECTOR_SCRIPT } from './libs/design-writeback/inspector-script';
import { computeWritebackPlan, type CssEdit } from './libs/design-writeback/write-plan';
import {
  locateJsxElement,
  locateLineByFingerprint,
  type ElementAnchor,
} from './libs/design-writeback/source-locator';
import { extractInlineSourceMap, originalPositionFor } from './libs/design-writeback/sourcemap';
import { applyReversePatch, type ReversePatch } from './libs/design-writeback/patch';
import { enqueueFileWrite } from './libs/design-writeback/file-write-queue';
import {
  classifyVerification,
  expandEditProperties,
  valuesMatch,
  type VerificationVerdict,
} from './libs/design-writeback/verify-loop';
// The renderer↔main contract lives in ONE place — shared/design-mode-types —
// same convention as browser-ipc/browser-types. Do not re-declare it here.
import type {
  DesignApplyInput,
  DesignApplyResult,
  DesignCapabilities,
  DesignModeEvent,
  DesignModeTarget,
  DesignSelectionInfo,
} from '../shared/design-mode-types';

export type {
  DesignApplyInput,
  DesignApplyResult,
  DesignModeTarget,
} from '../shared/design-mode-types';

const POLL_INTERVAL_MS = 300;
const SETTLE_POLL_MS = 150;
const SETTLE_TIMEOUT_MS = 4000;

interface DesignSessionState {
  sessionId: string;
  tabId: string;
  projectRoot: string;
  pollTimer: NodeJS.Timeout | null;
  undoStack: Array<{ patch: ReversePatch; label: string }>;
  lastRollbackable: { patch: ReversePatch; edits: CssEdit[] } | null;
  capabilities: DesignCapabilities;
}

function keyOf(target: DesignModeTarget): string {
  return `${target.sessionId}:${target.tabId}`;
}

function isLocalhostUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PreWriteMeasurement {
  computed: Record<string, string>;
  sanitySuspect: boolean;
}

export class DesignModeService {
  private readonly sessions = new Map<string, DesignSessionState>();
  private listener: ((event: DesignModeEvent) => void) | null = null;

  subscribe(listener: (event: DesignModeEvent) => void): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  private emit(event: DesignModeEvent): void {
    this.listener?.(event);
  }

  private webContentsFor(target: DesignModeTarget): WebContents | null {
    return browserManager.getLiveWebContents(target.sessionId, target.tabId);
  }

  async enable(input: DesignModeTarget & { projectRoot: string }): Promise<{ ok: boolean; message?: string; capabilities?: DesignCapabilities }> {
    const wc = this.webContentsFor(input);
    if (!wc) return { ok: false, message: 'This browser tab is not active.' };

    const url = wc.getURL() || '';
    if (!isLocalhostUrl(url)) {
      return {
        ok: false,
        message: 'Design mode only works on localhost dev pages. Start the project dev server and open it here first.',
      };
    }

    try {
      await wc.executeJavaScript(INSPECTOR_SCRIPT, true);
    } catch (error) {
      return { ok: false, message: `Failed to inject inspector: ${error instanceof Error ? error.message : String(error)}` };
    }

    const capabilities = await this.probeCapabilities(wc, url);
    const key = keyOf(input);
    const existing = this.sessions.get(key);
    if (existing?.pollTimer) clearInterval(existing.pollTimer);

    const state: DesignSessionState = {
      sessionId: input.sessionId,
      tabId: input.tabId,
      projectRoot: input.projectRoot,
      pollTimer: null,
      undoStack: existing?.undoStack ?? [],
      lastRollbackable: null,
      capabilities,
    };
    state.pollTimer = setInterval(() => {
      void this.pollOnce(state);
    }, POLL_INTERVAL_MS);
    state.pollTimer.unref();
    this.sessions.set(key, state);

    browserManager.setSessionPinned(input.sessionId, true);
    this.emit({ kind: 'enabled', sessionId: input.sessionId, tabId: input.tabId, capabilities });
    return { ok: true, capabilities };
  }

  private async probeCapabilities(wc: WebContents, url: string): Promise<DesignCapabilities> {
    let reactFiber = false;
    let hmrClient = false;
    try {
      const probe = (await wc.executeJavaScript(
        `(() => {
          let fiber = false;
          const all = document.querySelectorAll('*');
          for (let i = 0; i < all.length && i < 400; i += 1) {
            for (const key in all[i]) { if (key.indexOf('__reactFiber$') === 0) { fiber = true; break; } }
            if (fiber) break;
          }
          const hmr = Boolean(document.querySelector('script[src*="/@vite/client"]')) ||
            Boolean(window.__vite_plugin_react_preamble_installed__) ||
            Boolean(window.webpackHotUpdate) || Boolean(window.__webpack_hash__);
          return JSON.stringify({ fiber, hmr });
        })()`,
        true
      )) as string;
      const parsed = JSON.parse(probe) as { fiber: boolean; hmr: boolean };
      reactFiber = parsed.fiber;
      hmrClient = parsed.hmr;
    } catch {
      // Probe failure leaves capabilities pessimistic.
    }
    return { reactFiber, hmrClient, localhost: isLocalhostUrl(url) };
  }

  async disable(input: DesignModeTarget, reason = 'user'): Promise<void> {
    const key = keyOf(input);
    const state = this.sessions.get(key);
    if (state?.pollTimer) clearInterval(state.pollTimer);
    this.sessions.delete(key);
    const stillPinned = [...this.sessions.values()].some((s) => s.sessionId === input.sessionId);
    if (!stillPinned) browserManager.setSessionPinned(input.sessionId, false);
    const wc = this.webContentsFor(input);
    if (wc) {
      await wc
        .executeJavaScript(
          `(() => { if (window.__aegisDesignClearSelection) window.__aegisDesignClearSelection(); if (window.__aegisDesignSetEnabled) window.__aegisDesignSetEnabled(false); return true; })()`,
          true
        )
        .catch(() => undefined);
    }
    this.emit({ kind: 'disabled', sessionId: input.sessionId, tabId: input.tabId, reason });
  }

  private async pollOnce(state: DesignSessionState): Promise<void> {
    const wc = this.webContentsFor(state);
    if (!wc) {
      await this.disable(state, 'page-gone');
      return;
    }
    let raw: unknown = null;
    try {
      raw = await wc.executeJavaScript('window.__aegisDesignDrain ? window.__aegisDesignDrain() : null', true);
    } catch {
      raw = null;
    }
    if (raw === null) {
      // Injection lost (navigation / reload). Re-inject while still on localhost.
      const url = wc.getURL() || '';
      if (!isLocalhostUrl(url)) {
        await this.disable(state, 'left-localhost');
        return;
      }
      try {
        await wc.executeJavaScript(INSPECTOR_SCRIPT, true);
        this.emit({ kind: 'reinjected', sessionId: state.sessionId, tabId: state.tabId });
      } catch {
        // Try again next tick.
      }
      return;
    }
    try {
      const events = JSON.parse(String(raw)) as Array<{ kind: string; info?: DesignSelectionInfo }>;
      for (const event of events) {
        if (event.kind === 'selected' && event.info) {
          this.emit({ kind: 'selection', sessionId: state.sessionId, tabId: state.tabId, info: event.info });
        }
      }
    } catch {
      // Malformed drain payload — ignore this tick.
    }
  }

  /**
   * Fresh geometry of the selected element (annotate crops the screenshot at
   * SUBMIT time — the selection-time rect goes stale the moment the page
   * scrolls or reflows).
   */
  async measureSelection(
    input: DesignModeTarget
  ): Promise<{ found: boolean; rect?: { x: number; y: number; w: number; h: number }; viewport?: { w: number; h: number } }> {
    const wc = this.webContentsFor(input);
    if (!wc) return { found: false };
    try {
      const measured = await this.measurePage(wc);
      if (!measured) return { found: false };
      return {
        found: measured.found,
        rect: (measured as { rect?: { x: number; y: number; w: number; h: number } }).rect,
        viewport: (measured as { viewport?: { w: number; h: number } }).viewport,
      };
    } catch {
      return { found: false };
    }
  }

  async preview(input: DesignModeTarget & { property: string; value: string }): Promise<boolean> {
    const wc = this.webContentsFor(input);
    if (!wc) return false;
    try {
      return Boolean(
        await wc.executeJavaScript(
          `window.__aegisDesignPreview ? window.__aegisDesignPreview(${JSON.stringify(input.property)}, ${JSON.stringify(input.value)}) : false`,
          true
        )
      );
    } catch {
      return false;
    }
  }

  async clearPreview(input: DesignModeTarget): Promise<void> {
    const wc = this.webContentsFor(input);
    if (!wc) return;
    await wc
      .executeJavaScript('window.__aegisDesignStripPreview ? window.__aegisDesignStripPreview() : false', true)
      .catch(() => undefined);
  }

  /**
   * Validate that the write target is a real file inside the project root.
   * source.file comes from an untrusted page (a page can fabricate fibers
   * pointing anywhere), so this is a security boundary, not a convenience.
   */
  private validatePath(projectRoot: string, filePath: string): { ok: true; resolved: string } | { ok: false; message: string } {
    try {
      if (!existsSync(filePath)) return { ok: false, message: `file does not exist: ${filePath}` };
      const resolved = realpathSync(filePath);
      const rootResolved = realpathSync(projectRoot);
      if (resolved !== rootResolved && !resolved.startsWith(rootResolved + sep)) {
        return { ok: false, message: 'write target is outside the project root — refused' };
      }
      return { ok: true, resolved };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async apply(input: DesignApplyInput): Promise<DesignApplyResult> {
    const key = keyOf(input);
    const state = this.sessions.get(key);
    if (!state) {
      return {
        outcome: 'error',
        detail: 'design mode is not enabled for this tab',
        undoDepth: 0,
        canUndo: false,
        canRollback: false,
      };
    }
    const depth = () => state.undoStack.length;

    const pathCheck = this.validatePath(input.projectRoot, input.filePath);
    if (!pathCheck.ok) {
      return {
        outcome: 'refused',
        reason: 'unsafe-path',
        detail: pathCheck.message,
        undoDepth: depth(),
        canUndo: depth() > 0,
        canRollback: false,
      };
    }

    // 0. Resolve the anchor: fiber line numbers from modern toolchains
    //    (esbuild jsxDev) are TRANSFORMED-module coordinates. Try the raw
    //    line, then the className fingerprint, then sourcemap remap.
    const anchor = await this.resolveAnchor(input, pathCheck.resolved);

    // 1. PRE-WRITE measurement (verification step 0): strip the preview and
    //    capture the baseline BEFORE the file changes — measuring after the
    //    write races HMR on fast dev servers and misreports a successful
    //    apply as sanity-suspect (review finding).
    const wc = this.webContentsFor(input);
    let baseline: PreWriteMeasurement | null = null;
    if (wc) baseline = await this.measureBeforeWrite(wc, input.edits);

    // 2. Plan + write, atomically per file (read-verify-write in one job).
    const writeResult = await enqueueFileWrite(pathCheck.resolved, () => {
      const content = readFileSync(pathCheck.resolved, 'utf8');
      const plan = computeWritebackPlan({
        filePath: pathCheck.resolved,
        fileContent: content,
        anchor,
        edits: input.edits,
        variantHint: input.variantHint,
      });
      if (!plan.ok) return { plan } as const;
      writeFileSync(pathCheck.resolved, plan.newContent, 'utf8');
      return { plan } as const;
    });

    const plan = writeResult.plan;
    if (!plan.ok) {
      return {
        outcome: 'refused',
        reason: plan.reason,
        detail: plan.detail,
        undoDepth: depth(),
        canUndo: depth() > 0,
        canRollback: false,
      };
    }

    // 3. Settle + classify.
    let verdict: VerificationVerdict;
    let measuredClassList: string | null = null;
    if (!wc) {
      verdict = {
        state: 'unverified',
        reason: 'element-missing',
        detail: 'page went away during apply — write kept',
      };
    } else {
      const verified = await this.verify(wc, plan, input.edits, baseline);
      verdict = verified.verdict;
      measuredClassList = verified.lastClassList;
    }

    // 4. Act on the verdict.
    if (verdict.state === 'failed' && verdict.autoRollback) {
      const rolledBack = await this.rollback(pathCheck.resolved, plan.reversePatch);
      return {
        outcome: 'rolled-back',
        reason: verdict.reason,
        detail: `${verdict.detail}${rolledBack ? '' : ' (rollback also failed — file left as written)'}`,
        strategy: plan.strategy,
        undoDepth: depth(),
        canUndo: depth() > 0,
        canRollback: false,
      };
    }

    state.undoStack.push({ patch: plan.reversePatch, label: plan.addedClasses.join(' ') });
    state.lastRollbackable = verdict.state === 'failed' ? { patch: plan.reversePatch, edits: input.edits } : null;

    if (verdict.state === 'failed' && wc) {
      // Category (b): keep the code, but restore the user's visual state so
      // their adjustment work is never destroyed (product review).
      for (const edit of input.edits) {
        await this.preview({ ...input, property: edit.property, value: edit.value });
      }
    }

    return {
      outcome: verdict.state,
      reason: 'reason' in verdict ? verdict.reason : undefined,
      detail: verdict.detail,
      strategy: plan.strategy,
      addedClasses: plan.addedClasses,
      // The source changed — the drawer must adopt the new className as its
      // selection snapshot or the NEXT apply is refused as stale-anchor.
      updatedSnapshot: measuredClassList ?? plan.mergedClassName ?? undefined,
      undoDepth: depth(),
      canUndo: depth() > 0,
      canRollback: verdict.state === 'failed',
    };
  }

  /**
   * Turn a runtime anchor into one that actually locates in the source file.
   *
   * Order matters: (1) raw line — exact-source toolchains; (2) className
   * FINGERPRINT — precise whenever the static class-set is unique, and the
   * primary fallback in practice because modern @vitejs/plugin-react reports
   * fiber lines in INTERMEDIATE transform coordinates that even the served
   * sourcemap cannot decode (stage mismatch, verified empirically); (3)
   * sourcemap remap — best-effort for toolchains whose fiber coordinates DO
   * match the served module. A wrong remap cannot silently corrupt: static
   * shapes are guarded by the snapshot check here, and dynamic shapes by the
   * verify loop's "classes landed on the SELECTED element" assertion.
   */
  private async resolveAnchor(
    input: DesignApplyInput,
    resolvedPath: string
  ): Promise<ElementAnchor> {
    const anchor: ElementAnchor = {
      line: input.anchor.line,
      tagName: input.anchor.tagName,
      siblingIndex: input.anchor.siblingIndex,
      classNameSnapshot: input.anchor.classNameSnapshot,
    };
    let content: string;
    try {
      content = readFileSync(resolvedPath, 'utf8');
    } catch {
      return anchor;
    }
    if (locateJsxElement(content, anchor).ok) return anchor;

    const fingerprint = locateLineByFingerprint(content, anchor.tagName, anchor.classNameSnapshot);
    if (fingerprint.ok) {
      return { ...anchor, line: fingerprint.line, siblingIndex: fingerprint.siblingIndex };
    }

    const wc = this.webContentsFor(input);
    if (wc) {
      try {
        const origin = new URL(wc.getURL()).origin;
        const moduleUrl = `${origin}/@fs${resolvedPath}`;
        const response = await fetch(moduleUrl);
        if (response.ok) {
          const map = extractInlineSourceMap(await response.text());
          if (map) {
            const columnGuesses = [input.anchor.column ?? 1, Math.max(0, (input.anchor.column ?? 1) - 1)];
            for (const column of columnGuesses) {
              const mapped = originalPositionFor(map, anchor.line, Math.max(0, column));
              if (!mapped) continue;
              const candidate = { ...anchor, line: mapped.line };
              if (locateJsxElement(content, candidate).ok) return candidate;
            }
          }
        }
      } catch {
        // Best-effort only.
      }
    }
    return anchor;
  }

  private async measurePage(wc: WebContents) {
    const raw = (await wc.executeJavaScript(
      'window.__aegisDesignMeasure ? window.__aegisDesignMeasure() : null',
      true
    )) as string | null;
    if (!raw) return null;
    return JSON.parse(raw) as {
      found: boolean;
      viteErrorOverlay: boolean;
      classList?: string;
      computed?: Record<string, string>;
      previewActive?: boolean;
    };
  }

  /**
   * Verification step 0, taken BEFORE the file write: strip every preview
   * patch (red-team A1 — otherwise the measurement reads our preview back)
   * and capture the true pre-edit baseline. Measuring after the write races
   * HMR and can misreport a fast successful apply as sanity-suspect.
   */
  private async measureBeforeWrite(wc: WebContents, edits: CssEdit[]): Promise<PreWriteMeasurement | null> {
    try {
      await wc.executeJavaScript('window.__aegisDesignStripPreview ? window.__aegisDesignStripPreview() : false', true);
      const initial = await this.measurePage(wc);
      if (!initial?.found || !initial.computed) return null;
      return {
        computed: initial.computed,
        sanitySuspect: edits.every((edit) =>
          expandEditProperties(edit.property).every((prop) => valuesMatch(edit.value, initial.computed?.[prop]))
        ),
      };
    } catch {
      return null;
    }
  }

  private async verify(
    wc: WebContents,
    plan: Extract<ReturnType<typeof computeWritebackPlan>, { ok: true }>,
    edits: CssEdit[],
    preWrite: PreWriteMeasurement | null
  ): Promise<{ verdict: VerificationVerdict; lastClassList: string | null }> {
    const measure = () => this.measurePage(wc);
    const baseline = preWrite?.computed ?? null;
    const sanitySuspect = preWrite?.sanitySuspect ?? false;

    // Settle poll: wait for the written classes to reach the DOM and for two
    // consecutive stable readings (covers HMR latency AND css transitions).
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    let last: Awaited<ReturnType<typeof measure>> = null;
    let previousComputed: string | null = null;
    let stable = false;
    let timedOut = false;
    while (Date.now() < deadline) {
      await wait(SETTLE_POLL_MS);
      try {
        last = await measure();
      } catch {
        last = null;
      }
      if (!last) continue;
      if (last.viteErrorOverlay) break;
      if (!last.found) continue;
      const classTokens = new Set((last.classList || '').split(/\s+/).filter(Boolean));
      const classesLanded = plan.addedClasses.every((token) => classTokens.has(token));
      const computedKey = JSON.stringify(last.computed ?? {});
      if (classesLanded && computedKey === previousComputed) {
        stable = true;
        break;
      }
      previousComputed = computedKey;
    }
    if (!stable && !(last?.viteErrorOverlay)) {
      const classTokens = new Set((last?.classList || '').split(/\s+/).filter(Boolean));
      timedOut = !plan.addedClasses.every((token) => classTokens.has(token));
    }

    const verdict = classifyVerification({
      found: Boolean(last?.found),
      timedOut,
      viteErrorOverlay: Boolean(last?.viteErrorOverlay),
      sanitySuspect,
      classList: last?.classList ?? null,
      addedClasses: plan.addedClasses,
      removedClasses: plan.removedClasses,
      edits: edits.map((edit) => ({ property: edit.property, expected: edit.value })),
      baseline,
      current: last?.computed ?? null,
      alsoAffects: plan.alsoAffects,
    });
    return { verdict, lastClassList: last?.found ? last.classList ?? null : null };
  }

  private async rollback(filePath: string, patch: ReversePatch): Promise<boolean> {
    return enqueueFileWrite(filePath, () => {
      const current = readFileSync(filePath, 'utf8');
      const undone = applyReversePatch(current, patch);
      if (!undone.ok) return false;
      writeFileSync(filePath, undone.content, 'utf8');
      return true;
    });
  }

  /** Roll back the most recent kept-but-failed write (user-invoked). */
  async rollbackLastFailed(
    input: DesignModeTarget
  ): Promise<{ ok: boolean; message?: string; remaining: number }> {
    const state = this.sessions.get(keyOf(input));
    if (!state?.lastRollbackable) {
      return { ok: false, message: 'nothing to roll back', remaining: state?.undoStack.length ?? 0 };
    }
    const pathCheck = this.validatePath(state.projectRoot, state.lastRollbackable.patch.filePath);
    if (!pathCheck.ok) return { ok: false, message: pathCheck.message, remaining: state.undoStack.length };
    const ok = await this.rollback(pathCheck.resolved, state.lastRollbackable.patch);
    if (ok) {
      state.lastRollbackable = null;
      state.undoStack.pop();
    }
    return {
      ok,
      message: ok ? undefined : 'the edited region changed — refused to overwrite it',
      remaining: state.undoStack.length,
    };
  }

  async undo(input: DesignModeTarget): Promise<{ ok: boolean; message?: string; remaining: number }> {
    const state = this.sessions.get(keyOf(input));
    if (!state || state.undoStack.length === 0) {
      return { ok: false, message: 'nothing to undo', remaining: state?.undoStack.length ?? 0 };
    }
    const entry = state.undoStack[state.undoStack.length - 1];
    const pathCheck = this.validatePath(state.projectRoot, entry.patch.filePath);
    if (!pathCheck.ok) return { ok: false, message: pathCheck.message, remaining: state.undoStack.length };
    const ok = await this.rollback(pathCheck.resolved, entry.patch);
    if (ok) state.undoStack.pop();
    return {
      ok,
      message: ok ? undefined : 'the edited region changed since this edit — undo refused to avoid clobbering later work',
      remaining: state.undoStack.length,
    };
  }
}

export const designModeService = new DesignModeService();

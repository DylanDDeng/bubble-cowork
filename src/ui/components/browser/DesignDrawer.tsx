import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useAppStore } from '../../store/useAppStore';
import { Loader2, MessageSquare, Undo2, X } from '../icons';
import type {
  DesignApplyResult,
  DesignCapabilities,
  DesignSelectionInfo,
} from '../../../shared/design-mode-types';
import type { Attachment } from '../../../shared/types';
import { computeAnnotationCrop, composeAnnotationText } from './design-annotate';

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Crop a captured PNG data URL to the annotation region; null → use original. */
async function cropDataUrl(
  dataUrl: string,
  crop: { sx: number; sy: number; sw: number; sh: number } | null
): Promise<Uint8Array | null> {
  if (!crop) return null;
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('screenshot decode failed'));
    image.src = dataUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = crop.sw;
  canvas.height = crop.sh;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(image, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Coalesce per-side longhand edits into shorthands so the tailwind mapper
 * emits `p-6` instead of four `pt-6 pr-6 pb-6 pl-6` classes.
 */
export function coalesceEdits(edits: Record<string, string>): Array<{ property: string; value: string }> {
  const out = new Map(Object.entries(edits));
  for (const base of ['padding', 'margin'] as const) {
    const top = out.get(`${base}-top`);
    const right = out.get(`${base}-right`);
    const bottom = out.get(`${base}-bottom`);
    const left = out.get(`${base}-left`);
    if (top && right && bottom && left && top === right && top === bottom && top === left) {
      out.delete(`${base}-top`);
      out.delete(`${base}-right`);
      out.delete(`${base}-bottom`);
      out.delete(`${base}-left`);
      out.set(base, top);
      continue;
    }
    if (left && right && left === right) {
      out.delete(`${base}-left`);
      out.delete(`${base}-right`);
      out.set(`${base}-inline`, left);
    }
    if (top && bottom && top === bottom) {
      out.delete(`${base}-top`);
      out.delete(`${base}-bottom`);
      out.set(`${base}-block`, top);
    }
  }
  return [...out.entries()].map(([property, value]) => ({ property, value }));
}

function pxNumber(value: string | undefined): string {
  if (!value) return '';
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim());
  return match ? match[1] : '';
}

function rgbToHex(value: string | undefined): string {
  if (!value) return '#000000';
  const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value.trim());
  if (!match) return value.startsWith('#') ? value : '#000000';
  const toHex = (part: string) => Number(part).toString(16).padStart(2, '0');
  return `#${toHex(match[1])}${toHex(match[2])}${toHex(match[3])}`;
}

const SIDE_LABELS = [
  ['top', 'T'],
  ['right', 'R'],
  ['bottom', 'B'],
  ['left', 'L'],
] as const;

const FONT_WEIGHTS = ['100', '200', '300', '400', '500', '600', '700', '800', '900'];

const OUTCOME_STYLES: Record<string, string> = {
  verified: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  unverified: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  failed: 'border-red-500/40 bg-red-500/10 text-red-400',
  'rolled-back': 'border-red-500/40 bg-red-500/10 text-red-400',
  refused: 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]',
  error: 'border-red-500/40 bg-red-500/10 text-red-400',
};

const OUTCOME_LABELS: Record<string, string> = {
  verified: 'Applied & verified',
  unverified: 'Applied — not verified',
  failed: 'Applied but not effective',
  'rolled-back': 'Rolled back',
  refused: 'Needs the agent',
  error: 'Error',
};

export function DesignDrawer({
  browserSessionId,
  tabId,
  projectRoot,
  capabilities,
  onClose,
  resolveChatTargetId,
}: {
  browserSessionId: string;
  tabId: string;
  projectRoot: string;
  capabilities: DesignCapabilities | null;
  onClose: () => void;
  resolveChatTargetId: () => string;
}) {
  const requestChatInjection = useAppStore((s) => s.requestChatInjection);
  const [selection, setSelection] = useState<DesignSelectionInfo | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<DesignApplyResult | null>(null);
  const [undoCount, setUndoCount] = useState(0);
  const [annotation, setAnnotation] = useState('');
  const [annotating, setAnnotating] = useState(false);

  useEffect(() => {
    return window.electron.designMode.onEvent((event) => {
      if (event.sessionId !== browserSessionId || event.tabId !== tabId) return;
      if (event.kind === 'selection') {
        setSelection(event.info);
        setEdits({});
        setResult(null);
      }
      if (event.kind === 'reinjected') {
        // The guest page fully reloaded: the fresh inspector has NO selection,
        // so a kept stale one would make every preview call silently no-op.
        setSelection(null);
        setEdits({});
        setResult(null);
      }
      if (event.kind === 'disabled') onClose();
    });
  }, [browserSessionId, tabId, onClose]);

  const setEdit = useCallback(
    (property: string, value: string) => {
      setEdits((current) => ({ ...current, [property]: value }));
      void window.electron.designMode.preview({ sessionId: browserSessionId, tabId, property, value });
    },
    [browserSessionId, tabId]
  );

  const pendingCount = Object.keys(edits).length;

  const composeAgentText = useCallback(() => {
    if (!selection) return '';
    const lines: string[] = [];
    const where = selection.source
      ? `${selection.source.file}:${selection.source.line}`
      : `selector <${selection.tagName}> (no source location)`;
    lines.push(`Apply these style changes to the <${selection.tagName}> element at ${where}:`);
    for (const edit of coalesceEdits(edits)) {
      lines.push(`- ${edit.property}: ${edit.value}`);
    }
    if (selection.chain.length > 0) lines.push(`Component chain: ${selection.chain.join(' > ')}`);
    if (selection.className) lines.push(`Current className: "${selection.className}"`);
    if (result?.outcome === 'failed' || result?.outcome === 'refused') {
      lines.push(`Note: direct write-back ${result.outcome === 'refused' ? 'was refused' : 'did not take effect'} (${result.reason ?? ''}: ${result.detail ?? ''}).`);
    }
    return lines.join('\n');
  }, [selection, edits, result]);

  const handleAskAgent = useCallback(() => {
    const text = composeAgentText();
    if (!text) return;
    requestChatInjection({
      sessionId: resolveChatTargetId(),
      text,
      mode: 'append',
      source: 'design-mode',
    });
    toast.success('Sent to the composer — review and send it to the agent');
  }, [composeAgentText, requestChatInjection, resolveChatTargetId]);

  const handleApply = useCallback(async () => {
    if (!selection || pendingCount === 0 || applying) return;
    if (!selection.source) {
      handleAskAgent();
      return;
    }
    setApplying(true);
    try {
      const applied = await window.electron.designMode.apply({
        sessionId: browserSessionId,
        tabId,
        projectRoot,
        filePath: selection.source.file,
        anchor: {
          line: selection.source.line,
          tagName: selection.tagName,
          siblingIndex: selection.siblingIndex,
          classNameSnapshot: selection.className || null,
          column: selection.source.column,
        },
        edits: coalesceEdits(edits),
      });
      setResult(applied);
      // The service is authoritative for undo depth — canUndo alone reflects
      // OLDER stack entries and must not bump the counter (review finding).
      setUndoCount(applied.undoDepth);
      if (applied.updatedSnapshot !== undefined) {
        // The source's className changed; without adopting it as the new
        // snapshot the NEXT apply on this selection is refused as stale.
        setSelection((current) =>
          current ? { ...current, className: applied.updatedSnapshot ?? current.className } : current
        );
      }
      if (applied.outcome === 'verified' || applied.outcome === 'unverified') {
        setEdits({});
      }
    } catch (error) {
      setResult({
        outcome: 'error',
        detail: error instanceof Error ? error.message : String(error),
        undoDepth: undoCount,
        canUndo: undoCount > 0,
        canRollback: false,
      });
    } finally {
      setApplying(false);
    }
  }, [selection, pendingCount, applying, browserSessionId, tabId, projectRoot, edits, handleAskAgent, undoCount]);

  // Annotate: free-text intent + a screenshot cropped to the element,
  // attached to the composer. Works for EVERY selection tier — including
  // source-less ones where deterministic write-back is impossible.
  const handleAnnotate = useCallback(async () => {
    if (!selection || !annotation.trim() || annotating) return;
    setAnnotating(true);
    try {
      const attachments: Attachment[] = [];
      let pageUrl: string | null = null;
      try {
        const captured = await window.electron.browser.capture({ sessionId: browserSessionId, tabId });
        if (captured.ok && captured.base64 && captured.dataUrl) {
          pageUrl = captured.pageUrl ?? null;
          // Fresh geometry at submit time — the selection-time rect is stale
          // the moment the page scrolls.
          const measured = await window.electron.designMode.measureSelection({ sessionId: browserSessionId, tabId });
          const rect = measured.found && measured.rect ? measured.rect : selection.rect;
          const viewport = measured.viewport ?? { w: rect.w, h: rect.h };
          const crop = computeAnnotationCrop(rect, viewport, {
            width: captured.width ?? 0,
            height: captured.height ?? 0,
          });
          const cropped = await cropDataUrl(captured.dataUrl, crop).catch(() => null);
          const bytes = cropped ?? base64ToBytes(captured.base64);
          const attachment = (await window.electron.createInlineImageAttachment(
            captured.mimeType || 'image/png',
            bytes
          )) as Attachment | null;
          if (attachment) attachments.push(attachment);
        }
      } catch {
        // Screenshot is best-effort; the annotation still carries the context.
      }
      requestChatInjection({
        sessionId: resolveChatTargetId(),
        text: composeAnnotationText({ note: annotation, selection, pageUrl }),
        attachments,
        mode: 'append',
        source: 'design-annotate',
      });
      setAnnotation('');
      toast.success('Annotation sent to the composer — review and send');
    } finally {
      setAnnotating(false);
    }
  }, [selection, annotation, annotating, browserSessionId, tabId, requestChatInjection, resolveChatTargetId]);

  const handleUndo = useCallback(async () => {
    const undone = await window.electron.designMode.undo({ sessionId: browserSessionId, tabId });
    if (!undone.ok) {
      toast.error(undone.message || 'Undo failed');
    }
    setUndoCount(undone.remaining);
  }, [browserSessionId, tabId]);

  const handleRollback = useCallback(async () => {
    const rolled = await window.electron.designMode.rollbackLastFailed({ sessionId: browserSessionId, tabId });
    if (!rolled.ok) toast.error(rolled.message || 'Rollback failed');
    else setResult(null);
    setUndoCount(rolled.remaining);
  }, [browserSessionId, tabId]);

  const computed = selection?.computed ?? {};
  const directWritable = Boolean(selection?.source);

  const spacingGroup = (base: 'padding' | 'margin') => (
    <div>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{base}</div>
      <div className="grid grid-cols-4 gap-1">
        {SIDE_LABELS.map(([side, label]) => {
          const property = `${base}-${side}`;
          const value = edits[property] ?? computed[property] ?? '';
          return (
            <label key={property} className="flex items-center gap-0.5 text-[10px] text-[var(--text-muted)]">
              {label}
              <input
                type="number"
                value={pxNumber(value)}
                onChange={(event) => setEdit(property, `${event.target.value || 0}px`)}
                className="h-6 w-full min-w-0 rounded border border-[var(--border)] bg-[var(--bg-tertiary)] px-1 text-[11px] text-[var(--text-primary)] focus:border-[var(--border-focus)] focus:outline-none"
              />
            </label>
          );
        })}
      </div>
    </div>
  );

  const colorControl = (property: 'color' | 'background-color', label: string) => (
    <label className="flex items-center justify-between gap-2 text-[11px] text-[var(--text-secondary)]">
      {label}
      <input
        type="color"
        value={rgbToHex(edits[property] ?? computed[property])}
        onChange={(event) => setEdit(property, event.target.value)}
        className="h-6 w-10 cursor-pointer rounded border border-[var(--border)] bg-transparent"
      />
    </label>
  );

  return (
    <div
      data-design-drawer
      className="flex w-[248px] flex-shrink-0 flex-col overflow-hidden border-l border-[var(--border)] bg-[var(--bg-primary)]"
    >
      <div className="flex flex-shrink-0 items-center justify-between border-b border-[var(--border)] px-2.5 py-1.5">
        <span className="text-[11px] font-medium text-[var(--text-primary)]">Design</span>
        <div className="flex items-center gap-1">
          {undoCount > 0 ? (
            <button
              type="button"
              onClick={handleUndo}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
              title={`Undo last applied edit (${undoCount})`}
            >
              <Undo2 className="h-3 w-3" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
            title="Exit design mode"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>

      {!selection ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-[11px] text-[var(--text-muted)]">
          <span>Click an element in the page to inspect and edit it.</span>
          {capabilities && !capabilities.reactFiber ? (
            <span className="text-amber-500">
              No React dev build detected — source locations unavailable; edits go through the agent.
            </span>
          ) : null}
          {capabilities && !capabilities.hmrClient ? (
            <span className="text-amber-500">No HMR client detected — writes cannot be live-verified.</span>
          ) : null}
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-2.5 py-2.5">
          {/* Element identity */}
          <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/60 px-2 py-1.5">
            <div className="truncate text-[11px] font-medium text-[var(--text-primary)]">
              &lt;{selection.tagName}&gt;
              {selection.text ? <span className="ml-1 font-normal text-[var(--text-muted)]">{selection.text}</span> : null}
            </div>
            {selection.chain.length > 0 ? (
              <div className="mt-0.5 truncate text-[10px] text-[var(--text-muted)]" title={selection.chain.join(' > ')}>
                {selection.chain.slice(0, 3).join(' › ')}
              </div>
            ) : null}
            <div className="mt-0.5 truncate text-[10px] text-[var(--text-muted)]" title={selection.source ? `${selection.source.file}:${selection.source.line}` : undefined}>
              {selection.source
                ? `${selection.source.file.split('/').pop()}:${selection.source.line}`
                : 'source unknown — agent only'}
            </div>
          </div>

          {/* Annotate: point at the element, say what you want in words */}
          <div className="space-y-1">
            <textarea
              value={annotation}
              onChange={(event) => setAnnotation(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  void handleAnnotate();
                }
              }}
              placeholder="Annotate: tell the agent what to change here…"
              rows={2}
              className="w-full resize-none rounded-md border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 py-1.5 text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)] focus:outline-none"
            />
            {annotation.trim() ? (
              <button
                type="button"
                onClick={() => void handleAnnotate()}
                disabled={annotating}
                className="inline-flex h-6 w-full items-center justify-center gap-1.5 rounded-md border border-[var(--border)] text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] disabled:opacity-40"
                title="Send this note + a cropped screenshot of the element to the composer (⌘↵)"
              >
                {annotating ? <Loader2 className="h-3 w-3 animate-spin" /> : <MessageSquare className="h-3 w-3" />}
                Annotate → agent
              </button>
            ) : null}
          </div>

          {spacingGroup('padding')}
          {spacingGroup('margin')}

          <div className="space-y-1.5">
            <label className="flex items-center justify-between gap-2 text-[11px] text-[var(--text-secondary)]">
              Font size
              <input
                type="number"
                value={pxNumber(edits['font-size'] ?? computed['font-size'])}
                onChange={(event) => setEdit('font-size', `${event.target.value || 0}px`)}
                className="h-6 w-16 rounded border border-[var(--border)] bg-[var(--bg-tertiary)] px-1 text-[11px] text-[var(--text-primary)] focus:border-[var(--border-focus)] focus:outline-none"
              />
            </label>
            <label className="flex items-center justify-between gap-2 text-[11px] text-[var(--text-secondary)]">
              Weight
              <select
                value={edits['font-weight'] ?? computed['font-weight'] ?? '400'}
                onChange={(event) => setEdit('font-weight', event.target.value)}
                className="h-6 w-16 rounded border border-[var(--border)] bg-[var(--bg-tertiary)] px-1 text-[11px] text-[var(--text-primary)] focus:outline-none"
              >
                {FONT_WEIGHTS.map((weight) => (
                  <option key={weight} value={weight}>{weight}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center justify-between gap-2 text-[11px] text-[var(--text-secondary)]">
              Radius
              <input
                type="number"
                value={pxNumber(edits['border-radius'] ?? computed['border-radius'])}
                onChange={(event) => setEdit('border-radius', `${event.target.value || 0}px`)}
                className="h-6 w-16 rounded border border-[var(--border)] bg-[var(--bg-tertiary)] px-1 text-[11px] text-[var(--text-primary)] focus:border-[var(--border-focus)] focus:outline-none"
              />
            </label>
            {colorControl('color', 'Text color')}
            {colorControl('background-color', 'Background')}
          </div>

          {/* Result banner */}
          {result ? (
            <div className={`rounded-md border px-2 py-1.5 text-[10px] ${OUTCOME_STYLES[result.outcome] ?? OUTCOME_STYLES.error}`}>
              <div className="font-medium">{OUTCOME_LABELS[result.outcome] ?? result.outcome}</div>
              {result.detail ? <div className="mt-0.5 opacity-90">{result.detail}</div> : null}
              {result.outcome === 'failed' && result.canRollback ? (
                <div className="mt-1 flex gap-1">
                  <button type="button" onClick={() => setResult(null)} className="rounded border border-current px-1.5 py-0.5">
                    Keep code
                  </button>
                  <button type="button" onClick={handleRollback} className="rounded border border-current px-1.5 py-0.5">
                    Roll back
                  </button>
                  <button type="button" onClick={handleAskAgent} className="rounded border border-current px-1.5 py-0.5">
                    Ask agent
                  </button>
                </div>
              ) : null}
              {result.outcome === 'refused' ? (
                <div className="mt-1">
                  <button type="button" onClick={handleAskAgent} className="rounded border border-current px-1.5 py-0.5">
                    Apply via agent
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      {/* Footer: apply */}
      {selection ? (
        <div className="flex flex-shrink-0 items-center gap-1.5 border-t border-[var(--border)] px-2.5 py-2">
          <button
            type="button"
            onClick={handleApply}
            disabled={pendingCount === 0 || applying}
            className="inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md bg-[var(--accent)] px-2 text-[11px] font-medium text-white transition-opacity disabled:opacity-40"
            title={directWritable ? 'Write the change into source code' : 'No source location — goes to the agent'}
          >
            {applying ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {directWritable ? `Apply${pendingCount > 0 ? ` (${pendingCount})` : ''}` : 'Apply via agent'}
          </button>
          <button
            type="button"
            onClick={handleAskAgent}
            disabled={pendingCount === 0}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[var(--border)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] disabled:opacity-40"
            title="Send these values to the agent instead"
          >
            <MessageSquare className="h-3 w-3" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

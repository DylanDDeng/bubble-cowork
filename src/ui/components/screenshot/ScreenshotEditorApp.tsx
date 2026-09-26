import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  DEFAULT_SCREENSHOT_STYLE,
  SCREENSHOT_BACKGROUNDS,
  SCREENSHOT_CUSTOM_BACKGROUND,
  SCREENSHOT_RATIOS,
  SCREENSHOT_STYLE_LIMITS,
  normalizeScreenshotStyle,
  screenshotBackground,
  screenshotBackgroundBlurs,
  screenshotFileName,
  screenshotRectFromPoints,
  type ScreenshotBackground,
  type ScreenshotCaptureInfo,
  type ScreenshotExportAction,
  type ScreenshotRect,
  type ScreenshotStyle,
} from '../../../shared/screenshot';
import { Blur, Check, Copy, Crop, Download, Paperclip, Plus, Redo2, RefreshCw, Undo2 } from '../icons';
import { exportScreenshotPng, renderScreenshotScene, sceneLayout, sceneSource, type ScreenshotScene } from './screenshot-render';

const STYLE_KEY = 'aegis.screenshot.style';
const REMEMBER_KEY = 'aegis.screenshot.rememberStyle';
// Agents downscale large images anyway; keep attachments under the 10 MB cap.
const ATTACH_MAX_EDGE = 3200;
const ATTACH_MAX_BYTES = 9.5 * 1024 * 1024;

type Tool = 'none' | 'crop' | 'redact';

interface EditorDoc {
  style: ScreenshotStyle;
  crop: ScreenshotRect | null;
  redactions: ScreenshotRect[];
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Style memory is a convenience only.
  }
}

function initialStyle(): ScreenshotStyle {
  const raw = readStorage(STYLE_KEY);
  if (!raw) return DEFAULT_SCREENSHOT_STYLE;
  try {
    return normalizeScreenshotStyle(JSON.parse(raw));
  } catch {
    return DEFAULT_SCREENSHOT_STYLE;
  }
}

function backgroundSwatch(background: ScreenshotBackground): string | undefined {
  switch (background.kind) {
    case 'solid':
      return background.color;
    case 'linear':
      return `linear-gradient(${background.angle}deg, ${background.stops.map(([offset, color]) => `${color} ${offset * 100}%`).join(', ')})`;
    case 'mesh':
      return [
        ...background.blobs.map((blob) => `radial-gradient(at ${blob.x * 100}% ${blob.y * 100}%, ${blob.color} 0, transparent ${blob.r * 90}%)`),
        background.base,
      ].join(', ');
    default:
      return undefined;
  }
}

function sameDoc(a: EditorDoc, b: EditorDoc): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function ScreenshotEditorApp() {
  const [capture, setCapture] = useState<{ info: ScreenshotCaptureInfo; image: ImageBitmap } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [doc, setDoc] = useState<EditorDoc>(() => ({ style: initialStyle(), crop: null, redactions: [] }));
  const committed = useRef(doc);
  // Refs hold the truth so StrictMode's double-invoked updaters stay pure.
  const docRef = useRef(doc);
  docRef.current = doc;
  const historyRef = useRef<{ past: EditorDoc[]; future: EditorDoc[] }>({ past: [], future: [] });
  const [history, setHistory] = useState<{ past: EditorDoc[]; future: EditorDoc[] }>({ past: [], future: [] });
  const [tool, setTool] = useState<Tool>('none');
  const [cropDraft, setCropDraft] = useState<ScreenshotRect | null>(null);
  const [drawing, setDrawing] = useState<ScreenshotRect | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [customBackground, setCustomBackground] = useState<ImageBitmap | null>(null);
  const [remember, setRemember] = useState(() => readStorage(REMEMBER_KEY) !== 'false');
  const [busy, setBusy] = useState<ScreenshotExportAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    document.title = 'Screenshot';
  }, []);

  const load = useCallback(async () => {
    try {
      const payload = await window.electron.loadScreenshotEditor();
      if (!payload) {
        setLoadError('This screenshot is no longer available.');
        return;
      }
      const image = await createImageBitmap(new Blob([payload.data as BlobPart], { type: 'image/png' }));
      setCapture((previous) => {
        previous?.image.close();
        return { info: payload.info, image };
      });
      setLoadError(null);
      // A new capture keeps the style but drops edits tied to the old pixels.
      const next = { style: committed.current.style, crop: null, redactions: [] };
      committed.current = next;
      setDoc(next);
      historyRef.current = { past: [], future: [] };
      setHistory({ past: [], future: [] });
      setTool('none');
      setSelected(null);
      setCropDraft(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load the screenshot.');
    }
  }, []);

  useEffect(() => {
    void load();
    return window.electron.onScreenshotEditorUpdated(() => void load());
  }, [load]);

  useLayoutEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => {
      setViewport({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // ---- history -------------------------------------------------------------
  const publishHistory = () => setHistory({ ...historyRef.current });

  const commit = useCallback((next?: EditorDoc) => {
    const value = next ?? docRef.current;
    setDoc(value);
    if (sameDoc(value, committed.current)) return;
    historyRef.current = { past: [...historyRef.current.past.slice(-49), committed.current], future: [] };
    committed.current = value;
    publishHistory();
  }, []);

  const undo = useCallback(() => {
    const previous = historyRef.current.past.at(-1);
    if (!previous) return;
    historyRef.current = { past: historyRef.current.past.slice(0, -1), future: [committed.current, ...historyRef.current.future] };
    committed.current = previous;
    setDoc(previous);
    setSelected(null);
    publishHistory();
  }, []);

  const redo = useCallback(() => {
    const next = historyRef.current.future[0];
    if (!next) return;
    historyRef.current = { past: [...historyRef.current.past, committed.current], future: historyRef.current.future.slice(1) };
    committed.current = next;
    setDoc(next);
    setSelected(null);
    publishHistory();
  }, []);

  const updateStyle = (patch: Partial<ScreenshotStyle>, shouldCommit: boolean) => {
    const current = docRef.current;
    const next = { ...current, style: { ...current.style, ...patch } };
    if (shouldCommit) commit(next);
    else setDoc(next);
  };

  useEffect(() => {
    writeStorage(REMEMBER_KEY, String(remember));
    // The custom image lives in memory only; normalize drops it on reload.
    if (remember) writeStorage(STYLE_KEY, JSON.stringify(normalizeScreenshotStyle(doc.style)));
  }, [doc.style, remember]);

  // ---- scene + preview -----------------------------------------------------
  const scene: ScreenshotScene | null = useMemo(() => capture ? {
    image: capture.image,
    crop: tool === 'crop' ? null : doc.crop,
    redactions: doc.redactions,
    style: doc.style,
    scaleFactor: capture.info.scaleFactor,
    customBackground,
  } : null, [capture, customBackground, doc, tool]);

  const exportScene = useMemo(() => (scene ? { ...scene, crop: doc.crop } : null), [doc.crop, scene]);
  const layout = scene ? sceneLayout(scene) : null;
  const exportLayout = exportScene ? sceneLayout(exportScene) : null;
  const zoom = layout && viewport.width > 0
    ? Math.min(1, (viewport.width - 64) / layout.width, (viewport.height - 64) / layout.height)
    : 0;
  const pixelZoom = Math.min(1, zoom * (window.devicePixelRatio || 1));

  useEffect(() => {
    if (!scene || !canvasRef.current || pixelZoom <= 0) return;
    const frame = requestAnimationFrame(() => {
      if (canvasRef.current) renderScreenshotScene(canvasRef.current, scene, pixelZoom);
    });
    return () => cancelAnimationFrame(frame);
  }, [pixelZoom, scene]);

  // Image rect inside the preview, in CSS pixels, plus the source it shows.
  const source = scene ? sceneSource(scene) : null;
  const imageBox = layout ? {
    x: layout.image.x * zoom,
    y: layout.image.y * zoom,
    width: layout.image.width * zoom,
    height: layout.image.height * zoom,
  } : null;

  const toCss = (rect: ScreenshotRect) => ({
    left: (rect.x - (source?.x ?? 0)) * zoom,
    top: (rect.y - (source?.y ?? 0)) * zoom,
    width: rect.width * zoom,
    height: rect.height * zoom,
  });

  const toSource = (event: ReactPointerEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: (source?.x ?? 0) + (event.clientX - box.left) / zoom,
      y: (source?.y ?? 0) + (event.clientY - box.top) / zoom,
    };
  };

  // ---- pointer drawing (crop + redact) --------------------------------------
  const onOverlayPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (tool === 'none' || !source || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStart.current = toSource(event);
    setSelected(null);
    setDrawing({ ...dragStart.current, width: 0, height: 0 });
  };

  const onOverlayPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragStart.current || !source) return;
    const rect = screenshotRectFromPoints(dragStart.current, toSource(event), source);
    if (tool === 'crop') setCropDraft(rect);
    else setDrawing(rect);
  };

  const onOverlayPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragStart.current || !source || !capture) return;
    const rect = screenshotRectFromPoints(dragStart.current, toSource(event), source);
    dragStart.current = null;
    setDrawing(null);
    const minimum = 4 * capture.info.scaleFactor;
    if (rect.width < minimum || rect.height < minimum) {
      if (tool === 'crop') setCropDraft(doc.crop);
      return;
    }
    if (tool === 'crop') {
      setCropDraft(rect);
    } else {
      commit({ ...doc, redactions: [...doc.redactions, rect] });
      setSelected(doc.redactions.length);
    }
  };

  const enterCrop = () => {
    setSelected(null);
    setCropDraft(doc.crop);
    setTool('crop');
  };

  const applyCrop = () => {
    const full = capture && cropDraft && cropDraft.x === 0 && cropDraft.y === 0
      && cropDraft.width === capture.image.width && cropDraft.height === capture.image.height;
    commit({ ...doc, crop: full ? null : cropDraft });
    setTool('none');
  };

  const cancelCrop = () => {
    setCropDraft(null);
    setTool('none');
  };

  const deleteSelected = () => {
    if (selected === null) return;
    commit({ ...doc, redactions: doc.redactions.filter((_, index) => index !== selected) });
    setSelected(null);
  };

  // ---- export --------------------------------------------------------------
  const runExport = useCallback(async (action: ScreenshotExportAction) => {
    if (!exportScene || busy) return;
    setBusy(action);
    setNotice(null);
    try {
      const data = await exportScreenshotPng(exportScene, action === 'attach' ? { maxEdge: ATTACH_MAX_EDGE, maxBytes: ATTACH_MAX_BYTES } : {});
      const result = await window.electron.exportScreenshot(action, data, screenshotFileName(new Date(capture?.info.capturedAt ?? Date.now())));
      if (result.ok) {
        // Attach closes from the main process; copy/save finish the hand-off here.
        if (action !== 'attach') void window.electron.closeScreenshotEditor();
      } else if (result.message) {
        setNotice(result.message);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Export failed.');
    } finally {
      setBusy(null);
    }
  }, [busy, capture?.info.capturedAt, exportScene]);

  // ---- keyboard ------------------------------------------------------------
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (mod && key === 'c') {
        event.preventDefault();
        void runExport('copy');
      } else if (mod && key === 's') {
        event.preventDefault();
        void runExport('save');
      } else if (event.key === 'Enter' && !mod) {
        event.preventDefault();
        if (tool === 'crop') applyCrop();
        else void runExport('attach');
      } else if (event.key === 'Escape') {
        event.preventDefault();
        if (tool === 'crop') cancelCrop();
        else if (selected !== null) setSelected(null);
        else if (tool === 'redact') setTool('none');
        else void window.electron.closeScreenshotEditor();
      } else if ((event.key === 'Backspace' || event.key === 'Delete') && selected !== null) {
        event.preventDefault();
        deleteSelected();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const onPickImage = async (file: File | undefined) => {
    if (!file) return;
    try {
      const bitmap = await createImageBitmap(file);
      setCustomBackground((previous) => {
        previous?.close();
        return bitmap;
      });
      commit({ ...doc, style: { ...doc.style, background: SCREENSHOT_CUSTOM_BACKGROUND.id } });
    } catch {
      setNotice('That image could not be opened.');
    }
  };

  const background = screenshotBackground(doc.style.background);
  const blurEnabled = screenshotBackgroundBlurs(background);
  const outputLabel = exportLayout && capture
    ? `${exportLayout.width} × ${exportLayout.height} · PNG${capture.info.scaleFactor >= 2 ? ' · Retina' : ''}`
    : '';

  return (
    <div className="flex h-screen flex-col bg-[var(--bg-primary)] text-[var(--text-primary)]">
      {/* Title bar */}
      <div className="drag-region relative flex h-11 shrink-0 items-center border-b border-[var(--border)] bg-[var(--app-chrome-bg,var(--bg-primary))] pl-20 pr-3">
        <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-[12.5px] font-semibold text-[var(--text-secondary)]">Screenshot</div>
        <div className="no-drag ml-auto flex items-center gap-0.5">
          <ToolbarButton active={tool === 'crop'} onClick={() => (tool === 'crop' ? applyCrop() : enterCrop())} disabled={!capture} label="Crop">
            <Crop className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton active={tool === 'redact'} onClick={() => { setSelected(null); setTool(tool === 'redact' ? 'none' : 'redact'); }} disabled={!capture || tool === 'crop'} label="Redact">
            <Blur className="h-4 w-4" />
          </ToolbarButton>
          <div className="mx-1.5 h-4 w-px bg-[var(--border)]" />
          <ToolbarButton onClick={undo} disabled={!history.past.length || tool === 'crop'} title="Undo (⌘Z)">
            <Undo2 className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton onClick={redo} disabled={!history.future.length || tool === 'crop'} title="Redo (⇧⌘Z)">
            <Redo2 className="h-4 w-4" />
          </ToolbarButton>
          <div className="mx-1.5 h-4 w-px bg-[var(--border)]" />
          <ToolbarButton onClick={() => void window.electron.retakeScreenshot()} label="Retake">
            <RefreshCw className="h-4 w-4" />
          </ToolbarButton>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Canvas */}
        <div
          ref={canvasHostRef}
          className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-[var(--bg-tertiary)]"
          style={{ backgroundImage: 'radial-gradient(var(--border) 1px, transparent 1px)', backgroundSize: '16px 16px' }}
          onPointerDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}
        >
          {loadError ? (
            <div className="text-[13px] text-[var(--text-muted)]">{loadError}</div>
          ) : layout && zoom > 0 ? (
            <div
              className="relative shadow-[0_1px_3px_rgba(0,0,0,0.12)]"
              style={{
                width: layout.width * zoom,
                height: layout.height * zoom,
                background: background.kind === 'none'
                  ? 'repeating-conic-gradient(rgba(128,128,128,0.22) 0 25%, transparent 0 50%) 0 0 / 16px 16px'
                  : undefined,
              }}
            >
              <canvas ref={canvasRef} className="block h-full w-full" />
              {imageBox && tool !== 'none' ? (
                <div
                  className="absolute overflow-hidden"
                  style={{ left: imageBox.x, top: imageBox.y, width: imageBox.width, height: imageBox.height, cursor: 'crosshair', touchAction: 'none' }}
                  onPointerDown={onOverlayPointerDown}
                  onPointerMove={onOverlayPointerMove}
                  onPointerUp={onOverlayPointerUp}
                  onPointerCancel={() => { dragStart.current = null; setDrawing(null); }}
                >
                  {tool === 'crop' ? (
                    cropDraft ? (
                      <div
                        className="pointer-events-none absolute border border-white/90"
                        style={{ ...toCss(cropDraft), boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)' }}
                      />
                    ) : null
                  ) : null}
                  {tool === 'redact' ? doc.redactions.map((rect, index) => (
                    <button
                      key={`${rect.x}:${rect.y}:${index}`}
                      type="button"
                      aria-label="Select redaction"
                      className="absolute rounded-[3px] outline-offset-2"
                      style={{
                        ...toCss(rect),
                        outline: `1.5px ${selected === index ? 'solid' : 'dashed'} var(--accent)`,
                      }}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        setSelected(index);
                      }}
                    />
                  )) : null}
                  {drawing && tool === 'redact' ? (
                    <div className="pointer-events-none absolute rounded-[3px] bg-[var(--accent-light)]" style={{ ...toCss(drawing), outline: '1.5px dashed var(--accent)' }} />
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {tool === 'crop' ? (
            <div className="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-1 rounded-[10px] bg-[var(--popover-bg)] p-1 text-[12px] shadow-[var(--popover-shadow-lg)]">
              <span className="px-2 text-[var(--text-muted)]">Drag to crop</span>
              <button type="button" className="h-7 rounded-[7px] px-2.5 text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]" onClick={() => setCropDraft(null)}>Reset</button>
              <button type="button" className="h-7 rounded-[7px] px-2.5 text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]" onClick={cancelCrop}>Cancel</button>
              <button type="button" className="flex h-7 items-center gap-1 rounded-[7px] bg-[var(--accent)] px-2.5 font-medium text-[var(--accent-foreground)]" onClick={applyCrop}>
                <Check className="h-3.5 w-3.5" /> Done
              </button>
            </div>
          ) : tool === 'redact' ? (
            <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-[10px] bg-[var(--popover-bg)] px-3 py-1.5 text-[12px] text-[var(--text-muted)] shadow-[var(--popover-shadow-lg)]">
              Drag over anything sensitive · Delete removes the selected box
            </div>
          ) : null}

          {zoom > 0 ? (
            <div className="absolute bottom-3 left-3.5 rounded-md bg-[var(--popover-bg)] px-2 py-1 text-[11px] text-[var(--text-muted)] shadow-[var(--popover-shadow-lg)]">
              Fit · {Math.round(zoom * 100)}%
            </div>
          ) : null}
        </div>

        {/* Inspector */}
        <aside className="flex w-[280px] shrink-0 flex-col gap-[18px] overflow-y-auto border-l border-[var(--border)] px-4 py-3.5">
          <Section title="Background">
            <div className="grid grid-cols-5 gap-[7px]">
              {SCREENSHOT_BACKGROUNDS.map((item) => (
                <Swatch
                  key={item.id}
                  label={item.label}
                  selected={doc.style.background === item.id}
                  onClick={() => commit({ ...doc, style: { ...doc.style, background: item.id } })}
                  style={
                    item.kind === 'none'
                      ? { background: 'repeating-conic-gradient(#d4d4d4 0 25%, #fff 0 50%) 0 0 / 8px 8px' }
                      : item.kind === 'backdrop'
                        ? { background: 'linear-gradient(135deg, var(--text-muted), var(--bg-tertiary))', filter: 'blur(0.5px)' }
                        : { background: backgroundSwatch(item) }
                  }
                />
              ))}
              <Swatch
                label={customBackground ? 'Custom image' : 'Choose image…'}
                selected={doc.style.background === SCREENSHOT_CUSTOM_BACKGROUND.id}
                onClick={() => {
                  if (customBackground && doc.style.background !== SCREENSHOT_CUSTOM_BACKGROUND.id) {
                    commit({ ...doc, style: { ...doc.style, background: SCREENSHOT_CUSTOM_BACKGROUND.id } });
                  } else {
                    fileInputRef.current?.click();
                  }
                }}
                style={{}}
              >
                <Plus className="h-4 w-4 text-[var(--text-muted)]" />
              </Swatch>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/heic"
                className="hidden"
                onChange={(event) => {
                  void onPickImage(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
            </div>
          </Section>

          <SliderSection
            title="Blur"
            value={doc.style.blur}
            limits={SCREENSHOT_STYLE_LIMITS.blur}
            disabled={!blurEnabled}
            hint={blurEnabled ? 'Blurs the image behind the shot' : 'Available for image backgrounds'}
            onChange={(value, done) => updateStyle({ blur: value }, done)}
          />
          <SliderSection title="Padding" value={doc.style.padding} limits={SCREENSHOT_STYLE_LIMITS.padding} onChange={(value, done) => updateStyle({ padding: value }, done)} />
          <SliderSection title="Corner radius" value={doc.style.radius} limits={SCREENSHOT_STYLE_LIMITS.radius} onChange={(value, done) => updateStyle({ radius: value }, done)} />
          <SliderSection title="Shadow" value={doc.style.shadow} limits={SCREENSHOT_STYLE_LIMITS.shadow} onChange={(value, done) => updateStyle({ shadow: value }, done)} />

          <Section title="Aspect ratio">
            <div className="grid grid-cols-5 rounded-lg bg-[var(--bg-secondary)] p-0.5">
              {SCREENSHOT_RATIOS.map((ratio) => (
                <button
                  key={ratio}
                  type="button"
                  onClick={() => commit({ ...doc, style: { ...doc.style, ratio } })}
                  className={`h-[26px] rounded-md text-[11.5px] transition-colors ${
                    doc.style.ratio === ratio
                      ? 'bg-[var(--popover-bg)] text-[var(--text-primary)] shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {ratio === 'auto' ? 'Auto' : ratio}
                </button>
              ))}
            </div>
          </Section>

          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-[var(--text-secondary)]">
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} className="h-3.5 w-3.5 accent-[var(--accent)]" />
            Use this style for next capture
          </label>

          <button
            type="button"
            className="self-start text-[12px] text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            onClick={() => commit({ ...doc, style: DEFAULT_SCREENSHOT_STYLE })}
          >
            Reset style
          </button>
        </aside>
      </div>

      {/* Footer */}
      <div className="flex h-14 shrink-0 items-center gap-2 border-t border-[var(--border)] px-3.5">
        <span data-screenshot-output className="text-[11.5px] tabular-nums text-[var(--text-muted)]">{outputLabel}</span>
        {notice ? <span className="truncate text-[11.5px] text-[var(--error)]">{notice}</span> : null}
        <span className="flex-1" />
        <FooterButton onClick={() => void runExport('save')} disabled={!capture || busy !== null} shortcut="⌘S">
          <Download className="h-4 w-4" /> Save…
        </FooterButton>
        <FooterButton onClick={() => void runExport('copy')} disabled={!capture || busy !== null} shortcut="⌘C">
          <Copy className="h-4 w-4" /> Copy
        </FooterButton>
        <button
          type="button"
          onClick={() => void runExport('attach')}
          disabled={!capture || busy !== null}
          className="flex h-8 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 text-[12.5px] font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          <Paperclip className="h-4 w-4" />
          {busy === 'attach' ? 'Attaching…' : 'Attach to chat'}
          <span className="text-[11px] opacity-70">↵</span>
        </button>
      </div>
    </div>
  );
}

function ToolbarButton({ active, disabled, label, title, onClick, children }: {
  active?: boolean;
  disabled?: boolean;
  label?: string;
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title ?? label}
      aria-label={title ?? label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-7 min-w-7 items-center justify-center gap-1.5 rounded-[7px] px-2 text-[12px] transition-colors disabled:opacity-40 ${
        active
          ? 'bg-[var(--accent-light)] text-[var(--accent)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'
      }`}
    >
      {children}
      {label ? <span>{label}</span> : null}
    </button>
  );
}

function FooterButton({ onClick, disabled, shortcut, children }: { onClick: () => void; disabled?: boolean; shortcut: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 text-[12.5px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-secondary)] disabled:opacity-50"
    >
      {children}
      <span className="text-[11px] text-[var(--text-muted)]">{shortcut}</span>
    </button>
  );
}

function Section({ title, value, children }: { title: string; value?: number; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-[11.5px] font-semibold text-[var(--text-secondary)]">
        {title}
        {value !== undefined ? <span className="font-normal tabular-nums text-[var(--text-muted)]">{value}</span> : null}
      </div>
      {children}
    </div>
  );
}

function SliderSection({ title, value, limits, disabled, hint, onChange }: {
  title: string;
  value: number;
  limits: readonly [number, number];
  disabled?: boolean;
  hint?: string;
  onChange: (value: number, done: boolean) => void;
}) {
  return (
    <div className={disabled ? 'opacity-45' : undefined}>
      <Section title={title} value={value}>
        <input
          type="range"
          min={limits[0]}
          max={limits[1]}
          value={value}
          disabled={disabled}
          aria-label={title}
          onChange={(event) => onChange(Number(event.target.value), false)}
          onPointerUp={(event) => onChange(Number(event.currentTarget.value), true)}
          onKeyUp={(event) => onChange(Number(event.currentTarget.value), true)}
          className="w-full accent-[var(--accent)]"
        />
        {hint ? <div className="mt-1 text-[11px] text-[var(--text-muted)]">{hint}</div> : null}
      </Section>
    </div>
  );
}

function Swatch({ label, selected, onClick, style, children }: {
  label: string;
  selected: boolean;
  onClick: () => void;
  style: React.CSSProperties;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={selected}
      onClick={onClick}
      className={`relative flex aspect-square items-center justify-center rounded-lg shadow-[inset_0_0_0_1px_var(--border)] ${
        selected ? 'after:absolute after:-inset-[3px] after:rounded-[10px] after:border-2 after:border-[var(--accent)]' : ''
      }`}
      style={style}
    >
      {children}
    </button>
  );
}

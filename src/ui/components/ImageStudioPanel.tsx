import { ImageGenerationPlaceholder } from './ImageGenerationPlaceholder';
import { ImageStudioLatestTurn } from './ImageStudioLatestTurn';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useAppStore } from '../store/useAppStore';
import { EMPTY_IMAGE_STUDIO, useImageStudioStore } from '../store/useImageStudioStore';
import { cancelQueuedImageEdit, submitImageEdit } from '../lib/image-studio';
import { clampImageZoom, collectStudioImages, drawBrushStrokes, IMAGE_RATIOS, imagePoint, resolveStudioActivePath, supportsImageStudio, type BrushStroke, type ImageComment } from '../utils/image-studio';
import { useAppReducedMotion } from '../hooks/useAppReducedMotion';
import { CheckSquare, ChevronDown, Download, Image as ImageIcon, LayoutGrid, Maximize2, MessageCircle, Minus, Pencil, Plus, Redo2, Sparkles, Undo2, X } from './icons';
import { ImageStudioComposerSlot } from './ImageStudioComposerDock';
import './image-studio.css';

type Preview = { src: string; width: number; height: number };
const previewCache = new Map<string, Promise<Preview>>();
const resolvedPreviews = new Map<string, Preview>();
function loadPreview(path: string): Promise<Preview> {
  const cached = previewCache.get(path);
  if (cached) return cached;
  const pending = (async () => {
    const preview = await window.electron.readProjectFilePreview(path.replace(/\/[^/]*$/, '') || '/', path) as { kind?: string; dataUrl?: string };
    if (preview.kind !== 'image' || !preview.dataUrl) throw new Error('Could not open this image.');
    const img = new window.Image();
    img.src = preview.dataUrl;
    await img.decode();
    const value = { src: preview.dataUrl, width: img.naturalWidth, height: img.naturalHeight };
    if (previewCache.has(path)) resolvedPreviews.set(path, value);
    return value;
  })();
  previewCache.set(path, pending);
  // Bound decoded source retention; panel-local references live only while mounted.
  if (previewCache.size > 24) {
    const oldest = previewCache.keys().next().value!;
    previewCache.delete(oldest); resolvedPreviews.delete(oldest);
  }
  pending.catch(() => previewCache.delete(path));
  return pending;
}
function usePreview(path: string) {
  const [value, setValue] = useState<{ path: string; image?: Preview; error?: string }>(() => ({ path, image: resolvedPreviews.get(path) }));
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    loadPreview(path).then(image => { if (!cancelled) setValue({ path, image }); }, error => { if (!cancelled) setValue({ path, error: String(error.message || error) }); });
    return () => { cancelled = true; };
  }, [path, retry]);
  return { ...(value?.path === path ? value : {}), retry: () => { previewCache.delete(path); resolvedPreviews.delete(path); setValue({ path }); setRetry(v => v + 1); } };
}
function Thumbnail({ path }: { path: string }) {
  const preview = usePreview(path);
  return preview.image ? <img src={preview.image.src} alt="" draggable={false} /> : <ImageIcon size={20} />;
}

interface PictureProps {
  path: string;
  zoom: number;
  fitWidth: number;
  fitHeight: number;
  selected: boolean;
  notes: ImageComment[];
  tool: 'pan' | 'comment' | 'select' | 'erase';
  strokes?: BrushStroke[];
  brush: number;
  onStroke: (stroke: BrushStroke) => void;
  onPoint: (point: { x: number; y: number }) => void;
  onNote: (note: ImageComment) => void;
  onSelect: () => void;
  onReady?: (image: Preview) => void;
}
function Picture({ path, zoom, fitWidth, fitHeight, selected, notes, tool, strokes, brush, onStroke, onPoint, onNote, onSelect, onReady }: PictureProps) {
  const preview = usePreview(path);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stroke = useRef<BrushStroke | null>(null);
  const [live, setLive] = useState<BrushStroke | null>(null);
  useEffect(() => { if (preview.image) onReady?.(preview.image); }, [preview.image, onReady]);
  useLayoutEffect(() => { if (canvasRef.current) drawBrushStrokes(canvasRef.current, [...(strokes || []), ...(live ? [live] : [])]); }, [strokes, live, preview.image]);
  if (preview.error) return <div className="image-studio-empty" role="status">{preview.error}<button onClick={preview.retry}>Retry</button></div>;
  if (!preview.image) return <div className="image-studio-empty" role="status">Loading image…</div>;
  const image = preview.image;
  const scale = Math.min(fitWidth / image.width, fitHeight / image.height, 1) * zoom / 100;
  return <div className="image-studio-picture" data-image-path={path} data-selected={selected} data-tool={tool}
    style={{ width: image.width * scale, height: image.height * scale }}
    onClick={event => {
      if (tool === 'pan') { onSelect(); return; }
      if (tool !== 'comment' && tool !== 'select') return;
      onPoint(imagePoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect()));
    }}>
    <img src={image.src} alt={path.split('/').pop() || 'Generated image'} draggable={false} />
    {notes.map((note, index) => <button className="image-studio-pin" key={note.id} style={{ left: `${note.x * 100}%`, top: `${note.y * 100}%` }}
      title={note.text} aria-label={`Comment ${index + 1}: ${note.text}`} onPointerDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); onNote(note); }}>{index + 1}</button>)}
    {tool === 'erase' && <canvas ref={canvasRef} width={image.width} height={image.height} aria-label="Paint area to remove"
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
        stroke.current = { size: brush, points: [imagePoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect())] };
        setLive(stroke.current);
      }} onPointerMove={event => {
        if (!stroke.current) return;
        stroke.current = { ...stroke.current, points: [...stroke.current.points, imagePoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect())] };
        setLive(stroke.current);
      }} onPointerUp={event => {
        if (!stroke.current) return;
        onStroke(stroke.current); stroke.current = null; setLive(null);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }} onPointerCancel={() => { stroke.current = null; setLive(null); }} />}
  </div>;
}

export function ImageStudioPanel({ sessionId, hidden = false, fullscreen = false }: { sessionId: string; hidden?: boolean; fullscreen?: boolean }) {
  const session = useAppStore(state => state.sessions[sessionId]);
  const studio = useImageStudioStore(state => state.sessions[sessionId] || EMPTY_IMAGE_STUDIO);
  const patch = (update: Parameters<ReturnType<typeof useImageStudioStore.getState>['patch']>[1]) => useImageStudioStore.getState().patch(sessionId, update);
  const images = useMemo(() => collectStudioImages(session?.messages || [], session?.cwd), [session?.messages, session?.cwd]);
  const paths = useMemo(() => images.map(image => image.path), [images]);
  const selectedPath = resolveStudioActivePath(studio.activePath, images, session?.cwd);
  // A resolved Markdown image may not have a literal absolute path in the transcript.
  const allImages = selectedPath && !paths.includes(selectedPath) ? [...images, { path: selectedPath, turnId: 'image' }] : images;
  const active = selectedPath || allImages.at(-1)?.path || '';
  const activePreview = usePreview(active);
  const [tool, setTool] = useState<PictureProps['tool']>('pan');
  const [zoom, setZoom] = useState(100);
  const [size, setSize] = useState({ width: 640, height: 600 });
  const [editor, setEditor] = useState<{ path: string; note: ImageComment } | null>(null);
  const [editorPosition, setEditorPosition] = useState({ left: 16, top: 80 });
  const [strokes, setStrokes] = useState<BrushStroke[]>([]);
  const [redo, setRedo] = useState<BrushStroke[]>([]);
  const [brush, setBrush] = useState(8);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [menu, setMenu] = useState<'zoom' | 'resize' | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const dragged = useRef(false);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const reducedMotion = useAppReducedMotion();
  const supported = supportsImageStudio(session?.provider);
  const editable = !!session && !session.readOnly && supported;
  const permission = !session?.readOnly && session?.status === 'running' ? session.permissionRequests[0] : undefined;
  const pendingImage = studio.pending && !studio.pending.resultPath ? studio.pending : undefined;
  const pendingActive = !!pendingImage && studio.activePendingId === pendingImage.id;
  const locked = busy || !!studio.pending || !!permission;
  const canEditActive = editable && !!activePreview.image;
  const selectedPaths = studio.selected.filter(path => allImages.some(image => image.path === path));
  const focusedFitHeight = Math.max(120, size.height - (fullscreen ? 150 : 48));


  useEffect(() => {
    if (selectedPath !== studio.activePath) useImageStudioStore.getState().patch(sessionId, { activePath: selectedPath });
  }, [selectedPath, studio.activePath, sessionId]);

  useEffect(() => {
    if (!viewport.current || hidden) return;
    const observer = new ResizeObserver(entries => setSize({ width: entries[0].contentRect.width, height: entries[0].contentRect.height }));
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [hidden]);
  useLayoutEffect(() => {
    const container = viewport.current;
    if (!container || hidden || studio.view !== 'canvas') return;
    const image = pendingActive ? container.querySelector<HTMLElement>('[data-image-pending]') : Array.from(container.querySelectorAll<HTMLElement>('[data-image-path]')).find(element => element.dataset.imagePath === active);
    if (!image) return;
    const bounds = container.getBoundingClientRect(), rect = image.getBoundingClientRect();
    // Resizing the window changes the visible canvas, not the image layout.
    // Keep the active image in view without moving the outer chat workspace.
    if (rect.right > bounds.right) container.scrollLeft += rect.left + rect.width / 2 - bounds.left - bounds.width / 2;
    else if (rect.left < bounds.left) container.scrollLeft += rect.left - bounds.left;
    container.scrollTop += rect.top - bounds.top - 24;
  }, [active, activePreview.image, pendingActive, hidden, studio.view, size.width, size.height]);
  useLayoutEffect(() => {
    if (!editor || !viewport.current) return;
    const viewportElement = viewport.current;
    const update = () => {
      const element = Array.from(viewportElement.querySelectorAll<HTMLElement>('[data-image-path]')).find(el => el.dataset.imagePath === editor.path);
      const panel = viewportElement.closest('.image-studio');
      if (!element || !panel) return;
      const rect = element.getBoundingClientRect(), bounds = panel.getBoundingClientRect();
      setEditorPosition({
        left: Math.max(16, Math.min(bounds.width - 326, rect.left - bounds.left + rect.width * editor.note.x + 14)),
        top: Math.max(72, Math.min(bounds.height - 360, rect.top - bounds.top + rect.height * editor.note.y + 14)),
      });
    };
    update(); viewportElement.addEventListener('scroll', update, { passive: true });
    return () => viewportElement.removeEventListener('scroll', update);
  }, [editor?.path, editor?.note.id, size]);
  useEffect(() => { setStrokes([]); setRedo([]); setEditor(null); if (studio.view === 'single') { setZoom(100); setTool('pan'); } }, [active]);
  useEffect(() => { if (pendingActive) setZoom(100); }, [pendingActive]);
  useEffect(() => { if (locked) { setEditor(null); setMenu(null); setTool('pan'); } }, [locked]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest('.image-studio-zoom, .image-studio-resize')) setMenu(null);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menu]);
  const changeZoom = (value: number, anchor?: { x: number; y: number }) => {
    const element = viewport.current;
    const next = clampImageZoom(value);
    if (!element) return setZoom(next);
    const x = anchor?.x ?? element.clientWidth / 2, y = anchor?.y ?? element.clientHeight / 2;
    const bounds = element.getBoundingClientRect();
    const clientX = bounds.left + x, clientY = bounds.top + y;
    const pictures = Array.from(element.querySelectorAll<HTMLElement>('[data-image-path]'));
    const anchorImage = pictures.find(image => {
      const r = image.getBoundingClientRect();
      return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
    }) || pictures[0];
    const before = anchorImage?.getBoundingClientRect();
    const rx = before?.width ? (clientX - before.left) / before.width : 0;
    const ry = before?.height ? (clientY - before.top) / before.height : 0;
    flushSync(() => setZoom(next));
    const after = anchorImage?.getBoundingClientRect();
    if (after && before) {
      element.scrollLeft += after.left + rx * after.width - clientX;
      element.scrollTop += after.top + ry * after.height - clientY;
    }

  };
  useEffect(() => {
    const element = viewport.current;
    if (!element || hidden) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      changeZoom(zoom * Math.exp(-event.deltaY * 0.008), { x: event.clientX - rect.left, y: event.clientY - rect.top });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [hidden, zoom]);

  const switchView = (view: 'single' | 'canvas', target = active) => {
    if (studio.view === view) return;
    const findImage = () => Array.from(viewport.current?.querySelectorAll<HTMLElement>('[data-image-path]') || []).find(el => el.dataset.imagePath === target);
    const before = findImage()?.getBoundingClientRect();
    flushSync(() => { patch({ view, activePath: target, ...(view === 'canvas' && !selectedPaths.length ? { selected: [target] } : {}) }); setZoom(100); setTool('pan'); setMenu(null); });
    if (viewport.current) flushSync(() => setSize({ width: viewport.current!.clientWidth, height: viewport.current!.clientHeight }));
    const element = findImage();
    element?.scrollIntoView({ block: 'center', inline: 'center' });
    const after = element?.getBoundingClientRect();
    if (!reducedMotion && element && before && after?.width && before.width) {
      element.style.zIndex = '2';
      const animation = element.animate([
        { transformOrigin: 'top left', transform: `translate(${before.left - after.left}px, ${before.top - after.top}px) scale(${before.width / after.width}, ${before.height / after.height})` },
        { transformOrigin: 'top left', transform: 'none' },
      ], { duration: 450, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
      animation.onfinish = () => { element.style.zIndex = ''; };
    }
  };
  const runEdit = async (request: string, originals: string[], mask?: Blob) => {
    if (locked || !editable) return;
    setBusy(true); setError('');
    try {
      await submitImageEdit(sessionId, request, originals, mask);
      setStrokes([]); setRedo([]); setTool('pan');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const removeSelection = async () => {
    if (!strokes.length || locked) return;
    try {
      const image = await loadPreview(active);
      const mask = document.createElement('canvas'); mask.width = image.width; mask.height = image.height;
      drawBrushStrokes(mask, strokes, true);
      const blob = await new Promise<Blob>((resolve, reject) => mask.toBlob(value => value ? resolve(value) : reject(new Error('Could not create selection mask.')), 'image/png'));
      await runEdit('Remove the area marked in the second image from the first image. Fill it naturally to match its surroundings.', [active], blob);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const selectImage = (path: string, multiple = false) => {
    if (dragged.current) return;
    if (!editable || locked) { patch({ activePath: path, activePendingId: undefined }); return; }
    patch({ activePath: path, activePendingId: undefined, selected: multiple ? selectedPaths.includes(path) ? selectedPaths.filter(item => item !== path) : [...selectedPaths, path] : [path] });
  };
  const picture = (path: string, canvas: boolean) => <Picture key={path} path={path} zoom={canvas ? 100 : zoom}
    fitWidth={canvas ? Infinity : Math.max(160, size.width - 48)} fitHeight={canvas ? 292 : focusedFitHeight}
    selected={selectedPaths.includes(path)} notes={studio.comments[path] || []} tool={editable && !locked ? tool : 'pan'}
    onSelect={() => selectImage(path)} brush={brush} strokes={path === active ? strokes : []} onStroke={stroke => { setStrokes(s => [...s, stroke]); setRedo([]); }}
    onPoint={point => {
      if (tool === 'select') selectImage(path, true);
      else setEditor({ path, note: { id: crypto.randomUUID(), ...point, text: '' } });
    }} onNote={note => { if (editable && !locked) setEditor({ path, note }); }} />;
  const groups = new Map<string, typeof allImages>();
  for (const image of allImages) groups.set(image.turnId, [...(groups.get(image.turnId) || []), image]);

  return <section className="image-studio" data-view={studio.view} data-fullscreen={fullscreen} aria-label="Image workspace" hidden={hidden} onKeyDown={event => {
    const typing = (event.target as HTMLElement).closest('input,textarea,[contenteditable]');
    if (event.key === 'Escape') {
      if (editor || menu || tool !== 'pan') { event.stopPropagation(); setEditor(null); setMenu(null); setTool('pan'); }
      return;
    }
    if (typing) return;
    if (studio.view === 'single' && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      const index = (pendingActive ? allImages.length : allImages.findIndex(image => image.path === active)) + (event.key === 'ArrowRight' ? 1 : -1);
      if (allImages[index]) { event.preventDefault(); patch({ activePath: allImages[index].path, activePendingId: undefined }); }
      else if (index === allImages.length && pendingImage) { event.preventDefault(); patch({ activePendingId: pendingImage.id }); }
    }
  }}>
    <header className="image-studio-header">
      <div className="image-studio-capsule" aria-label="Image view">
        <button title="Focused view" aria-label="Focused view" aria-pressed={studio.view === 'single'} onClick={() => switchView('single')}><ImageIcon size={17} /></button>
        <button title="Canvas view" aria-label="Canvas view" aria-pressed={studio.view === 'canvas'} onClick={() => switchView('canvas')}><LayoutGrid size={17} /></button>
      </div>
      <div className="image-studio-capsule image-studio-tools">
        <button title="Comment" aria-label="Comment" aria-pressed={tool === 'comment'} disabled={!editable || locked} onClick={() => setTool(tool === 'comment' ? 'pan' : 'comment')}><MessageCircle size={16} /><span>Comment</span></button>
        {studio.view === 'canvas' && <button title="Multi-select" aria-label="Multi-select" aria-pressed={tool === 'select'} disabled={!editable || locked} onClick={() => setTool(tool === 'select' ? 'pan' : 'select')}><CheckSquare size={16} /><span>Multi-select</span></button>}
      {studio.view === 'single' && <div className="image-studio-editbar">
        {tool === 'erase' ? <>
          <button title="Undo" aria-label="Undo brush stroke" disabled={!strokes.length} onClick={() => { setRedo(r => [...r, strokes.at(-1)!]); setStrokes(s => s.slice(0, -1)); }}><Undo2 size={17} /></button>
          <button title="Redo" aria-label="Redo brush stroke" disabled={!redo.length} onClick={() => { setStrokes(s => [...s, redo.at(-1)!]); setRedo(r => r.slice(0, -1)); }}><Redo2 size={17} /></button>
          <input aria-label="Brush size" type="range" min={1} max={30} value={brush} onChange={event => setBrush(Number(event.target.value))} />
          <button onClick={() => { setTool('pan'); setStrokes([]); setRedo([]); }}>Cancel</button><button disabled={!strokes.length || locked} onClick={() => void removeSelection()}>Remove</button>
        </> : <>
          <button disabled={!canEditActive || locked || !active} onClick={() => void runEdit('Remove the background from this image, preserving the foreground subject with clean, smooth edges. Output a PNG with a transparent background.', [active])}><Sparkles size={16} /><span>Remove BG</span></button>
          <button disabled={!canEditActive || locked || !active} onClick={() => setTool('erase')}><Pencil size={16} /><span>Remove</span></button>
          <div className="image-studio-resize"><button disabled={!canEditActive || locked || !active} aria-expanded={menu === 'resize'} onClick={() => setMenu(menu === 'resize' ? null : 'resize')}><Maximize2 size={16} /><span>Resize</span></button>
            {menu === 'resize' && <div className="image-studio-menu" role="menu">{IMAGE_RATIOS.map(([label, ratio]) => <button role="menuitem" key={ratio} onClick={() => { setMenu(null); void runEdit(`Make the aspect ratio ${ratio}. Preserve the subject and adapt the composition naturally.`, [active]); }}>{label}<span>{ratio}</span></button>)}</div>}
          </div>

        </>}
      </div>}

      </div>
      <div className="image-studio-capsule image-studio-zoom">
        <button aria-label="Zoom options" aria-expanded={menu === 'zoom'} onClick={() => setMenu(menu === 'zoom' ? null : 'zoom')}>{Math.round(zoom * (studio.view === 'single' && !pendingActive && activePreview.image ? Math.min(Math.max(160, size.width - 48) / activePreview.image.width, focusedFitHeight / activePreview.image.height, 1) : 1))}%<ChevronDown size={12} /></button>
        {menu === 'zoom' && <div className="image-studio-menu" role="menu"><button role="menuitem" onClick={() => changeZoom(zoom / 1.2)}><Minus size={14} />Zoom out</button><button role="menuitem" onClick={() => changeZoom(zoom * 1.2)}><Plus size={14} />Zoom in</button>{[25, 50, 100, 150, 200].map(value => <button role="menuitem" key={value} onClick={() => { changeZoom(value / (studio.view === 'single' && !pendingActive && activePreview.image ? Math.min(Math.max(160, size.width - 48) / activePreview.image.width, focusedFitHeight / activePreview.image.height, 1) : 1)); setMenu(null); }}>{value}%</button>)}<button role="menuitem" onClick={() => { changeZoom(100); setMenu(null); }}><Maximize2 size={14} />Fit</button></div>}
      </div>
    </header>
    <div className="image-studio-body">
      {studio.view === 'single' && allImages.length + (pendingImage ? 1 : 0) > 1 && <nav className="image-studio-rail" aria-label="Image history">{allImages.map(image => <button key={image.path} aria-label={`Open ${image.path.split('/').pop()}`} aria-current={!pendingActive && image.path === active ? 'true' : undefined} title={image.path} onClick={() => patch({ activePath: image.path, activePendingId: undefined })}><Thumbnail path={image.path} /></button>)}{pendingImage && <button aria-label="Open generating image" aria-current={pendingActive ? 'true' : undefined} onClick={() => patch({ activePendingId: pendingImage.id })}><ImageGenerationPlaceholder thumbnail hidden={hidden} paused={pendingImage.queued || !!permission} label={pendingImage.queued ? 'Image edit queued' : 'Generating image…'} /></button>}</nav>}
      <div ref={viewport} className="image-studio-viewport" tabIndex={0} aria-label="Image canvas" data-pan={tool === 'pan'}
        onPointerDown={event => {
          if (tool !== 'pan' || event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
          dragged.current = false;
          pan.current = { x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop };
          // Do not capture a stationary click away from its image.

        }} onPointerMove={event => { if (pan.current) { if (Math.hypot(event.clientX - pan.current.x, event.clientY - pan.current.y) > 4) { dragged.current = true; event.currentTarget.setPointerCapture(event.pointerId); } event.currentTarget.scrollLeft = pan.current.left + pan.current.x - event.clientX; event.currentTarget.scrollTop = pan.current.top + pan.current.y - event.clientY; } }}
        onPointerUp={event => { pan.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { pan.current = null; }}>
        {!allImages.length ? <div className="image-studio-empty">No images yet</div> : studio.view === 'single' ? <div className="image-studio-focused">{pendingActive ? <div className="image-studio-focused-pending" style={{ width: Math.min(Math.max(120, size.width - 48), focusedFitHeight) * zoom / 100 }}><ImageGenerationPlaceholder hidden={hidden} paused={pendingImage?.queued || !!permission} label={permission ? 'Waiting for approval' : pendingImage?.queued ? 'Image edit queued' : 'Generating image…'} /></div> : picture(active, false)}</div> :
          <><div className="image-studio-turns" style={{ zoom: zoom / 100 }}>{Array.from(groups, ([id, items]) => <section className="image-studio-turn" key={id}>
            <div className="image-studio-turn-label">{items[0].createdAt ? new Date(items[0].createdAt).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Generated images'}</div>
            <div className="image-studio-row">{items.map(image => <div key={image.path} onDoubleClick={() => switchView('single', image.path)}>{picture(image.path, true)}</div>)}</div>
          </section>)}{pendingImage && <section className="image-studio-turn" data-image-pending>
            <div className="image-studio-turn-label">{new Date(pendingImage.startedAt).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
            <div className="image-studio-pending-image" onDoubleClick={() => { patch({ activePendingId: pendingImage.id }); switchView('single'); }}><ImageGenerationPlaceholder hidden={hidden} paused={pendingImage.queued || !!permission} label={permission ? 'Waiting for approval' : pendingImage.queued ? 'Image edit queued' : 'Generating image…'} /></div>
          </section>}</div><div aria-hidden="true" style={{ height: size.height / 2 }} /></>}
      </div>
    </div>
    {editor && <form className="image-studio-comment-editor" style={editorPosition} aria-label="Image comment" onSubmit={event => {
      event.preventDefault(); if (!editor.note.text.trim()) return;
      useImageStudioStore.getState().comment(sessionId, editor.path, editor.note, editor.note.id); patch({ selected: Array.from(new Set([...selectedPaths, editor.path])) }); setEditor(null);
    }}>
      <div className="image-studio-comment-heading">Comment<span>{Math.round(editor.note.x * 100)}%, {Math.round(editor.note.y * 100)}%</span><button type="button" aria-label="Close comment" onClick={() => setEditor(null)}><X size={16} /></button></div>
      <textarea autoFocus aria-label="Comment text" placeholder="Add a comment…" value={editor.note.text} onChange={event => setEditor({ ...editor, note: { ...editor.note, text: event.target.value } })} />
      <div className="image-studio-comment-actions"><button type="button" onClick={() => { useImageStudioStore.getState().comment(sessionId, editor.path, null, editor.note.id); setEditor(null); }}>Delete</button><button type="submit" disabled={!editor.note.text.trim()}>Save</button></div>
    </form>}
    <footer className="image-studio-footer">
      {(error || studio.feedback) && <div className="image-studio-feedback" role={error ? 'alert' : 'status'}>{error || studio.feedback}<button aria-label="Dismiss message" onClick={() => { setError(''); patch({ feedback: undefined }); }}><X size={14} /></button></div>}
      {studio.pending && (permission || studio.pending.queued) && <div className="image-studio-feedback" role="status">{permission ? 'Waiting for approval' : 'Edit queued'}{studio.pending.queued && <button onClick={() => cancelQueuedImageEdit(sessionId)}>Cancel</button>}</div>}
      {fullscreen && <ImageStudioLatestTurn key={sessionId} sessionId={sessionId} />}
      {fullscreen && !hidden && <ImageStudioComposerSlot sessionId={sessionId} />}
    </footer>
  </section>;
}

export function ImageStudioFileActions({ sessionId }: { sessionId: string }) {
  const path = useImageStudioStore(state => state.sessions[sessionId]?.activePath || '');
  const view = useImageStudioStore(state => state.sessions[sessionId]?.view);
  const generating = useImageStudioStore(state => { const studio = state.sessions[sessionId]; return !!studio?.pending && !studio.pending.resultPath && studio.activePendingId === studio.pending.id; });
  const [apps, setApps] = useState<Array<{ name: string; appPath: string; iconDataUrl: string | null }> | null>(null);
  const [error, setError] = useState('');
  const run = async (action: () => Promise<{ ok: boolean; message?: string }>) => {
    setApps(null);
    try { const result = await action(); if (!result.ok) setError(result.message || 'Could not open image'); } catch (error) { setError(String(error)); }
  };
  if (!path || view !== 'single' || generating) return null;
  return <div className="image-studio-file-actions no-drag">
    <button aria-label="Open image" onClick={() => void run(() => window.electron.openPath(path))}><ImageIcon size={13} />Open</button>
    <button aria-label="Open image with" onClick={async () => {
      if (apps) return setApps(null);
      try { const result = await window.electron.listOpenWithApps(path.replace(/\/[^/]*$/, ''), path); setApps(result.apps || []); } catch (error) { setError(String(error)); }
    }}><ChevronDown size={12} /></button>
    <button aria-label="Download image" onClick={async () => {
      try { const image = await loadPreview(path); const link = document.createElement('a'); link.href = image.src; link.download = path.split('/').pop() || 'Image'; link.click(); } catch (error) { setError(String(error)); }
    }}><Download size={14} /></button>
    {apps && <><div className="image-studio-file-dismiss" onClick={() => setApps(null)} /><div className="image-studio-file-menu" role="menu">
      {apps.map(app => <button role="menuitem" key={app.appPath} onClick={() => void run(() => window.electron.openFileWithApp(path.replace(/\/[^/]*$/, ''), path, app.appPath))}>{app.iconDataUrl && <img src={app.iconDataUrl} alt="" />}{app.name}</button>)}
      <button role="menuitem" onClick={() => void run(() => window.electron.revealPath(path))}>Show in Finder</button>
    </div></>}
    {error && <button role="alert" onClick={() => setError('')}>{error}</button>}
  </div>;
}

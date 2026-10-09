// The inspector script injected into the user's page for design mode.
//
// Deliberately CDP-free: events flow through an in-page queue that the main
// process drains via periodic executeJavaScript. Using Runtime.addBinding
// would require webContents.debugger.attach, which is mutually exclusive
// with DevTools / "Inspect element" (both exist in the browser panel UI) —
// polling removes that whole failure class. The script does not survive
// navigation; the service re-injects when a drain comes back undefined.
//
// Kept as a template string so no bundler step is needed for guest pages
// (sandbox + contextIsolation, no preload).

export const INSPECTOR_FLAG = '__aegisDesign';

export const INSPECTOR_SCRIPT = `(() => {
  if (window.__aegisDesign) { window.__aegisDesign.enabled = true; return 'already-injected'; }

  const state = {
    enabled: true,
    queue: [],
    selected: null,
    baseline: null,
    // A dragged-out area, in document coordinates so it scrolls with the page.
    region: null,
  };
  window.__aegisDesign = state;

  function emit(event) { state.queue.push(event); }
  window.__aegisDesignDrain = () => {
    const drained = state.queue;
    state.queue = [];
    return JSON.stringify(drained);
  };

  // ── overlays ────────────────────────────────────────────────────────────
  function makeOverlay(color, bg) {
    const el = document.createElement('div');
    el.setAttribute('data-aegis-overlay', '');
    el.style.cssText =
      'position:fixed;pointer-events:none;z-index:2147483646;display:none;' +
      'border:1.5px solid ' + color + ';background:' + bg + ';border-radius:2px;';
    document.documentElement.appendChild(el);
    return el;
  }
  const hoverOverlay = makeOverlay('#4f8ff7', 'rgba(79,143,247,0.10)');
  const selectOverlay = makeOverlay('#f59e0b', 'transparent');
  const regionOverlay = makeOverlay('#f59e0b', 'rgba(245,158,11,0.08)');
  regionOverlay.style.borderStyle = 'dashed';

  function regionViewportRect() {
    const r = state.region;
    if (!r) return null;
    return { x: r.docX - window.scrollX, y: r.docY - window.scrollY, w: r.w, h: r.h };
  }
  function positionRegionOverlay() {
    const rect = regionViewportRect();
    if (!rect) { regionOverlay.style.display = 'none'; return; }
    regionOverlay.style.display = 'block';
    regionOverlay.style.left = rect.x + 'px';
    regionOverlay.style.top = rect.y + 'px';
    regionOverlay.style.width = rect.w + 'px';
    regionOverlay.style.height = rect.h + 'px';
  }

  function positionOverlay(overlay, el) {
    if (!el || !el.getBoundingClientRect) { overlay.style.display = 'none'; return; }
    const rect = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = rect.left + 'px';
    overlay.style.top = rect.top + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
  }

  // ── fiber helpers ───────────────────────────────────────────────────────
  function fiberOf(el) {
    for (const key in el) {
      if (key.indexOf('__reactFiber$') === 0) return el[key];
    }
    return null;
  }

  // Own-source only: walking up would return the PARENT's location and edit
  // the wrong element. Missing own source → tier B (data attr) → tier C.
  function sourceOf(el) {
    const fiber = fiberOf(el);
    const src = fiber && fiber._debugSource;
    if (src && src.fileName) {
      return { file: src.fileName, line: src.lineNumber, column: typeof src.columnNumber === 'number' ? src.columnNumber : null, tier: 'fiber' };
    }
    const attr = el.getAttribute && el.getAttribute('data-aegis-src');
    if (attr) {
      const parts = attr.split(':');
      if (parts.length >= 2) {
        const column = parts.length >= 3 ? Number(parts[parts.length - 1]) : null;
        const line = Number(parts[parts.length >= 3 ? parts.length - 2 : parts.length - 1]);
        const file = parts.slice(0, parts.length >= 3 ? -2 : -1).join(':');
        if (file && Number.isFinite(line)) return { file, line, column: Number.isFinite(column) ? column : null, tier: 'attr' };
      }
    }
    return null;
  }

  function componentChain(el) {
    const chain = [];
    let fiber = fiberOf(el);
    while (fiber && chain.length < 6) {
      const type = fiber.type;
      if (typeof type === 'function') {
        chain.push(type.displayName || type.name || 'Anonymous');
      } else if (typeof type === 'object' && type && type.displayName) {
        chain.push(type.displayName);
      }
      fiber = fiber.return;
    }
    return chain;
  }

  function siblingIndexOf(el, source) {
    if (!source) return 0;
    try {
      const others = [];
      const all = document.querySelectorAll(el.localName);
      for (const candidate of all) {
        const src = sourceOf(candidate);
        if (src && src.file === source.file && src.line === source.line) {
          others.push({ el: candidate, column: src.column == null ? 0 : src.column });
        }
      }
      const columns = [];
      const seen = new Set();
      for (const item of others) {
        if (!seen.has(item.column)) { seen.add(item.column); columns.push(item.column); }
      }
      columns.sort((a, b) => a - b);
      const own = sourceOf(el);
      return Math.max(0, columns.indexOf(own && own.column != null ? own.column : 0));
    } catch (e) {
      return 0;
    }
  }

  const COMPUTED_PROPS = [
    'padding-top','padding-right','padding-bottom','padding-left',
    'margin-top','margin-right','margin-bottom','margin-left',
    'color','background-color','font-size','font-weight','line-height',
    'border-radius','gap','column-gap','row-gap','width','height','opacity',
    'display','position','border-top-width','border-color','text-align',
    'flex-direction','align-items','justify-content','box-shadow',
  ];
  function snapshotComputed(el) {
    const style = getComputedStyle(el);
    const out = {};
    for (const prop of COMPUTED_PROPS) out[prop] = style.getPropertyValue(prop);
    return out;
  }

  function describe(el) {
    const source = sourceOf(el);
    return {
      tagName: el.localName,
      className: typeof el.className === 'string' ? el.className : (el.getAttribute('class') || ''),
      text: (el.textContent || '').trim().slice(0, 80),
      source,
      siblingIndex: siblingIndexOf(el, source),
      chain: componentChain(el),
      computed: snapshotComputed(el),
      rect: (() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
    };
  }

  // ── selection & relocation ──────────────────────────────────────────────
  let selectedInfo = null;
  // Index among the RENDERED same-source instances (document order) at
  // selection time. siblingIndex is a SOURCE-space index and is 0 for every
  // item of a .map()-rendered list (one JSX element, N instances) — using it
  // for relocation always snapped to the first instance.
  let selectedInstanceIndex = 0;

  function sameSourceCandidates(info) {
    const candidates = [];
    if (!info || !info.source) return candidates;
    const all = document.querySelectorAll(info.tagName);
    for (const candidate of all) {
      const src = sourceOf(candidate);
      if (src && src.file === info.source.file && src.line === info.source.line) {
        candidates.push(candidate);
      }
    }
    return candidates;
  }

  function relocate() {
    if (state.selected && document.contains(state.selected)) return state.selected;
    const candidates = sameSourceCandidates(selectedInfo);
    if (candidates.length === 0) return null;
    state.selected = candidates[Math.min(selectedInstanceIndex, candidates.length - 1)];
    return state.selected;
  }

  window.__aegisDesignMeasure = () => {
    const el = relocate();
    const viteOverlay = Boolean(document.querySelector('vite-error-overlay'));
    const viewport = { w: window.innerWidth, h: window.innerHeight };
    if (!el) return JSON.stringify({ found: false, viteErrorOverlay: viteOverlay, viewport });
    const rect = el.getBoundingClientRect();
    return JSON.stringify({
      found: true,
      viteErrorOverlay: viteOverlay,
      viewport,
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      classList: typeof el.className === 'string' ? el.className : (el.getAttribute('class') || ''),
      computed: snapshotComputed(el),
    });
  };

  window.__aegisDesignSetEnabled = (enabled) => {
    state.enabled = Boolean(enabled);
    if (!state.enabled) {
      hoverOverlay.style.display = 'none';
      hideBubble();
    }
    return state.enabled;
  };

  window.__aegisDesignClearSelection = () => {
    state.selected = null;
    state.region = null;
    selectedInfo = null;
    selectOverlay.style.display = 'none';
    regionOverlay.style.display = 'none';
    hideBubble();
    return true;
  };

  // ── annotate bubble (Cursor-style in-page input next to the element) ─────
  const bubble = document.createElement('div');
  bubble.setAttribute('data-aegis-ui', '');
  bubble.style.cssText =
    'position:fixed;z-index:2147483647;display:none;align-items:center;gap:6px;' +
    'background:#ffffff;border:1px solid rgba(0,0,0,0.12);border-radius:10px;' +
    'box-shadow:0 8px 24px rgba(0,0,0,0.18);padding:6px 8px;max-width:380px;' +
    'font:12px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;color:#111827;';
  const bubbleChip = document.createElement('span');
  bubbleChip.style.cssText =
    'flex-shrink:0;background:#eef2ff;color:#4f46e5;border-radius:6px;padding:2px 6px;' +
    'font-weight:600;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  const bubbleInput = document.createElement('input');
  bubbleInput.type = 'text';
  bubbleInput.placeholder = 'Describe the change…';
  bubbleInput.style.cssText =
    'border:none;outline:none;background:transparent;min-width:190px;font:inherit;color:inherit;';
  const bubbleSend = document.createElement('button');
  bubbleSend.type = 'button';
  bubbleSend.textContent = '↵';
  bubbleSend.style.cssText =
    'border:none;background:#111827;color:#fff;border-radius:6px;width:22px;height:22px;' +
    'cursor:pointer;flex-shrink:0;font:inherit;';
  bubble.appendChild(bubbleChip);
  bubble.appendChild(bubbleInput);
  bubble.appendChild(bubbleSend);
  document.documentElement.appendChild(bubble);

  function positionBubble() {
    if (bubble.style.display === 'none') return;
    const el = state.selected;
    const area = regionViewportRect();
    if (!area && (!el || !document.contains(el))) return;
    const box = area || el.getBoundingClientRect();
    const rect = area
      ? { left: area.x, top: area.y, bottom: area.y + area.h }
      : { left: box.left, top: box.top, bottom: box.bottom };
    const bubbleWidth = bubble.offsetWidth || 280;
    const bubbleHeight = bubble.offsetHeight || 36;
    let top = rect.bottom + 8;
    if (top + bubbleHeight > window.innerHeight - 8) top = Math.max(8, rect.top - bubbleHeight - 8);
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - bubbleWidth - 8));
    bubble.style.top = top + 'px';
    bubble.style.left = left + 'px';
  }

  function showBubble() {
    if (!selectedInfo) return;
    bubbleChip.textContent = selectedInfo.region ? 'Area' : selectedInfo.tagName;
    bubble.style.display = 'flex';
    positionBubble();
    setTimeout(() => { try { bubbleInput.focus(); } catch (e) { /* ignore */ } }, 0);
  }

  function hideBubble() {
    bubble.style.display = 'none';
    bubbleInput.value = '';
  }

  function submitAnnotation() {
    const note = bubbleInput.value.trim();
    if (!note || !selectedInfo) return;
    // Hide BEFORE emitting: the main process screenshots the page right after
    // draining this event, and a still-visible bubble (or the hover
    // highlight) would end up in the cropped capture, covering the very
    // element the agent needs to see.
    hideBubble();
    hoverOverlay.style.display = 'none';
    // Geometry travels WITH the event, measured at submit time in this same
    // tick: the bridge must never re-measure "the current selection" later —
    // the user may have clicked a different element by then, pairing note A
    // with a crop of element B.
    const info = Object.assign({}, selectedInfo);
    const area = regionViewportRect();
    if (info.region && area) {
      info.rect = area;
    } else {
      const el = relocate();
      if (el) {
        const r = el.getBoundingClientRect();
        info.rect = { x: r.x, y: r.y, w: r.width, h: r.height };
      }
    }
    flashAdded(info.rect);
    emit({
      kind: 'annotate',
      note,
      info,
      viewport: { w: window.innerWidth, h: window.innerHeight },
    });
  }

  // A short confirmation where the annotation was, so several in a row read
  // as a batch collecting in the composer.
  const added = document.createElement('div');
  added.setAttribute('data-aegis-ui', '');
  added.textContent = 'Added to composer';
  added.style.cssText =
    'position:fixed;z-index:2147483647;display:none;pointer-events:none;background:#111827;color:#fff;' +
    'border-radius:8px;padding:4px 8px;font:600 11px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;' +
    'box-shadow:0 6px 18px rgba(0,0,0,0.2);transition:opacity 300ms ease;';
  document.documentElement.appendChild(added);
  let addedTimer = null;
  function flashAdded(rect) {
    if (!rect) return;
    added.style.left = Math.max(8, Math.min(rect.x, window.innerWidth - 140)) + 'px';
    added.style.top = Math.max(8, rect.y - 30) + 'px';
    added.style.opacity = '1';
    added.style.display = 'block';
    clearTimeout(addedTimer);
    addedTimer = setTimeout(() => {
      added.style.opacity = '0';
      setTimeout(() => { added.style.display = 'none'; }, 320);
    }, 1200);
  }

  bubbleInput.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      submitAnnotation();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      hideBubble();
    }
  });
  bubbleInput.addEventListener('keyup', (event) => event.stopPropagation());
  bubbleSend.addEventListener('click', (event) => {
    event.stopPropagation();
    submitAnnotation();
  });

  // ── event wiring ────────────────────────────────────────────────────────
  function eligible(target) {
    if (!target || target.nodeType !== 1) return null;
    if (target.hasAttribute && target.hasAttribute('data-aegis-overlay')) return null;
    // Our own UI (the annotate bubble) must stay interactive, not selectable.
    if (target.closest && target.closest('[data-aegis-ui]')) return null;
    if (target === document.documentElement || target === document.body) return null;
    return target;
  }

  document.addEventListener('mousemove', (event) => {
    if (!state.enabled) return;
    const el = eligible(event.target);
    if (el) positionOverlay(hoverOverlay, el);
    else hoverOverlay.style.display = 'none';
  }, true);

  // ── area selection: press and drag to mark a region ─────────────────────
  const DRAG_THRESHOLD = 6;
  let press = null;
  let suppressClick = false;

  function regionInfo(docX, docY, w, h) {
    const view = { x: docX - window.scrollX, y: docY - window.scrollY, w, h };
    const inside = [];
    const texts = [];
    const all = document.body ? document.body.querySelectorAll('*') : [];
    for (let i = 0; i < all.length && inside.length < 12; i += 1) {
      const node = all[i];
      if (node.closest && node.closest('[data-aegis-ui],[data-aegis-overlay]')) continue;
      const r = node.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (r.left < view.x || r.top < view.y || r.right > view.x + w || r.bottom > view.y + h) continue;
      // Outermost elements only: skip ones whose parent is already inside.
      const parent = node.parentElement;
      if (parent) {
        const pr = parent.getBoundingClientRect();
        if (pr.left >= view.x && pr.top >= view.y && pr.right <= view.x + w && pr.bottom <= view.y + h) continue;
      }
      const label = node.localName + (typeof node.className === 'string' && node.className.trim() ? '.' + node.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
      inside.push(label);
      const text = (node.innerText || '').trim().replace(/\s+/g, ' ');
      if (text) texts.push(text);
    }
    return {
      tagName: 'region',
      className: '',
      text: texts.join(' · ').slice(0, 300),
      source: null,
      siblingIndex: 0,
      chain: [],
      computed: {},
      rect: view,
      region: true,
      elements: inside,
    };
  }

  // A drag may start anywhere on the page, empty background included; only
  // our own UI is off limits.
  function dragStart(target) {
    if (!target || target.nodeType !== 1) return false;
    if (target.hasAttribute && target.hasAttribute('data-aegis-overlay')) return false;
    return !(target.closest && target.closest('[data-aegis-ui]'));
  }

  document.addEventListener('mousedown', (event) => {
    if (!state.enabled || event.button !== 0) return;
    if (!dragStart(event.target)) return;
    // No text selection or native drag while design mode owns the pointer.
    event.preventDefault();
    press = { x: event.clientX, y: event.clientY, dragging: false };
  }, true);

  document.addEventListener('mousemove', (event) => {
    if (!press) return;
    if (!press.dragging && Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_THRESHOLD) return;
    press.dragging = true;
    hoverOverlay.style.display = 'none';
    const x = Math.min(press.x, event.clientX);
    const y = Math.min(press.y, event.clientY);
    state.region = { docX: x + window.scrollX, docY: y + window.scrollY, w: Math.abs(event.clientX - press.x), h: Math.abs(event.clientY - press.y) };
    positionRegionOverlay();
  }, true);

  document.addEventListener('mouseup', () => {
    if (!press) return;
    const dragged = press.dragging;
    press = null;
    if (!dragged || !state.region) return;
    // The click that follows this mouseup must not also select an element.
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    state.selected = null;
    selectOverlay.style.display = 'none';
    const r = state.region;
    const info = regionInfo(r.docX, r.docY, r.w, r.h);
    selectedInfo = info;
    state.baseline = null;
    emit({ kind: 'selected', info });
    showBubble();
  }, true);

  document.addEventListener('click', (event) => {
    if (!state.enabled) return;
    if (suppressClick) {
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const el = eligible(event.target);
    if (!el) return;
    event.preventDefault();
    event.stopPropagation();
    state.region = null;
    regionOverlay.style.display = 'none';
    state.selected = el;
    const info = describe(el);
    selectedInfo = info;
    selectedInstanceIndex = Math.max(0, sameSourceCandidates(info).indexOf(el));
    state.baseline = info.computed;
    positionOverlay(selectOverlay, el);
    emit({ kind: 'selected', info });
    showBubble();
  }, true);

  document.addEventListener('scroll', () => {
    if (state.selected) positionOverlay(selectOverlay, state.selected);
    if (state.region) positionRegionOverlay();
    if (state.selected || state.region) positionBubble();
  }, true);
  window.addEventListener('resize', () => {
    if (state.selected) positionOverlay(selectOverlay, state.selected);
    if (state.region) positionRegionOverlay();
    if (state.selected || state.region) positionBubble();
  });

  return 'injected';
})();`;

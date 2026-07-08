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
    previewProps: new Map(),
    baseline: null,
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

  // ── preview (path 1/3): marked inline patches ───────────────────────────
  window.__aegisDesignPreview = (property, value) => {
    const el = relocate();
    if (!el) return false;
    if (!state.previewProps.has(property)) {
      // Remember the original priority too: restoring "red" without its
      // original !important flag would permanently demote the declaration.
      state.previewProps.set(property, {
        value: el.style.getPropertyValue(property) || null,
        priority: el.style.getPropertyPriority(property) || '',
      });
    }
    el.style.setProperty(property, value, 'important');
    el.setAttribute('data-aegis-preview', [...state.previewProps.keys()].join(','));
    positionOverlay(selectOverlay, el);
    return true;
  };

  // Verification step 0 (red-team A1): strip EVERY preview patch before
  // measuring, or the measurement reads our own preview back.
  window.__aegisDesignStripPreview = () => {
    const el = relocate();
    if (el) {
      for (const [property, original] of state.previewProps) {
        if (original.value) el.style.setProperty(property, original.value, original.priority);
        else el.style.removeProperty(property);
      }
      el.removeAttribute('data-aegis-preview');
    }
    state.previewProps.clear();
    return Boolean(el);
  };

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
      previewActive: el.hasAttribute('data-aegis-preview'),
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
    window.__aegisDesignStripPreview();
    state.selected = null;
    selectedInfo = null;
    selectOverlay.style.display = 'none';
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
  // Opens the (hidden-by-default) style drawer for slider-level tuning.
  const bubbleStyles = document.createElement('button');
  bubbleStyles.type = 'button';
  bubbleStyles.textContent = 'Aa';
  bubbleStyles.title = 'Tune styles';
  bubbleStyles.style.cssText =
    'border:1px solid rgba(0,0,0,0.12);background:#f9fafb;color:#374151;border-radius:6px;' +
    'width:24px;height:22px;cursor:pointer;flex-shrink:0;font:10px/1 -apple-system,sans-serif;font-weight:600;';
  bubble.appendChild(bubbleChip);
  bubble.appendChild(bubbleInput);
  bubble.appendChild(bubbleStyles);
  bubble.appendChild(bubbleSend);
  document.documentElement.appendChild(bubble);

  function positionBubble() {
    const el = state.selected;
    if (!el || !document.contains(el) || bubble.style.display === 'none') return;
    const rect = el.getBoundingClientRect();
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
    bubbleChip.textContent = selectedInfo.tagName;
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
    emit({ kind: 'annotate', note, info: selectedInfo });
    bubbleInput.value = '';
    bubbleSend.textContent = '✓';
    setTimeout(() => { bubbleSend.textContent = '↵'; hideBubble(); }, 350);
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
  bubbleStyles.addEventListener('click', (event) => {
    event.stopPropagation();
    emit({ kind: 'open-styles' });
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

  document.addEventListener('click', (event) => {
    if (!state.enabled) return;
    const el = eligible(event.target);
    if (!el) return;
    event.preventDefault();
    event.stopPropagation();
    window.__aegisDesignStripPreview();
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
    if (state.selected) {
      positionOverlay(selectOverlay, state.selected);
      positionBubble();
    }
  }, true);
  window.addEventListener('resize', () => {
    if (state.selected) {
      positionOverlay(selectOverlay, state.selected);
      positionBubble();
    }
  });

  return 'injected';
})();`;

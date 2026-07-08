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
    }
    return state.enabled;
  };

  window.__aegisDesignClearSelection = () => {
    window.__aegisDesignStripPreview();
    state.selected = null;
    selectedInfo = null;
    selectOverlay.style.display = 'none';
    return true;
  };

  // ── event wiring ────────────────────────────────────────────────────────
  function eligible(target) {
    if (!target || target.nodeType !== 1) return null;
    if (target.hasAttribute && target.hasAttribute('data-aegis-overlay')) return null;
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
  }, true);

  document.addEventListener('scroll', () => {
    if (state.selected) positionOverlay(selectOverlay, state.selected);
  }, true);
  window.addEventListener('resize', () => {
    if (state.selected) positionOverlay(selectOverlay, state.selected);
  });

  return 'injected';
})();`;

// Origin-independent storage for renderer state that must survive origin
// changes (dev server ↔ file:// fallback ↔ port overrides). Backed by
// userData/renderer-state.json in the main process; falls back to
// localStorage when the preload bridge is unavailable (e.g. plain-browser
// rendering in tests).
//
// Existing users have their data only in the current origin's localStorage,
// so the first read of a key migrates the localStorage value into the file
// store. Migration is per key and only when the file store has no value yet —
// whichever origin is seen first wins; later origins never clobber it.

type BridgeStorage = NonNullable<Window['electron']>['rendererState'];

function getBridge(): BridgeStorage | null {
  try {
    return window.electron?.rendererState ?? null;
  } catch {
    return null;
  }
}

function readLocalStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

const migratedKeys = new Set<string>();

function migrateFromLocalStorage(bridge: BridgeStorage, key: string): void {
  if (migratedKeys.has(key)) {
    return;
  }
  migratedKeys.add(key);
  if (bridge.getItem(key) !== null) {
    return;
  }
  const legacy = readLocalStorage(key);
  if (legacy !== null) {
    bridge.setItem(key, legacy);
  }
}

export const rendererStateStorage = {
  getItem(key: string): string | null {
    const bridge = getBridge();
    if (!bridge) {
      return readLocalStorage(key);
    }
    migrateFromLocalStorage(bridge, key);
    return bridge.getItem(key);
  },
  setItem(key: string, value: string): void {
    const bridge = getBridge();
    if (!bridge) {
      try {
        localStorage.setItem(key, value);
      } catch {
        // storage unavailable
      }
      return;
    }
    migratedKeys.add(key);
    bridge.setItem(key, value);
  },
  removeItem(key: string): void {
    const bridge = getBridge();
    if (!bridge) {
      try {
        localStorage.removeItem(key);
      } catch {
        // storage unavailable
      }
      return;
    }
    migratedKeys.add(key);
    bridge.removeItem(key);
  },
};

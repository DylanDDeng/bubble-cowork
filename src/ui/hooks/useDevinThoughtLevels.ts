import { useEffect, useState } from 'react';
import type { DevinThoughtLevels } from '../types';

// Levels are per model and each first read is an ACP round trip in the main
// process, so share one request per model across every mounted composer.
const requests = new Map<string, Promise<DevinThoughtLevels>>();
const resolved = new Map<string, DevinThoughtLevels>();

function requestLevels(key: string): Promise<DevinThoughtLevels> {
  let request = requests.get(key);
  if (!request) {
    request = window.electron.getDevinThoughtLevels(key || null).then((levels) => {
      // A failed read (CLI missing, offline) must not stick for the session.
      if (levels.levels.length > 0 || levels.model) resolved.set(key, levels);
      else requests.delete(key);
      return levels;
    });
    request.catch(() => requests.delete(key));
    requests.set(key, request);
  }
  return request;
}

/** Thinking levels for a Devin model ('' / null = the Default row); null while loading. */
export function useDevinThoughtLevels(model: string | null, enabled = true): DevinThoughtLevels | null {
  const key = model?.trim() || '';
  const [levels, setLevels] = useState<DevinThoughtLevels | null>(() => resolved.get(key) ?? null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLevels(resolved.get(key) ?? null);
    requestLevels(key)
      .then((next) => {
        if (!cancelled) setLevels(next);
      })
      .catch(() => {
        // Picker falls back to the models-only view.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, key]);

  return levels;
}

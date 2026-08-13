import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import type { GeneratedMediaItem } from '../utils/generated-media';
import { resolveGeneratedMediaPath } from '../utils/generated-media';

function dirnameOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index > 0 ? normalized.slice(0, index) : '/';
}

function isUnderRoot(root: string | null | undefined, filePath: string): boolean {
  if (!root) return false;
  const prefix = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return filePath === prefix || filePath.startsWith(`${prefix}/`);
}

export function GeneratedMediaGallery({
  items,
  cwd,
}: {
  items: GeneratedMediaItem[];
  cwd: string | null;
}) {
  const openProjectFileInRightPanel = useAppStore((state) => state.openProjectFileInRightPanel);
  const [previews, setPreviews] = useState<Record<string, { kind: 'image' | 'video'; src: string } | null>>({});

  const resolved = useMemo(
    () => items.map((item) => ({ ...item, path: resolveGeneratedMediaPath(cwd, item.path) })),
    [cwd, items]
  );

  useEffect(() => {
    let cancelled = false;
    const missing = resolved.filter((item) => !Object.prototype.hasOwnProperty.call(previews, item.path));
    if (missing.length === 0) return;

    void (async () => {
      const entries = await Promise.all(missing.map(async (item) => {
        try {
          const preview = await window.electron.readProjectFilePreview(dirnameOf(item.path), item.path) as {
            kind?: string;
            dataUrl?: string;
            previewUrl?: string;
          };
          if (preview?.kind === 'image' && preview.dataUrl) {
            return [item.path, { kind: 'image' as const, src: preview.dataUrl }] as const;
          }
          if (preview?.kind === 'video' && (preview.previewUrl || preview.dataUrl)) {
            return [item.path, { kind: 'video' as const, src: preview.previewUrl || preview.dataUrl || '' }] as const;
          }
        } catch {
          // Preview is optional; the tile still opens the file.
        }
        return [item.path, null] as const;
      }));
      if (cancelled) return;
      setPreviews((current) => {
        const next = { ...current };
        for (const [path, preview] of entries) {
          next[path] = preview;
        }
        return next;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [previews, resolved]);

  if (resolved.length === 0) return null;

  const openItem = (item: GeneratedMediaItem) => {
    const path = resolveGeneratedMediaPath(cwd, item.path);
    openProjectFileInRightPanel({
      cwd: isUnderRoot(cwd, path) ? cwd || dirnameOf(path) : dirnameOf(path),
      path,
      external: !isUnderRoot(cwd, path),
    });
  };

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {resolved.map((item) => {
        const preview = previews[item.path];
        const name = item.path.split('/').pop() || item.path;
        return (
          <button
            key={item.path}
            type="button"
            onClick={() => openItem(item)}
            className="group relative max-w-[320px] overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-secondary)] text-left transition-colors hover:border-[var(--text-muted)]"
            title={item.prompt || name}
          >
            {preview?.kind === 'image' ? (
              <img src={preview.src} alt={name} className="max-h-[280px] max-w-full object-contain" />
            ) : preview?.kind === 'video' ? (
              <video
                src={preview.src}
                className="max-h-[280px] max-w-full"
                controls
                playsInline
                onClick={(event) => event.stopPropagation()}
              />
            ) : (
              <div className="px-3 py-8 text-[12px] text-[var(--text-muted)]">
                {item.kind === 'video' ? 'Generated video' : 'Generated image'}
              </div>
            )}
            <span className="block truncate px-2.5 py-1.5 text-[11px] text-[var(--text-muted)]">
              {name}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function openGeneratedMediaInFilesPanel(
  item: GeneratedMediaItem,
  cwd: string | null,
  openProjectFileInRightPanel: (request: {
    cwd: string;
    path: string;
    external?: boolean;
  }) => void
): void {
  const path = resolveGeneratedMediaPath(cwd, item.path);
  const root = isUnderRoot(cwd, path) ? cwd || dirnameOf(path) : dirnameOf(path);
  openProjectFileInRightPanel({
    cwd: root,
    path,
    external: !isUnderRoot(cwd, path),
  });
}



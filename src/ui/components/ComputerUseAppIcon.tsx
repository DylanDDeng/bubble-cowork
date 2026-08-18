import { useEffect, useState } from 'react';
import { Monitor } from './icons';

const computerUseAppIconRequests = new Map<string, Promise<string | null>>();

function loadComputerUseAppIcon(app: string): Promise<string | null> {
  const key = app.trim();
  if (!key) return Promise.resolve(null);
  let pending = computerUseAppIconRequests.get(key);
  if (!pending) {
    pending = window.electron.readComputerUseAppIcon(key).catch(() => null);
    computerUseAppIconRequests.set(key, pending);
  }
  return pending;
}

export function ComputerUseAppIcon({
  app,
  className,
}: {
  app: string | null | undefined;
  className: string;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!app) {
      setSrc(null);
      return;
    }
    let cancelled = false;
    void loadComputerUseAppIcon(app).then((url) => {
      if (!cancelled) setSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [app]);

  if (src) {
    return (
      <img
        src={src}
        alt=""
        className="h-3.5 w-3.5 flex-shrink-0 rounded-[3px] object-cover"
      />
    );
  }

  return <Monitor className={className} />;
}

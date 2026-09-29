import { useEffect, useRef, useState } from 'react';

export function ProjectVideoPreview({ src, name, active }: { src: string; name: string; active: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!active) videoRef.current?.pause();
  }, [active]);

  return (
    <div className="flex min-h-0 w-full flex-col gap-3">
      <video
        ref={videoRef}
        src={src}
        aria-label={name}
        className="max-h-full w-full rounded-md object-contain"
        controls
        playsInline
        preload="metadata"
        onLoadStart={() => setFailed(false)}
        onError={() => setFailed(true)}
      />
      {failed && (
        <p role="alert" className="text-sm text-[var(--text-muted)]">
          Unable to load or decode this video. Try opening it in your system player.
        </p>
      )}
    </div>
  );
}

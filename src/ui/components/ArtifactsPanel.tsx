import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Copy, Check, ExternalLink, FolderSearch } from 'lucide-react';
import type { StreamMessage } from '../types';
import { MDContent } from '../render/markdown';
import { extractArtifactsFromMessages, type ArtifactItem, type ArtifactKind } from '../utils/artifacts';

type ReadTextResult =
  | { ok: true; path: string; size: number; text: string }
  | { ok: false; message: string; code?: 'too_large'; size?: number; maxBytes?: number };

type ReadBinaryResult =
  | { ok: true; path: string; size: number; mimeType: string; data: ArrayBuffer }
  | { ok: false; message: string; code?: 'too_large'; size?: number; maxBytes?: number };

export function ArtifactsPanel({
  cwd,
  messages,
}: {
  cwd: string | null;
  messages: StreamMessage[];
}) {
  const artifacts = useMemo(() => extractArtifactsFromMessages(messages), [messages]);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const selectedArtifact = useMemo(
    () => (selectedPath ? artifacts.find((a) => a.filePath === selectedPath) || null : null),
    [artifacts, selectedPath]
  );

  // HTML view mode
  const [htmlMode, setHtmlMode] = useState<'view' | 'code'>('view');

  // Preview state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tooLarge, setTooLarge] = useState<{ size: number; maxBytes: number } | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [binaryUrl, setBinaryUrl] = useState<string | null>(null);
  const binaryUrlRef = useRef<string | null>(null);
  const previewRequestIdRef = useRef(0);
  const [copiedPath, setCopiedPath] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    // Clear selection if the artifact list no longer contains it.
    if (selectedPath && !artifacts.some((a) => a.filePath === selectedPath)) {
      setSelectedPath(null);
    }
  }, [artifacts, selectedPath]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) {
        window.clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    // Cleanup old blob URL when selection changes.
    if (binaryUrlRef.current) {
      URL.revokeObjectURL(binaryUrlRef.current);
      binaryUrlRef.current = null;
    }
    setBinaryUrl(null);
    setText(null);
    setError(null);
    setTooLarge(null);

    if (!selectedArtifact) {
      setLoading(false);
      return;
    }

    const requestId = (previewRequestIdRef.current += 1);
    const run = async () => {
      setLoading(true);

      try {
        const kind = selectedArtifact.kind;

        // Text-like previews
        if (kind === 'html' || kind === 'markdown' || kind === 'json') {
          const maybeContent = selectedArtifact.content;
          if (typeof maybeContent === 'string' && maybeContent.length > 0) {
            if (previewRequestIdRef.current !== requestId) return;
            setText(maybeContent);
            return;
          }

          if (!cwd) {
            if (previewRequestIdRef.current !== requestId) return;
            setError('No working directory for this session.');
            return;
          }

          const result = (await window.electron.readArtifactText(
            cwd,
            selectedArtifact.filePath
          )) as ReadTextResult;

          if (previewRequestIdRef.current !== requestId) return;

          if (!result.ok) {
            if (result.code === 'too_large' && typeof result.size === 'number' && typeof result.maxBytes === 'number') {
              setTooLarge({ size: result.size, maxBytes: result.maxBytes });
              return;
            }
            setError(result.message || 'Failed to load file.');
            return;
          }

          setText(result.text);
          return;
        }

        // Binary previews
        if (kind === 'image' || kind === 'pdf') {
          if (!cwd) {
            if (previewRequestIdRef.current !== requestId) return;
            setError('No working directory for this session.');
            return;
          }

          const result = (await window.electron.readArtifactBinary(
            cwd,
            selectedArtifact.filePath
          )) as ReadBinaryResult;

          if (previewRequestIdRef.current !== requestId) return;

          if (!result.ok) {
            if (result.code === 'too_large' && typeof result.size === 'number' && typeof result.maxBytes === 'number') {
              setTooLarge({ size: result.size, maxBytes: result.maxBytes });
              return;
            }
            setError(result.message || 'Failed to load file.');
            return;
          }

          const url = URL.createObjectURL(new Blob([result.data], { type: result.mimeType }));
          binaryUrlRef.current = url;
          setBinaryUrl(url);
          return;
        }

        // Unsupported previews for now
        return;
      } catch (e) {
        if (previewRequestIdRef.current !== requestId) return;
        setError(String(e));
      } finally {
        if (previewRequestIdRef.current === requestId) {
          setLoading(false);
        }
      }
    };

    run();
  }, [cwd, selectedArtifact]);

  const handleCopyPath = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedPath(true);
      if (copiedTimerRef.current) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => setCopiedPath(false), 1500);
    } catch {
      // ignore
    }
  };

  const handleOpen = async () => {
    if (!selectedArtifact) return;
    if (!cwd) return;
    await window.electron.openArtifactPath(cwd, selectedArtifact.filePath);
  };

  const handleReveal = async () => {
    if (!selectedArtifact) return;
    if (!cwd) return;
    await window.electron.revealArtifactPath(cwd, selectedArtifact.filePath);
  };

  return (
    <div className="flex-1 min-h-0 flex">
      {/* List */}
      <div className={`${selectedArtifact ? 'flex-[0_0_240px] min-w-[190px] max-w-[320px]' : 'flex-1'} overflow-auto px-3 pb-3`}>
        {artifacts.length === 0 ? (
          <div className="text-sm text-[var(--text-muted)] px-1 py-2">
            No artifacts yet. Artifacts are extracted from Write/Edit tool calls.
          </div>
        ) : (
          <div className="pt-1">
            {artifacts.map((artifact) => {
              const isSelected = selectedArtifact?.filePath === artifact.filePath;
              return (
                <button
                  key={artifact.filePath}
                  onClick={() =>
                    setSelectedPath((prev) => (prev === artifact.filePath ? null : artifact.filePath))
                  }
                  className={`w-full flex items-center gap-2 py-1.5 px-2 text-sm rounded-md text-left hover:bg-[var(--text-primary)]/5 transition-colors ${
                    isSelected ? 'bg-[var(--text-primary)]/[0.07]' : ''
                  }`}
                  title={artifact.filePath}
                >
                  <ArtifactBadge kind={artifact.kind} />
                  <span className="truncate text-[var(--text-secondary)] flex-1">
                    {artifact.fileName}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Divider and Preview - only shown when an artifact is selected */}
      {selectedArtifact && (
        <>
          <div className="w-px bg-[var(--border)]" />

          <div className="flex-1 min-w-0 flex flex-col px-3 py-3">
            <div className="flex items-center justify-between gap-2 pb-2">
              <div className="min-w-0">
                <div className="text-xs text-[var(--text-muted)]">Artifact</div>
                <div
                  className="text-sm font-medium text-[var(--text-primary)] truncate"
                  title={selectedArtifact.filePath}
                >
                  {selectedArtifact.fileName}
                </div>
              </div>

              <div className="flex items-center gap-1 flex-shrink-0 no-drag">
                {selectedArtifact.kind === 'html' && (
                  <HtmlModeToggle value={htmlMode} onChange={setHtmlMode} />
                )}

                <IconSquareButton
                  onClick={handleOpen}
                  title={cwd ? 'Open' : 'No working directory'}
                  ariaLabel="Open"
                  disabled={!cwd}
                >
                  <ExternalLink className="w-4 h-4" />
                </IconSquareButton>
                <IconSquareButton
                  onClick={handleReveal}
                  title={cwd ? 'Reveal' : 'No working directory'}
                  ariaLabel="Reveal"
                  disabled={!cwd}
                >
                  <FolderSearch className="w-4 h-4" />
                </IconSquareButton>
                <IconSquareButton
                  onClick={() => handleCopyPath(selectedArtifact.filePath)}
                  title={copiedPath ? 'Copied' : 'Copy path'}
                  ariaLabel="Copy path"
                >
                  {copiedPath ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </IconSquareButton>
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-auto rounded-lg border border-[var(--border)] bg-white p-3">
              {loading && (
                <div className="text-sm text-[var(--text-muted)]">Loading...</div>
              )}

              {!loading && error && (
                <div className="text-sm text-[var(--error)]">{error}</div>
              )}

              {!loading && !error && tooLarge && (
                <div className="text-sm text-[var(--text-muted)]">
                  File is larger than {formatBytes(tooLarge.maxBytes)} and cannot be previewed here.
                  <div className="mt-1 text-xs text-[var(--text-muted)]">
                    Size: {formatBytes(tooLarge.size)}
                  </div>
                </div>
              )}

              {!loading && !error && !tooLarge && (
                <ArtifactPreview
                  artifact={selectedArtifact}
                  htmlMode={htmlMode}
                  text={text}
                  binaryUrl={binaryUrl}
                />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ArtifactBadge({ kind }: { kind: ArtifactKind }) {
  const label =
    kind === 'html'
      ? 'HTML'
      : kind === 'markdown'
        ? 'MD'
        : kind === 'json'
          ? 'JSON'
          : kind === 'image'
            ? 'IMG'
            : kind === 'pdf'
              ? 'PDF'
              : kind === 'pptx'
                ? 'PPTX'
                : 'XLSX';

  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] bg-[var(--bg-secondary)]">
      {label}
    </span>
  );
}

function ArtifactPreview({
  artifact,
  htmlMode,
  text,
  binaryUrl,
}: {
  artifact: ArtifactItem;
  htmlMode: 'view' | 'code';
  text: string | null;
  binaryUrl: string | null;
}) {
  switch (artifact.kind) {
    case 'markdown':
      return (
        <div className="text-sm">
          <MDContent content={text || ''} allowHtml={false} />
        </div>
      );

    case 'json': {
      const formatted = formatJson(text || '');
      return (
        <pre className="whitespace-pre-wrap break-words font-mono text-sm text-[var(--text-primary)]">
          {formatted}
        </pre>
      );
    }

    case 'html':
      if (htmlMode === 'code') {
        return (
          <pre className="whitespace-pre-wrap break-words font-mono text-sm text-[var(--text-primary)]">
            {text || ''}
          </pre>
        );
      }
      return (
        <iframe
          title={artifact.fileName}
          sandbox="allow-scripts"
          srcDoc={text || ''}
          className="w-full h-full min-h-[260px] rounded-md border border-[var(--border)] bg-white"
        />
      );

    case 'image':
      return binaryUrl ? (
        <img src={binaryUrl} alt={artifact.fileName} className="max-w-full rounded-md" />
      ) : (
        <div className="text-sm text-[var(--text-muted)]">No image data.</div>
      );

    case 'pdf':
      return binaryUrl ? (
        <iframe
          title={artifact.fileName}
          src={binaryUrl}
          className="w-full h-full min-h-[320px] rounded-md border border-[var(--border)] bg-white"
        />
      ) : (
        <div className="text-sm text-[var(--text-muted)]">No PDF data.</div>
      );

    case 'pptx':
    case 'xlsx':
      return (
        <div className="text-sm text-[var(--text-muted)]">
          Preview for {artifact.kind.toUpperCase()} is not supported yet. Click “Open”.
        </div>
      );

    default:
      return (
        <div className="text-sm text-[var(--text-muted)]">Preview not supported.</div>
      );
  }
}

function formatJson(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return value;
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(Math.round(size)) : size.toFixed(1);
  return `${rounded} ${units[unit]}`;
}

function HtmlModeToggle({
  value,
  onChange,
}: {
  value: 'view' | 'code';
  onChange: (next: 'view' | 'code') => void;
}) {
  return (
    <div className="flex items-center rounded-lg border border-[var(--border)] overflow-hidden mr-1">
      <button
        onClick={() => onChange('view')}
        className={`px-2 py-1 text-xs ${value === 'view' ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'}`}
        title="View"
      >
        View
      </button>
      <button
        onClick={() => onChange('code')}
        className={`px-2 py-1 text-xs ${value === 'code' ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'}`}
        title="Code"
      >
        Code
      </button>
    </div>
  );
}

function IconSquareButton({
  children,
  onClick,
  title,
  ariaLabel,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  title: string;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      disabled={disabled}
      className="w-8 h-8 flex items-center justify-center rounded-lg border border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--text-primary)]/5 hover:border-[var(--text-primary)]/10 transition-all duration-150 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:border-transparent disabled:hover:text-[var(--text-secondary)]"
    >
      {children}
    </button>
  );
}



import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAppStore } from '../store/useAppStore';
import { MDContent } from '../render/markdown';
import type { ProjectTreeNode } from '../types';

type ProjectFilePreview =
  | {
      kind: 'text' | 'markdown';
      path: string;
      name: string;
      ext: string;
      size: number;
      text: string;
      editable: boolean;
    }
  | {
      kind: 'image';
      path: string;
      name: string;
      ext: string;
      size: number;
      dataUrl: string;
    }
  | {
      kind: 'binary' | 'unsupported';
      path: string;
      name: string;
      ext: string;
      size: number;
    }
  | {
      kind: 'too_large';
      path: string;
      name: string;
      ext: string;
      size: number;
      maxBytes: number;
    }
  | {
      kind: 'error';
      path: string;
      name: string;
      ext: string;
      message: string;
    };

function TreeNode({
  node,
  depth,
  expandedPaths,
  onToggle,
  onSelectFile,
  selectedFilePath,
  forceExpand,
}: {
  node: ProjectTreeNode;
  depth: number;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
  onSelectFile: (node: ProjectTreeNode) => void;
  selectedFilePath: string | null;
  forceExpand: boolean;
}) {
  const isDir = node.kind === 'dir';
  const isExpanded = forceExpand || expandedPaths.has(node.path);
  const chevron = isDir ? (isExpanded ? 'v' : '>') : '';
  const isImageFile = !isDir && isImageName(node.name);
  const isSelected = !isDir && !!selectedFilePath && node.path === selectedFilePath;

  return (
    <>
      <div
        className={`flex items-center gap-2 py-0.5 text-sm rounded-md cursor-pointer hover:bg-[var(--text-primary)]/5 transition-colors duration-150 ${
          isSelected ? 'bg-[var(--text-primary)]/[0.07]' : ''
        }`}
        style={{ paddingLeft: depth * 12 }}
        onClick={() => {
          if (isDir) {
            onToggle(node.path);
          } else {
            onSelectFile(node);
          }
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (isDir) {
              onToggle(node.path);
            } else {
              onSelectFile(node);
            }
          }
        }}
      >
        <span className="text-[var(--text-muted)] text-xs w-3">{chevron}</span>
        <span className="text-[var(--text-muted)]">
          {isDir ? (
            <FolderIcon />
          ) : isImageFile ? (
            <ImageFileIcon />
          ) : (
            <FileIcon />
          )}
        </span>
        <span
          className={`truncate ${isDir ? 'font-medium' : 'text-[var(--text-secondary)]'}`}
          title={node.name}
        >
          {node.name}
        </span>
      </div>
      {isDir &&
        isExpanded &&
        node.children?.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            expandedPaths={expandedPaths}
            onToggle={onToggle}
            onSelectFile={onSelectFile}
            selectedFilePath={selectedFilePath}
            forceExpand={forceExpand}
          />
        ))}
    </>
  );
}

function isImageName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith('.png') ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    lower.endsWith('.gif') ||
    lower.endsWith('.webp') ||
    lower.endsWith('.svg') ||
    lower.endsWith('.bmp') ||
    lower.endsWith('.ico')
  );
}

function FolderIcon() {
  return (
    <svg
      className="w-4 h-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      className="w-4 h-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3.5h8l4 4v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2z" />
      <path d="M14 3.5v4h4" />
    </svg>
  );
}

function ImageFileIcon() {
  return (
    <svg
      className="w-4 h-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3.5" y="4" width="17" height="16" rx="2" />
      <circle cx="9" cy="9" r="1.6" />
      <path d="M4.5 18l5.5-5.5 3.5 3.5 3-3L19.5 18" />
    </svg>
  );
}

export function ProjectTreePanel() {
  const defaultWidth = 520;
  const minWidth = 320;
  const maxWidth = 720;
  const {
    activeSessionId,
    sessions,
    projectCwd,
    projectTree,
    projectTreeCwd,
    setProjectTree,
  } = useAppStore();
  const [loading, setLoading] = useState(false);
  const prevCwdRef = useRef<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const initRootRef = useRef<string | null>(null);
  const [panelWidth, setPanelWidth] = useState(defaultWidth);
  const resizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const latestWidthRef = useRef(panelWidth);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedPreview, setSelectedPreview] = useState<ProjectFilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewRequestIdRef = useRef(0);
  const [draftText, setDraftText] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const copiedTimerRef = useRef<number | null>(null);
  const [copiedPath, setCopiedPath] = useState(false);

  const activeCwd = activeSessionId ? sessions[activeSessionId]?.cwd : null;
  const cwd = activeCwd || projectCwd || null;

  useEffect(() => {
    latestWidthRef.current = panelWidth;
  }, [panelWidth]);

  useEffect(() => {
    const stored = window.localStorage.getItem('cowork.projectTreeWidth');
    if (!stored) return;
    const parsed = Number(stored);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(maxWidth, Math.max(minWidth, parsed));
    setPanelWidth(clamped);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const current = cwd?.trim() || '';

    if (!current) {
      setProjectTree(null, null);
      if (prevCwdRef.current) {
        window.electron.unwatchProjectTree(prevCwdRef.current);
        prevCwdRef.current = null;
      }
      return;
    }

    if (prevCwdRef.current && prevCwdRef.current !== current) {
      window.electron.unwatchProjectTree(prevCwdRef.current);
    }
    prevCwdRef.current = current;

    setLoading(true);
    window.electron
      .getProjectTree(current)
      .then((tree) => {
        if (cancelled) return;
        if (tree) {
          setProjectTree(current, tree);
        } else {
          setProjectTree(current, null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    window.electron.watchProjectTree(current);

    return () => {
      cancelled = true;
      window.electron.unwatchProjectTree(current);
    };
  }, [cwd, setProjectTree]);

  const visibleTree = useMemo(() => {
    if (!cwd || !projectTree || projectTreeCwd !== cwd) {
      return null;
    }
    return projectTree;
  }, [cwd, projectTree, projectTreeCwd]);

  useEffect(() => {
    setExpandedPaths(new Set());
    initRootRef.current = null;
    setSelectedFilePath(null);
    setSelectedPreview(null);
    setPreviewLoading(false);
    setDraftText('');
    setSaveState('idle');
    setSaveError(null);
  }, [cwd]);

  useEffect(() => {
    if (!visibleTree?.path) return;
    if (initRootRef.current === visibleTree.path) return;
    initRootRef.current = visibleTree.path;
    setExpandedPaths(new Set([visibleTree.path]));
  }, [visibleTree?.path]);

  const togglePath = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const selectFile = async (node: ProjectTreeNode) => {
    if (node.kind !== 'file') return;
    if (!cwd) return;

    // Toggle: 如果点击的是已选中的文件，取消选中
    if (selectedFilePath === node.path) {
      setSelectedFilePath(null);
      setSelectedPreview(null);
      return;
    }

    setSelectedFilePath(node.path);
    setPreviewLoading(true);
    setSelectedPreview(null);
    setDraftText('');
    setSaveState('idle');
    setSaveError(null);

    const reader = window.electron.readProjectFilePreview;
    if (typeof reader !== 'function') {
      setPreviewLoading(false);
      setSelectedPreview({
        kind: 'error',
        path: node.path,
        name: node.name,
        ext: '',
        message:
          'File preview API is not available. Please restart the app (or re-run `npm run transpile:electron`).',
      });
      return;
    }

    const requestId = (previewRequestIdRef.current += 1);
    try {
      const preview = (await reader(cwd, node.path)) as ProjectFilePreview;
      if (previewRequestIdRef.current !== requestId) return;
      setSelectedPreview(preview);
      if (preview.kind === 'text' && preview.editable) {
        setDraftText(preview.text);
      }
    } catch (error) {
      if (previewRequestIdRef.current !== requestId) return;
      setSelectedPreview({
        kind: 'error',
        path: node.path,
        name: node.name,
        ext: '',
        message: String(error),
      });
    } finally {
      if (previewRequestIdRef.current === requestId) {
        setPreviewLoading(false);
      }
    }
  };

  const handleCopyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      setCopiedPath(true);
      if (copiedTimerRef.current) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => setCopiedPath(false), 1500);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) {
        window.clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  const canSaveTxt =
    !!cwd &&
    !!selectedPreview &&
    selectedPreview.kind === 'text' &&
    selectedPreview.editable &&
    draftText !== selectedPreview.text;

  const handleSaveTxt = async () => {
    if (!cwd) return;
    if (!selectedPreview || selectedPreview.kind !== 'text' || !selectedPreview.editable) return;
    if (!selectedFilePath) return;
    if (!canSaveTxt) return;

    setSaveState('saving');
    setSaveError(null);
    try {
      const result = (await window.electron.writeProjectTextFile(
        cwd,
        selectedFilePath,
        draftText
      )) as { ok: boolean; message?: string };
      if (!result?.ok) {
        setSaveState('error');
        setSaveError(result?.message || 'Failed to save');
        return;
      }
      setSelectedPreview({ ...selectedPreview, text: draftText });
      setSaveState('saved');
      window.setTimeout(() => setSaveState('idle'), 1200);
    } catch (error) {
      setSaveState('error');
      setSaveError(String(error));
    }
  };

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = startXRef.current - event.clientX;
      const nextWidth = Math.min(
        maxWidth,
        Math.max(minWidth, startWidthRef.current + delta)
      );
      setPanelWidth(nextWidth);
    };

    const handleUp = () => {
      if (!resizingRef.current) return;
      resizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.localStorage.setItem(
        'cowork.projectTreeWidth',
        String(latestWidthRef.current)
      );
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, []);

  const handleResizeStart = (event: React.MouseEvent) => {
    event.preventDefault();
    resizingRef.current = true;
    startXRef.current = event.clientX;
    startWidthRef.current = panelWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <div
      className="relative flex-shrink-0 bg-[var(--bg-secondary)] border-l border-[var(--border)] flex flex-col h-full"
      style={{ width: panelWidth }}
    >
      <div
        className="group absolute left-0 top-0 bottom-0 w-2 cursor-col-resize no-drag"
        onMouseDown={handleResizeStart}
      >
        <div className="absolute left-1 top-0 bottom-0 w-px bg-transparent group-hover:bg-[var(--border)]" />
      </div>
      <div className="h-8 drag-region" />
      <div className="px-4 pt-2 pb-2">
        <div className="text-xs text-[var(--text-muted)]">Project files</div>
        {!cwd && (
          <div className="text-xs text-[var(--text-muted)]">No folder selected</div>
        )}
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* Tree */}
        <div className={`${selectedFilePath ? 'flex-[0_0_240px] min-w-[190px] max-w-[320px]' : 'flex-1'} overflow-auto px-3 pb-3`}>
          {!cwd && (
            <div className="text-sm text-[var(--text-muted)] px-1 py-2">
              Select a folder to view files.
            </div>
          )}
          {cwd && loading && !visibleTree && (
            <div className="text-sm text-[var(--text-muted)] px-1 py-2">
              Loading files...
            </div>
          )}
          {cwd && visibleTree && (
            <TreeNode
              node={visibleTree}
              depth={0}
              expandedPaths={expandedPaths}
              onToggle={togglePath}
              onSelectFile={selectFile}
              selectedFilePath={selectedFilePath}
              forceExpand={false}
            />
          )}
          {cwd && !loading && !visibleTree && (
            <div className="text-sm text-[var(--text-muted)] px-1 py-2">
              No files found.
            </div>
          )}
        </div>

        {/* Divider and Preview - only shown when a file is selected */}
        {selectedFilePath && (
          <>
            <div className="w-px bg-[var(--border)]" />

            {/* Preview (right side) */}
            <div className="flex-1 min-w-0 flex flex-col px-3 py-3">
              <div className="flex items-center justify-between gap-2 pb-2">
                <div className="min-w-0">
                  <div className="text-xs text-[var(--text-muted)]">Preview</div>
                  <div
                    className="text-sm font-medium text-[var(--text-primary)] truncate"
                    title={selectedFilePath}
                  >
                    {selectedPreview?.name ||
                      selectedFilePath.split('/').pop() ||
                      selectedFilePath}
                  </div>
                </div>

                <div className="flex items-center gap-1 flex-shrink-0 no-drag">
                  {canSaveTxt && (
                    <button
                      onClick={handleSaveTxt}
                      disabled={saveState === 'saving'}
                      className="px-2 py-1 text-xs rounded-md bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Save"
                    >
                      {saveState === 'saving'
                        ? 'Saving...'
                        : saveState === 'saved'
                          ? 'Saved'
                          : 'Save'}
                    </button>
                  )}

                  <IconSquareButton
                    onClick={() => window.electron.openPath(selectedFilePath)}
                    title="Open"
                    ariaLabel="Open"
                  >
                    <OpenIcon />
                  </IconSquareButton>
                  <IconSquareButton
                    onClick={() => window.electron.revealPath(selectedFilePath)}
                    title="Reveal"
                    ariaLabel="Reveal"
                  >
                    <RevealIcon />
                  </IconSquareButton>
                  <IconSquareButton
                    onClick={() => handleCopyPath(selectedFilePath)}
                    title={copiedPath ? 'Copied' : 'Copy path'}
                    ariaLabel="Copy path"
                  >
                    {copiedPath ? <CheckIcon /> : <CopyIcon />}
                  </IconSquareButton>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-auto rounded-lg border border-[var(--border)] bg-white p-3">
                {previewLoading && (
                  <div className="text-sm text-[var(--text-muted)]">Loading...</div>
                )}

                {!previewLoading && selectedPreview?.kind === 'error' && (
                  <div className="text-sm text-[var(--error)]">{selectedPreview.message}</div>
                )}

                {!previewLoading && selectedPreview?.kind === 'too_large' && (
                  <div className="text-sm text-[var(--text-muted)]">
                    File is larger than {formatBytes(selectedPreview.maxBytes)} and cannot be previewed.
                  </div>
                )}

                {!previewLoading && selectedPreview?.kind === 'unsupported' && (
                  <div className="text-sm text-[var(--text-muted)]">
                    Preview not supported for this file type. Click “Open” to view it.
                  </div>
                )}

                {!previewLoading && selectedPreview?.kind === 'binary' && (
                  <div className="text-sm text-[var(--text-muted)]">
                    This file can be opened with your system viewer.
                  </div>
                )}

                {!previewLoading && selectedPreview?.kind === 'image' && (
                  <img
                    src={selectedPreview.dataUrl}
                    alt={selectedPreview.name}
                    className="max-w-full rounded-md"
                  />
                )}

                {!previewLoading && selectedPreview?.kind === 'markdown' && (
                  <div className="text-sm">
                    <MDContent content={selectedPreview.text} allowHtml={false} />
                  </div>
                )}

                {!previewLoading && selectedPreview?.kind === 'text' && (
                  <>
                    {selectedPreview.editable ? (
                      <textarea
                        value={draftText}
                        onChange={(e) => setDraftText(e.target.value)}
                        className="w-full h-full min-h-[220px] resize-none bg-transparent outline-none font-mono text-sm whitespace-pre-wrap"
                        spellCheck={false}
                      />
                    ) : (
                      <pre className="whitespace-pre-wrap break-words font-mono text-sm text-[var(--text-primary)]">
                        {selectedPreview.text}
                      </pre>
                    )}
                    {saveState === 'error' && saveError && (
                      <div className="mt-2 text-xs text-[var(--error)]">{saveError}</div>
                    )}
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
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

function IconSquareButton({
  children,
  onClick,
  title,
  ariaLabel,
}: {
  children: ReactNode;
  onClick: () => void;
  title: string;
  ariaLabel: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      className="w-8 h-8 flex items-center justify-center rounded-lg border border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--text-primary)]/5 hover:border-[var(--text-primary)]/10 transition-all duration-150"
    >
      {children}
    </button>
  );
}

function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function OpenIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 3h7v7" />
      <path d="M10 14L21 3" />
      <path d="M21 14v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

function RevealIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 7.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M12 10v6" />
      <path d="M9.5 13l2.5 3 2.5-3" />
    </svg>
  );
}

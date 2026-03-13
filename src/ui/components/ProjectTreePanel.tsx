import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FolderClosed, FolderOpen, FileArchive, FileText, Image, Presentation, ChevronLeft, ChevronRight, Copy, Check, ExternalLink, FolderSearch, X } from 'lucide-react';
import { pptxToHtml } from '@jvmr/pptx-to-html';
import { useAppStore } from '../store/useAppStore';
import { MDContent } from '../render/markdown';
import type { ProjectTreeNode } from '../types';

type ProjectFilePreview =
  | {
      kind: 'text' | 'markdown' | 'html';
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
      kind: 'pdf';
      path: string;
      name: string;
      ext: string;
      size: number;
      dataBase64?: string;
      dataUrl?: string;
    }
  | {
      kind: 'pptx';
      path: string;
      name: string;
      ext: string;
      size: number;
      dataBase64: string;
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
        className={`flex min-h-[24px] items-center gap-2 rounded-md py-0.5 text-sm transition-colors duration-150 hover:bg-[var(--tree-item-hover)] ${
          isSelected ? 'bg-[var(--tree-item-active)] ring-1 ring-[var(--tree-item-border)]' : ''
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
        <span className="flex h-4 w-3 shrink-0 items-center justify-center text-[10px] leading-none text-[var(--text-muted)]">
          {chevron}
        </span>
        <ProjectTreeNodeIcon node={node} isExpanded={isExpanded} isImageFile={isImageFile} />
        <span
          className={`min-w-0 truncate leading-5 ${isDir ? 'font-medium' : 'text-[var(--text-secondary)]'}`}
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

function ProjectTreeNodeIcon({
  node,
  isExpanded,
  isImageFile,
}: {
  node: ProjectTreeNode;
  isExpanded: boolean;
  isImageFile: boolean;
}) {
  if (node.kind === 'dir') {
    return (
      <span className="flex h-4.5 w-4.5 shrink-0 items-center justify-center text-[var(--tree-file-accent-fg)]">
        {isExpanded ? <FolderOpen className="w-3.5 h-3.5" /> : <FolderClosed className="w-3.5 h-3.5" />}
      </span>
    );
  }

  const visual = getProjectFileVisual(node.name, isImageFile);
  const Icon = visual.icon;

  return (
    <span
      className={`flex h-4.5 w-4.5 flex-shrink-0 items-center justify-center rounded-[5px] border ${visual.containerClass}`}
      aria-hidden="true"
    >
      <Icon className={`h-3 w-3 ${visual.iconClass}`} strokeWidth={1.9} />
    </span>
  );
}

function getProjectFileVisual(
  name: string,
  isImageFile: boolean
): {
  icon: typeof FileText;
  containerClass: string;
  iconClass: string;
} {
  const lower = name.toLowerCase();

  if (isImageFile) {
    return {
      icon: Image,
      containerClass: 'border-[var(--tree-file-media-border)] bg-[var(--tree-file-media-bg)]',
      iconClass: 'text-[var(--tree-file-media-fg)]',
    };
  }

  if (lower.endsWith('.ppt') || lower.endsWith('.pptx') || lower.endsWith('.key')) {
    return {
      icon: Presentation,
      containerClass: 'border-[var(--tree-file-warm-border)] bg-[var(--tree-file-warm-bg)]',
      iconClass: 'text-[var(--tree-file-warm-fg)]',
    };
  }

  if (
    lower.endsWith('.html') ||
    lower.endsWith('.htm') ||
    lower.endsWith('.css') ||
    lower.endsWith('.scss') ||
    lower.endsWith('.js') ||
    lower.endsWith('.jsx') ||
    lower.endsWith('.ts') ||
    lower.endsWith('.tsx') ||
    lower.endsWith('.json') ||
    lower.endsWith('.yml') ||
    lower.endsWith('.yaml') ||
    lower.endsWith('.xml')
  ) {
    return {
      icon: FileText,
      containerClass: 'border-[var(--tree-file-accent-border)] bg-[var(--tree-file-accent-bg)]',
      iconClass: 'text-[var(--tree-file-accent-fg)]',
    };
  }

  if (
    lower.endsWith('.zip') ||
    lower.endsWith('.tar') ||
    lower.endsWith('.gz') ||
    lower.endsWith('.rar') ||
    lower.endsWith('.7z')
  ) {
    return {
      icon: FileArchive,
      containerClass: 'border-[var(--tree-file-accent-border)] bg-[var(--tree-file-accent-bg)]',
      iconClass: 'text-[var(--tree-file-accent-fg)]',
    };
  }

  return {
    icon: FileText,
    containerClass: 'border-[var(--tree-file-neutral-border)] bg-[var(--tree-file-neutral-bg)]',
    iconClass: 'text-[var(--tree-file-neutral-fg)]',
  };
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


export function ProjectTreePanel() {
  const railWidth = 280;
  const defaultPreviewWidth = 520;
  const minPreviewWidth = 340;
  const maxPreviewWidth = 960;
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
  const [previewPanelWidth, setPreviewPanelWidth] = useState(defaultPreviewWidth);
  const previewResizingRef = useRef(false);
  const [isPreviewResizing, setIsPreviewResizing] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const latestPreviewWidthRef = useRef(previewPanelWidth);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedPreview, setSelectedPreview] = useState<ProjectFilePreview | null>(null);
  const [pptxSlideIndex, setPptxSlideIndex] = useState(0);
  const [htmlMode, setHtmlMode] = useState<'view' | 'code'>('view');
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
    latestPreviewWidthRef.current = previewPanelWidth;
  }, [previewPanelWidth]);

  useEffect(() => {
    const stored = window.localStorage.getItem('cowork.projectPreviewWidth');
    if (!stored) return;
    const parsed = Number(stored);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(maxPreviewWidth, Math.max(minPreviewWidth, parsed));
    setPreviewPanelWidth(clamped);
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
  const visibleNodes = useMemo(
    () => visibleTree?.children || [],
    [visibleTree]
  );

  useEffect(() => {
    setExpandedPaths(new Set());
    initRootRef.current = null;
    setSelectedFilePath(null);
    setSelectedPreview(null);
    setHtmlMode('view');
    setPreviewLoading(false);
    setDraftText('');
    setSaveState('idle');
    setSaveError(null);
    setPptxSlideIndex(0);
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
    setHtmlMode('view');
    setPreviewLoading(true);
    setSelectedPreview(null);
    setDraftText('');
    setSaveState('idle');
    setSaveError(null);
    setPptxSlideIndex(0);

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

  useEffect(() => {
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty(
      '--project-preview-space',
      selectedFilePath ? `${previewPanelWidth}px` : '0px'
    );

    return () => {
      root.style.setProperty('--project-preview-space', '0px');
    };
  }, [selectedFilePath, previewPanelWidth]);

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

  const handlePreviewResizeMove = (clientX: number) => {
    if (!previewResizingRef.current) return;
    const delta = startXRef.current - clientX;
    const nextPreviewWidth = Math.min(
      maxPreviewWidth,
      Math.max(minPreviewWidth, startWidthRef.current + delta)
    );
    setPreviewPanelWidth(nextPreviewWidth);
  };

  const finishPreviewResize = () => {
    if (!previewResizingRef.current) return;
    previewResizingRef.current = false;
    setIsPreviewResizing(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.localStorage.setItem(
      'cowork.projectPreviewWidth',
      String(latestPreviewWidthRef.current)
    );
  };

  useEffect(() => {
    if (!isPreviewResizing) return;

    const handleWindowBlur = () => finishPreviewResize();
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [isPreviewResizing]);

  const handlePreviewResizeStart = (event: React.MouseEvent) => {
    event.preventDefault();
    previewResizingRef.current = true;
    setIsPreviewResizing(true);
    startXRef.current = event.clientX;
    startWidthRef.current = previewPanelWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <>
      {isPreviewResizing && (
        <div
          className="fixed inset-0 z-[70] cursor-col-resize no-drag bg-transparent"
          onMouseMove={(event) => handlePreviewResizeMove(event.clientX)}
          onMouseUp={finishPreviewResize}
        />
      )}

      <div
        className="relative flex h-full flex-shrink-0 flex-col border-l border-[var(--tree-item-border)] bg-[var(--preview-surface)]"
        style={{ width: railWidth }}
      >
        <div className="h-8 drag-region" />
        <div className="px-4 pt-2 pb-2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--tree-file-accent-fg)]">
            PROJECT FILES
          </div>
          {!cwd && (
            <div className="text-xs text-[var(--text-muted)]">No folder selected</div>
          )}
        </div>

        <div className="flex-1 min-h-0 flex">
          <div className="flex-1 overflow-auto px-3 pb-3">
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
            {cwd && visibleTree && visibleNodes.length > 0 && (
              <>
                {visibleNodes.map((node) => (
                  <TreeNode
                    key={node.path}
                    node={node}
                    depth={0}
                    expandedPaths={expandedPaths}
                    onToggle={togglePath}
                    onSelectFile={selectFile}
                    selectedFilePath={selectedFilePath}
                    forceExpand={false}
                  />
                ))}
              </>
            )}
            {cwd && !loading && (!visibleTree || visibleNodes.length === 0) && (
              <div className="text-sm text-[var(--text-muted)] px-1 py-2">
                No files found.
              </div>
            )}
          </div>
        </div>

        {selectedFilePath && (
          <div
            className="absolute top-8 bottom-0 z-20 border-l border-[var(--tree-item-border)] bg-[var(--preview-surface)] shadow-[-12px_0_32px_rgba(0,0,0,0.08)]"
            style={{ right: 'calc(100% - 1px)', width: previewPanelWidth }}
          >
            <div
              className="group absolute left-0 top-0 bottom-0 w-3 -translate-x-1/2 cursor-col-resize no-drag"
              onMouseDown={handlePreviewResizeStart}
            >
              <div className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 bg-transparent group-hover:bg-[var(--border)]" />
            </div>

            <div className="h-full min-w-0 flex flex-col px-3 py-3">
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
                  {selectedPreview?.kind === 'html' && (
                    <HtmlModeToggle value={htmlMode} onChange={setHtmlMode} />
                  )}

                  {canSaveTxt && (
                    <button
                      onClick={handleSaveTxt}
                      disabled={saveState === 'saving'}
                      className="px-2 py-1 text-xs rounded-md bg-[var(--accent)] text-[var(--accent-foreground)] hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
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
                    onClick={() => setSelectedFilePath(null)}
                    title="Close preview"
                    ariaLabel="Close preview"
                  >
                    <X className="w-4 h-4" />
                  </IconSquareButton>
                  <IconSquareButton
                    onClick={() => window.electron.openPath(selectedFilePath)}
                    title="Open"
                    ariaLabel="Open"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </IconSquareButton>
                  <IconSquareButton
                    onClick={() => window.electron.revealPath(selectedFilePath)}
                    title="Reveal"
                    ariaLabel="Reveal"
                  >
                    <FolderSearch className="w-4 h-4" />
                  </IconSquareButton>
                  <IconSquareButton
                    onClick={() => handleCopyPath(selectedFilePath)}
                    title={copiedPath ? 'Copied' : 'Copy path'}
                    ariaLabel="Copy path"
                  >
                    {copiedPath ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </IconSquareButton>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--preview-surface)] p-3">
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

                {!previewLoading && selectedPreview?.kind === 'pdf' && (
                  <PdfPreview preview={selectedPreview} />
                )}

                {!previewLoading && selectedPreview?.kind === 'pptx' && (
                  <PptxPreview
                    preview={selectedPreview}
                    slideIndex={pptxSlideIndex}
                    onSlideIndexChange={setPptxSlideIndex}
                    viewportWidth={previewPanelWidth}
                  />
                )}

                {!previewLoading && selectedPreview?.kind === 'markdown' && (
                  <div className="text-sm">
                    <MDContent content={selectedPreview.text} allowHtml={false} />
                  </div>
                )}

                {!previewLoading && selectedPreview?.kind === 'html' && (
                  htmlMode === 'code' ? (
                    <pre className="whitespace-pre-wrap break-words font-mono text-sm text-[var(--text-primary)]">
                      {selectedPreview.text}
                    </pre>
                  ) : (
                    <iframe
                      title={selectedPreview.name}
                      sandbox="allow-scripts"
                      srcDoc={selectedPreview.text}
                      className="w-full h-full min-h-[320px] rounded-md border border-[var(--border)] bg-[var(--preview-surface)]"
                    />
                  )
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
          </div>
        )}
      </div>
    </>
  );
}

function PptxPreview({
  preview,
  slideIndex,
  onSlideIndexChange,
  viewportWidth,
}: {
  preview: Extract<ProjectFilePreview, { kind: 'pptx' }>;
  slideIndex: number;
  onSlideIndexChange: (next: number) => void;
  viewportWidth: number;
}) {
  const [slideHtml, setSlideHtml] = useState<string[]>([]);
  const [rendering, setRendering] = useState(true);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const render = async () => {
      setRendering(true);
      setRenderError(null);
      setSlideHtml([]);

      try {
        const buffer = base64ToArrayBuffer(preview.dataBase64);
        const slides = await pptxToHtml(buffer);

        if (cancelled) {
          return;
        }

        setSlideHtml(slides);
        onSlideIndexChange(0);
      } catch (error) {
        if (!cancelled) {
          setRenderError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) {
          setRendering(false);
        }
      }
    };

    void render();

    return () => {
      cancelled = true;
    };
  }, [onSlideIndexChange, preview.dataBase64, preview.path]);

  const totalSlides = slideHtml.length;
  const safeIndex = Math.min(Math.max(slideIndex, 0), Math.max(totalSlides - 1, 0));
  const currentSlideHtml = slideHtml[safeIndex] || '';

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium text-[var(--text-primary)]">
          {totalSlides > 1 ? `Slide ${safeIndex + 1} of ${totalSlides}` : 'Presentation preview'}
        </div>
        <div className="flex items-center gap-1.5 no-drag">
          <button
            type="button"
            onClick={() => onSlideIndexChange(Math.max(safeIndex - 1, 0))}
            disabled={safeIndex === 0}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Previous slide"
            title="Previous slide"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => onSlideIndexChange(Math.min(safeIndex + 1, totalSlides - 1))}
            disabled={safeIndex >= totalSlides - 1}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Next slide"
            title="Next slide"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {rendering ? (
        <div className="text-sm text-[var(--text-muted)]">Rendering presentation...</div>
      ) : renderError ? (
        <div className="text-sm text-[var(--error)]">{renderError}</div>
      ) : currentSlideHtml ? (
        <iframe
          key={`${preview.path}:${safeIndex}:${viewportWidth}`}
          title={`${preview.name} slide ${safeIndex + 1}`}
          sandbox="allow-scripts"
          srcDoc={buildPptxSlideDocument(currentSlideHtml)}
          className="w-full h-[clamp(260px,52vh,560px)] rounded-md border border-[var(--border)] bg-[var(--preview-surface)]"
        />
      ) : (
        <div className="text-sm text-[var(--text-muted)]">No slides could be rendered.</div>
      )}

      <div className="text-sm text-[var(--text-muted)]">
        {totalSlides > 1 ? 'Use the arrows to navigate between slides.' : 'Presentation preview.'}
      </div>
    </div>
  );
}

function PdfPreview({
  preview,
}: {
  preview: Extract<ProjectFilePreview, { kind: 'pdf' }>;
}) {
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;

    try {
      const encoded =
        preview.dataBase64 ||
        preview.dataUrl?.replace(/^data:application\/pdf;base64,/, '') ||
        '';

      if (!encoded) {
        setPdfUrl(null);
        setPdfError('No PDF data available.');
        return;
      }

      const buffer = base64ToArrayBuffer(encoded);
      objectUrl = URL.createObjectURL(new Blob([buffer], { type: 'application/pdf' }));
      setPdfUrl(objectUrl);
      setPdfError(null);
    } catch (error) {
      setPdfUrl(null);
      setPdfError(error instanceof Error ? error.message : String(error));
    }

    return () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [preview.dataBase64, preview.dataUrl, preview.path]);

  if (pdfError) {
    return <div className="text-sm text-[var(--error)]">{pdfError}</div>;
  }

  if (!pdfUrl) {
    return <div className="text-sm text-[var(--text-muted)]">Loading PDF preview...</div>;
  }

  return (
    <iframe
      title={preview.name}
      src={pdfUrl}
      className="w-full h-full min-h-[320px] rounded-md border border-[var(--border)] bg-[var(--preview-surface)]"
    />
  );
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function buildPptxSlideDocument(slideHtml: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        background: #ffffff;
        overflow: hidden;
      }
      body {
        display: flex;
        align-items: center;
        justify-content: center;
      }
      #pptx-stage {
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
      }
      #pptx-shell {
        position: relative;
        width: 100%;
        height: 100%;
        overflow: hidden;
      }
      #pptx-scale {
        position: absolute;
        left: 0;
        top: 0;
        transform-origin: top left;
        will-change: transform;
      }
      #pptx-scale > * {
        margin: 0;
      }
    </style>
  </head>
  <body>
    <div id="pptx-stage">
      <div id="pptx-shell">
        <div id="pptx-scale">${slideHtml}</div>
      </div>
    </div>
    <script>
      (() => {
        const stage = document.getElementById('pptx-stage');
        const shell = document.getElementById('pptx-shell');
        const scaleNode = document.getElementById('pptx-scale');
        if (!stage || !shell || !scaleNode) {
          return;
        }

        const fit = () => {
          const content = scaleNode.firstElementChild || scaleNode;
          if (!content) {
            return;
          }

          scaleNode.style.transform = 'none';
          scaleNode.style.width = 'auto';
          scaleNode.style.height = 'auto';

          const rect = content.getBoundingClientRect();
          if (!rect.width || !rect.height) {
            return;
          }

          const padding = 16;
          const availableWidth = Math.max(stage.clientWidth - padding, 1);
          const availableHeight = Math.max(stage.clientHeight - padding, 1);
          const scale = Math.min(availableWidth / rect.width, availableHeight / rect.height, 1);
          const scaledWidth = rect.width * scale;
          const scaledHeight = rect.height * scale;
          const offsetX = Math.max((stage.clientWidth - scaledWidth) / 2, 0);
          const offsetY = Math.max((stage.clientHeight - scaledHeight) / 2, 0);

          scaleNode.style.width = rect.width + 'px';
          scaleNode.style.height = rect.height + 'px';
          scaleNode.style.transform = 'translate(' + offsetX + 'px, ' + offsetY + 'px) scale(' + scale + ')';
        };

        window.addEventListener('resize', fit);
        window.addEventListener('load', fit);
        if (window.visualViewport) {
          window.visualViewport.addEventListener('resize', fit);
        }
        if (typeof ResizeObserver !== 'undefined') {
          const observer = new ResizeObserver(() => fit());
          observer.observe(stage);
          observer.observe(document.documentElement);
        }
        if (document.fonts && document.fonts.ready) {
          document.fonts.ready.then(() => fit()).catch(() => undefined);
        }
        const images = shell.querySelectorAll('img');
        images.forEach((img) => {
          if (img.complete) {
            return;
          }
          img.addEventListener('load', fit, { once: true });
          img.addEventListener('error', fit, { once: true });
        });
        requestAnimationFrame(() => {
          requestAnimationFrame(fit);
        });
      })();
    </script>
  </body>
</html>`;
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

function HtmlModeToggle({
  value,
  onChange,
}: {
  value: 'view' | 'code';
  onChange: (next: 'view' | 'code') => void;
}) {
  return (
    <div className="mr-1 flex items-center overflow-hidden rounded-lg border border-[var(--border)]">
      <button
        onClick={() => onChange('view')}
        className={`px-2 py-1 text-xs ${
          value === 'view'
            ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
            : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
        }`}
        title="View"
      >
        View
      </button>
      <button
        onClick={() => onChange('code')}
        className={`px-2 py-1 text-xs ${
          value === 'code'
            ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
            : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
        }`}
        title="Code"
      >
        Code
      </button>
    </div>
  );
}

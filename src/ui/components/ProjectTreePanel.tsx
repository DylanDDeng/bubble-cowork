import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FolderClosed, FolderOpen, FileArchive, FileText, Image, Presentation, ChevronLeft, ChevronRight, Copy, Check, X, RefreshCw } from 'lucide-react';
import { pptxToHtml } from '@jvmr/pptx-to-html';
import { useAppStore } from '../store/useAppStore';
import { MDContent } from '../render/markdown';
import { HighlightedCode } from './HighlightedCode';
import {
  applyDiffToChangeRecord,
  applyTextMetaToChangeRecord,
  extractToolChangeRecords,
  getOperationLabel,
  mergeChangeRecords,
  summarizeChangeRecords,
  type ChangeOperation,
  type ChangeRecord,
} from '../utils/change-records';
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
  const defaultRailWidth = 280;
  const minRailWidth = 260;
  const maxRailWidth = 560;
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
  const [panelWidth, setPanelWidth] = useState(defaultRailWidth);
  const panelResizingRef = useRef(false);
  const [isPanelResizing, setIsPanelResizing] = useState(false);
  const panelStartXRef = useRef(0);
  const panelStartWidthRef = useRef(defaultRailWidth);
  const latestPanelWidthRef = useRef(defaultRailWidth);
  const [previewPanelWidth, setPreviewPanelWidth] = useState(defaultPreviewWidth);
  const previewResizingRef = useRef(false);
  const [isPreviewResizing, setIsPreviewResizing] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const latestPreviewWidthRef = useRef(previewPanelWidth);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedPreview, setSelectedPreview] = useState<ProjectFilePreview | null>(null);
  const [pptxSlideIndex, setPptxSlideIndex] = useState(0);
  const [viewMode, setViewMode] = useState<'view' | 'code'>('view');
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewRequestIdRef = useRef(0);
  const [draftText, setDraftText] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const copiedTimerRef = useRef<number | null>(null);
  const [copiedPath, setCopiedPath] = useState(false);

  const [activeTab, setActiveTab] = useState<'files' | 'changes'>('files');
  const [changeRecords, setChangeRecords] = useState<ChangeRecord[]>([]);
  const [changesError, setChangesError] = useState<string | null>(null);
  const [changesLoading, setChangesLoading] = useState(false);
  const [expandedChangeId, setExpandedChangeId] = useState<string | null>(null);

  const activeCwd = activeSessionId ? sessions[activeSessionId]?.cwd : null;
  const cwd = activeCwd || projectCwd || null;

  const loadChangeRecords = async () => {
    if (!cwd) return;
    setChangesLoading(true);
    setChangesError(null);
    try {
      const toolRecords = extractToolChangeRecords(activeSession?.messages || []);
      const result = await window.electron.getGitChanges(cwd);
      if (result.ok) {
        const merged = mergeChangeRecords(toolRecords, result.entries);
        const enriched = await enrichChangeRecords(cwd, merged);
        setChangeRecords(enriched);
        setChangesError(null);
      } else if (result.error === 'not-a-repo') {
        setChangeRecords(toolRecords);
        setChangesError(toolRecords.length > 0 ? null : 'not-a-repo');
      } else {
        setChangesError(result.error);
        setChangeRecords(toolRecords);
      }
    } catch {
      setChangesError('git-error');
      setChangeRecords([]);
    } finally {
      setChangesLoading(false);
    }
  };

  // Reload changes when tab activates, cwd changes, or session messages update
  const activeSession = activeSessionId ? sessions[activeSessionId] : null;
  const messageCount = activeSession?.messages.length ?? 0;
  const sessionStatus = activeSession?.status;
  const changeSummary = useMemo(
    () => summarizeChangeRecords(changeRecords),
    [changeRecords]
  );

  const enrichChangeRecords = async (
    currentCwd: string,
    records: ChangeRecord[]
  ): Promise<ChangeRecord[]> => {
    const enriched = await Promise.all(
      records.map(async (record) => {
        let next = record;

        if (
          record.source === 'git' ||
          (record.operation === 'edit' && !record.diffContent) ||
          (record.operation === 'delete' && !record.diffContent)
        ) {
          try {
            const diff = await window.electron.getGitDiff(currentCwd, record.filePath);
            if (diff.trim()) {
              next = applyDiffToChangeRecord(next, diff);
            }
          } catch {
            // Ignore per-file diff failures and keep the record visible.
          }
        }

        if (next.sizeBytes === null || next.lineCount === null) {
          try {
            const preview = (await window.electron.readProjectFilePreview(
              currentCwd,
              next.filePath
            )) as ProjectFilePreview | null;

            if (
              preview &&
              (preview.kind === 'text' || preview.kind === 'markdown' || preview.kind === 'html')
            ) {
              next = applyTextMetaToChangeRecord(next, preview.text, preview.size);
            } else if (preview && 'size' in preview && typeof preview.size === 'number') {
              next = {
                ...next,
                sizeBytes: next.sizeBytes ?? preview.size,
              };
            }
          } catch {
            // Deleted or unreadable files simply stay without size metadata.
          }
        }

        return next;
      })
    );

    return enriched;
  };

  useEffect(() => {
    if (activeTab === 'changes' && cwd) {
      void loadChangeRecords();
    }
  }, [activeTab, cwd, messageCount, sessionStatus, projectTreeCwd, projectTree]);

  useEffect(() => {
    latestPanelWidthRef.current = panelWidth;
  }, [panelWidth]);

  useEffect(() => {
    latestPreviewWidthRef.current = previewPanelWidth;
  }, [previewPanelWidth]);

  useEffect(() => {
    const storedPanelWidth = window.localStorage.getItem('cowork.projectPanelWidth');
    if (storedPanelWidth) {
      const parsed = Number(storedPanelWidth);
      if (Number.isFinite(parsed)) {
        const clamped = Math.min(maxRailWidth, Math.max(minRailWidth, parsed));
        setPanelWidth(clamped);
      }
    }

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
    setViewMode('view');
    setPreviewLoading(false);
    setDraftText('');
    setSaveState('idle');
    setSaveError(null);
    setPptxSlideIndex(0);
    setActiveTab('files');
    setChangeRecords([]);
    setChangesError(null);
    setExpandedChangeId(null);
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
    setViewMode('view');
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
    const showPreview = selectedFilePath;
    root.style.setProperty(
      '--project-preview-space',
      showPreview ? `${previewPanelWidth}px` : '0px'
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
      void loadChangeRecords();
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

  const handlePanelResizeMove = (clientX: number) => {
    if (!panelResizingRef.current) return;
    const delta = panelStartXRef.current - clientX;
    const nextPanelWidth = Math.min(
      maxRailWidth,
      Math.max(minRailWidth, panelStartWidthRef.current + delta)
    );
    setPanelWidth(nextPanelWidth);
  };

  const finishPanelResize = () => {
    if (!panelResizingRef.current) return;
    panelResizingRef.current = false;
    setIsPanelResizing(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.localStorage.setItem(
      'cowork.projectPanelWidth',
      String(latestPanelWidthRef.current)
    );
  };

  useEffect(() => {
    if (!isPanelResizing) return;

    const handleWindowBlur = () => finishPanelResize();
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [isPanelResizing]);

  const handlePanelResizeStart = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    panelResizingRef.current = true;
    setIsPanelResizing(true);
    panelStartXRef.current = event.clientX;
    panelStartWidthRef.current = panelWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <>
      {isPanelResizing && (
        <div
          className="fixed inset-0 z-[70] cursor-col-resize no-drag bg-transparent"
          onMouseMove={(event) => handlePanelResizeMove(event.clientX)}
          onMouseUp={finishPanelResize}
        />
      )}

      {isPreviewResizing && (
        <div
          className="fixed inset-0 z-[70] cursor-col-resize no-drag bg-transparent"
          onMouseMove={(event) => handlePreviewResizeMove(event.clientX)}
          onMouseUp={finishPreviewResize}
        />
      )}

      <div
        className="relative flex h-full flex-shrink-0 flex-col border-l border-[var(--tree-item-border)] bg-[var(--preview-surface)]"
        style={{ width: panelWidth }}
      >
        {!selectedFilePath && (
          <div
            className="group absolute left-0 top-0 bottom-0 z-10 w-3 -translate-x-1/2 cursor-col-resize no-drag"
            onMouseDown={handlePanelResizeStart}
          >
            <div className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 bg-transparent group-hover:bg-[var(--border)]" />
          </div>
        )}
        <div className="h-8 drag-region" />
        <div className="px-4 pt-2 pb-2">
          <div className="flex items-center gap-1">
            <button
              onClick={() => { setActiveTab('files'); setExpandedChangeId(null); }}
              className={`text-[10px] font-semibold uppercase tracking-[0.14em] px-1.5 py-0.5 rounded transition-colors ${
                activeTab === 'files'
                  ? 'text-[var(--tree-file-accent-fg)] bg-[var(--tree-file-accent-fg)]/10'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
            >
              Files
            </button>
            <button
              onClick={() => { setActiveTab('changes'); setSelectedFilePath(null); setSelectedPreview(null); }}
              className={`text-[10px] font-semibold uppercase tracking-[0.14em] px-1.5 py-0.5 rounded transition-colors ${
                activeTab === 'changes'
                  ? 'text-[var(--tree-file-accent-fg)] bg-[var(--tree-file-accent-fg)]/10'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
            >
              Changes
              {changeRecords.length > 0 && (
                <span className="ml-1 text-[9px] opacity-70">{changeRecords.length}</span>
              )}
            </button>
            {activeTab === 'changes' && (
              <button
                onClick={() => void loadChangeRecords()}
                disabled={changesLoading}
                className="ml-auto p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors disabled:opacity-40"
                title="Refresh"
              >
                <RefreshCw className={`w-3 h-3 ${changesLoading ? 'animate-spin' : ''}`} />
              </button>
            )}
          </div>
          {!cwd && (
            <div className="text-xs text-[var(--text-muted)] mt-1">No folder selected</div>
          )}
        </div>

        <div className="flex-1 min-h-0 flex">
          <div className="flex-1 overflow-auto px-3 pb-3">
            {activeTab === 'files' ? (
              <>
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
              </>
            ) : (
              <>
                {!cwd && (
                  <div className="text-sm text-[var(--text-muted)] px-1 py-2">
                    Select a folder to view changes.
                  </div>
                )}
                {cwd && changesLoading && changeRecords.length === 0 && (
                  <div className="text-sm text-[var(--text-muted)] px-1 py-2">
                    Loading changes...
                  </div>
                )}
                {cwd && !changesLoading && changeRecords.length === 0 && (
                  <div className="text-sm text-[var(--text-muted)] px-1 py-2">
                    {changesError === 'not-a-repo'
                      ? 'Not a git repository. Changes from this session will appear here.'
                      : changesError === 'git-error'
                        ? 'Failed to read git status.'
                        : 'No changes detected.'}
                  </div>
                )}
                {changeRecords.length > 0 && (
                  <ChangeSummaryHeader summary={changeSummary} />
                )}
                {changeRecords.map((entry) => (
                  <ChangeRecordItem
                    key={entry.id}
                    entry={entry}
                    isExpanded={expandedChangeId === entry.id}
                    onToggle={() => {
                      setExpandedChangeId((current) => current === entry.id ? null : entry.id);
                    }}
                  />
                ))}
              </>
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
                  {(selectedPreview?.kind === 'html' || selectedPreview?.kind === 'markdown') && (
                    <ViewModeToggle value={viewMode} onChange={setViewMode} />
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
                  viewMode === 'code' ? (
                    <HighlightedCode code={selectedPreview.text} language="markdown" className="-m-3 rounded-none" />
                  ) : (
                    <div className="text-sm">
                      <MDContent content={selectedPreview.text} allowHtml={false} />
                    </div>
                  )
                )}

                {!previewLoading && selectedPreview?.kind === 'html' && (
                  viewMode === 'code' ? (
                    <HighlightedCode code={selectedPreview.text} language="html" className="-m-3 rounded-none" />
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
                      <HighlightedCode code={selectedPreview.text} fileName={selectedPreview.name} className="-m-3 rounded-none" />
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

function ViewModeToggle({
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

function ChangeSummaryHeader({
  summary,
}: {
  summary: ReturnType<typeof summarizeChangeRecords>;
}) {
  return (
    <div className="mb-1 border-b border-[var(--border)] px-1 py-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="font-medium text-[var(--text-primary)]">
          {summary.total} change{summary.total === 1 ? '' : 's'}
        </span>
        {summary.operationCounts.map((entry) => (
          <span key={entry.operation} className="text-[var(--text-muted)]">
            {entry.count} {getOperationLabel(entry.operation, entry.count)}
          </span>
        ))}
        {summary.totalSizeBytes > 0 && (
          <span className="text-[var(--text-muted)]">{formatBytes(summary.totalSizeBytes)}</span>
        )}
      </div>
    </div>
  );
}

function ChangeRecordItem({
  entry,
  isExpanded,
  onToggle,
}: {
  entry: ChangeRecord;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const isImageFile = isImageName(entry.fileName);
  const visual = getProjectFileVisual(entry.fileName, isImageFile);
  const Icon = visual.icon;
  const canExpand = !!entry.diffContent;

  return (
    <div className="border-b border-[var(--border)]/80 last:border-b-0">
      <button
        onClick={() => {
          if (canExpand) onToggle();
        }}
        className="flex w-full items-start gap-2 px-1 py-2.5 text-left transition-colors hover:bg-[var(--tree-item-hover)]/35"
      >
        <ChevronRight
          className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--text-muted)] transition-transform ${
            isExpanded ? 'rotate-90' : ''
          } ${canExpand ? 'opacity-100' : 'opacity-30'}`}
        />
        <span
          className={`mt-0.5 flex h-4.5 w-4.5 flex-shrink-0 items-center justify-center rounded-[5px] border ${visual.containerClass}`}
          aria-hidden="true"
        >
          <Icon className={`h-3 w-3 ${visual.iconClass}`} strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-sm font-medium text-[var(--text-primary)]"
            title={entry.filePath}
          >
            {entry.fileName}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center justify-end gap-1.5 pt-0.5 text-[10px]">
          <ChangeOperationPill operation={entry.operation} state={entry.state} />
          {entry.sizeBytes !== null &&
            (entry.operation === 'write' ||
              entry.operation === 'added' ||
              entry.operation === 'untracked') && (
              <span className="text-[var(--text-muted)]">{formatBytes(entry.sizeBytes)}</span>
            )}
          {entry.lineCount !== null &&
            (entry.operation === 'write' ||
              entry.operation === 'added' ||
              entry.operation === 'untracked') && (
              <span className="whitespace-nowrap text-[var(--text-muted)]">
                {entry.lineCount} line{entry.lineCount === 1 ? '' : 's'}
              </span>
            )}
          {(entry.addedLines > 0 || entry.removedLines > 0) && (
            <ChangeDiffStat addedLines={entry.addedLines} removedLines={entry.removedLines} />
          )}
        </div>
      </button>

      {isExpanded && (
        <div className="border-t border-[var(--border)]/70 bg-[var(--bg-secondary)]/12 px-1 pb-2 pt-2">
          {entry.diffContent ? (
            <div className="overflow-auto border border-[var(--border)]/60 bg-[var(--preview-surface)]">
              <ChangeDiffView diffContent={entry.diffContent} />
            </div>
          ) : (
            <div className="text-xs text-[var(--text-muted)]">No diff available for this change.</div>
          )}
        </div>
      )}
    </div>
  );
}

function ChangeOperationPill({
  operation,
  state,
}: {
  operation: ChangeOperation;
  state: ChangeRecord['state'];
}) {
  const tone =
    operation === 'write' || operation === 'added' || operation === 'untracked'
      ? 'border-green-500/15 bg-green-500/6 text-green-600'
      : operation === 'edit' || operation === 'modified'
        ? 'border-sky-500/15 bg-sky-500/6 text-sky-600'
        : operation === 'delete' || operation === 'deleted'
          ? 'border-red-500/15 bg-red-500/6 text-red-600'
          : 'border-purple-500/15 bg-purple-500/6 text-purple-600';

  return (
    <span className={`rounded-md border px-1.5 py-0.5 font-medium ${tone}`}>
      {state === 'pending' ? `${getOperationLabel(operation)}…` : getOperationLabel(operation)}
    </span>
  );
}

function ChangeDiffStat({
  addedLines,
  removedLines,
}: {
  addedLines: number;
  removedLines: number;
}) {
  return (
    <span className="flex items-center gap-1 font-medium">
      {removedLines > 0 && <span className="text-red-500">-{removedLines}</span>}
      {addedLines > 0 && <span className="text-green-500">+{addedLines}</span>}
    </span>
  );
}

type ParsedDiffRow =
  | { type: 'hunk'; text: string }
  | { type: 'context'; text: string; oldLine: number | null; newLine: number | null }
  | { type: 'addition'; text: string; oldLine: number | null; newLine: number | null }
  | { type: 'deletion'; text: string; oldLine: number | null; newLine: number | null }
  | { type: 'note'; text: string };

function ChangeDiffView({ diffContent }: { diffContent: string }) {
  const rows = useMemo(() => parseDiffRows(diffContent), [diffContent]);

  return (
    <table className="w-full border-collapse text-[12px] leading-6 font-mono">
      <tbody>
        {rows.map((row, index) => {
          if (row.type === 'hunk') {
            return (
              <tr key={`hunk-${index}`} className="bg-[var(--bg-secondary)]/45">
                <td className="w-[3.5ch] px-2 py-0.5 text-right text-[var(--text-muted)]/60" />
                <td className="w-[3.5ch] px-2 py-0.5 text-right text-[var(--text-muted)]/60 border-r border-[var(--border)]/50" />
                <td className="px-3 py-0.5 text-[11px] text-[var(--text-muted)]">{row.text}</td>
              </tr>
            );
          }

          if (row.type === 'note') {
            return (
              <tr key={`note-${index}`}>
                <td className="w-[3.5ch] px-2 py-0.5 text-right text-[var(--text-muted)]/60" />
                <td className="w-[3.5ch] px-2 py-0.5 text-right text-[var(--text-muted)]/60 border-r border-[var(--border)]/50" />
                <td className="px-3 py-0.5 text-[var(--text-muted)]">{row.text}</td>
              </tr>
            );
          }

          const rowTone =
            row.type === 'addition'
              ? 'bg-green-500/10'
              : row.type === 'deletion'
                ? 'bg-red-500/10'
                : '';
          const prefixTone =
            row.type === 'addition'
              ? 'text-green-600'
              : row.type === 'deletion'
                ? 'text-red-500'
                : 'text-[var(--text-primary)]';

          return (
            <tr key={`row-${index}`} className={rowTone}>
              <td className="w-[3.5ch] px-2 py-0.5 text-right text-[var(--text-muted)]/60 select-none">
                {row.oldLine ?? ''}
              </td>
              <td className="w-[3.5ch] px-2 py-0.5 text-right text-[var(--text-muted)]/60 border-r border-[var(--border)]/50 select-none">
                {row.newLine ?? ''}
              </td>
              <td className="px-3 py-0.5">
                <span className={`mr-2 select-none ${prefixTone}`}>
                  {row.type === 'addition' ? '+' : row.type === 'deletion' ? '-' : ' '}
                </span>
                <span className={prefixTone}>{row.text || ' '}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function parseDiffRows(diffContent: string): ParsedDiffRow[] {
  const rows: ParsedDiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of diffContent.split('\n')) {
    if (!line) continue;
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      continue;
    }

    if (line.startsWith('@@')) {
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
      }
      rows.push({ type: 'hunk', text: line });
      continue;
    }

    if (line.startsWith('\\')) {
      rows.push({ type: 'note', text: line });
      continue;
    }

    if (line.startsWith('+')) {
      rows.push({ type: 'addition', text: line.slice(1), oldLine: null, newLine });
      newLine += 1;
      continue;
    }

    if (line.startsWith('-')) {
      rows.push({ type: 'deletion', text: line.slice(1), oldLine, newLine: null });
      oldLine += 1;
      continue;
    }

    const text = line.startsWith(' ') ? line.slice(1) : line;
    rows.push({ type: 'context', text, oldLine, newLine });
    oldLine += 1;
    newLine += 1;
  }

  return rows;
}

function GitStatusBadge({ status }: { status: string }) {
  const label = status;
  const colorClass =
    status === 'M' ? 'text-amber-500'
    : status === 'A' ? 'text-green-500'
    : status === 'D' ? 'text-red-500'
    : status === 'R' ? 'text-purple-500'
    : 'text-[var(--text-muted)]';

  const title =
    status === 'M' ? 'Modified'
    : status === 'A' ? 'Added'
    : status === 'D' ? 'Deleted'
    : status === 'R' ? 'Renamed'
    : 'Untracked';

  return (
    <span
      className={`flex h-4 w-4 shrink-0 items-center justify-center text-[10px] font-bold ${colorClass}`}
      title={title}
    >
      {label}
    </span>
  );
}

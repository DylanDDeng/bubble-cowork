import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FolderClosed, FolderOpen, ChevronLeft, ChevronRight, Copy, Check, X, RefreshCw, Maximize2, Minimize2, File, FileDiff, Files, FileAddIcon, FolderAddIcon } from './icons';
import { pptxToHtml } from '@jvmr/pptx-to-html';
import { toast } from 'sonner';
import { useAppStore } from '../store/useAppStore';
import { MDContent } from '../render/markdown';
import { HighlightedCode } from './HighlightedCode';
import { FileTypeIcon } from './FileTypeIcon';
import { ProjectMarkdownEditor } from './ProjectMarkdownEditor';
import { IconButton } from './ui/icon-button';
import { isHtmlFilePath, openHtmlFileInBrowserTab } from '../utils/html-preview';
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

type ProjectPanelTab = 'files' | 'changes';
type ProjectPanelDimensions = {
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  title: string;
};

const PANEL_DIMENSIONS: Record<ProjectPanelTab, ProjectPanelDimensions> = {
  files: { defaultWidth: 50, minWidth: 50, maxWidth: 440, title: 'Files' },
  changes: { defaultWidth: 360, minWidth: 320, maxWidth: 560, title: 'Changes' },
};

const LEGACY_PROJECT_PANEL_WIDTH_STORAGE_KEY = 'cowork.projectPanelWidth';
const getProjectPanelWidthStorageKey = (tab: ProjectPanelTab) =>
  `${LEGACY_PROJECT_PANEL_WIDTH_STORAGE_KEY}.${tab}`;

function parseStoredPanelWidth(
  stored: string | null,
  minWidth: number,
  maxWidth: number
) {
  if (!stored) return null;
  const parsed = Number(stored);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(maxWidth, Math.max(minWidth, parsed));
}

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
      previewUrl?: string;
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

type CreateEntryKind = 'file' | 'folder';
type CreateDraftState = {
  id: number;
  kind: CreateEntryKind;
  parentPath: string;
  name: string;
  error: string | null;
  submitting: boolean;
};
type ProjectEntryCreateResult = {
  ok: boolean;
  path?: string;
  tree?: ProjectTreeNode;
  message?: string;
};
type ProjectTreeContextMenuState = {
  x: number;
  y: number;
  parentPath: string;
};

function CreateEntryIcon({
  kind,
  size = 'md',
}: {
  kind: CreateEntryKind;
  size?: 'sm' | 'md';
}) {
  const iconClass = size === 'sm' ? 'h-4 w-4' : 'h-[18px] w-[18px]';
  const Icon = kind === 'folder' ? FolderAddIcon : FileAddIcon;

  return (
    <Icon className={iconClass} stroke={1.85} aria-hidden="true" />
  );
}

function dirnameOfPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index > 0 ? normalized.slice(0, index) : '.';
}

function sliceTextLineRange(text: string, lineStart?: number, lineEnd?: number): string {
  if (typeof lineStart !== 'number' || !Number.isFinite(lineStart) || lineStart < 1) {
    return text;
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = Math.max(1, Math.floor(lineStart));
  const end = typeof lineEnd === 'number' && Number.isFinite(lineEnd)
    ? Math.max(start, Math.floor(lineEnd))
    : start;
  return lines
    .slice(start - 1, Math.min(lines.length, end))
    .map((line, index) => `${String(start + index).padStart(4, ' ')} | ${line}`)
    .join('\n');
}

function TreeNode({
  node,
  depth,
  expandedPaths,
  onToggle,
  onSelectFile,
  onOpenContextMenu,
  selectedFilePath,
  forceExpand,
  createDraft,
  onCreateDraftNameChange,
  onSubmitCreateDraft,
  onCancelCreateDraft,
}: {
  node: ProjectTreeNode;
  depth: number;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
  onSelectFile: (node: ProjectTreeNode) => void;
  onOpenContextMenu: (event: React.MouseEvent, node: ProjectTreeNode) => void;
  selectedFilePath: string | null;
  forceExpand: boolean;
  createDraft: CreateDraftState | null;
  onCreateDraftNameChange: (name: string) => void;
  onSubmitCreateDraft: () => void;
  onCancelCreateDraft: () => void;
}) {
  const isDir = node.kind === 'dir';
  const isExpanded = forceExpand || expandedPaths.has(node.path);
  const chevron = isDir ? (isExpanded ? 'v' : '>') : '';
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
        onContextMenu={(event) => onOpenContextMenu(event, node)}
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
        <ProjectTreeNodeIcon node={node} isExpanded={isExpanded} />
        <span
          className={`min-w-0 truncate leading-5 ${isDir ? 'font-medium' : 'text-[var(--text-secondary)]'}`}
          title={node.name}
        >
          {node.name}
        </span>
      </div>
      {isDir && isExpanded && createDraft?.parentPath === node.path ? (
        <CreateEntryRow
          depth={depth + 1}
          draft={createDraft}
          onNameChange={onCreateDraftNameChange}
          onSubmit={onSubmitCreateDraft}
          onCancel={onCancelCreateDraft}
        />
      ) : null}
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
            onOpenContextMenu={onOpenContextMenu}
            selectedFilePath={selectedFilePath}
            forceExpand={forceExpand}
            createDraft={createDraft}
            onCreateDraftNameChange={onCreateDraftNameChange}
            onSubmitCreateDraft={onSubmitCreateDraft}
            onCancelCreateDraft={onCancelCreateDraft}
          />
        ))}
    </>
  );
}

function CreateEntryRow({
  depth,
  draft,
  onNameChange,
  onSubmit,
  onCancel,
}: {
  depth: number;
  draft: CreateDraftState;
  onNameChange: (name: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [draft.id]);

  return (
    <div className="py-0.5" style={{ paddingLeft: depth * 12 }}>
      <div className="flex min-h-[24px] items-center gap-2 rounded-md bg-[var(--tree-item-active)] px-1 ring-1 ring-[var(--tree-item-border)]">
        <span className="flex h-4 w-3 shrink-0 items-center justify-center" />
        <span className="group flex h-4.5 w-4.5 shrink-0 items-center justify-center text-[var(--tree-file-accent-fg)]">
          <CreateEntryIcon kind={draft.kind} size="sm" />
        </span>
        <input
          ref={inputRef}
          value={draft.name}
          disabled={draft.submitting}
          placeholder={draft.kind === 'folder' ? 'folder-name' : 'file-name.md'}
          onChange={(event) => onNameChange(event.target.value)}
          onBlur={() => {
            if (!draft.submitting && !draft.name.trim()) {
              onCancel();
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onSubmit();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              onCancel();
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-sm leading-5 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
        />
      </div>
      {draft.error ? (
        <div className="mt-1 px-8 text-[11px]" style={{ color: 'var(--danger, #d1435b)' }}>
          {draft.error}
        </div>
      ) : null}
    </div>
  );
}

function ProjectTreeNodeIcon({
  node,
  isExpanded,
}: {
  node: ProjectTreeNode;
  isExpanded: boolean;
}) {
  if (node.kind === 'dir') {
    return (
      <span className="flex h-4.5 w-4.5 shrink-0 items-center justify-center text-[var(--tree-file-accent-fg)]">
        {isExpanded ? <FolderOpen className="w-3.5 h-3.5" /> : <FolderClosed className="w-3.5 h-3.5" />}
      </span>
    );
  }

  return (
    <span className="flex h-4.5 w-4.5 flex-shrink-0 items-center justify-center" aria-hidden="true">
      <FileTypeIcon
        name={node.name}
        className="h-4 w-4"
        fallbackClassName="h-3.5 w-3.5 text-[var(--text-secondary)]"
      />
    </span>
  );
}
export function ProjectTreePanel({
  collapsed = false,
  activeTab,
  onClose,
  isFullscreen = false,
  onToggleFullscreen,
}: {
  collapsed?: boolean;
  activeTab: ProjectPanelTab;
  onClose: () => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
}) {
  const MIN_CHANGES_SPINNER_MS = 450;
  const panelMeta = PANEL_DIMENSIONS[activeTab];
  const PanelTitleIcon = activeTab === 'files' ? Files : FileDiff;
  const defaultRailWidth = panelMeta.defaultWidth;
  const minRailWidth = panelMeta.minWidth;
  const maxRailWidth = panelMeta.maxWidth;
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
    setBrowserPanelOpen,
    setProjectTreeCollapsed,
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
  const [externalDiskText, setExternalDiskText] = useState<string | null>(null);
  const copiedTimerRef = useRef<number | null>(null);
  const [copiedPath, setCopiedPath] = useState(false);
  const createDraftIdRef = useRef(0);
  const [createDraft, setCreateDraft] = useState<CreateDraftState | null>(null);
  const [projectTreeContextMenu, setProjectTreeContextMenu] = useState<ProjectTreeContextMenuState | null>(null);

  const [changeRecords, setChangeRecords] = useState<ChangeRecord[]>([]);
  const [changesError, setChangesError] = useState<string | null>(null);
  const [changesLoading, setChangesLoading] = useState(false);
  const [expandedChangeId, setExpandedChangeId] = useState<string | null>(null);

  const activeSession = activeSessionId ? sessions[activeSessionId] : null;
  const activeCwd = activeSession?.cwd || null;
  const cwd = activeCwd || projectCwd || null;
  const shouldWatchProjectTree = !collapsed && activeTab === 'files';
  const shouldRefreshChangeRecords = !collapsed && activeTab === 'changes';

  const loadChangeRecords = async () => {
    if (!cwd) return;
    const startedAt = Date.now();
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
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(MIN_CHANGES_SPINNER_MS - elapsed, 0);
      window.setTimeout(() => {
        setChangesLoading(false);
      }, remaining);
    }
  };

  // Reload changes when tab activates, cwd changes, or session messages update
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
    if (cwd && shouldRefreshChangeRecords) {
      void loadChangeRecords();
      return;
    }

    if (!cwd) {
      setChangeRecords([]);
      setChangesError(null);
    }
  }, [cwd, messageCount, sessionStatus, shouldRefreshChangeRecords]);

  useEffect(() => {
    latestPanelWidthRef.current = panelWidth;
  }, [panelWidth]);

  useEffect(() => {
    latestPreviewWidthRef.current = previewPanelWidth;
  }, [previewPanelWidth]);

  useEffect(() => {
    const storageKey = getProjectPanelWidthStorageKey(activeTab);
    const storedPanelWidth = parseStoredPanelWidth(
      window.localStorage.getItem(storageKey),
      minRailWidth,
      maxRailWidth
    );
    if (storedPanelWidth !== null) {
      setPanelWidth(storedPanelWidth);
      return;
    }

    if (activeTab === 'changes') {
      const legacyPanelWidth = parseStoredPanelWidth(
        window.localStorage.getItem(LEGACY_PROJECT_PANEL_WIDTH_STORAGE_KEY),
        minRailWidth,
        maxRailWidth
      );
      if (legacyPanelWidth !== null) {
        window.localStorage.setItem(storageKey, String(legacyPanelWidth));
        window.localStorage.removeItem(LEGACY_PROJECT_PANEL_WIDTH_STORAGE_KEY);
        setPanelWidth(legacyPanelWidth);
        return;
      }
    }

    setPanelWidth(defaultRailWidth);
  }, [activeTab, defaultRailWidth, minRailWidth, maxRailWidth]);

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

    if (!current || !shouldWatchProjectTree) {
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
  }, [cwd, setProjectTree, shouldWatchProjectTree]);

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
    setCreateDraft(null);
    setProjectTreeContextMenu(null);
    setChangeRecords([]);
    setChangesError(null);
    setExpandedChangeId(null);
  }, [cwd]);

  useEffect(() => {
    setPanelWidth((current) =>
      Math.min(maxRailWidth, Math.max(minRailWidth, current || defaultRailWidth))
    );
  }, [defaultRailWidth, minRailWidth, maxRailWidth]);

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

  const expandParentsForPath = useCallback((path: string) => {
    const parts = path.split('/').filter(Boolean);
    if (parts.length <= 1) return;

    setExpandedPaths((prev) => {
      const next = new Set(prev);
      let current = '';
      for (const part of parts.slice(0, -1)) {
        current = current ? `${current}/${part}` : part;
        next.add(current);
      }
      return next;
    });
  }, []);

  const expandPath = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      next.add(path);
      return next;
    });
  }, []);

  const getDefaultCreateParent = useCallback(() => {
    if (selectedFilePath) {
      return dirnameOfPath(selectedFilePath);
    }
    return visibleTree?.path || cwd || '';
  }, [cwd, selectedFilePath, visibleTree?.path]);

  const startCreateEntry = useCallback((parentPath: string, kind: CreateEntryKind) => {
    if (!cwd || !parentPath) return;
    setProjectTreeContextMenu(null);
    expandPath(parentPath);
    setCreateDraft({
      id: createDraftIdRef.current += 1,
      kind,
      parentPath,
      name: '',
      error: null,
      submitting: false,
    });
  }, [cwd, expandPath]);

  const cancelCreateEntry = useCallback(() => {
    setCreateDraft(null);
  }, []);

  const handleCreateDraftNameChange = useCallback((name: string) => {
    setCreateDraft((current) => current ? { ...current, name, error: null } : current);
  }, []);

  const selectFilePath = useCallback(async (filePath: string, fileName?: string, toggleSame = false) => {
    if (!cwd) return;

    // Toggle: 如果点击的是已选中的文件，取消选中
    if (toggleSame && selectedFilePath === filePath) {
      setSelectedFilePath(null);
      setSelectedPreview(null);
      return;
    }

    const name = fileName || filePath.split('/').filter(Boolean).pop() || filePath;

    if (isHtmlFilePath(filePath)) {
      const requestId = (previewRequestIdRef.current += 1);
      expandParentsForPath(filePath);
      setSelectedFilePath(null);
      setPreviewLoading(false);
      setSelectedPreview(null);
      setDraftText('');
      setSaveState('idle');
      setSaveError(null);
      setExternalDiskText(null);
      setPptxSlideIndex(0);

      if (!activeSessionId) {
        toast.error('No active session for browser preview.');
        return;
      }

      try {
        await openHtmlFileInBrowserTab({
          cwd,
          filePath,
          sessionId: activeSessionId,
        });
        if (previewRequestIdRef.current !== requestId) return;
        setBrowserPanelOpen(true);
        setProjectTreeCollapsed(true);
      } catch (error) {
        if (previewRequestIdRef.current !== requestId) return;
        toast.error(`Failed to open in browser panel: ${error}`);
      }
      return;
    }

    setSelectedFilePath(filePath);
    expandParentsForPath(filePath);
    setViewMode('view');
    setPreviewLoading(true);
    setSelectedPreview(null);
    setDraftText('');
    setSaveState('idle');
    setSaveError(null);
    setExternalDiskText(null);
    setPptxSlideIndex(0);

    const reader = window.electron.readProjectFilePreview;
    if (typeof reader !== 'function') {
      setPreviewLoading(false);
      setSelectedPreview({
        kind: 'error',
        path: filePath,
        name,
        ext: '',
        message:
          'File preview API is not available. Please restart the app (or re-run `npm run transpile:electron`).',
      });
      return;
    }

    const requestId = (previewRequestIdRef.current += 1);
    try {
      const preview = (await reader(cwd, filePath)) as ProjectFilePreview;
      if (previewRequestIdRef.current !== requestId) return;
      setSelectedPreview(preview);
      if ((preview.kind === 'text' || preview.kind === 'markdown') && preview.editable) {
        setDraftText(preview.text);
      }
    } catch (error) {
      if (previewRequestIdRef.current !== requestId) return;
      setSelectedPreview({
        kind: 'error',
        path: filePath,
        name,
        ext: '',
        message: String(error),
      });
    } finally {
      if (previewRequestIdRef.current === requestId) {
        setPreviewLoading(false);
      }
    }
  }, [
    activeSessionId,
    cwd,
    expandParentsForPath,
    selectedFilePath,
    setBrowserPanelOpen,
    setProjectTreeCollapsed,
  ]);

  const selectFile = async (node: ProjectTreeNode) => {
    if (node.kind !== 'file') return;
    await selectFilePath(node.path, node.name, true);
  };

  const submitCreateDraft = useCallback(async () => {
    if (!cwd || !createDraft) return;
    const trimmedName = createDraft.name.trim();
    if (!trimmedName) {
      setCreateDraft((current) => current ? { ...current, error: 'Name is required.' } : current);
      return;
    }

    setCreateDraft((current) => current ? { ...current, submitting: true, error: null } : current);

    try {
      const result = (
        createDraft.kind === 'folder'
          ? await window.electron.createProjectFolder(cwd, createDraft.parentPath, trimmedName)
          : await window.electron.createProjectFile(cwd, createDraft.parentPath, trimmedName)
      ) as ProjectEntryCreateResult;

      if (!result?.ok || !result.path || !result.tree) {
        setCreateDraft((current) =>
          current ? { ...current, submitting: false, error: result?.message || 'Failed to create.' } : current
        );
        return;
      }

      setProjectTree(cwd, result.tree);
      expandPath(createDraft.parentPath);
      if (createDraft.kind === 'folder') {
        expandPath(result.path);
      }
      setCreateDraft(null);
      toast.success(`${createDraft.kind === 'folder' ? 'Folder' : 'File'} created.`);

      if (createDraft.kind === 'file') {
        await selectFilePath(result.path, trimmedName, false);
      }
    } catch (error) {
      setCreateDraft((current) =>
        current ? { ...current, submitting: false, error: String(error) } : current
      );
    }
  }, [createDraft, cwd, expandPath, selectFilePath, setProjectTree]);

  const openProjectTreeContextMenu = useCallback((event: React.MouseEvent, node?: ProjectTreeNode) => {
    if (!cwd) return;
    event.preventDefault();
    event.stopPropagation();
    const parentPath = node
      ? node.kind === 'dir'
        ? node.path
        : dirnameOfPath(node.path)
      : visibleTree?.path || cwd;
    setProjectTreeContextMenu({
      x: event.clientX,
      y: event.clientY,
      parentPath,
    });
  }, [cwd, visibleTree?.path]);

  const selectExternalFilePath = useCallback(async (
    filePath: string,
    options: { lineStart?: number; lineEnd?: number } = {}
  ) => {
    const reader = window.electron.readProjectFilePreview;
    if (typeof reader !== 'function') return;

    const name = filePath.split('/').filter(Boolean).pop() || filePath;
    setSelectedFilePath(filePath);
    setViewMode('view');
    setPreviewLoading(true);
    setSelectedPreview(null);
    setDraftText('');
    setSaveState('idle');
    setSaveError(null);
    setExternalDiskText(null);
    setPptxSlideIndex(0);

    const requestId = (previewRequestIdRef.current += 1);
    try {
      const preview = (await reader(dirnameOfPath(filePath), filePath)) as ProjectFilePreview;
      if (previewRequestIdRef.current !== requestId) return;
      if (
        (preview.kind === 'text' || preview.kind === 'markdown' || preview.kind === 'html') &&
        typeof options.lineStart === 'number'
      ) {
        setSelectedPreview({
          kind: 'text',
          path: preview.path,
          name: `${preview.name} lines ${options.lineStart}${
            options.lineEnd && options.lineEnd !== options.lineStart ? `-${options.lineEnd}` : ''
          }`,
          ext: preview.ext,
          size: preview.size,
          text: sliceTextLineRange(preview.text, options.lineStart, options.lineEnd),
          editable: false,
        });
        return;
      }
      if (preview.kind === 'text' || preview.kind === 'markdown' || preview.kind === 'html') {
        setSelectedPreview({ ...preview, editable: false });
        return;
      }
      setSelectedPreview(preview);
    } catch (error) {
      if (previewRequestIdRef.current !== requestId) return;
      setSelectedPreview({
        kind: 'error',
        path: filePath,
        name,
        ext: '',
        message: String(error),
      });
    } finally {
      if (previewRequestIdRef.current === requestId) {
        setPreviewLoading(false);
      }
    }
  }, []);

  const closePreview = useCallback(() => {
    setSelectedFilePath(null);
    setSelectedPreview(null);
    setViewMode('view');
    setDraftText('');
    setSaveState('idle');
    setSaveError(null);
    setExternalDiskText(null);
    setPptxSlideIndex(0);
    if (isFullscreen && onToggleFullscreen) onToggleFullscreen();
  }, [isFullscreen, onToggleFullscreen]);

  useEffect(() => {
    const handleOpenProjectFile = (event: Event) => {
      const detail = (event as CustomEvent<{
        cwd?: string;
        path?: string;
        external?: boolean;
        lineStart?: number;
        lineEnd?: number;
      }>).detail;
      if (!detail?.path) return;
      if (detail.external) {
        void selectExternalFilePath(detail.path, {
          lineStart: detail.lineStart,
          lineEnd: detail.lineEnd,
        });
        return;
      }
      if (detail.cwd && cwd && detail.cwd !== cwd) return;
      void selectFilePath(detail.path, undefined, false);
    };

    window.addEventListener('aegis:open-project-file', handleOpenProjectFile);
    return () => window.removeEventListener('aegis:open-project-file', handleOpenProjectFile);
  }, [cwd, selectExternalFilePath, selectFilePath]);

  useEffect(() => {
    if (!projectTreeContextMenu) return;
    const closeMenu = () => setProjectTreeContextMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu();
      }
    };
    window.addEventListener('mousedown', closeMenu);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', closeMenu);
      window.removeEventListener('blur', closeMenu);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [projectTreeContextMenu]);

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
    const showPreview = !collapsed && selectedFilePath;
    root.style.setProperty(
      '--project-preview-space',
      showPreview ? `${previewPanelWidth}px` : '0px'
    );

    return () => {
      root.style.setProperty('--project-preview-space', '0px');
    };
  }, [collapsed, selectedFilePath, previewPanelWidth]);

  const canSaveText =
    !!cwd &&
    !!selectedPreview &&
    (selectedPreview.kind === 'text' || selectedPreview.kind === 'markdown') &&
    selectedPreview.editable &&
    draftText !== selectedPreview.text;

  const handleSaveText = async () => {
    if (!cwd) return;
    if (
      !selectedPreview ||
      (selectedPreview.kind !== 'text' && selectedPreview.kind !== 'markdown') ||
      !selectedPreview.editable
    ) {
      return;
    }
    if (!selectedFilePath) return;
    if (!canSaveText) return;

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
      setExternalDiskText(null);
      void loadChangeRecords();
      setSaveState('saved');
      window.setTimeout(() => setSaveState('idle'), 1200);
    } catch (error) {
      setSaveState('error');
      setSaveError(String(error));
    }
  };

  useEffect(() => {
    if (
      !selectedPreview ||
      selectedPreview.kind !== 'markdown' ||
      !selectedPreview.editable ||
      !canSaveText ||
      externalDiskText !== null ||
      saveState === 'saving'
    ) {
      return;
    }

    const timerId = window.setTimeout(() => {
      void handleSaveText();
    }, 1200);

    return () => window.clearTimeout(timerId);
  }, [canSaveText, draftText, externalDiskText, saveState, selectedPreview]);

  useEffect(() => {
    if (
      !cwd ||
      !selectedFilePath ||
      !selectedPreview ||
      selectedPreview.kind !== 'markdown' ||
      !selectedPreview.editable
    ) {
      return;
    }

    const reader = window.electron.readProjectFilePreview;
    if (typeof reader !== 'function') return;

    const intervalId = window.setInterval(() => {
      void (async () => {
        try {
          const latest = (await reader(cwd, selectedFilePath)) as ProjectFilePreview;
          if (latest.kind !== 'markdown' || !latest.editable) return;
          if (latest.text === selectedPreview.text) return;

          if (draftText === selectedPreview.text) {
            setSelectedPreview(latest);
            setDraftText(latest.text);
            setExternalDiskText(null);
          } else {
            setExternalDiskText(latest.text);
          }
        } catch {
          // Polling is only a conflict detector; preview load/save surfaces real errors.
        }
      })();
    }, 4000);

    return () => window.clearInterval(intervalId);
  }, [cwd, draftText, selectedFilePath, selectedPreview]);

  const handleReloadMarkdownExternal = () => {
    if (
      !selectedPreview ||
      selectedPreview.kind !== 'markdown' ||
      externalDiskText === null
    ) {
      return;
    }

    setSelectedPreview({ ...selectedPreview, text: externalDiskText });
    setDraftText(externalDiskText);
    setExternalDiskText(null);
    setSaveState('idle');
    setSaveError(null);
  };

  const handleKeepMarkdownLocal = () => {
    if (
      !selectedPreview ||
      selectedPreview.kind !== 'markdown' ||
      externalDiskText === null
    ) {
      return;
    }

    setSelectedPreview({ ...selectedPreview, text: externalDiskText });
    setExternalDiskText(null);
    setSaveState('idle');
    setSaveError(null);
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
      getProjectPanelWidthStorageKey(activeTab),
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

  // Esc exits fullscreen. Only binds when in fullscreen so we don't swallow
  // Escape elsewhere.
  useEffect(() => {
    if (!isFullscreen || !onToggleFullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onToggleFullscreen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFullscreen, onToggleFullscreen]);

  // Fullscreen is only meaningful while a preview is open. If the preview goes
  // away for any reason (e.g. active session change resets selection), exit
  // fullscreen so the panel collapses back to its rail width instead of sitting
  // expanded with just the file tree.
  useEffect(() => {
    if (isFullscreen && !selectedFilePath && onToggleFullscreen) {
      onToggleFullscreen();
    }
  }, [isFullscreen, selectedFilePath, onToggleFullscreen]);

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

  const isCodePreviewSurface =
    !previewLoading &&
    !!selectedPreview &&
    (
      (selectedPreview.kind === 'markdown' && viewMode === 'code') ||
      (selectedPreview.kind === 'html' && viewMode === 'code') ||
      (selectedPreview.kind === 'text' && !selectedPreview.editable)
    );
  const isMarkdownCodePreviewSurface =
    !previewLoading &&
    selectedPreview?.kind === 'markdown' &&
    viewMode === 'code';
  const isMarkdownPreviewSurface =
    !previewLoading &&
    selectedPreview?.kind === 'markdown' &&
    viewMode === 'view';
  const isEditableMarkdownPreview =
    isMarkdownPreviewSurface &&
    selectedPreview?.editable &&
    !!cwd &&
    !!selectedFilePath;

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
        className={`aegis-project-panel relative flex h-full flex-col border-l border-[var(--tree-item-border)] bg-[var(--bg-primary)] transition-[width,opacity,transform,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          isFullscreen ? 'flex-1 min-w-0' : 'flex-shrink-0'
        } ${collapsed && !isFullscreen ? 'pointer-events-none' : ''}`}
        style={
          isFullscreen
            ? {
                width: 'auto',
                opacity: 1,
                transform: 'translateX(0)',
                borderLeftWidth: 1,
              }
            : {
                width: collapsed ? 0 : panelWidth,
                opacity: collapsed ? 0 : 1,
                transform: collapsed ? 'translateX(18px)' : 'translateX(0)',
                borderLeftWidth: collapsed ? 0 : 1,
              }
        }
        aria-hidden={collapsed && !isFullscreen}
      >
        {!selectedFilePath && !isFullscreen && (
          <div
            className="group absolute left-0 top-0 bottom-0 z-10 w-3 -translate-x-1/2 cursor-col-resize no-drag"
            onMouseDown={handlePanelResizeStart}
          >
            <div className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 bg-transparent group-hover:bg-[var(--border)]" />
          </div>
        )}
        {!selectedFilePath && <div className="h-8 drag-region flex-shrink-0 bg-[var(--bg-primary)]" />}
        <div className="pl-4 pr-2 pt-2 pb-2">
          <div className="flex items-center justify-between gap-2">
            <div
              className="flex h-7 w-7 shrink-0 items-center justify-center text-[var(--text-muted)]"
              title={panelMeta.title}
              role="img"
              aria-label={`${panelMeta.title} panel`}
            >
              <PanelTitleIcon className="h-3.5 w-3.5" aria-hidden="true" />
            </div>
            {activeTab === 'files' && (
              <div className="flex items-center gap-0.5">
                <IconButton
                  label="New file"
                  size="sm"
                  onClick={() => startCreateEntry(getDefaultCreateParent(), 'file')}
                  disabled={!cwd}
                >
                  <CreateEntryIcon kind="file" />
                </IconButton>
                <IconButton
                  label="New folder"
                  size="sm"
                  onClick={() => startCreateEntry(getDefaultCreateParent(), 'folder')}
                  disabled={!cwd}
                >
                  <CreateEntryIcon kind="folder" />
                </IconButton>
              </div>
            )}
            {activeTab === 'changes' && (
              <IconButton
                label="Refresh changes"
                size="sm"
                onClick={() => void loadChangeRecords()}
                disabled={changesLoading}
                className={changesLoading ? 'cursor-wait bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : undefined}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${changesLoading ? 'animate-spin' : ''}`} />
              </IconButton>
            )}
          </div>
          {!cwd && (
            <div className="text-xs text-[var(--text-muted)] mt-1">No folder selected</div>
          )}
        </div>

        <div className="flex-1 min-h-0 flex">
          <div
            className="flex-1 overflow-auto px-3 pb-3"
            onContextMenu={(event) => {
              if (activeTab === 'files' && cwd) {
                openProjectTreeContextMenu(event);
              }
            }}
          >
            {activeTab === 'files' && (
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
                    {createDraft?.parentPath === visibleTree.path ? (
                      <CreateEntryRow
                        depth={0}
                        draft={createDraft}
                        onNameChange={handleCreateDraftNameChange}
                        onSubmit={submitCreateDraft}
                        onCancel={cancelCreateEntry}
                      />
                    ) : null}
                    {visibleNodes.map((node) => (
                      <TreeNode
                        key={node.path}
                        node={node}
                        depth={0}
                        expandedPaths={expandedPaths}
                        onToggle={togglePath}
                        onSelectFile={selectFile}
                        onOpenContextMenu={openProjectTreeContextMenu}
                        selectedFilePath={selectedFilePath}
                        forceExpand={false}
                        createDraft={createDraft}
                        onCreateDraftNameChange={handleCreateDraftNameChange}
                        onSubmitCreateDraft={submitCreateDraft}
                        onCancelCreateDraft={cancelCreateEntry}
                      />
                    ))}
                  </>
                )}
                {cwd && visibleTree && visibleNodes.length === 0 && createDraft?.parentPath === visibleTree.path && (
                  <CreateEntryRow
                    depth={0}
                    draft={createDraft}
                    onNameChange={handleCreateDraftNameChange}
                    onSubmit={submitCreateDraft}
                    onCancel={cancelCreateEntry}
                  />
                )}
                {cwd && !loading && (!visibleTree || visibleNodes.length === 0) && !createDraft && (
                  <div className="text-sm text-[var(--text-muted)] px-1 py-2">
                    No files found.
                  </div>
                )}
              </>
            )}
            {activeTab === 'changes' && (
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

        {projectTreeContextMenu && activeTab === 'files' && (
          <div
            className="fixed z-[80] min-w-[168px] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] py-1 shadow-[0_18px_42px_rgba(15,23,42,0.18)]"
            style={{ left: projectTreeContextMenu.x, top: projectTreeContextMenu.y }}
            onMouseDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            <button
              type="button"
              onClick={() => startCreateEntry(projectTreeContextMenu.parentPath, 'file')}
              className="group flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
            >
              <span className="inline-flex">
                <CreateEntryIcon kind="file" size="sm" />
              </span>
              <span>New File</span>
            </button>
            <button
              type="button"
              onClick={() => startCreateEntry(projectTreeContextMenu.parentPath, 'folder')}
              className="group flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
            >
              <span className="inline-flex">
                <CreateEntryIcon kind="folder" size="sm" />
              </span>
              <span>New Folder</span>
            </button>
          </div>
        )}

        {selectedFilePath && (
          <div
            className="absolute inset-y-0 z-20 border-l border-[var(--tree-item-border)] bg-[var(--bg-primary)] shadow-[-12px_0_32px_rgba(0,0,0,0.08)]"
            style={
              isFullscreen
                ? { left: 0, right: 0, width: 'auto' }
                : { right: 'calc(100% - 1px)', width: previewPanelWidth }
            }
          >
            {!isFullscreen && (
              <div
                className="group absolute left-0 top-0 bottom-0 w-3 -translate-x-1/2 cursor-col-resize no-drag"
                onMouseDown={handlePreviewResizeStart}
              >
                <div className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 bg-transparent group-hover:bg-[var(--border)]" />
              </div>
            )}

            <div className={`h-full min-w-0 flex flex-col ${isEditableMarkdownPreview ? '' : 'px-3 py-3'}`}>
              {isEditableMarkdownPreview ? (
                <div
                  className={`flex h-10 flex-shrink-0 items-center justify-end gap-2 border-b border-[var(--border)]/60 bg-[var(--bg-primary)] px-4 ${
                    isFullscreen ? 'drag-region' : 'no-drag'
                  }`}
                >
                  <div className="flex items-center gap-2 no-drag">
                    {onToggleFullscreen && (
                      <IconButton
                        onClick={onToggleFullscreen}
                        tooltip={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
                        label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                      >
                        {isFullscreen ? (
                          <Minimize2 className="w-4 h-4" />
                        ) : (
                          <Maximize2 className="w-4 h-4" />
                        )}
                      </IconButton>
                    )}
                    <IconButton
                      onClick={closePreview}
                      label="Close preview"
                    >
                      <X className="w-4 h-4" />
                    </IconButton>
                  </div>
                </div>
              ) : (
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
                    <ViewModeToggle value={viewMode} onChange={setViewMode} />
                  )}

                  {canSaveText && (
                    <button
                      onClick={handleSaveText}
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

                  {onToggleFullscreen && (
                    <IconButton
                      onClick={onToggleFullscreen}
                      tooltip={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
                      label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                    >
                      {isFullscreen ? (
                        <Minimize2 className="w-4 h-4" />
                      ) : (
                        <Maximize2 className="w-4 h-4" />
                      )}
                    </IconButton>
                  )}
                  <IconButton
                    onClick={closePreview}
                    label="Close preview"
                  >
                    <X className="w-4 h-4" />
                  </IconButton>
                  <IconButton
                    onClick={() => handleCopyPath(selectedFilePath)}
                    tooltip={copiedPath ? 'Copied' : 'Copy path'}
                    label="Copy path"
                  >
                    {copiedPath ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </IconButton>
                </div>
                </div>
              )}

              <div
                className={`flex-1 min-h-0 overflow-auto ${
                  isMarkdownCodePreviewSurface
                    ? 'bg-[var(--bg-primary)] p-0'
                    : isCodePreviewSurface
                    ? 'rounded-lg border border-[var(--border)] bg-[var(--code-block-bg)] p-0'
                    : isMarkdownPreviewSurface
                      ? 'bg-[var(--bg-primary)] p-0'
                    : 'rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-3'
                }`}
              >
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
                  selectedPreview.editable && cwd && selectedFilePath ? (
                    <ProjectMarkdownEditor
                      value={draftText}
                      cwd={cwd}
                      filePath={selectedFilePath}
                      fileName={selectedPreview.name}
                      hideTitleBar
                      saveState={saveState}
                      saveError={saveError}
                      externalChange={externalDiskText !== null}
                      onChange={setDraftText}
                      onSave={handleSaveText}
                      onReloadExternal={handleReloadMarkdownExternal}
                      onKeepLocal={handleKeepMarkdownLocal}
                    />
                  ) : (
                    <MDContent
                      content={selectedPreview.text}
                      allowHtml={false}
                      className="project-markdown-preview"
                    />
                  )
                )}

                {!previewLoading && selectedPreview?.kind === 'html' && (
                  viewMode === 'code' ? (
                    <HighlightedCode
                      code={selectedPreview.text}
                      language="html"
                      className="min-h-full rounded-none"
                    />
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
                      <HighlightedCode
                        code={selectedPreview.text}
                        fileName={selectedPreview.name}
                        className="min-h-full rounded-none"
                      />
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
      if (preview.previewUrl) {
        setPdfUrl(preview.previewUrl);
        setPdfError(null);
        return;
      }

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
  }, [preview.dataBase64, preview.dataUrl, preview.path, preview.previewUrl]);

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
    <div className="mb-1 border-b border-[var(--border)]/25 px-1 py-2">
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
  const canExpand = !!entry.diffContent;

  return (
    <div className="border-b border-[var(--border)]/25 last:border-b-0">
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
        <span className="mt-0.5 flex h-4.5 w-4.5 flex-shrink-0 items-center justify-center" aria-hidden="true">
          <FileTypeIcon
            name={entry.fileName}
            className="h-4 w-4"
            fallbackClassName="h-3.5 w-3.5 text-[var(--text-secondary)]"
          />
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
        <div className="border-t border-[var(--border)]/25 bg-[var(--bg-secondary)]/12 px-1 pb-2 pt-2">
          {entry.diffContent ? (
            <div className="overflow-auto border border-[var(--border)]/50 bg-[var(--preview-surface)]">
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

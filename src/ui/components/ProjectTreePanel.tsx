import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { FolderClosed, FolderOpen, ChevronDown, ChevronLeft, ChevronRight, Copy, Check, X, Maximize2, Minimize2, File, Files, FileAddIcon, FolderAddIcon } from './icons';
import { pptxToHtml } from '@jvmr/pptx-to-html';
import { toast } from 'sonner';
import { useAppStore } from '../store/useAppStore';
import { MDContent } from '../render/markdown';
import { HighlightedCode } from './HighlightedCode';
import TextFileReader from './TextFileReader';
import { FileTypeIcon } from './FileTypeIcon';
import { ProjectMarkdownEditor, type ProjectMarkdownEditorBridge } from './ProjectMarkdownEditor';
import { ProjectMdxPreview, ProjectMdxProperties, parseMdxDocument } from './ProjectMdxPreview';
import { ProjectTextEditor, type ProjectTextEditorHandle } from './ProjectTextEditor';
import { IconButton } from './ui/icon-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import {
  isHtmlFilePath,
  openUrlInBrowserSession,
  resolveHtmlPreviewUrl,
} from '../utils/html-preview';
import { getBrowserUtilitySessionId } from '../utils/browser-utility';
import {
  copyMarkdownAsWechatAiHtml,
  copyMarkdownAsWechatHtml,
  type WeChatAiThemeId,
  type WeChatStaticThemeId,
} from '../lib/wechatMarkdown';
import type { ProjectTreeNode, ProjectUtilityPanelKind, ProjectUtilityPanelTarget } from '../types';

type ProjectPanelTab = 'files';
type ViewMode = 'view' | 'code' | 'split';
type ProjectEditorFlushResult = { ok: boolean; message?: string };
type ProjectPanelDimensions = {
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  title: string;
};

const PANEL_DIMENSIONS: Record<ProjectPanelTab, ProjectPanelDimensions> = {
  files: { defaultWidth: 300, minWidth: 240, maxWidth: 520, title: 'Files' },
};

const LEGACY_PROJECT_PANEL_WIDTH_STORAGE_KEY = 'cowork.projectPanelWidth';
const getProjectPanelWidthStorageKey = (tab: ProjectPanelTab) =>
  `${LEGACY_PROJECT_PANEL_WIDTH_STORAGE_KEY}.${tab}`;
const PROJECT_ENTRY_DRAG_MIME = 'application/x-aegis-project-entry';
const PROJECT_TREE_INDENT_PX = 18;
const PROJECT_TREE_ROW_PADDING_LEFT_PX = 4;
const PROJECT_TREE_GUIDE_OFFSET_PX = 12;

function parseStoredPanelWidth(
  stored: string | null,
  minWidth: number,
  maxWidth: number,
  fallbackWidth?: number
) {
  if (!stored) return null;
  const parsed = Number(stored);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < minWidth && typeof fallbackWidth === 'number') return fallbackWidth;
  return Math.min(maxWidth, Math.max(minWidth, parsed));
}

type ProjectFilePreview =
  | {
      kind: 'text' | 'markdown' | 'html';
      path: string;
      name: string;
      ext: string;
      size: number;
      mtimeMs: number;
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

type EditableProjectFilePreview = {
  kind: 'markdown' | 'text';
  path: string;
  name: string;
  ext: string;
  size: number;
  mtimeMs: number;
  text: string;
  editable: true;
};
type ProjectEditorViewState = {
  selectionFrom: number;
  selectionTo: number;
  scrollTop: number;
};
type OpenProjectFileTab = {
  id: string;
  cwd: string;
  filePath: string;
  name: string;
  ext: string;
  kind: 'markdown' | 'text';
  preview: EditableProjectFilePreview;
  draftText: string;
  viewMode: ViewMode;
  viewState: ProjectEditorViewState | null;
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
type ProjectEntryMoveResult = ProjectEntryCreateResult;
type ProjectDraggedEntry = Pick<ProjectTreeNode, 'kind' | 'name' | 'path'>;

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

function normalizeProjectPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

function dirnameOfPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index > 0 ? normalized.slice(0, index) : '.';
}

function basenameOfPath(filePath: string): string {
  const normalized = normalizeProjectPath(filePath);
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || normalized || 'Project';
}

function getProjectFileTabId(cwd: string, filePath: string): string {
  return `${normalizeProjectPath(cwd)}::${normalizeProjectPath(filePath)}`;
}

function isEditableProjectFilePreview(preview: ProjectFilePreview | null): preview is EditableProjectFilePreview {
  return (
    !!preview &&
    (preview.kind === 'markdown' || preview.kind === 'text') &&
    preview.editable
  );
}

function isSameProjectPath(left: string, right: string): boolean {
  return normalizeProjectPath(left) === normalizeProjectPath(right);
}

function isPathInsideProjectPath(path: string, parentPath: string): boolean {
  const normalizedPath = normalizeProjectPath(path);
  const normalizedParent = normalizeProjectPath(parentPath);
  const parentPrefix = normalizedParent.endsWith('/') ? normalizedParent : `${normalizedParent}/`;
  return normalizedPath !== normalizedParent && normalizedPath.startsWith(parentPrefix);
}

function readDraggedProjectEntry(event: DragEvent<HTMLElement>): ProjectDraggedEntry | null {
  const raw = event.dataTransfer.getData(PROJECT_ENTRY_DRAG_MIME);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<ProjectDraggedEntry>;
    if (
      typeof parsed.path === 'string' &&
      typeof parsed.name === 'string' &&
      (parsed.kind === 'file' || parsed.kind === 'dir')
    ) {
      return {
        path: parsed.path,
        name: parsed.name,
        kind: parsed.kind,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function getNodeDropHoverId(path: string): string {
  return `node:${normalizeProjectPath(path)}`;
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
  parentPath,
  expandedPaths,
  onToggle,
  onSelectFile,
  onOpenContextMenu,
  onProjectEntryDragStart,
  onProjectEntryDragEnd,
  onTreeNodeDragOver,
  onTreeNodeDragLeave,
  onTreeNodeDrop,
  canDropEntryOnParent,
  selectedFilePath,
  draggedEntry,
  dropHoverId,
  movingEntryPath,
  forceExpand,
  createDraft,
  onCreateDraftNameChange,
  onSubmitCreateDraft,
  onCancelCreateDraft,
}: {
  node: ProjectTreeNode;
  depth: number;
  parentPath: string | null;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
  onSelectFile: (node: ProjectTreeNode) => void;
  onOpenContextMenu: (event: React.MouseEvent, node: ProjectTreeNode) => void;
  onProjectEntryDragStart: (event: DragEvent<HTMLDivElement>, node: ProjectTreeNode) => void;
  onProjectEntryDragEnd: () => void;
  onTreeNodeDragOver: (event: DragEvent<HTMLElement>, node: ProjectTreeNode, parentPath: string | null) => void;
  onTreeNodeDragLeave: (event: DragEvent<HTMLElement>, node: ProjectTreeNode, parentPath: string | null) => void;
  onTreeNodeDrop: (event: DragEvent<HTMLElement>, node: ProjectTreeNode, parentPath: string | null) => void;
  canDropEntryOnParent: (entry: ProjectDraggedEntry, targetParentPath: string) => boolean;
  selectedFilePath: string | null;
  draggedEntry: ProjectDraggedEntry | null;
  dropHoverId: string | null;
  movingEntryPath: string | null;
  forceExpand: boolean;
  createDraft: CreateDraftState | null;
  onCreateDraftNameChange: (name: string) => void;
  onSubmitCreateDraft: () => void;
  onCancelCreateDraft: () => void;
}) {
  const isDir = node.kind === 'dir';
  const isExpanded = forceExpand || expandedPaths.has(node.path);
  const isSelected = !isDir && !!selectedFilePath && node.path === selectedFilePath;
  const isDragSource = !!draggedEntry && isSameProjectPath(draggedEntry.path, node.path);
  const isMoving = !!movingEntryPath && isSameProjectPath(movingEntryPath, node.path);
  // The drop target a hover on this row resolves to: dirs target themselves; files target their parent dir.
  const resolvedTargetPath: string | null = isDir
    ? node.path
    : parentPath || null;
  const canAcceptDrop =
    !!draggedEntry &&
    !!resolvedTargetPath &&
    canDropEntryOnParent(draggedEntry, resolvedTargetPath);
  // Files highlight their parent dir row; dirs highlight themselves.
  const isDropTarget =
    isDir &&
    canAcceptDrop &&
    dropHoverId === getNodeDropHoverId(node.path);

  // Hover-to-expand: when a collapsed dir is the active drop target, expand it after a short delay.
  useEffect(() => {
    if (!isDir || isExpanded) return;
    if (!canAcceptDrop) return;
    if (dropHoverId !== getNodeDropHoverId(node.path)) return;
    const timer = window.setTimeout(() => {
      onToggle(node.path);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [isDir, isExpanded, canAcceptDrop, dropHoverId, node.path, onToggle]);

  return (
    <div>
      <div
        className={`group/project-tree-row flex min-h-[26px] items-center gap-2 rounded-[5px] px-1.5 py-[2px] text-[13px] transition-[background-color,color,box-shadow,opacity] duration-150 hover:bg-[var(--tree-item-hover)] ${
          isSelected ? 'bg-[var(--tree-item-active)] shadow-[inset_0_0_0_1px_var(--tree-item-border)]' : ''
        } ${isDropTarget ? 'bg-[var(--tree-item-active)] shadow-[inset_0_0_0_1px_var(--tree-file-accent-fg)]' : ''} ${
          isDragSource || isMoving ? 'opacity-50' : ''
        } ${!isDir ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'}`}
        style={{
          paddingLeft: PROJECT_TREE_ROW_PADDING_LEFT_PX + depth * PROJECT_TREE_INDENT_PX,
        }}
        draggable={!isMoving}
        onDragStart={(event) => onProjectEntryDragStart(event, node)}
        onDragEnd={onProjectEntryDragEnd}
        onDragOver={(event) => onTreeNodeDragOver(event, node, parentPath)}
        onDragLeave={(event) => onTreeNodeDragLeave(event, node, parentPath)}
        onDrop={(event) => onTreeNodeDrop(event, node, parentPath)}
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
        aria-expanded={isDir ? isExpanded : undefined}
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
        <ProjectTreeNodeIcon node={node} isExpanded={isExpanded} />
        <span
          className={`min-w-0 truncate leading-[22px] ${isDir ? 'font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}
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
      {isDir && isExpanded && node.children?.length ? (
        <div className="relative">
          <span
            className="pointer-events-none absolute bottom-1 top-0 w-px bg-[var(--tree-item-border)] opacity-[0.55]"
            style={{
              left:
                PROJECT_TREE_ROW_PADDING_LEFT_PX +
                depth * PROJECT_TREE_INDENT_PX +
                PROJECT_TREE_GUIDE_OFFSET_PX,
            }}
            aria-hidden="true"
          />
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              parentPath={node.path}
              expandedPaths={expandedPaths}
              onToggle={onToggle}
              onSelectFile={onSelectFile}
              onOpenContextMenu={onOpenContextMenu}
              onProjectEntryDragStart={onProjectEntryDragStart}
              onProjectEntryDragEnd={onProjectEntryDragEnd}
              onTreeNodeDragOver={onTreeNodeDragOver}
              onTreeNodeDragLeave={onTreeNodeDragLeave}
              onTreeNodeDrop={onTreeNodeDrop}
              canDropEntryOnParent={canDropEntryOnParent}
              selectedFilePath={selectedFilePath}
              draggedEntry={draggedEntry}
              dropHoverId={dropHoverId}
              movingEntryPath={movingEntryPath}
              forceExpand={forceExpand}
              createDraft={createDraft}
              onCreateDraftNameChange={onCreateDraftNameChange}
              onSubmitCreateDraft={onSubmitCreateDraft}
              onCancelCreateDraft={onCancelCreateDraft}
            />
          ))}
        </div>
      ) : null}
    </div>
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
    <div
      className="py-[1px]"
      style={{
        paddingLeft: PROJECT_TREE_ROW_PADDING_LEFT_PX + depth * PROJECT_TREE_INDENT_PX,
      }}
    >
      <div className="flex min-h-[26px] items-center gap-2 rounded-[5px] bg-[var(--tree-item-active)] px-1.5 shadow-[inset_0_0_0_1px_var(--tree-item-border)]">
        <span className="group flex h-[18px] w-[18px] shrink-0 items-center justify-center text-[var(--tree-file-accent-fg)]">
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
          className="min-w-0 flex-1 bg-transparent text-[13px] leading-[22px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
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
      <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-[var(--tree-file-accent-fg)]">
        {isExpanded ? <FolderOpen className="h-4 w-4" stroke={1.75} /> : <FolderClosed className="h-4 w-4" stroke={1.75} />}
      </span>
    );
  }

  return (
    <span className="flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center" aria-hidden="true">
      <FileTypeIcon
        name={node.name}
        className="h-4 w-4 opacity-90"
        fallbackClassName="h-4 w-4 text-[var(--text-secondary)]"
      />
    </span>
  );
}

export function ProjectTreePanel({
  collapsed = false,
  activeTab,
  onClose,
  onActiveFileTabChange,
  sharedPanelWidth,
  onSharedPanelWidthChange,
  onOpenUtilityTab,
  isFullscreen = false,
  onToggleFullscreen,
  topInset = 0,
  embedded = false,
}: {
  collapsed?: boolean;
  activeTab: ProjectPanelTab;
  onClose: () => void;
  onActiveFileTabChange?: (file: { filePath: string; name: string } | null) => void;
  sharedPanelWidth?: number;
  onSharedPanelWidthChange?: (width: number) => void;
  onOpenUtilityTab?: (target: ProjectUtilityPanelKind) => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  topInset?: number;
  embedded?: boolean;
}) {
  const panelMeta = PANEL_DIMENSIONS[activeTab];
  const PanelTitleIcon = Files;
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
  const [projectTreeError, setProjectTreeError] = useState<string | null>(null);
  const prevCwdRef = useRef<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const initRootRef = useRef<string | null>(null);
  const [panelWidth, setPanelWidth] = useState(defaultRailWidth);
  const panelResizingRef = useRef(false);
  const [isPanelResizing, setIsPanelResizing] = useState(false);
  const panelStartXRef = useRef(0);
  const panelStartWidthRef = useRef(defaultRailWidth);
  const latestPanelWidthRef = useRef(defaultRailWidth);
  const panelResizingSharedWidthRef = useRef(false);
  const [previewPanelWidth, setPreviewPanelWidth] = useState(defaultPreviewWidth);
  const previewResizingRef = useRef(false);
  const [isPreviewResizing, setIsPreviewResizing] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const latestPreviewWidthRef = useRef(previewPanelWidth);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedFileCwd, setSelectedFileCwd] = useState<string | null>(null);
  const [selectedPreview, setSelectedPreview] = useState<ProjectFilePreview | null>(null);
  const [openFileTabs, setOpenFileTabs] = useState<OpenProjectFileTab[]>([]);
  const openFileTabsRef = useRef<OpenProjectFileTab[]>([]);
  const [pptxSlideIndex, setPptxSlideIndex] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>('view');
  const [mdxRevealTarget, setMdxRevealTarget] = useState<{ line: number; token: number } | null>(null);
  const mdxRevealTokenRef = useRef(0);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewRequestIdRef = useRef(0);
  const [draftText, setDraftText] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const draftTextRef = useRef('');
  const saveErrorRef = useRef<string | null>(null);
  const saveStateRef = useRef<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const selectedEditableTextPreviewRef = useRef<ProjectFilePreview | null>(null);
  const activeMarkdownBridgeRef = useRef<ProjectMarkdownEditorBridge | null>(null);
  const activeTextEditorBridgeRef = useRef<ProjectTextEditorHandle | null>(null);
  const [wechatAiGeneratingTheme, setWechatAiGeneratingTheme] = useState<WeChatAiThemeId | null>(null);
  const normalizedSharedPanelWidth =
    typeof sharedPanelWidth === 'number' && Number.isFinite(sharedPanelWidth)
      ? sharedPanelWidth
      : null;
  const usesSharedPanelWidth =
    normalizedSharedPanelWidth !== null &&
    !isFullscreen;
  const visiblePanelWidth =
    normalizedSharedPanelWidth !== null && !isFullscreen && !selectedFilePath
      ? normalizedSharedPanelWidth
      : panelWidth;
  const useEmbeddedFilesGrid = embedded && activeTab === 'files';
  const projectRailWidth = Math.min(maxRailWidth, Math.max(minRailWidth, panelWidth));
  const projectPreviewViewportWidth = Math.max(
    minPreviewWidth,
    (normalizedSharedPanelWidth ?? projectRailWidth + previewPanelWidth) - projectRailWidth
  );
  // Every disk content we have loaded, saved, or applied for the open file.
  // The watcher only treats an event as a genuine external change when its
  // content is NOT in this set. A set (not a single value) is required because
  // the editor's serialization jitters between keystrokes and autosave writes
  // several variants, while watcher events arrive debounced and out of order.
  const knownDiskContentsRef = useRef<Set<string>>(new Set());
  const rememberDiskContent = useCallback((text: string) => {
    const set = knownDiskContentsRef.current;
    set.add(text);
    if (set.size > 64) {
      const oldest = set.values().next().value;
      if (oldest !== undefined) set.delete(oldest);
    }
  }, []);
  const pendingExternalReloadRef = useRef<{
    cwd: string;
    filePath: string;
    text: string;
    mtimeMs: number;
    size: number;
    exists: boolean;
  } | null>(null);
  const saveInFlightRef = useRef(false);
  const saveAgainAfterInFlightRef = useRef(false);
  const savePromiseRef = useRef<Promise<boolean> | null>(null);
  const projectEditorFlushRef = useRef<() => Promise<ProjectEditorFlushResult>>(async () => ({ ok: true }));
  const updateOpenFileTabs = useCallback((updater: (current: OpenProjectFileTab[]) => OpenProjectFileTab[]) => {
    setOpenFileTabs((current) => {
      const next = updater(current);
      openFileTabsRef.current = next;
      return next;
    });
  }, []);
  const setDraftTextSynced = useCallback((next: string) => {
    draftTextRef.current = next;
    if (saveInFlightRef.current) {
      saveAgainAfterInFlightRef.current = true;
    }
    setDraftText(next);
  }, []);
  const mirrorProjectEditorDraftSync = useCallback(
    (next: string) => {
      const preview = selectedEditableTextPreviewRef.current;
      if (
        selectedFileCwd &&
        selectedFilePath &&
        preview &&
        (preview.kind === 'markdown' || preview.kind === 'text') &&
        preview.editable &&
        next !== preview.text
      ) {
        window.electron.commitProjectEditorDraftSync?.({
          cwd: selectedFileCwd,
          filePath: selectedFilePath,
          content: next,
        });
        return;
      }
      window.electron.commitProjectEditorDraftSync?.(null);
    },
    [selectedFileCwd, selectedFilePath]
  );
  const handleDraftTextChange = useCallback(
    (next: string) => {
      setDraftTextSynced(next);
      mirrorProjectEditorDraftSync(next);
      if (selectedFileCwd && selectedFilePath) {
        const tabId = getProjectFileTabId(selectedFileCwd, selectedFilePath);
        updateOpenFileTabs((current) =>
          current.map((tab) =>
            tab.id === tabId
              ? { ...tab, draftText: next }
              : tab
          )
        );
      }
    },
    [mirrorProjectEditorDraftSync, selectedFileCwd, selectedFilePath, setDraftTextSynced, updateOpenFileTabs]
  );
  const setSaveStateSynced = useCallback((next: 'idle' | 'saving' | 'saved' | 'error') => {
    saveStateRef.current = next;
    setSaveState(next);
  }, []);
  const setSaveErrorSynced = useCallback((next: string | null) => {
    saveErrorRef.current = next;
    setSaveError(next);
  }, []);
  const registerMarkdownBridge = useCallback((bridge: ProjectMarkdownEditorBridge | null) => {
    activeMarkdownBridgeRef.current = bridge;
  }, []);
  const registerTextEditorBridge = useCallback((bridge: ProjectTextEditorHandle | null) => {
    activeTextEditorBridgeRef.current = bridge;
  }, []);
  const copiedTimerRef = useRef<number | null>(null);
  const [copiedPath, setCopiedPath] = useState(false);
  const createDraftIdRef = useRef(0);
  const [createDraft, setCreateDraft] = useState<CreateDraftState | null>(null);
  const [draggedProjectEntry, setDraggedProjectEntry] = useState<ProjectDraggedEntry | null>(null);
  const draggedProjectEntryRef = useRef<ProjectDraggedEntry | null>(null);
  const [projectDropHoverId, setProjectDropHoverId] = useState<string | null>(null);
  const [movingProjectEntryPath, setMovingProjectEntryPath] = useState<string | null>(null);

  const activeSession = activeSessionId ? sessions[activeSessionId] : null;
  const activeCwd = activeSession?.cwd || null;
  const cwd = activeCwd || projectCwd || null;
  const activeFileTabId = selectedFileCwd && selectedFilePath
    ? getProjectFileTabId(selectedFileCwd, selectedFilePath)
    : null;
  const activeFileTabIdRef = useRef<string | null>(null);
  const tabRefreshSequenceRef = useRef(0);
  const tabRefreshTokensRef = useRef<Map<string, number>>(new Map());
  const shouldWatchProjectTree = !collapsed && activeTab === 'files';

  useEffect(() => {
    openFileTabsRef.current = openFileTabs;
  }, [openFileTabs]);

  useEffect(() => {
    activeFileTabIdRef.current = activeFileTabId;
  }, [activeFileTabId]);

  useEffect(() => {
    if (!onActiveFileTabChange) return;
    onActiveFileTabChange(
      selectedFilePath
        ? { filePath: selectedFilePath, name: basenameOfPath(selectedFilePath) }
        : null
    );
  }, [onActiveFileTabChange, selectedFilePath]);

  const captureActiveEditorViewState = useCallback(() => {
    if (!activeFileTabId) return;
    const viewState =
      activeMarkdownBridgeRef.current?.getViewState() ||
      activeTextEditorBridgeRef.current?.getViewState() ||
      null;
    updateOpenFileTabs((current) =>
      current.map((tab) =>
        tab.id === activeFileTabId
          ? { ...tab, viewMode, viewState }
          : tab
      )
    );
  }, [activeFileTabId, updateOpenFileTabs, viewMode]);

  const prepareActiveFileForTransition = useCallback(async () => {
    captureActiveEditorViewState();
    const result = await projectEditorFlushRef.current();
    if (!result.ok) {
      toast.error(result.message || 'Failed to save pending editor changes.');
      return false;
    }
    return true;
  }, [captureActiveEditorViewState]);

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

  const ensureOpenFileTab = useCallback((
    preview: EditableProjectFilePreview,
    fileCwd: string,
    filePath: string,
    nextViewMode: ViewMode,
    nextDraftText = preview.text
  ) => {
    const id = getProjectFileTabId(fileCwd, filePath);
    updateOpenFileTabs((current) => {
      const existing = current.find((tab) => tab.id === id);
      if (existing) {
        return current.map((tab) =>
          tab.id === id
            ? {
                ...tab,
                name: preview.name,
                ext: preview.ext,
                kind: preview.kind,
                preview,
                draftText: nextDraftText,
                viewMode: tab.viewMode || nextViewMode,
              }
            : tab
        );
      }
      return [
        ...current,
        {
          id,
          cwd: fileCwd,
          filePath,
          name: preview.name,
          ext: preview.ext,
          kind: preview.kind,
          preview,
          draftText: nextDraftText,
          viewMode: nextViewMode,
          viewState: null,
        },
      ];
    });
  }, [updateOpenFileTabs]);

  const applyCachedFileTab = useCallback((tab: OpenProjectFileTab) => {
    previewRequestIdRef.current += 1;
    selectedEditableTextPreviewRef.current = tab.preview;
    rememberDiskContent(tab.preview.text);
    setSelectedFilePath(tab.filePath);
    setSelectedFileCwd(tab.cwd);
    expandParentsForPath(tab.filePath);
    setViewMode(tab.viewMode);
    setMdxRevealTarget(null);
    setPreviewLoading(false);
    setSelectedPreview(tab.preview);
    setDraftTextSynced(tab.draftText);
    setSaveStateSynced('idle');
    setSaveErrorSynced(null);
    setPptxSlideIndex(0);
  }, [
    expandParentsForPath,
    rememberDiskContent,
    setDraftTextSynced,
    setSaveErrorSynced,
    setSaveStateSynced,
  ]);

  const refreshFileTabFromDisk = useCallback(async (tabId: string) => {
    const tab = openFileTabsRef.current.find((item) => item.id === tabId);
    const reader = window.electron.readProjectFilePreview;
    if (!tab || typeof reader !== 'function') return;

    const refreshToken = (tabRefreshSequenceRef.current += 1);
    tabRefreshTokensRef.current.set(tabId, refreshToken);

    try {
      const preview = (await reader(tab.cwd, tab.filePath)) as ProjectFilePreview;
      if (tabRefreshTokensRef.current.get(tabId) !== refreshToken) return;
      if (!isEditableProjectFilePreview(preview)) return;

      const latestTab = openFileTabsRef.current.find((item) => item.id === tabId);
      if (!latestTab) return;
      if (latestTab.draftText !== latestTab.preview.text) return;

      const changed =
        preview.text !== latestTab.preview.text ||
        preview.mtimeMs !== latestTab.preview.mtimeMs ||
        preview.size !== latestTab.preview.size ||
        preview.name !== latestTab.name ||
        preview.ext !== latestTab.ext ||
        preview.kind !== latestTab.kind;
      if (!changed) return;

      updateOpenFileTabs((current) =>
        current.map((item) => {
          if (item.id !== tabId || item.draftText !== item.preview.text) {
            return item;
          }
          return {
            ...item,
            name: preview.name,
            ext: preview.ext,
            kind: preview.kind,
            preview,
            draftText: preview.text,
          };
        })
      );

      if (activeFileTabIdRef.current === tabId && draftTextRef.current === latestTab.preview.text) {
        selectedEditableTextPreviewRef.current = preview;
        rememberDiskContent(preview.text);
        setSelectedPreview(preview);
        setDraftTextSynced(preview.text);
        setSaveStateSynced('idle');
        setSaveErrorSynced(null);
      }
    } catch {
      // Cached tabs stay usable if a background freshness check fails.
    } finally {
      if (tabRefreshTokensRef.current.get(tabId) === refreshToken) {
        tabRefreshTokensRef.current.delete(tabId);
      }
    }
  }, [
    rememberDiskContent,
    setDraftTextSynced,
    setSaveErrorSynced,
    setSaveStateSynced,
    updateOpenFileTabs,
  ]);

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
      maxRailWidth,
      defaultRailWidth
    );
    if (storedPanelWidth !== null) {
      setPanelWidth(storedPanelWidth);
      return;
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

    if (!current) {
      setProjectTree(null, null);
      setProjectTreeError(null);
      if (prevCwdRef.current) {
        window.electron.unwatchProjectTree(prevCwdRef.current);
        prevCwdRef.current = null;
      }
      return;
    }

    if (!shouldWatchProjectTree) {
      setProjectTreeError(null);
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
    setProjectTreeError(null);
    window.electron
      .getProjectTree(current)
      .then((tree) => {
        if (cancelled) return;
        if (tree) {
          setProjectTreeError(null);
          setProjectTree(current, tree);
          void window.electron.watchProjectTree(current);
        } else {
          setProjectTreeError('Project folder not found.');
          setProjectTree(current, null);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setProjectTreeError('Unable to read project folder.');
        setProjectTree(current, null);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

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
  const canUseProjectTree = Boolean(cwd && visibleTree && !projectTreeError);

  useEffect(() => {
    setExpandedPaths(new Set());
    initRootRef.current = null;
    setSelectedFilePath(null);
    setSelectedFileCwd(null);
    setSelectedPreview(null);
    updateOpenFileTabs(() => []);
    setViewMode('view');
    setMdxRevealTarget(null);
    setPreviewLoading(false);
    setDraftTextSynced('');
    setSaveStateSynced('idle');
    setSaveErrorSynced(null);
    setProjectTreeError(null);
    setPptxSlideIndex(0);
    setCreateDraft(null);
    setDraggedProjectEntry(null);
    draggedProjectEntryRef.current = null;
    setProjectDropHoverId(null);
    setMovingProjectEntryPath(null);
  }, [cwd, setDraftTextSynced, setSaveStateSynced, updateOpenFileTabs]);

  useEffect(() => {
    setPanelWidth((current) =>
      Math.min(maxRailWidth, Math.max(minRailWidth, current || defaultRailWidth))
    );
  }, [defaultRailWidth, minRailWidth, maxRailWidth]);

  useEffect(() => {
    if (!usesSharedPanelWidth || !selectedFilePath || normalizedSharedPanelWidth === null) return;

    const maxRailForSharedWidth = Math.min(
      maxRailWidth,
      Math.max(minRailWidth, normalizedSharedPanelWidth - minPreviewWidth)
    );

    if (panelWidth > maxRailForSharedWidth) {
      setPanelWidth(maxRailForSharedWidth);
      return;
    }

    const nextPreviewWidth = Math.min(
      maxPreviewWidth,
      Math.max(minPreviewWidth, normalizedSharedPanelWidth - panelWidth)
    );
    setPreviewPanelWidth((current) =>
      current === nextPreviewWidth ? current : nextPreviewWidth
    );
  }, [
    maxPreviewWidth,
    maxRailWidth,
    minPreviewWidth,
    minRailWidth,
    normalizedSharedPanelWidth,
    panelWidth,
    selectedFilePath,
    usesSharedPanelWidth,
  ]);

  useEffect(() => {
    if (!visibleTree?.path) return;
    if (initRootRef.current === visibleTree.path) return;
    initRootRef.current = visibleTree.path;
    setExpandedPaths(new Set([visibleTree.path]));
  }, [visibleTree?.path]);

  const togglePath = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
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

  const selectFilePath = useCallback(async (
    filePath: string,
    fileName?: string,
    toggleSame = false,
    skipTransition = false
  ) => {
    if (!cwd) return;

    // Tabs own closing now; clicking the active file in the tree should keep it active.
    if (toggleSame && selectedFilePath === filePath) {
      return;
    }
    if (!skipTransition && selectedFilePath && selectedFilePath !== filePath) {
      const ready = await prepareActiveFileForTransition();
      if (!ready) return;
    }

    const name = fileName || filePath.split('/').filter(Boolean).pop() || filePath;

    if (isHtmlFilePath(filePath)) {
      const requestId = (previewRequestIdRef.current += 1);
      expandParentsForPath(filePath);
      setSelectedFilePath(null);
      setSelectedFileCwd(null);
      setPreviewLoading(false);
      setSelectedPreview(null);
      setMdxRevealTarget(null);
      setDraftTextSynced('');
      setSaveStateSynced('idle');
      setSaveErrorSynced(null);
      setPptxSlideIndex(0);

      if (!activeSessionId) {
        toast.error('No active session for browser preview.');
        return;
      }

      try {
        const url = await resolveHtmlPreviewUrl({ cwd, filePath });
        if (previewRequestIdRef.current !== requestId) return;

        if (onOpenUtilityTab) {
          // Re-activate the browser tab that already shows this file instead
          // of opening a duplicate.
          const browserTargets = useAppStore
            .getState()
            .rightUtilityTabs.filter(
              (target) => target === 'browser' || target.startsWith('browser:')
            );
          for (const target of browserTargets) {
            const targetState = await window.electron.browser.getState({
              sessionId: getBrowserUtilitySessionId(activeSessionId, target),
            });
            if (previewRequestIdRef.current !== requestId) return;
            if (targetState.tabs.some((tab) => tab.url === url)) {
              useAppStore.getState().setActiveRightUtilityTab(target);
              return;
            }
          }

          // The base browser session hosts the first preview; every further
          // file gets its own browser tab so previews never replace each other.
          const baseState = await window.electron.browser.getState({
            sessionId: activeSessionId,
          });
          if (previewRequestIdRef.current !== requestId) return;
          if (baseState.tabs.length === 0) {
            await openUrlInBrowserSession({ sessionId: activeSessionId, url });
            if (previewRequestIdRef.current !== requestId) return;
            onOpenUtilityTab('browser');
          } else {
            // Seed the new browser session with the file URL before its panel
            // exists: once the tab is activated, the mounting BrowserPanel's
            // open(DEFAULT_HOME_URL) finds a populated session and leaves it
            // alone. Activating first instead would race the mount load and
            // intermittently lose the file URL to about:blank.
            const target: ProjectUtilityPanelTarget = `browser:${crypto.randomUUID()}`;
            await openUrlInBrowserSession({
              sessionId: getBrowserUtilitySessionId(activeSessionId, target),
              url,
            });
            if (previewRequestIdRef.current !== requestId) return;
            useAppStore.getState().setActiveRightUtilityTab(target);
          }
        } else {
          await openUrlInBrowserSession({ sessionId: activeSessionId, url });
          if (previewRequestIdRef.current !== requestId) return;
          setBrowserPanelOpen(true);
          setProjectTreeCollapsed(true);
        }
      } catch (error) {
        if (previewRequestIdRef.current !== requestId) return;
        toast.error(`Failed to open in browser panel: ${error}`);
      }
      return;
    }

    const cachedTab = openFileTabsRef.current.find((tab) =>
      tab.id === getProjectFileTabId(cwd, filePath)
    );
    if (cachedTab) {
      applyCachedFileTab(cachedTab);
      void refreshFileTabFromDisk(cachedTab.id);
      return;
    }

    setSelectedFilePath(filePath);
    setSelectedFileCwd(cwd);
    expandParentsForPath(filePath);
    setViewMode('view');
    setMdxRevealTarget(null);
    setPreviewLoading(true);
    setSelectedPreview(null);
    setDraftTextSynced('');
    setSaveStateSynced('idle');
    setSaveErrorSynced(null);
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
      if (preview.kind === 'text' && preview.ext === '.mdx') {
        setDraftTextSynced(preview.text);
        setViewMode('code');
        if (preview.editable) {
          ensureOpenFileTab(preview as EditableProjectFilePreview, cwd, filePath, 'code');
        }
        return;
      }
      if ((preview.kind === 'text' || preview.kind === 'markdown') && preview.editable) {
        const nextViewMode = preview.kind === 'text' ? 'code' : 'view';
        setViewMode(nextViewMode);
        setDraftTextSynced(preview.text);
        ensureOpenFileTab(preview as EditableProjectFilePreview, cwd, filePath, nextViewMode);
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
    applyCachedFileTab,
    cwd,
    expandParentsForPath,
    ensureOpenFileTab,
    prepareActiveFileForTransition,
    refreshFileTabFromDisk,
    selectedFilePath,
    onOpenUtilityTab,
    setBrowserPanelOpen,
    setProjectTreeCollapsed,
    setDraftTextSynced,
    setSaveStateSynced,
  ]);

  const selectFile = async (node: ProjectTreeNode) => {
    if (node.kind !== 'file') return;
    await selectFilePath(node.path, node.name, true);
  };

  const activateProjectFileTab = useCallback(async (tab: OpenProjectFileTab) => {
    if (tab.id === activeFileTabId) return;
    const ready = await prepareActiveFileForTransition();
    if (!ready) return;
    const latestTab = openFileTabsRef.current.find((item) => item.id === tab.id) || tab;
    applyCachedFileTab(latestTab);
    void refreshFileTabFromDisk(latestTab.id);
  }, [
    activeFileTabId,
    applyCachedFileTab,
    prepareActiveFileForTransition,
    refreshFileTabFromDisk,
  ]);

  const canDropEntryOnParent = useCallback((entry: ProjectDraggedEntry, targetParentPath: string) => {
    if (!cwd || !entry.path || !targetParentPath) return false;

    const sourcePath = normalizeProjectPath(entry.path);
    const targetPath = normalizeProjectPath(targetParentPath);
    const projectRoot = normalizeProjectPath(cwd);

    if (!isPathInsideProjectPath(sourcePath, projectRoot)) return false;
    if (targetPath !== projectRoot && !isPathInsideProjectPath(targetPath, projectRoot)) return false;
    if (isSameProjectPath(sourcePath, targetPath)) return false;
    if (isSameProjectPath(dirnameOfPath(sourcePath), targetPath)) return false;
    if (entry.kind === 'dir' && isPathInsideProjectPath(targetPath, sourcePath)) return false;

    return true;
  }, [cwd]);

  const moveProjectEntryIntoParent = useCallback(async (
    entry: ProjectDraggedEntry,
    targetParentPath: string
  ) => {
    if (!cwd) return;

    const mover = window.electron.moveProjectEntry;
    if (typeof mover !== 'function') {
      toast.error('File move API is not available. Please restart the app.');
      return;
    }

    if (!canDropEntryOnParent(entry, targetParentPath)) return;

    const wasSelected = !!selectedFilePath && isSameProjectPath(selectedFilePath, entry.path);
    setMovingProjectEntryPath(entry.path);
    setProjectDropHoverId(null);
    setDraggedProjectEntry(null);
    draggedProjectEntryRef.current = null;

    try {
      const result = (await mover(cwd, entry.path, targetParentPath)) as ProjectEntryMoveResult;
      if (!result?.ok || !result.path || !result.tree) {
        toast.error(result?.message || 'Failed to move file.');
        return;
      }

      setProjectTree(cwd, result.tree);
      expandPath(targetParentPath);
      updateOpenFileTabs((current) =>
        current.map((tab) => {
          if (entry.kind === 'file' && isSameProjectPath(tab.filePath, entry.path)) {
            const movedName = basenameOfPath(result.path!);
            return {
              ...tab,
              id: getProjectFileTabId(cwd, result.path!),
              filePath: result.path!,
              name: movedName,
              preview: {
                ...tab.preview,
                path: result.path!,
                name: movedName,
              },
            };
          }
          if (entry.kind === 'dir' && isPathInsideProjectPath(tab.filePath, entry.path)) {
            const relative = normalizeProjectPath(tab.filePath).slice(normalizeProjectPath(entry.path).length).replace(/^\/+/, '');
            const movedPath = relative ? `${result.path}/${relative}` : result.path!;
            const movedName = basenameOfPath(movedPath);
            return {
              ...tab,
              id: getProjectFileTabId(cwd, movedPath),
              filePath: movedPath,
              name: movedName,
              preview: {
                ...tab.preview,
                path: movedPath,
                name: movedName,
              },
            };
          }
          return tab;
        })
      );

      if (wasSelected) {
        const movedPath = result.path;
        const movedName = basenameOfPath(movedPath);
        setSelectedFilePath(movedPath);
        setSelectedFileCwd(cwd);
        setSelectedPreview((current) => current ? { ...current, path: movedPath, name: movedName } : current);
      }

      toast.success(`${entry.kind === 'dir' ? 'Folder' : 'File'} moved.`);
    } catch (error) {
      toast.error(`Failed to move file: ${String(error)}`);
    } finally {
      setMovingProjectEntryPath(null);
    }
  }, [canDropEntryOnParent, cwd, expandPath, selectedFilePath, setProjectTree, updateOpenFileTabs]);

  const handleProjectEntryDragStart = useCallback((event: DragEvent<HTMLDivElement>, node: ProjectTreeNode) => {
    if (node.kind !== 'file' && node.kind !== 'dir') return;

    const entry: ProjectDraggedEntry = {
      kind: node.kind,
      name: node.name,
      path: node.path,
    };
    setCreateDraft(null);
    draggedProjectEntryRef.current = entry;
    setDraggedProjectEntry(entry);
    setProjectDropHoverId(null);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(PROJECT_ENTRY_DRAG_MIME, JSON.stringify(entry));
    event.dataTransfer.setData('text/plain', node.path);
  }, []);

  const handleProjectEntryDragEnd = useCallback(() => {
    draggedProjectEntryRef.current = null;
    setDraggedProjectEntry(null);
    setProjectDropHoverId(null);
  }, []);

  const getDraggedEntryForEvent = useCallback((event: DragEvent<HTMLElement>) => {
    return draggedProjectEntryRef.current || draggedProjectEntry || readDraggedProjectEntry(event);
  }, [draggedProjectEntry]);

  // Set hover highlight to (targetParentPath, hoverId) if a drop is acceptable.
  // Always call stopPropagation when we have a dragged entry so the root container
  // does not see events that originated on a child row.
  const handleDropTargetDragOver = useCallback((
    event: DragEvent<HTMLElement>,
    targetParentPath: string,
    hoverId: string
  ) => {
    const entry = getDraggedEntryForEvent(event);
    if (!entry) return;

    event.stopPropagation();

    if (canDropEntryOnParent(entry, targetParentPath)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setProjectDropHoverId((current) => (current === hoverId ? current : hoverId));
      return;
    }

    // Not acceptable: don't preventDefault (browser shows "not allowed" cursor),
    // but still clear hover if it belonged to this surface.
    setProjectDropHoverId((current) => (current === hoverId ? null : current));
  }, [canDropEntryOnParent, getDraggedEntryForEvent]);

  const handleDropTargetDragLeave = useCallback((
    event: DragEvent<HTMLElement>,
    hoverId: string
  ) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }

    setProjectDropHoverId((current) => (current === hoverId ? null : current));
  }, []);

  const handleProjectEntryDrop = useCallback((
    event: DragEvent<HTMLElement>,
    targetParentPath: string
  ) => {
    const entry = getDraggedEntryForEvent(event);
    if (!entry) return;

    event.preventDefault();
    event.stopPropagation();
    setProjectDropHoverId(null);

    if (!canDropEntryOnParent(entry, targetParentPath)) return;
    void moveProjectEntryIntoParent(entry, targetParentPath);
  }, [canDropEntryOnParent, getDraggedEntryForEvent, moveProjectEntryIntoParent]);

  // Resolve which parent dir a hover on a tree row should target:
  // dir → itself; file → its parent dir.
  const resolveTreeNodeDropTarget = useCallback((
    node: ProjectTreeNode,
    parentPath: string | null
  ): { targetParentPath: string; hoverId: string } | null => {
    if (node.kind === 'dir') {
      return { targetParentPath: node.path, hoverId: getNodeDropHoverId(node.path) };
    }
    if (!parentPath) return null;
    // Files surface the highlight on their containing directory.
    return { targetParentPath: parentPath, hoverId: getNodeDropHoverId(parentPath) };
  }, []);

  const handleTreeNodeDragOver = useCallback((
    event: DragEvent<HTMLElement>,
    node: ProjectTreeNode,
    parentPath: string | null
  ) => {
    const resolved = resolveTreeNodeDropTarget(node, parentPath);
    if (!resolved) {
      // No valid target on this row; still consume the event so it does not
      // bubble up and highlight the project root.
      const entry = getDraggedEntryForEvent(event);
      if (entry) event.stopPropagation();
      return;
    }
    handleDropTargetDragOver(event, resolved.targetParentPath, resolved.hoverId);
  }, [getDraggedEntryForEvent, handleDropTargetDragOver, resolveTreeNodeDropTarget]);

  const handleTreeNodeDragLeave = useCallback((
    event: DragEvent<HTMLElement>,
    node: ProjectTreeNode,
    parentPath: string | null
  ) => {
    const resolved = resolveTreeNodeDropTarget(node, parentPath);
    if (!resolved) return;
    handleDropTargetDragLeave(event, resolved.hoverId);
  }, [handleDropTargetDragLeave, resolveTreeNodeDropTarget]);

  const handleTreeNodeDrop = useCallback((
    event: DragEvent<HTMLElement>,
    node: ProjectTreeNode,
    parentPath: string | null
  ) => {
    const resolved = resolveTreeNodeDropTarget(node, parentPath);
    if (!resolved) {
      // Consume the event regardless to prevent the root container from acting on it.
      const entry = getDraggedEntryForEvent(event);
      if (entry) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    handleProjectEntryDrop(event, resolved.targetParentPath);
  }, [getDraggedEntryForEvent, handleProjectEntryDrop, resolveTreeNodeDropTarget]);

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

  const selectExternalFilePath = useCallback(async (
    filePath: string,
    options: { lineStart?: number; lineEnd?: number } = {}
  ) => {
    const reader = window.electron.readProjectFilePreview;
    if (typeof reader !== 'function') return;
    if (selectedFilePath && selectedFilePath !== filePath) {
      const ready = await prepareActiveFileForTransition();
      if (!ready) return;
    }

    const name = filePath.split('/').filter(Boolean).pop() || filePath;
    const fileCwd = dirnameOfPath(filePath);
    setSelectedFilePath(filePath);
    setSelectedFileCwd(fileCwd);
    setViewMode('view');
    setMdxRevealTarget(null);
    setPreviewLoading(true);
    setSelectedPreview(null);
    setDraftTextSynced('');
    setSaveStateSynced('idle');
    setSaveErrorSynced(null);
    setPptxSlideIndex(0);

    const requestId = (previewRequestIdRef.current += 1);
    try {
      const preview = (await reader(fileCwd, filePath)) as ProjectFilePreview;
      if (previewRequestIdRef.current !== requestId) return;
      // MDX files: use CodeMirror plain-text editor (default), with toggle to rendered preview.
      if (preview.kind === 'text' && preview.ext === '.mdx') {
        setSelectedPreview(preview);
        setDraftTextSynced(preview.text);
        setViewMode('code'); // default to source editing like Cursor
        if (preview.editable) {
          ensureOpenFileTab(preview as EditableProjectFilePreview, fileCwd, filePath, 'code');
        }
        if (typeof options.lineStart === 'number') {
          mdxRevealTokenRef.current += 1;
          setMdxRevealTarget({
            line: options.lineStart,
            token: mdxRevealTokenRef.current,
          });
        }
        return;
      }
      if (preview.kind === 'markdown') {
        setSelectedPreview(preview);
        if (preview.editable) {
          setDraftTextSynced(preview.text);
          ensureOpenFileTab(preview as EditableProjectFilePreview, fileCwd, filePath, 'view');
        }
        return;
      }
      if (
        (preview.kind === 'text' || preview.kind === 'html') &&
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
          mtimeMs: preview.mtimeMs,
          text: sliceTextLineRange(preview.text, options.lineStart, options.lineEnd),
          editable: false,
        });
        return;
      }
      if (preview.kind === 'text' || preview.kind === 'html') {
        if (preview.kind === 'text' && preview.editable) {
          setSelectedPreview(preview);
          setDraftTextSynced(preview.text);
          setViewMode('code');
          ensureOpenFileTab(preview as EditableProjectFilePreview, fileCwd, filePath, 'code');
          return;
        }
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
  }, [
    ensureOpenFileTab,
    prepareActiveFileForTransition,
    selectedFilePath,
    setDraftTextSynced,
    setSaveStateSynced,
  ]);

  const closePreview = useCallback(() => {
    setSelectedFilePath(null);
    setSelectedFileCwd(null);
    setSelectedPreview(null);
    setViewMode('view');
    setMdxRevealTarget(null);
    setDraftTextSynced('');
    setSaveStateSynced('idle');
    setSaveErrorSynced(null);
    setPptxSlideIndex(0);
    if (isFullscreen && onToggleFullscreen) onToggleFullscreen();
  }, [isFullscreen, onToggleFullscreen, setDraftTextSynced, setSaveStateSynced]);

  const closeProjectFileTab = useCallback(async (tabId: string) => {
    const tab = openFileTabs.find((item) => item.id === tabId);
    if (!tab) return;
    const closingActiveTab = tabId === activeFileTabId;
    if (closingActiveTab) {
      const ready = await prepareActiveFileForTransition();
      if (!ready) return;
    }

    const nextTabs = openFileTabs.filter((item) => item.id !== tabId);
    updateOpenFileTabs(() => nextTabs);

    if (!closingActiveTab) return;
    const closedIndex = openFileTabs.findIndex((item) => item.id === tabId);
    const nextTab =
      nextTabs[Math.max(0, closedIndex - 1)] ||
      nextTabs[closedIndex] ||
      null;
    if (nextTab) {
      await selectFilePath(nextTab.filePath, nextTab.name, false, true);
      setViewMode(nextTab.viewMode);
      return;
    }
    closePreview();
  }, [
    activeFileTabId,
    closePreview,
    openFileTabs,
    prepareActiveFileForTransition,
    selectFilePath,
    updateOpenFileTabs,
  ]);

  const closeAllProjectFileTabs = useCallback(async () => {
    if (activeFileTabId) {
      const ready = await prepareActiveFileForTransition();
      if (!ready) return;
    }
    tabRefreshTokensRef.current.clear();
    updateOpenFileTabs(() => []);
    closePreview();
  }, [
    activeFileTabId,
    closePreview,
    prepareActiveFileForTransition,
    updateOpenFileTabs,
  ]);

  const deleteEntry = useCallback(async (node: ProjectTreeNode) => {
    if (!cwd) return;
    if (node.kind !== 'file') return;
    const deleter = window.electron.deleteProjectEntry;
    if (typeof deleter !== 'function') {
      toast.error('Delete is not available in this build.');
      return;
    }
    // eslint-disable-next-line no-alert
    const confirmed = window.confirm(
      `Move file "${node.name}" to Trash?`
    );
    if (!confirmed) return;

    try {
      const result = await deleter(cwd, node.path);
      if (!result?.ok || !result.tree) {
        toast.error(result?.message || 'Failed to delete file.');
        return;
      }
      setProjectTree(cwd, result.tree);

      // If the deleted file is currently being previewed, close it.
      const normalizedDeleted = normalizeProjectPath(node.path);
      const previewed = selectedFilePath ? normalizeProjectPath(selectedFilePath) : null;
      updateOpenFileTabs((current) =>
        current.filter((tab) => normalizeProjectPath(tab.filePath) !== normalizedDeleted)
      );
      if (previewed === normalizedDeleted) {
        closePreview();
      }
      toast.success('File moved to Trash.');
    } catch (error) {
      toast.error(`Failed to delete: ${String(error)}`);
    }
  }, [closePreview, cwd, selectedFilePath, setProjectTree, updateOpenFileTabs]);

  const openProjectTreeContextMenu = useCallback(async (event: React.MouseEvent, node?: ProjectTreeNode) => {
    if (!cwd) return;
    event.preventDefault();
    event.stopPropagation();

    const parentPath = node
      ? node.kind === 'dir'
        ? node.path
        : dirnameOfPath(node.path)
      : visibleTree?.path || cwd;
    const result = await window.electron.showNativeMenu({
      x: event.clientX + 2,
      y: event.clientY + 2,
      items: [
        { id: 'new-file', label: 'New File' },
        { id: 'new-folder', label: 'New Folder' },
        ...(node?.kind === 'file'
          ? [
              { id: 'file-actions-separator', type: 'separator' as const },
              { id: 'delete-file', label: 'Delete File' },
            ]
          : []),
      ],
    });

    if (!result.ok || !result.id) return;

    if (result.id === 'new-file') {
      startCreateEntry(parentPath, 'file');
      return;
    }
    if (result.id === 'new-folder') {
      startCreateEntry(parentPath, 'folder');
      return;
    }
    if (result.id === 'delete-file' && node?.kind === 'file') {
      void deleteEntry(node);
    }
  }, [cwd, deleteEntry, startCreateEntry, visibleTree?.path]);

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

  const showWechatCopyResult = useCallback((
    result: Awaited<ReturnType<typeof copyMarkdownAsWechatHtml>>,
    toastId?: string | number,
  ) => {
    const modelDescription = result.ok && result.model
      ? `使用：${result.runtime || 'aegis'} · ${result.model}`
      : undefined;
    const resultToastOptions = {
      closeButton: true,
      dismissible: true,
      ...(modelDescription ? { description: modelDescription } : {}),
    };
    const toastOptions = toastId === undefined
      ? resultToastOptions
      : { ...resultToastOptions, id: toastId };
    if (result.ok) {
      if (result.format === 'html') {
        toast.success('已复制到公众号剪贴板', toastOptions);
      } else if (result.format === 'source-html') {
        toast.success('富文本复制不可用，已复制生成的 HTML 源码', toastOptions);
      } else {
        toast.success('富文本复制不可用，已复制原始 Markdown', toastOptions);
      }
    } else {
      toast.error(`复制失败: ${result.error}`, toastOptions);
    }
  }, []);

  const handleCopyWechatHtml = useCallback(async (themeId: WeChatStaticThemeId = 'bubblebrain') => {
    activeMarkdownBridgeRef.current?.flush();
    const result = await copyMarkdownAsWechatHtml(draftTextRef.current, themeId);
    showWechatCopyResult(result);
  }, [showWechatCopyResult]);

  const handleCopyAiWechatHtml = useCallback(async (
    themeId: WeChatAiThemeId,
    themeLabel: string,
  ) => {
    if (wechatAiGeneratingTheme) return;
    activeMarkdownBridgeRef.current?.flush();
    setWechatAiGeneratingTheme(themeId);
    const loadingToastId = toast.loading(`Generating ${themeLabel} HTML...`, {
      description: 'It will be copied to the WeChat clipboard when ready',
      duration: Infinity,
      dismissible: false,
    });
    try {
      const result = await copyMarkdownAsWechatAiHtml(
        draftTextRef.current,
        themeId,
        selectedFilePath || undefined,
      );
      showWechatCopyResult(result, loadingToastId);
    } catch (error) {
      toast.error(`复制失败: ${error instanceof Error ? error.message : String(error)}`, {
        id: loadingToastId,
        closeButton: true,
        dismissible: true,
      });
    } finally {
      setWechatAiGeneratingTheme(null);
    }
  }, [selectedFilePath, showWechatCopyResult, wechatAiGeneratingTheme]);

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

  const selectedEditableTextPreview =
    isEditableProjectFilePreview(selectedPreview)
      ? selectedPreview
      : null;
  const hasEditableTextOpen = Boolean(selectedEditableTextPreview);

  useEffect(() => {
    draftTextRef.current = draftText;
  }, [draftText]);

  useEffect(() => {
    saveStateRef.current = saveState;
  }, [saveState]);

  useEffect(() => {
    selectedEditableTextPreviewRef.current = selectedEditableTextPreview;
  }, [selectedEditableTextPreview]);

  useEffect(() => {
    if (!activeFileTabId) return;
    updateOpenFileTabs((current) =>
      current.map((tab) =>
        tab.id === activeFileTabId
          ? { ...tab, viewMode }
          : tab
      )
    );
  }, [activeFileTabId, updateOpenFileTabs, viewMode]);

  useEffect(() => {
    if (!activeFileTabId || previewLoading || !selectedEditableTextPreview) return;
    const tab = openFileTabs.find((item) => item.id === activeFileTabId);
    if (!tab?.viewState) return;
    const viewState = tab.viewState;
    window.requestAnimationFrame(() => {
      activeMarkdownBridgeRef.current?.restoreViewState(viewState);
      activeTextEditorBridgeRef.current?.restoreViewState(viewState);
    });
  }, [activeFileTabId, openFileTabs, previewLoading, selectedEditableTextPreview]);

  // Mirror unsaved text to the main process for the synchronous quit fallback.
  useEffect(() => {
    const updateDraft = window.electron.updateProjectEditorDraft;
    if (typeof updateDraft !== 'function') return;
    if (
      selectedFileCwd &&
      selectedFilePath &&
      selectedEditableTextPreview &&
      draftText !== selectedEditableTextPreview.text
    ) {
      updateDraft({ cwd: selectedFileCwd, filePath: selectedFilePath, content: draftText });
    } else {
      updateDraft(null);
    }
  }, [draftText, selectedEditableTextPreview, selectedFileCwd, selectedFilePath]);

  const canSaveText =
    !!selectedFileCwd &&
    !!selectedEditableTextPreview &&
    draftText !== selectedEditableTextPreview.text;

  const handleSaveText = useCallback(async (): Promise<boolean> => {
    if (!selectedFileCwd) return true;
    const previewToSave = selectedEditableTextPreviewRef.current;
    if (
      !previewToSave ||
      (previewToSave.kind !== 'markdown' && previewToSave.kind !== 'text') ||
      !previewToSave.editable
    ) {
      return true;
    }
    if (!selectedFilePath) return true;
    const textToSave = draftTextRef.current;
    if (textToSave === previewToSave.text) {
      window.electron.commitProjectEditorDraftSync?.(null);
      return true;
    }
    if (saveInFlightRef.current) {
      saveAgainAfterInFlightRef.current = true;
      const inFlightSave = savePromiseRef.current;
      if (!inFlightSave) return true;
      const inFlightOk = await inFlightSave;
      if (!inFlightOk) return false;
      const latestPreview = selectedEditableTextPreviewRef.current;
      const stillDirty =
        !!latestPreview &&
        (latestPreview.kind === 'markdown' || latestPreview.kind === 'text') &&
        latestPreview.editable &&
        draftTextRef.current !== latestPreview.text;
      return stillDirty ? handleSaveText() : true;
    }

    saveInFlightRef.current = true;
    setSaveStateSynced('saving');
    setSaveErrorSynced(null);

    const savePromise = (async (): Promise<boolean> => {
      let savedOk = false;
      try {
        const result = await window.electron.writeProjectTextFile(
          selectedFileCwd,
          selectedFilePath,
          textToSave
        );
        if (!result?.ok) {
          setSaveStateSynced('error');
          setSaveErrorSynced(result?.message || 'Failed to save');
          return false;
        }
        const savedPreview = {
          ...previewToSave,
          text: textToSave,
          size: result.size ?? previewToSave.size,
          mtimeMs: result.mtimeMs ?? previewToSave.mtimeMs,
        } as EditableProjectFilePreview;
        selectedEditableTextPreviewRef.current = savedPreview;
        rememberDiskContent(textToSave);
        setSelectedPreview(savedPreview);
        ensureOpenFileTab(savedPreview, selectedFileCwd, selectedFilePath, viewMode, textToSave);
        savedOk = true;
        setSaveStateSynced('saved');
        window.setTimeout(() => {
          if (saveStateRef.current === 'saved') {
            setSaveStateSynced('idle');
          }
        }, 1200);
      } catch (error) {
        setSaveStateSynced('error');
        setSaveErrorSynced(String(error));
        return false;
      } finally {
        saveInFlightRef.current = false;
      }

      if (!savedOk) return false;
      const currentPreview = selectedEditableTextPreviewRef.current;
      const stillDirty =
        !!currentPreview &&
        (currentPreview.kind === 'markdown' || currentPreview.kind === 'text') &&
        currentPreview.editable &&
        draftTextRef.current !== currentPreview.text;
      if (saveAgainAfterInFlightRef.current || stillDirty) {
        saveAgainAfterInFlightRef.current = false;
        return handleSaveText();
      }
      window.electron.commitProjectEditorDraftSync?.(null);
      return true;
    })();

    savePromiseRef.current = savePromise;
    const saveOk = await savePromise;
    if (savePromiseRef.current === savePromise) {
      savePromiseRef.current = null;
    }
    return saveOk;
  }, [ensureOpenFileTab, selectedFileCwd, selectedFilePath, setSaveErrorSynced, setSaveStateSynced, viewMode]);

  useEffect(() => {
    if (
      !selectedEditableTextPreview ||
      !canSaveText
    ) {
      return;
    }

    const timerId = window.setTimeout(() => {
      void handleSaveText();
    }, 350);

    return () => window.clearTimeout(timerId);
  }, [canSaveText, draftText, handleSaveText, selectedEditableTextPreview]);

  const flushProjectEditorBeforeClose = useCallback(async (): Promise<ProjectEditorFlushResult> => {
    activeMarkdownBridgeRef.current?.flush();
    activeTextEditorBridgeRef.current?.flush();
    const saveOk = await handleSaveText();
    const currentPreview = selectedEditableTextPreviewRef.current;
    const stillDirty =
      !!currentPreview &&
      (currentPreview.kind === 'markdown' || currentPreview.kind === 'text') &&
      currentPreview.editable &&
      draftTextRef.current !== currentPreview.text;

    if (!saveOk || stillDirty) {
      return {
        ok: false,
        message: saveErrorRef.current || 'Failed to save pending editor changes.',
      };
    }

    return { ok: true };
  }, [handleSaveText]);

  useEffect(() => {
    projectEditorFlushRef.current = flushProjectEditorBeforeClose;
  }, [flushProjectEditorBeforeClose]);

  useEffect(() => {
    const registerFlushHandler = window.electron.registerProjectEditorFlushHandler;
    if (typeof registerFlushHandler !== 'function') return;
    return registerFlushHandler(() => projectEditorFlushRef.current());
  }, []);

  useEffect(() => {
    if (!selectedFileCwd || !selectedFilePath || !selectedEditableTextPreview) {
      return;
    }

    // Blur/visibility saves only the latest draft emitted by the active editor.
    // The final close path also flushes pending composition state before saving.
    const getDirtyContent = (flushEditor: boolean): string | null => {
      if (flushEditor) {
        activeMarkdownBridgeRef.current?.flush();
        activeTextEditorBridgeRef.current?.flush();
      }
      const currentPreview = selectedEditableTextPreviewRef.current;
      if (
        !currentPreview ||
        (currentPreview.kind !== 'markdown' && currentPreview.kind !== 'text') ||
        !currentPreview.editable ||
        draftTextRef.current === currentPreview.text
      ) {
        return null;
      }
      return draftTextRef.current;
    };

    const flushPendingDraft = () => {
      const content = getDirtyContent(false);
      if (content === null) return;
      window.electron.commitProjectEditorDraftSync?.({
        cwd: selectedFileCwd,
        filePath: selectedFilePath,
        content,
      });
      void handleSaveText();
    };

    const flushPendingDraftSync = () => {
      const content = getDirtyContent(true);
      if (content === null) return;
      window.electron.writeProjectTextFileSync?.({
        cwd: selectedFileCwd,
        filePath: selectedFilePath,
        content,
      });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushPendingDraft();
      }
    };

    window.addEventListener('blur', flushPendingDraft);
    window.addEventListener('pagehide', flushPendingDraftSync);
    window.addEventListener('beforeunload', flushPendingDraftSync);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('blur', flushPendingDraft);
      window.removeEventListener('pagehide', flushPendingDraftSync);
      window.removeEventListener('beforeunload', flushPendingDraftSync);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [handleSaveText, selectedEditableTextPreview, selectedFileCwd, selectedFilePath]);

  const applyExternalReload = useCallback(
    (payload: { text: string; mtimeMs: number; size: number }) => {
      const currentPreview = selectedEditableTextPreviewRef.current;
      if (!currentPreview) return;
      const latest = {
        ...currentPreview,
        text: payload.text,
        mtimeMs: payload.mtimeMs,
        size: payload.size,
      } as EditableProjectFilePreview;
      selectedEditableTextPreviewRef.current = latest;
      rememberDiskContent(payload.text);
      setSelectedPreview(latest);
      setDraftTextSynced(payload.text);
      if (selectedFileCwd && selectedFilePath) {
        ensureOpenFileTab(latest, selectedFileCwd, selectedFilePath, viewMode, payload.text);
      }
      setSaveStateSynced('idle');
      setSaveErrorSynced(null);
    },
    [
      ensureOpenFileTab,
      rememberDiskContent,
      selectedFileCwd,
      selectedFilePath,
      setDraftTextSynced,
      setSaveErrorSynced,
      setSaveStateSynced,
      viewMode,
    ]
  );

  // Subscribe to disk changes for the open editable file. Event-driven via the
  // main-process file watcher; replaces the previous 4s polling loop.
  useEffect(() => {
    if (!selectedFileCwd || !selectedFilePath || !hasEditableTextOpen) {
      return;
    }
    const watcher = window.electron.watchProjectFile;
    const unwatcher = window.electron.unwatchProjectFile;
    if (typeof watcher !== 'function' || typeof unwatcher !== 'function') return;

    void watcher(selectedFileCwd, selectedFilePath);
    return () => {
      void unwatcher(selectedFileCwd, selectedFilePath);
    };
  }, [selectedFileCwd, selectedFilePath, hasEditableTextOpen]);

  // Reconcile external disk changes pushed by the file watcher.
  useEffect(() => {
    if (!selectedFileCwd || !selectedFilePath) return;

    // New file context: drop all remembered disk content so every watcher event
    // is evaluated fresh against whatever the file actually contains.
    knownDiskContentsRef.current = new Set();

    const handleFileChanged = (event: Event) => {
      const detail = (event as CustomEvent<{
        cwd: string;
        filePath: string;
        text: string;
        mtimeMs: number;
        size: number;
        exists: boolean;
      }>).detail;
      if (!detail || detail.cwd !== selectedFileCwd || detail.filePath !== selectedFilePath) {
        return;
      }

      const currentPreview = selectedEditableTextPreviewRef.current;
      if (
        !currentPreview ||
        (currentPreview.kind !== 'markdown' && currentPreview.kind !== 'text') ||
        !currentPreview.editable
      ) {
        return;
      }
      // File removed/renamed away: keep the in-editor buffer rather than wiping it.
      if (!detail.exists) return;

      const composing =
        (activeMarkdownBridgeRef.current?.isComposing() ?? false) ||
        (activeTextEditorBridgeRef.current?.isComposing() ?? false);

      // Seed the known-contents set on the very first event so the originally
      // loaded preview text is recognised as "ours".
      if (knownDiskContentsRef.current.size === 0) {
        rememberDiskContent(currentPreview.text);
      }

      // Content we have previously loaded, saved, or applied: not external.
      // Using a set instead of a single value avoids false positives from
      // serialization jitter (210/211) and out-of-order debounced events.
      if (knownDiskContentsRef.current.has(detail.text)) {
        if (detail.mtimeMs !== currentPreview.mtimeMs || detail.size !== currentPreview.size) {
          const refreshed = {
            ...currentPreview,
            mtimeMs: detail.mtimeMs,
            size: detail.size,
          } as EditableProjectFilePreview;
          selectedEditableTextPreviewRef.current = refreshed;
          setSelectedPreview(refreshed);
          if (selectedFileCwd && selectedFilePath) {
            ensureOpenFileTab(refreshed, selectedFileCwd, selectedFilePath, viewMode, draftTextRef.current);
          }
        }
        return;
      }

      // Never-before-seen disk content. Remember it so future echoes are ignored.
      rememberDiskContent(detail.text);

      // The user has unsaved local edits or a save is in flight: never clobber.
      if (draftTextRef.current !== detail.text && saveStateRef.current !== 'idle') {
        return;
      }
      if (draftTextRef.current !== currentPreview.text && draftTextRef.current !== detail.text) {
        return;
      }

      // Genuine external change with no local edits. Defer while composing.
      if (composing) {
        pendingExternalReloadRef.current = detail;
        return;
      }
      applyExternalReload(detail);
    };

    window.addEventListener('aegis:project-file-changed', handleFileChanged);
    return () => window.removeEventListener('aegis:project-file-changed', handleFileChanged);
  }, [applyExternalReload, ensureOpenFileTab, rememberDiskContent, selectedFileCwd, selectedFilePath, viewMode]);

  // Apply a deferred external reload once IME composition settles.
  useEffect(() => {
    const pending = pendingExternalReloadRef.current;
    if (!pending) return;
    if (
      activeMarkdownBridgeRef.current?.isComposing() ||
      activeTextEditorBridgeRef.current?.isComposing()
    ) {
      return;
    }
    pendingExternalReloadRef.current = null;
    if (pending.text !== draftTextRef.current) {
      applyExternalReload(pending);
    }
  }, [applyExternalReload, draftText]);

  const handlePreviewResizeMove = (clientX: number) => {
    if (!previewResizingRef.current) return;
    const delta = startXRef.current - clientX;
    const nextPreviewWidth = Math.min(
      maxPreviewWidth,
      Math.max(minPreviewWidth, startWidthRef.current + delta)
    );
    latestPreviewWidthRef.current = nextPreviewWidth;
    setPreviewPanelWidth(nextPreviewWidth);
    onSharedPanelWidthChange?.(latestPanelWidthRef.current + nextPreviewWidth);
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
    if (panelResizingSharedWidthRef.current && onSharedPanelWidthChange) {
      onSharedPanelWidthChange(panelStartWidthRef.current + delta);
      return;
    }
    const nextPanelWidth = Math.min(
      maxRailWidth,
      Math.max(minRailWidth, panelStartWidthRef.current + delta)
    );
    latestPanelWidthRef.current = nextPanelWidth;
    setPanelWidth(nextPanelWidth);
  };

  const finishPanelResize = () => {
    if (!panelResizingRef.current) return;
    panelResizingRef.current = false;
    setIsPanelResizing(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (panelResizingSharedWidthRef.current) {
      panelResizingSharedWidthRef.current = false;
      return;
    }
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
    panelResizingSharedWidthRef.current =
      !embedded && usesSharedPanelWidth && !selectedFilePath && Boolean(onSharedPanelWidthChange);
    setIsPanelResizing(true);
    panelStartXRef.current = event.clientX;
    panelStartWidthRef.current = panelResizingSharedWidthRef.current
      ? visiblePanelWidth
      : panelWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const isCodePreviewSurface =
    !previewLoading &&
    !!selectedPreview &&
    (
      (selectedPreview.kind === 'markdown' && viewMode === 'code') ||
      (selectedPreview.kind === 'html' && viewMode === 'code') ||
      (selectedPreview.kind === 'text' && !selectedPreview.editable && selectedPreview.ext !== '.mdx')
    );
  const isMdxFilePreview =
    !previewLoading &&
    selectedPreview?.kind === 'text' &&
    selectedPreview.ext === '.mdx';
  const isMarkdownCodePreviewSurface =
    !previewLoading &&
    selectedPreview?.kind === 'markdown' &&
    viewMode === 'code';
  const isMarkdownPreviewSurface =
    !previewLoading &&
    selectedPreview?.kind === 'markdown' &&
    viewMode === 'view';
  const isMdxCodePreviewSurface =
    isMdxFilePreview &&
    viewMode === 'code';
  const isMdxPreviewSurface =
    isMdxFilePreview &&
    viewMode === 'view';
  const isMdxSplitPreviewSurface =
    isMdxFilePreview &&
    viewMode === 'split';
  const mdxDocumentModel = useMemo(
    () => (isMdxFilePreview ? parseMdxDocument(draftText) : null),
    [draftText, isMdxFilePreview]
  );
  const mdxIssueCount =
    (mdxDocumentModel?.issues.length ?? 0) +
    (mdxDocumentModel?.frontmatter?.parseError ? 1 : 0);

  const handleRevealMdxSource = useCallback((line: number) => {
    mdxRevealTokenRef.current += 1;
    setMdxRevealTarget({
      line,
      token: mdxRevealTokenRef.current,
    });
    setViewMode((current) => (current === 'split' ? 'split' : 'code'));
  }, []);

  const isEditableMarkdownPreview =
    isMarkdownPreviewSurface &&
    selectedPreview?.editable &&
    !!selectedFileCwd &&
    !!selectedFilePath;
  const activeOpenFileTab = activeFileTabId
    ? openFileTabs.find((tab) => tab.id === activeFileTabId) || null
    : null;
  const showProjectFileTabs = openFileTabs.length > 0;
  const showFilePreviewSurface = activeTab === 'files' && !!selectedFilePath;
  const canCopyWechat =
    selectedPreview?.kind === 'markdown' &&
    selectedPreview.editable &&
    !!selectedFilePath;
  const projectRootDropHoverId = visibleTree ? getNodeDropHoverId(visibleTree.path) : null;
  const isProjectRootDropTarget =
    !!projectRootDropHoverId && projectDropHoverId === projectRootDropHoverId;
  const isProjectRootExpanded =
    !!visibleTree && (expandedPaths.has(visibleTree.path) || initRootRef.current !== visibleTree.path);
  const projectRootName = visibleTree
    ? visibleTree.name || basenameOfPath(visibleTree.path)
    : cwd ? basenameOfPath(cwd) : 'Project';

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
        className={
          embedded
            ? `aegis-project-panel absolute inset-0 h-full min-h-0 min-w-0 bg-[var(--bg-primary)] font-sans ${
                collapsed ? 'hidden' : 'flex flex-col'
              }`
            : `aegis-project-panel relative flex h-full flex-col border-l border-[var(--tree-item-border)] bg-[var(--bg-primary)] font-sans transition-[width,opacity,transform,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                isFullscreen ? 'flex-1 min-w-0' : 'flex-shrink-0'
              } ${collapsed && !isFullscreen ? 'pointer-events-none' : ''}`
        }
        style={
          embedded
            ? useEmbeddedFilesGrid
              ? {
                  display: collapsed ? 'none' : 'grid',
                  gridTemplateColumns: `minmax(0, 1fr) ${projectRailWidth}px`,
                  gridTemplateRows: 'auto minmax(0, 1fr)',
                }
              : undefined
            : isFullscreen
            ? {
                width: 'auto',
                opacity: 1,
                transform: 'translateX(0)',
                borderLeftWidth: 1,
              }
            : {
                width: collapsed ? 0 : visiblePanelWidth,
                opacity: collapsed ? 0 : 1,
                transform: collapsed ? 'translateX(18px)' : 'translateX(0)',
                borderLeftWidth: collapsed ? 0 : 1,
              }
        }
        aria-hidden={collapsed && !isFullscreen}
      >
        {!embedded && !selectedFilePath && !isFullscreen && (
          <div
            className="group absolute left-0 top-0 bottom-0 z-10 w-3 -translate-x-1/2 cursor-col-resize no-drag"
            onMouseDown={handlePanelResizeStart}
          >
            <div className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 bg-transparent group-hover:bg-[var(--border)]" />
          </div>
        )}
        {!embedded && topInset > 0 ? (
          <div
            className="drag-region flex-shrink-0 bg-[var(--bg-primary)]"
            style={{ height: topInset }}
          />
        ) : !embedded && !selectedFilePath ? (
          <div className="h-8 drag-region flex-shrink-0 bg-[var(--bg-primary)]" />
        ) : null}
        {useEmbeddedFilesGrid && !selectedFilePath ? (
          <div
            className="flex min-h-0 min-w-0 flex-col items-center justify-center border-r border-[var(--tree-item-border)] bg-[var(--bg-primary)] px-8 text-center"
            style={{ gridColumn: 1, gridRow: '1 / span 2' }}
          >
            <FolderOpen className="mb-3 h-8 w-8 text-[var(--text-muted)]" aria-hidden="true" />
            <div className="text-sm font-medium text-[var(--text-primary)]">Open file</div>
            <div className="mt-1 text-xs text-[var(--text-muted)]">Select a file from the workspace tree</div>
          </div>
        ) : null}
        {useEmbeddedFilesGrid ? (
          <div
            className="group absolute bottom-0 top-0 z-10 w-3 -translate-x-1/2 cursor-col-resize no-drag"
            style={{ left: `calc(100% - ${projectRailWidth}px)` }}
            onMouseDown={handlePanelResizeStart}
          >
            <div className="absolute bottom-0 left-1/2 top-0 w-px -translate-x-1/2 bg-transparent group-hover:bg-[var(--border)]" />
          </div>
        ) : null}
        <div
          className="pl-4 pr-2 pt-2 pb-2"
          style={useEmbeddedFilesGrid ? { gridColumn: 2, gridRow: 1 } : undefined}
        >
          <div className="flex items-center justify-between gap-2">
            <div
              className="flex h-7 w-7 shrink-0 items-center justify-center text-[var(--text-muted)]"
              title={panelMeta.title}
              role="img"
              aria-label={`${panelMeta.title} panel`}
            >
              <PanelTitleIcon className="h-3.5 w-3.5" aria-hidden="true" />
            </div>
            <div className="flex items-center gap-0.5">
              {activeTab === 'files' && (
                <>
                <IconButton
                  label="New file"
                  size="sm"
                  onClick={() => startCreateEntry(getDefaultCreateParent(), 'file')}
                  disabled={!canUseProjectTree}
                >
                  <CreateEntryIcon kind="file" />
                </IconButton>
                <IconButton
                  label="New folder"
                  size="sm"
                  onClick={() => startCreateEntry(getDefaultCreateParent(), 'folder')}
                  disabled={!canUseProjectTree}
                >
                  <CreateEntryIcon kind="folder" />
                </IconButton>
                </>
              )}
            </div>
          </div>
          {!cwd && (
            <div className="text-xs text-[var(--text-muted)] mt-1">No folder selected</div>
          )}
        </div>

        <div
          className="flex-1 min-h-0 flex"
          style={useEmbeddedFilesGrid ? { gridColumn: 2, gridRow: 2, minHeight: 0 } : undefined}
        >
          <div
            className={`flex-1 overflow-auto px-2.5 pb-3 transition-colors duration-150 ${
              isProjectRootDropTarget ? 'bg-[var(--tree-item-hover)]' : ''
            }`}
            onDragOver={(event) => {
              if (activeTab === 'files' && visibleTree && projectRootDropHoverId) {
                handleDropTargetDragOver(event, visibleTree.path, projectRootDropHoverId);
              }
            }}
            onDragLeave={(event) => {
              if (activeTab === 'files' && projectRootDropHoverId) {
                handleDropTargetDragLeave(event, projectRootDropHoverId);
              }
            }}
            onDrop={(event) => {
              if (activeTab === 'files' && visibleTree) {
                handleProjectEntryDrop(event, visibleTree.path);
              }
            }}
            onContextMenu={(event) => {
              if (activeTab === 'files' && canUseProjectTree) {
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
                {cwd && visibleTree && !projectTreeError && (
                  <div className="mb-1">
                    <div
                      className={`flex min-h-[26px] items-center gap-2 rounded-[5px] px-1.5 py-[2px] text-[13px] transition-[background-color,color,box-shadow] duration-150 hover:bg-[var(--tree-item-hover)] ${
                        isProjectRootDropTarget
                          ? 'bg-[var(--tree-item-active)] shadow-[inset_0_0_0_1px_var(--tree-file-accent-fg)]'
                          : ''
                      }`}
                      style={{ paddingLeft: PROJECT_TREE_ROW_PADDING_LEFT_PX }}
                      onClick={() => togglePath(visibleTree.path)}
                      onDragOver={(event) => {
                        if (projectRootDropHoverId) {
                          handleDropTargetDragOver(event, visibleTree.path, projectRootDropHoverId);
                        }
                      }}
                      onDragLeave={(event) => {
                        if (projectRootDropHoverId) {
                          handleDropTargetDragLeave(event, projectRootDropHoverId);
                        }
                      }}
                      onDrop={(event) => handleProjectEntryDrop(event, visibleTree.path)}
                      onContextMenu={(event) => openProjectTreeContextMenu(event, visibleTree)}
                      role="button"
                      tabIndex={0}
                      aria-expanded={isProjectRootExpanded}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          togglePath(visibleTree.path);
                        }
                      }}
                    >
                      <ProjectTreeNodeIcon node={visibleTree} isExpanded={isProjectRootExpanded} />
                      <span
                        className="min-w-0 truncate font-semibold leading-[22px] text-[var(--text-primary)]"
                        title={visibleTree.path}
                      >
                        {projectRootName}
                      </span>
                    </div>
                  </div>
                )}
                {cwd && visibleTree && isProjectRootExpanded && visibleNodes.length > 0 && (
                  <div className="relative">
                    <span
                      className="pointer-events-none absolute bottom-1 top-0 w-px bg-[var(--tree-item-border)] opacity-[0.55]"
                      style={{
                        left: PROJECT_TREE_ROW_PADDING_LEFT_PX + PROJECT_TREE_GUIDE_OFFSET_PX,
                      }}
                      aria-hidden="true"
                    />
                    {createDraft?.parentPath === visibleTree.path ? (
                      <CreateEntryRow
                        depth={1}
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
                        depth={1}
                        parentPath={visibleTree.path}
                        expandedPaths={expandedPaths}
                        onToggle={togglePath}
                        onSelectFile={selectFile}
                        onOpenContextMenu={openProjectTreeContextMenu}
                        onProjectEntryDragStart={handleProjectEntryDragStart}
                        onProjectEntryDragEnd={handleProjectEntryDragEnd}
                        onTreeNodeDragOver={handleTreeNodeDragOver}
                        onTreeNodeDragLeave={handleTreeNodeDragLeave}
                        onTreeNodeDrop={handleTreeNodeDrop}
                        canDropEntryOnParent={canDropEntryOnParent}
                        selectedFilePath={selectedFilePath}
                        draggedEntry={draggedProjectEntry}
                        dropHoverId={projectDropHoverId}
                        movingEntryPath={movingProjectEntryPath}
                        forceExpand={false}
                        createDraft={createDraft}
                        onCreateDraftNameChange={handleCreateDraftNameChange}
                        onSubmitCreateDraft={submitCreateDraft}
                        onCancelCreateDraft={cancelCreateEntry}
                      />
                    ))}
                  </div>
                )}
                {cwd && visibleTree && visibleNodes.length === 0 && createDraft?.parentPath === visibleTree.path && (
                  <CreateEntryRow
                    depth={1}
                    draft={createDraft}
                    onNameChange={handleCreateDraftNameChange}
                    onSubmit={submitCreateDraft}
                    onCancel={cancelCreateEntry}
                  />
                )}
                {cwd && !loading && projectTreeError && (
                  <div className="text-sm text-[var(--text-muted)] px-1 py-2">
                    {projectTreeError}
                  </div>
                )}
                {cwd && !loading && !projectTreeError && (!visibleTree || (isProjectRootExpanded && visibleNodes.length === 0)) && !createDraft && (
                  <div className="text-sm text-[var(--text-muted)] px-1 py-2">
                    No files found.
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {showFilePreviewSurface && (
          <div
            className={
              useEmbeddedFilesGrid
                ? 'relative z-0 min-h-0 min-w-0 border-r border-[var(--tree-item-border)] bg-[var(--bg-primary)]'
                : 'absolute inset-y-0 z-20 border-l border-[var(--tree-item-border)] bg-[var(--bg-primary)] shadow-[-12px_0_32px_rgba(0,0,0,0.08)]'
            }
            style={
              useEmbeddedFilesGrid
                ? { gridColumn: 1, gridRow: '1 / span 2' }
                : isFullscreen
                ? { left: 0, right: 0, top: topInset, bottom: 0, width: 'auto' }
                : { right: 'calc(100% - 1px)', top: topInset, bottom: 0, width: previewPanelWidth }
            }
          >
            {!isFullscreen && !useEmbeddedFilesGrid && (
              <div
                className="group absolute left-0 top-0 bottom-0 w-3 -translate-x-1/2 cursor-col-resize no-drag"
                onMouseDown={handlePreviewResizeStart}
              >
                <div className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 bg-transparent group-hover:bg-[var(--border)]" />
              </div>
            )}

            <div className={`h-full min-w-0 flex flex-col ${showProjectFileTabs || isEditableMarkdownPreview ? '' : 'px-3 py-3'}`}>
              {showProjectFileTabs && (
                <div
                  className={`aegis-project-file-tabs${isFullscreen && !embedded ? ' window-controls-inset' : ''} drag-region flex h-11 flex-shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-primary)] pl-2 pr-2`}
                >
	                  <div className="no-drag flex min-w-0 max-w-full items-end overflow-x-auto">
	                    {openFileTabs.map((tab) => {
	                      const activeTab = tab.id === activeFileTabId;
	                      return (
	                        <button
	                          key={tab.id}
                          type="button"
                          onClick={() => void activateProjectFileTab(tab)}
                          className={`group flex h-9 max-w-[190px] min-w-[112px] items-center gap-1.5 rounded-t-[7px] border border-b-0 px-2.5 text-left text-xs transition-colors ${
                            activeTab
                              ? 'border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-[0_-1px_0_var(--bg-primary),0_1px_0_var(--bg-primary)]'
                              : 'border-transparent bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'
                          }`}
                          title={tab.filePath}
	                        >
	                          <FileTypeIcon name={tab.name} className="h-3.5 w-3.5 flex-shrink-0" fallbackClassName="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-secondary)]" />
	                          <span className="min-w-0 flex-1 truncate">{tab.name}</span>
	                          <span
                            role="button"
                            tabIndex={0}
                            aria-label={`Close ${tab.name}`}
                            className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-[4px] text-[var(--text-muted)] opacity-70 transition-opacity hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] group-hover:opacity-100"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              void closeProjectFileTab(tab.id);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                event.stopPropagation();
                                void closeProjectFileTab(tab.id);
                              }
                            }}
                          >
                            <X className="h-3 w-3" aria-hidden="true" />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="min-w-4 flex-1 self-stretch" aria-hidden="true" />

                  <div className="no-drag flex flex-shrink-0 items-center gap-1">
                    {(selectedPreview?.kind === 'html' || isMdxFilePreview) && (
                      <ViewModeToggle
                        value={viewMode}
                        onChange={setViewMode}
                        options={
                          isMdxFilePreview
                            ? [
                                { value: 'code', label: 'Source', title: 'Edit source' },
                                { value: 'view', label: 'Preview', title: 'Preview MDX' },
                                { value: 'split', label: 'Split', title: 'Source and preview' },
                              ]
                            : undefined
                        }
                      />
	                    )}

	                    {canCopyWechat && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className="inline-flex h-7 items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
                            title="WeChat Theme"
                            aria-label="WeChat Theme"
                          >
                            <span>WeChat Theme</span>
                            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" sideOffset={6}>
                          <DropdownMenuItem onSelect={() => void handleCopyWechatHtml('bubblebrain')}>
                            <span>BubbleBrain</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => void handleCopyWechatHtml('lapis')}>
                            <span>Lapis</span>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={wechatAiGeneratingTheme !== null}
                            onSelect={() => void handleCopyAiWechatHtml('black-red-imprint', 'Black Red Imprint')}
                          >
                            <span>
                              {wechatAiGeneratingTheme === 'black-red-imprint'
                                ? 'Black Red Imprint generating...'
                                : 'Black Red Imprint (AI)'}
                            </span>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={wechatAiGeneratingTheme !== null}
                            onSelect={() => void handleCopyAiWechatHtml('black-orange-imprint', 'Black Orange Imprint')}
                          >
                            <span>
                              {wechatAiGeneratingTheme === 'black-orange-imprint'
                                ? 'Black Orange Imprint generating...'
                                : 'Black Orange Imprint (AI)'}
                            </span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
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
                      onClick={() => void closeAllProjectFileTabs()}
                      tooltip="Close all tabs"
                      label="Close all tabs"
                    >
                      <X className="w-4 h-4" />
                    </IconButton>
                  </div>
                </div>
              )}

              {!showProjectFileTabs && !isEditableMarkdownPreview ? (
                <div className="drag-region flex items-center justify-between gap-2 pb-2">
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
                    {(selectedPreview?.kind === 'html' || isMdxFilePreview) && (
                      <ViewModeToggle
                        value={viewMode}
                        onChange={setViewMode}
                        options={
                          isMdxFilePreview
                            ? [
                                { value: 'code', label: 'Source', title: 'Edit source' },
                                { value: 'view', label: 'Preview', title: 'Preview MDX' },
                                { value: 'split', label: 'Split', title: 'Source and preview' },
                              ]
                            : undefined
                        }
                      />
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
                      onClick={() => {
                        const isTxt =
                          selectedPreview?.kind === 'text' &&
                          selectedPreview.name?.toLowerCase().endsWith('.txt');
                        handleCopyPath(isTxt ? selectedPreview.text : selectedFilePath);
                      }}
                      tooltip={copiedPath ? 'Copied' : (selectedPreview?.name?.toLowerCase().endsWith('.txt') ? 'Copy content' : 'Copy path')}
                      label={selectedPreview?.name?.toLowerCase().endsWith('.txt') ? 'Copy content' : 'Copy path'}
                    >
                      {copiedPath ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </IconButton>
                  </div>
                </div>
              ) : null}

              <div
                className={`flex-1 min-h-0 overflow-auto ${
                  isMarkdownCodePreviewSurface
                    ? 'bg-[var(--bg-primary)] p-0'
                    : isMdxFilePreview
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
	                    viewportWidth={useEmbeddedFilesGrid ? projectPreviewViewportWidth : previewPanelWidth}
	                  />
	                )}

                {!previewLoading && selectedPreview?.kind === 'markdown' && (
                  selectedPreview.editable && selectedFileCwd && selectedFilePath ? (
                    <ProjectMarkdownEditor
                      value={draftText}
                      cwd={selectedFileCwd}
                      filePath={selectedFilePath}
                      fileName={selectedPreview.name}
                      hideTitleBar
                      windowControlsInset={isFullscreen && !embedded}
                      saveState={saveState}
                      saveError={saveError}
                      onChange={handleDraftTextChange}
                      onSave={handleSaveText}
                      onRegisterBridge={registerMarkdownBridge}
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
                    {isMdxCodePreviewSurface ? (
                      <div className="aegis-mdx-editor-shell">
                        <ProjectMdxProperties
                          content={draftText}
                          onChange={handleDraftTextChange}
                          onRevealSource={handleRevealMdxSource}
                          compact
                        />
                        <div className="aegis-mdx-source-fill">
                          <ProjectTextEditor
                            ref={registerTextEditorBridge}
                            value={draftText}
                            onChange={handleDraftTextChange}
                            onSave={() => handleSaveText()}
                            revealTarget={mdxRevealTarget}
                          />
                        </div>
	                        <MdxStatusBar
	                          saveState={saveState}
	                          saveError={saveError}
	                          issueCount={mdxIssueCount}
                        />
                      </div>
                    ) : isMdxPreviewSurface ? (
                      <ProjectMdxPreview
                        content={draftText}
                        onChange={handleDraftTextChange}
                        onRevealSource={handleRevealMdxSource}
                      />
                    ) : isMdxSplitPreviewSurface ? (
                      <div className="aegis-mdx-split">
                        <div className="aegis-mdx-split-pane aegis-mdx-split-source">
                          <ProjectMdxProperties
                            content={draftText}
                            onChange={handleDraftTextChange}
                            onRevealSource={handleRevealMdxSource}
                            compact
                          />
                          <div className="aegis-mdx-source-fill">
                            <ProjectTextEditor
                              ref={registerTextEditorBridge}
                              value={draftText}
                              onChange={handleDraftTextChange}
                              onSave={() => handleSaveText()}
                              revealTarget={mdxRevealTarget}
                            />
                          </div>
	                          <MdxStatusBar
	                            saveState={saveState}
	                            saveError={saveError}
	                            issueCount={mdxIssueCount}
                          />
                        </div>
                        <div className="aegis-mdx-split-pane aegis-mdx-split-preview">
                          <ProjectMdxPreview
                            content={draftText}
                            onChange={handleDraftTextChange}
                            onRevealSource={handleRevealMdxSource}
                            showProperties={false}
                          />
                        </div>
                      </div>
                    ) : selectedPreview.editable ? (
                      <ProjectTextEditor
                        ref={registerTextEditorBridge}
                        value={draftText}
                        onChange={handleDraftTextChange}
                        onSave={() => handleSaveText()}
                      />
                    ) : selectedPreview.name?.toLowerCase().endsWith('.txt') ? (
                      <TextFileReader
                        text={selectedPreview.text}
                        fileName={selectedPreview.name}
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

function MdxStatusBar({
  saveState,
  saveError,
  issueCount,
}: {
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  saveError: string | null;
  issueCount: number;
}) {
  const previewLabel = issueCount > 0 ? `${issueCount} degraded` : 'Preview ready';

  return (
    <div className="aegis-mdx-statusbar">
      <span>MDX</span>
      {saveState === 'error' ? <span className="is-attention">Save failed</span> : null}
      <span className={issueCount > 0 ? 'is-attention' : ''}>{previewLabel}</span>
      {saveError ? <span className="is-error">{saveError}</span> : null}
    </div>
  );
}

function ViewModeToggle({
  value,
  onChange,
  options = [
    { value: 'view', label: 'View', title: 'View' },
    { value: 'code', label: 'Code', title: 'Code' },
  ],
}: {
  value: ViewMode;
  onChange: (next: ViewMode) => void;
  options?: Array<{ value: ViewMode; label: string; title: string }>;
}) {
  return (
    <div className="mr-1 flex items-center overflow-hidden rounded-lg border border-[var(--border)]">
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          className={`px-2 py-1 text-xs ${
            value === option.value
              ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
              : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
          }`}
          title={option.title}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
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

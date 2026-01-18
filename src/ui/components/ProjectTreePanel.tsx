import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import type { ProjectTreeNode } from '../types';

function TreeNode({
  node,
  depth,
  expandedPaths,
  onToggle,
  forceExpand,
}: {
  node: ProjectTreeNode;
  depth: number;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
  forceExpand: boolean;
}) {
  const isDir = node.kind === 'dir';
  const isExpanded = forceExpand || expandedPaths.has(node.path);
  const chevron = isDir ? (isExpanded ? 'v' : '>') : '';
  const isImageFile = !isDir && isImageName(node.name);

  return (
    <>
      <div
        className={`flex items-center gap-2 py-0.5 text-sm rounded-md ${
          isDir ? 'cursor-pointer hover:bg-[var(--bg-tertiary)]' : ''
        }`}
        style={{ paddingLeft: depth * 12 }}
        onClick={() => {
          if (isDir) {
            onToggle(node.path);
          }
        }}
        role={isDir ? 'button' : undefined}
        tabIndex={isDir ? 0 : -1}
        onKeyDown={(e) => {
          if (!isDir) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle(node.path);
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
  const defaultWidth = 288;
  const minWidth = 220;
  const maxWidth = 520;
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
        {cwd && visibleTree && (
          <TreeNode
            node={visibleTree}
            depth={0}
            expandedPaths={expandedPaths}
            onToggle={togglePath}
            forceExpand={false}
          />
        )}
        {cwd && !loading && !visibleTree && (
          <div className="text-sm text-[var(--text-muted)] px-1 py-2">
            No files found.
          </div>
        )}
      </div>
    </div>
  );
}

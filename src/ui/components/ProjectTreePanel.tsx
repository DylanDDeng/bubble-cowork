import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import type { ProjectTreeNode } from '../types';

function shortenPath(path: string): string {
  const homePrefix = '/Users/';
  if (path.startsWith(homePrefix)) {
    const parts = path.slice(homePrefix.length).split('/');
    if (parts.length > 2) {
      return `~/.../${parts.slice(-2).join('/')}`;
    }
    return `~/${parts.join('/')}`;
  }
  return path;
}

function filterTree(node: ProjectTreeNode, query: string): ProjectTreeNode | null {
  if (!query) return node;
  const normalized = query.toLowerCase();
  const nameMatch = node.name.toLowerCase().includes(normalized);
  if (!node.children || node.children.length === 0) {
    return nameMatch ? node : null;
  }
  const filteredChildren = node.children
    .map((child) => filterTree(child, query))
    .filter((child): child is ProjectTreeNode => Boolean(child));
  if (nameMatch || filteredChildren.length > 0) {
    return { ...node, children: filteredChildren };
  }
  return null;
}

function TreeNode({
  node,
  depth,
}: {
  node: ProjectTreeNode;
  depth: number;
}) {
  const isDir = node.kind === 'dir';
  return (
    <>
      <div
        className="flex items-center gap-2 py-0.5 text-sm"
        style={{ paddingLeft: depth * 12 }}
      >
        <span className="text-[var(--text-muted)] text-xs w-3">
          {isDir ? '>' : ''}
        </span>
        <span
          className={`truncate ${isDir ? 'font-medium' : 'text-[var(--text-secondary)]'}`}
          title={node.name}
        >
          {node.name}
        </span>
      </div>
      {isDir &&
        node.children?.map((child) => (
          <TreeNode key={child.path} node={child} depth={depth + 1} />
        ))}
    </>
  );
}

export function ProjectTreePanel() {
  const {
    activeSessionId,
    sessions,
    projectCwd,
    projectTree,
    projectTreeCwd,
    projectTreeSearch,
    setProjectTree,
    setProjectTreeSearch,
  } = useAppStore();
  const [loading, setLoading] = useState(false);
  const prevCwdRef = useRef<string | null>(null);

  const activeCwd = activeSessionId ? sessions[activeSessionId]?.cwd : null;
  const cwd = activeCwd || projectCwd || null;

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
    return filterTree(projectTree, projectTreeSearch);
  }, [cwd, projectTree, projectTreeCwd, projectTreeSearch]);

  return (
    <div className="w-72 bg-[var(--bg-secondary)] border-l border-[var(--border)] flex flex-col h-full">
      <div className="h-8 drag-region" />
      <div className="px-4 pt-2 pb-2">
        <div className="text-xs text-[var(--text-muted)]">Project files</div>
        {cwd ? (
          <div
            className="text-xs text-[var(--text-secondary)] truncate"
            title={cwd}
          >
            {shortenPath(cwd)}
          </div>
        ) : (
          <div className="text-xs text-[var(--text-muted)]">No folder selected</div>
        )}
      </div>

      <div className="px-4 pb-3">
        <div className="relative">
          <input
            value={projectTreeSearch}
            onChange={(e) => setProjectTreeSearch(e.target.value)}
            placeholder="Search files"
            className="w-full h-9 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] text-sm px-3 pr-8 outline-none focus:border-[var(--accent)]"
            disabled={!cwd}
          />
          {projectTreeSearch && (
            <button
              onClick={() => setProjectTreeSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
              aria-label="Clear search"
            >
              x
            </button>
          )}
        </div>
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
          <TreeNode node={visibleTree} depth={0} />
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

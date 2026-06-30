import { GitFork } from './icons';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { ChatPane } from './ChatPane';
import {
  type LeafNode,
  type PaneNode,
  type SplitEdge,
  type SplitNode,
  allLeaves,
} from '../store/layout-tree';

const SESSION_DND_TYPE = 'application/x-aegis-session-id';
const MIN_PANE_PX = 240;

// Diagonal quadrants: the nearest edge (no center "replace" zone). A drop near
// an edge splits the pane in that direction.
function computeDropEdge(rect: DOMRect, clientX: number, clientY: number): SplitEdge {
  const xf = (clientX - rect.left) / Math.max(rect.width, 1);
  const yf = (clientY - rect.top) / Math.max(rect.height, 1);
  const distLeft = xf;
  const distRight = 1 - xf;
  const distTop = yf;
  const distBottom = 1 - yf;
  const min = Math.min(distLeft, distRight, distTop, distBottom);
  if (min === distLeft) return 'left';
  if (min === distRight) return 'right';
  if (min === distTop) return 'top';
  return 'bottom';
}

function edgeHighlightClass(edge: SplitEdge): string {
  switch (edge) {
    case 'left':
      return 'left-0 top-0 bottom-0 w-1/2';
    case 'right':
      return 'right-0 top-0 bottom-0 w-1/2';
    case 'top':
      return 'left-0 right-0 top-0 h-1/2';
    case 'bottom':
      return 'left-0 right-0 bottom-0 h-1/2';
  }
}

interface SharedPaneProps {
  codexModelConfig: import('../types').CodexModelConfig;
  onWorkspaceGitChanged?: () => Promise<void>;
}

const LeafPane = memo(function LeafPane({
  leaf,
  canClose,
  codexModelConfig,
  onWorkspaceGitChanged,
}: SharedPaneProps & { leaf: LeafNode; canClose: boolean }) {
  const activePaneId = useAppStore((s) => s.workspaceLayout.activePaneId);
  const splitPaneAt = useAppStore((s) => s.splitPaneAt);
  const placeSessionInPane = useAppStore((s) => s.placeSessionInPane);
  const setActivePaneById = useAppStore((s) => s.setActivePaneById);
  const closePaneById = useAppStore((s) => s.closePaneById);
  const forkSessionToPane = useAppStore((s) => s.forkSessionToPane);
  const session = useAppStore((s) => (leaf.sessionId ? s.sessions[leaf.sessionId] : null));
  // Forking branches a Claude conversation; only available once it has a
  // resumable session id (i.e. after the first turn) and not for drafts.
  const canFork = Boolean(
    session && !session.isDraft && session.provider === 'claude' && session.claudeSessionId
  );

  const ref = useRef<HTMLDivElement>(null);
  const [dropEdge, setDropEdge] = useState<SplitEdge | null>(null);
  const [dropFill, setDropFill] = useState(false);
  const isActive = activePaneId === leaf.id;
  const isEmpty = leaf.sessionId === null;

  const clearDrop = useCallback(() => {
    setDropEdge(null);
    setDropFill(false);
  }, []);

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes(SESSION_DND_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (isEmpty) {
        setDropFill(true);
        setDropEdge(null);
        return;
      }
      const rect = ref.current?.getBoundingClientRect();
      if (rect) setDropEdge(computeDropEdge(rect, event.clientX, event.clientY));
    },
    [isEmpty]
  );

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    setDropEdge(null);
    setDropFill(false);
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const sessionId = event.dataTransfer.getData(SESSION_DND_TYPE);
      if (!sessionId) return;
      event.preventDefault();
      event.stopPropagation();
      if (isEmpty) {
        placeSessionInPane(leaf.id, sessionId);
      } else {
        const rect = ref.current?.getBoundingClientRect();
        const edge = rect ? computeDropEdge(rect, event.clientX, event.clientY) : 'right';
        splitPaneAt(leaf.id, edge, sessionId);
      }
      clearDrop();
    },
    [clearDrop, isEmpty, leaf.id, placeSessionInPane, splitPaneAt]
  );

  return (
    <div
      ref={ref}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <ChatPane
        paneId={leaf.id}
        sessionId={leaf.sessionId}
        isActive={isActive}
        onActivate={() => setActivePaneById(leaf.id)}
        codexModelConfig={codexModelConfig}
        onClose={canClose ? () => closePaneById(leaf.id) : undefined}
        headerActions={
          canFork ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                if (leaf.sessionId) void forkSessionToPane(leaf.sessionId);
              }}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
              aria-label="Fork conversation into a new pane"
              title="Fork into a new pane"
            >
              <GitFork className="h-3.5 w-3.5" />
            </button>
          ) : undefined
        }
        onWorkspaceGitChanged={onWorkspaceGitChanged}
      />
      {dropFill ? (
        <div className="pointer-events-none absolute inset-4 z-20 rounded-[var(--radius-2xl)] border-2 border-dashed border-[color-mix(in_srgb,var(--accent)_45%,transparent)] bg-[color-mix(in_srgb,var(--accent-light)_75%,transparent)]" />
      ) : null}
      {dropEdge ? (
        <div
          className={`pointer-events-none absolute z-20 ${edgeHighlightClass(
            dropEdge
          )} border-2 border-dashed border-[color-mix(in_srgb,var(--accent)_45%,transparent)] bg-[color-mix(in_srgb,var(--accent-light)_70%,transparent)]`}
        />
      ) : null}
    </div>
  );
});

function SplitContainer({
  node,
  codexModelConfig,
  onWorkspaceGitChanged,
  canCloseLeaves,
}: SharedPaneProps & { node: SplitNode; canCloseLeaves: boolean }) {
  const resizeSplitById = useAppStore((s) => s.resizeSplitById);
  const [liveSizes, setLiveSizes] = useState<number[] | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isRow = node.orientation === 'row';
  const sizes = liveSizes ?? node.sizes;

  const startResize = useCallback(
    (index: number, event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const container = containerRef.current;
      if (!container) return;
      const total = isRow ? container.clientWidth : container.clientHeight;
      const startPos = isRow ? event.clientX : event.clientY;
      const base = [...node.sizes];
      document.body.style.cursor = isRow ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';

      const minFrac = total > 0 ? MIN_PANE_PX / total : 0.1;
      const pairSum = base[index] + base[index + 1];

      const onMove = (moveEvent: MouseEvent) => {
        const pos = isRow ? moveEvent.clientX : moveEvent.clientY;
        const deltaFrac = total > 0 ? (pos - startPos) / total : 0;
        let first = base[index] + deltaFrac;
        first = Math.max(minFrac, Math.min(pairSum - minFrac, first));
        const next = [...base];
        next[index] = first;
        next[index + 1] = pairSum - first;
        setLiveSizes(next);
      };
      const finish = () => {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', finish);
        window.removeEventListener('blur', finish);
        setLiveSizes((current) => {
          if (current) resizeSplitById(node.id, current);
          return null;
        });
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', finish, { once: true });
      window.addEventListener('blur', finish, { once: true });
    },
    [isRow, node.id, node.sizes, resizeSplitById]
  );

  return (
    <div
      ref={containerRef}
      className={`flex min-h-0 min-w-0 flex-1 overflow-hidden ${isRow ? 'flex-row' : 'flex-col'}`}
    >
      {node.children.map((child, index) => (
        <div
          key={child.id}
          className="relative flex min-h-0 min-w-0 overflow-hidden"
          style={{ flexBasis: `${sizes[index] * 100}%`, flexGrow: 0, flexShrink: 0 }}
        >
          <PaneRenderer
            node={child}
            codexModelConfig={codexModelConfig}
            onWorkspaceGitChanged={onWorkspaceGitChanged}
            canCloseLeaves={canCloseLeaves}
          />
          {index < node.children.length - 1 ? (
            <div
              className={`group absolute z-10 ${
                isRow
                  ? 'right-0 top-0 bottom-0 w-2 -mr-1 cursor-col-resize'
                  : 'left-0 right-0 bottom-0 h-2 -mb-1 cursor-row-resize'
              }`}
              onMouseDown={(event) => startResize(index, event)}
            >
              <div
                className={`absolute bg-[var(--panel-soft-divider)] opacity-0 transition-opacity group-hover:opacity-100 ${
                  isRow ? 'inset-y-6 left-1/2 w-px -translate-x-1/2' : 'inset-x-6 top-1/2 h-px -translate-y-1/2'
                }`}
              />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function PaneRenderer({
  node,
  codexModelConfig,
  onWorkspaceGitChanged,
  canCloseLeaves,
}: SharedPaneProps & { node: PaneNode; canCloseLeaves: boolean }) {
  if (node.type === 'leaf') {
    return (
      <LeafPane
        leaf={node}
        canClose={canCloseLeaves}
        codexModelConfig={codexModelConfig}
        onWorkspaceGitChanged={onWorkspaceGitChanged}
      />
    );
  }
  return (
    <SplitContainer
      node={node}
      codexModelConfig={codexModelConfig}
      onWorkspaceGitChanged={onWorkspaceGitChanged}
      canCloseLeaves={canCloseLeaves}
    />
  );
}

export function WorkspaceHost({
  codexModelConfig,
  onWorkspaceGitChanged,
}: {
  codexModelConfig: import('../types').CodexModelConfig;
  onWorkspaceGitChanged?: () => Promise<void>;
  // Kept for call-site compatibility; the tree now owns all panes.
  dockSecondaryPane?: boolean;
}) {
  const root = useAppStore((s) => s.workspaceLayout.root);
  const canCloseLeaves = useMemo(() => allLeaves(root).length > 1, [root]);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <PaneRenderer
        node={root}
        codexModelConfig={codexModelConfig}
        onWorkspaceGitChanged={onWorkspaceGitChanged}
        canCloseLeaves={canCloseLeaves}
      />
    </div>
  );
}

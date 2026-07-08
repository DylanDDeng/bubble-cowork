// Renderer ↔ main contracts for design mode.

export interface DesignModeTarget {
  /** Browser session id (owns the WebContentsView). */
  sessionId: string;
  tabId: string;
}

export interface DesignSourceRef {
  file: string;
  line: number;
  column: number | null;
  tier: 'fiber' | 'attr';
}

export interface DesignSelectionInfo {
  tagName: string;
  className: string;
  text: string;
  source: DesignSourceRef | null;
  siblingIndex: number;
  chain: string[];
  computed: Record<string, string>;
  rect: { x: number; y: number; w: number; h: number };
}

export interface DesignCapabilities {
  reactFiber: boolean;
  hmrClient: boolean;
  localhost: boolean;
}

export interface DesignCssEdit {
  property: string;
  value: string;
}

export interface DesignApplyInput extends DesignModeTarget {
  projectRoot: string;
  filePath: string;
  anchor: {
    line: number;
    tagName: string;
    siblingIndex: number;
    classNameSnapshot: string | null;
    /** Fiber debugSource column (toolchain-dependent convention) for sourcemap remap. */
    column?: number | null;
  };
  edits: DesignCssEdit[];
  variantHint?: string | null;
}

export interface DesignApplyResult {
  outcome: 'refused' | 'verified' | 'unverified' | 'failed' | 'rolled-back' | 'error';
  reason?: string;
  detail?: string;
  strategy?: string;
  addedClasses?: string[];
  /**
   * The element's className after a KEPT write (measured from the DOM when
   * available, else the merged source value). The drawer must adopt this as
   * the new selection snapshot or the next Apply is refused as stale-anchor.
   */
  updatedSnapshot?: string;
  /** Authoritative undo-stack depth after this transaction. */
  undoDepth: number;
  canUndo: boolean;
  canRollback: boolean;
}

export type DesignModeEvent =
  | { kind: 'selection'; sessionId: string; tabId: string; info: DesignSelectionInfo }
  | { kind: 'annotate'; sessionId: string; tabId: string; note: string; info: DesignSelectionInfo }
  | { kind: 'open-styles'; sessionId: string; tabId: string }
  | { kind: 'enabled'; sessionId: string; tabId: string; capabilities: DesignCapabilities }
  | { kind: 'disabled'; sessionId: string; tabId: string; reason: string }
  | { kind: 'reinjected'; sessionId: string; tabId: string };

export interface DesignEnableResult {
  ok: boolean;
  message?: string;
  capabilities?: DesignCapabilities;
}

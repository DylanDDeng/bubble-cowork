// Renderer ↔ main contracts for design mode.
//
// Design mode is WRITE-FREE by product decision: the agent is the only
// writer of user source files. These types cover selection, annotate intent
// capture, and screenshot geometry only.

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

export type DesignModeEvent =
  | { kind: 'selection'; sessionId: string; tabId: string; info: DesignSelectionInfo }
  | {
      kind: 'annotate';
      sessionId: string;
      tabId: string;
      note: string;
      info: DesignSelectionInfo;
      /** Page viewport at SUBMIT time — crop geometry travels with the event. */
      viewport?: { w: number; h: number };
    }
  | { kind: 'enabled'; sessionId: string; tabId: string; capabilities: DesignCapabilities }
  | { kind: 'disabled'; sessionId: string; tabId: string; reason: string }
  | { kind: 'reinjected'; sessionId: string; tabId: string };

export interface DesignEnableResult {
  ok: boolean;
  message?: string;
  capabilities?: DesignCapabilities;
  /**
   * Ownership token for this design session. disable() with a token is a
   * no-op unless the current session still carries it — a stale disable
   * (from an outdated enable resolution) must never tear down a successor.
   */
  token?: number;
}

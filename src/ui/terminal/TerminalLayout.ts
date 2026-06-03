export type TerminalLayoutPane = {
  id: string;
  terminalId: string;
  size: number;
};

export type TerminalLayoutState = {
  panes: TerminalLayoutPane[];
  activePaneId: string | null;
};

export function createSingleTerminalLayout(terminalId: string): TerminalLayoutState {
  return {
    panes: [{ id: `pane-${terminalId}`, terminalId, size: 1 }],
    activePaneId: `pane-${terminalId}`,
  };
}

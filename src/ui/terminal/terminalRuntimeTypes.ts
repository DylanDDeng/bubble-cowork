import type { IDisposable, Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { LigaturesAddon } from '@xterm/addon-ligatures';
import type { Unicode11Addon } from '@xterm/addon-unicode11';
import type { WebglAddon } from '@xterm/addon-webgl';
import type { SearchAddon } from '@xterm/addon-search';
import type { ClipboardAddon } from '@xterm/addon-clipboard';
import type { ImageAddon } from '@xterm/addon-image';
import type {
  TerminalActivityEvent,
  TerminalAgentKind,
  TerminalEventPayload,
  TerminalSessionSnapshot,
} from '../../shared/terminal';
import { buildTerminalRuntimeKey as buildSharedTerminalRuntimeKey } from '../../shared/terminal';

export type TerminalRuntimeCallbacks = {
  onSnapshot?: (snapshot: TerminalSessionSnapshot) => void;
  onEvent?: (event: TerminalEventPayload) => void;
  onActivity?: (event: TerminalActivityEvent) => void;
  onExit?: (exitCode: number | null, exitSignal: number | string | null) => void;
  onError?: (message: string) => void;
};

export type TerminalRuntimeConfig = {
  runtimeKey: string;
  threadId: string;
  terminalId: string;
  cwd: string;
  agentKind: TerminalAgentKind;
  initialCommand?: string | null;
  initialNotice?: string | null;
  callbacks?: TerminalRuntimeCallbacks;
};

export type TerminalRuntimeViewState = {
  isVisible: boolean;
  isActive: boolean;
};

export type TerminalResize = {
  cols: number;
  rows: number;
};

export type TerminalRuntimeEntry = {
  runtimeKey: string;
  threadId: string;
  terminalId: string;
  cwd: string;
  agentKind: TerminalAgentKind;
  initialCommand: string | null;
  initialNotice: string | null;
  callbacks: TerminalRuntimeCallbacks;
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  unicodeAddon: Unicode11Addon;
  ligaturesAddon: LigaturesAddon | null;
  clipboardAddon: ClipboardAddon | null;
  imageAddon: ImageAddon | null;
  webglAddon: WebglAddon | null;
  webglLoadFrame: number | null;
  dataDisposable: IDisposable | null;
  eventDispose: (() => void) | null;
  container: HTMLDivElement | null;
  viewState: TerminalRuntimeViewState;
  opened: boolean;
  backendOpen: boolean;
  backendExited: boolean;
  launchCommandSent: boolean;
  pendingWrites: string[];
  pendingWriteLength: number;
  writeRafHandle: number | null;
  writeFlushTimeout: number | null;
  deferredWrites: string[];
  deferredWriteLength: number;
  pendingResize: TerminalResize | null;
  lastSentResize: TerminalResize | null;
  resizeDispatchTimer: number | null;
  visualResizeFrame: number | null;
  visualResizeTimer: number | null;
  lastVisualResizeAt: number;
  visibilityCleanup: (() => void) | null;
};

export function buildTerminalRuntimeKey(threadId: string, terminalId: string): string {
  return buildSharedTerminalRuntimeKey(threadId, terminalId);
}

export const AEGIS_COMPUTER_USE_SERVER_NAME = 'aegis-computer-use';
export const CODEX_COMPUTER_USE_SERVER_NAME = 'computer-use';
export const NODE_REPL_SERVER_NAME = 'node_repl';

export const COMPUTER_USE_READ_ONLY_TOOLS = ['list_apps', 'get_app_state'] as const;
export const COMPUTER_USE_MUTATING_TOOLS = [
  'click',
  'perform_secondary_action',
  'set_value',
  'select_text',
  'scroll',
  'drag',
  'press_key',
  'type_text',
] as const;
export const COMPUTER_USE_TOOLS = [
  ...COMPUTER_USE_READ_ONLY_TOOLS,
  ...COMPUTER_USE_MUTATING_TOOLS,
] as const;

export type ComputerUseActionKind =
  | (typeof COMPUTER_USE_TOOLS)[number]
  | 'script'
  | 'unknown';

export interface ComputerUseMediaRef {
  path: string;
  mimeType: string;
  sha256: string;
  sizeBytes: number;
}

export interface ComputerUseAction {
  kind: ComputerUseActionKind;
  mutating: boolean;
  app: string | null;
  title: string | null;
  server: string | null;
  tool: string | null;
}

export const AEGIS_COMPUTER_USE_DENIED_APP_IDS = [
  'com.aegis.desktop',
  'com.github.Electron',
] as const;

const AEGIS_DENIED_APP_NAMES = new Set(['aegis', 'electron', 'aegis dev']);

export function isComputerUseMutatingTool(tool: string | null | undefined): boolean {
  const normalized = (tool || '').trim().toLowerCase();
  return (COMPUTER_USE_MUTATING_TOOLS as readonly string[]).includes(normalized);
}

export function isComputerUseReadOnlyTool(tool: string | null | undefined): boolean {
  const normalized = (tool || '').trim().toLowerCase();
  return (COMPUTER_USE_READ_ONLY_TOOLS as readonly string[]).includes(normalized);
}

export function parseMcpToolName(
  toolName: string
): { server: string; tool: string } | null {
  const match = /^mcp__([^_].*)__([^_].*)$/.exec(toolName);
  if (!match) return null;
  return { server: match[1], tool: match[2] };
}

export function isComputerUseServerName(server: string | null | undefined): boolean {
  const normalized = (server || '').trim().toLowerCase();
  return (
    normalized === AEGIS_COMPUTER_USE_SERVER_NAME ||
    normalized === CODEX_COMPUTER_USE_SERVER_NAME
  );
}

export function isNodeReplServerName(server: string | null | undefined): boolean {
  return (server || '').trim().toLowerCase() === NODE_REPL_SERVER_NAME;
}

export function isDeniedComputerUseTarget(app: string | null | undefined): boolean {
  const raw = (app || '').trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  if (AEGIS_COMPUTER_USE_DENIED_APP_IDS.some((id) => id.toLowerCase() === lower)) {
    return true;
  }
  if (AEGIS_DENIED_APP_NAMES.has(lower)) return true;
  if (lower.includes('com.aegis.') || lower.endsWith('.aegis.desktop')) return true;
  return false;
}

export function classifyComputerUseAction(input: {
  toolName?: string | null;
  server?: string | null;
  tool?: string | null;
  app?: string | null;
  title?: string | null;
}): ComputerUseAction | null {
  const parsed = input.toolName ? parseMcpToolName(input.toolName) : null;
  const server = input.server || parsed?.server || null;
  const tool = input.tool || parsed?.tool || null;
  if (!isComputerUseServerName(server) && !isNodeReplServerName(server)) {
    if (tool && isComputerUseServerName(input.toolName)) {
      // fall through for bare computer-use tool names
    } else if (!tool || !isComputerUseActionKind(tool)) {
      return null;
    }
  }

  if (isNodeReplServerName(server) && (tool === 'js' || tool == null)) {
    return {
      kind: 'script',
      mutating: true,
      app: input.app || null,
      title: input.title || null,
      server,
      tool: tool || 'js',
    };
  }

  const kind = isComputerUseActionKind(tool) ? tool : 'unknown';
  return {
    kind,
    mutating: kind === 'unknown' ? true : isComputerUseMutatingTool(kind),
    app: input.app || null,
    title: input.title || null,
    server,
    tool,
  };
}

export function isComputerUseActionKind(value: string | null | undefined): value is ComputerUseActionKind {
  const normalized = (value || '').trim();
  return (
    (COMPUTER_USE_TOOLS as readonly string[]).includes(normalized) ||
    normalized === 'script' ||
    normalized === 'unknown'
  );
}

export function formatComputerUseLabel(
  action: ComputerUseAction,
  status: 'pending' | 'success' | 'error' | 'interrupted' = 'pending'
): string {
  if (action.title && action.title.trim()) {
    return action.title.trim();
  }

  const app = action.app?.trim() || null;
  const done = status === 'success';
  const failed = status === 'error';
  const interrupted = status === 'interrupted';
  const prefix = failed ? 'Failed to ' : interrupted ? 'Interrupted ' : done ? '' : '';
  const progressive = !done && !failed && !interrupted;

  switch (action.kind) {
    case 'list_apps':
      return progressive ? 'Listing apps' : `${prefix}${done ? 'Listed apps' : 'list apps'}`;
    case 'get_app_state':
      return app
        ? progressive
          ? `Looking at ${app}`
          : `${prefix}${done ? `Looked at ${app}` : `look at ${app}`}`
        : progressive
          ? 'Looking at the screen'
          : `${prefix}${done ? 'Looked at the screen' : 'look at the screen'}`;
    case 'click':
      return app
        ? progressive
          ? `Clicking in ${app}`
          : `${prefix}${done ? `Clicked in ${app}` : `click in ${app}`}`
        : progressive
          ? 'Clicking'
          : `${prefix}${done ? 'Clicked' : 'click'}`;
    case 'type_text':
      return app
        ? progressive
          ? `Typing in ${app}`
          : `${prefix}${done ? `Typed in ${app}` : `type in ${app}`}`
        : progressive
          ? 'Typing'
          : `${prefix}${done ? 'Typed' : 'type'}`;
    case 'press_key':
      return app
        ? progressive
          ? `Pressing a key in ${app}`
          : `${prefix}${done ? `Pressed a key in ${app}` : `press a key in ${app}`}`
        : progressive
          ? 'Pressing a key'
          : `${prefix}${done ? 'Pressed a key' : 'press a key'}`;
    case 'set_value':
      return app
        ? progressive
          ? `Setting a value in ${app}`
          : `${prefix}${done ? `Set a value in ${app}` : `set a value in ${app}`}`
        : progressive
          ? 'Setting a value'
          : `${prefix}${done ? 'Set a value' : 'set a value'}`;
    case 'scroll':
      return app
        ? progressive
          ? `Scrolling in ${app}`
          : `${prefix}${done ? `Scrolled in ${app}` : `scroll in ${app}`}`
        : progressive
          ? 'Scrolling'
          : `${prefix}${done ? 'Scrolled' : 'scroll'}`;
    case 'drag':
      return app
        ? progressive
          ? `Dragging in ${app}`
          : `${prefix}${done ? `Dragged in ${app}` : `drag in ${app}`}`
        : progressive
          ? 'Dragging'
          : `${prefix}${done ? 'Dragged' : 'drag'}`;
    case 'select_text':
      return app
        ? progressive
          ? `Selecting text in ${app}`
          : `${prefix}${done ? `Selected text in ${app}` : `select text in ${app}`}`
        : progressive
          ? 'Selecting text'
          : `${prefix}${done ? 'Selected text' : 'select text'}`;
    case 'perform_secondary_action':
      return app
        ? progressive
          ? `Acting in ${app}`
          : `${prefix}${done ? `Acted in ${app}` : `act in ${app}`}`
        : progressive
          ? 'Performing an action'
          : `${prefix}${done ? 'Performed an action' : 'perform an action'}`;
    case 'script':
      return progressive ? 'Running a computer-use script' : `${prefix}${done ? 'Ran a computer-use script' : 'run a computer-use script'}`;
    default:
      return progressive ? 'Using the computer' : `${prefix}${done ? 'Used the computer' : 'use the computer'}`;
  }
}

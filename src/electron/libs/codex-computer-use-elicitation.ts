import {
  AEGIS_COMPUTER_USE_SERVER_NAME,
  classifyComputerUseAction,
  isComputerUseServerName,
  isDeniedComputerUseTarget,
  isNodeReplServerName,
  type ComputerUseAction,
} from '../../shared/computer-use';

export const MCP_ELICITATION_METHODS = [
  'elicitation/create',
  'mcpserver/elicitation/request',
  'mcp/elicitation/create',
] as const;

export const MCP_APPROVAL_META = {
  kindKey: 'codex_approval_kind',
  kindMcpToolCall: 'mcp_tool_call',
  persistKey: 'persist',
  persistSession: 'session',
  persistAlways: 'always',
  toolNameKey: 'tool_name',
  toolTitleKey: 'tool_title',
  toolDescriptionKey: 'tool_description',
  toolParamsKey: 'tool_params',
  toolParamsDisplayKey: 'tool_params_display',
  sourceKey: 'source',
  connectorNameKey: 'connector_name',
} as const;

export interface McpToolApprovalElicitation {
  method: string;
  message: string;
  server: string | null;
  toolName: string | null;
  toolTitle: string | null;
  toolDescription: string | null;
  toolParams: Record<string, unknown>;
  toolParamsDisplay: Array<{ name: string; displayName: string; value: unknown }>;
  persistOptions: Array<'session' | 'always'>;
  action: ComputerUseAction | null;
  isComputerUse: boolean;
  isNodeRepl: boolean;
  deniedTarget: boolean;
  rawParams: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readMeta(params: Record<string, unknown>): Record<string, unknown> {
  const direct = isRecord(params._meta)
    ? params._meta
    : isRecord(params.meta)
      ? params.meta
      : {};
  const nested = isRecord(params.params) ? readMeta(params.params) : {};
  return { ...nested, ...direct };
}

export function isMcpElicitationMethod(method: string): boolean {
  const lower = method.toLowerCase();
  return MCP_ELICITATION_METHODS.includes(lower as (typeof MCP_ELICITATION_METHODS)[number])
    || (lower.includes('elicitation') && !lower.includes('response'));
}

function persistOptionsFromMeta(meta: Record<string, unknown>): Array<'session' | 'always'> {
  const value = meta[MCP_APPROVAL_META.persistKey];
  const raw = Array.isArray(value) ? value : value != null ? [value] : [];
  const options: Array<'session' | 'always'> = [];
  for (const item of raw) {
    if (item === MCP_APPROVAL_META.persistSession) options.push('session');
    if (item === MCP_APPROVAL_META.persistAlways) options.push('always');
  }
  return options;
}

function displayParamsFromMeta(
  meta: Record<string, unknown>
): Array<{ name: string; displayName: string; value: unknown }> {
  const raw = meta[MCP_APPROVAL_META.toolParamsDisplayKey];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!isRecord(item)) return [];
    const name = asString(item.name);
    if (!name) return [];
    return [
      {
        name,
        displayName: asString(item.display_name) || asString(item.displayName) || name,
        value: item.value,
      },
    ];
  });
}

export function parseMcpToolApprovalElicitation(
  method: string,
  params: unknown
): McpToolApprovalElicitation | null {
  if (!isMcpElicitationMethod(method) || !isRecord(params)) {
    return null;
  }

  const meta = readMeta(params);
  const kind = asString(meta[MCP_APPROVAL_META.kindKey]);
  let toolParamsRaw: Record<string, unknown> = {};
  const metaParams = meta[MCP_APPROVAL_META.toolParamsKey];
  if (isRecord(metaParams)) {
    toolParamsRaw = metaParams;
  } else if (isRecord(params.arguments)) {
    toolParamsRaw = params.arguments;
  } else if (isRecord(params.toolArguments)) {
    toolParamsRaw = params.toolArguments;
  }
  const server =
    asString(params.server) ||
    asString(params.serverName) ||
    asString(meta.server) ||
    asString(meta.server_name) ||
    null;
  const toolName =
    asString(meta[MCP_APPROVAL_META.toolNameKey]) ||
    asString(params.tool) ||
    asString(params.toolName) ||
    asString(params.name) ||
    null;
  const toolTitle =
    asString(meta[MCP_APPROVAL_META.toolTitleKey]) ||
    asString(toolParamsRaw.title) ||
    asString(params.title) ||
    null;
  const message =
    asString(params.message) ||
    asString(params.question) ||
    (toolName ? `Allow the ${server || 'MCP'} server to run "${toolName}"?` : null);

  // Fail closed: an elicitation without the MCP tool-call discriminator and
  // without a recognizable computer-use/node_repl identity is not ours to
  // auto-shape. Callers still decline unknown elicitation methods.
  const looksLikeToolApproval =
    kind === MCP_APPROVAL_META.kindMcpToolCall ||
    Boolean(server || toolName || Object.keys(toolParamsRaw).length > 0);
  if (!looksLikeToolApproval || !message) {
    return null;
  }

  const app = asString(toolParamsRaw.app);
  const action = classifyComputerUseAction({
    server,
    tool: toolName,
    app,
    title: toolTitle,
    toolName:
      server && toolName ? `mcp__${server}__${toolName}` : toolName,
  });
  const isComputerUse = Boolean(action && (isComputerUseServerName(action.server) || action.kind !== 'script'));
  const isNodeRepl = isNodeReplServerName(server) || action?.kind === 'script';

  return {
    method,
    message,
    server,
    toolName,
    toolTitle,
    toolDescription: asString(meta[MCP_APPROVAL_META.toolDescriptionKey]),
    toolParams: toolParamsRaw,
    toolParamsDisplay: displayParamsFromMeta(meta),
    persistOptions: persistOptionsFromMeta(meta),
    action,
    isComputerUse: isComputerUse || isComputerUseServerName(server),
    isNodeRepl,
    deniedTarget: isDeniedComputerUseTarget(app),
    rawParams: params,
  };
}

export function buildMcpElicitationResponse(input: {
  allow: boolean;
  persist?: 'session' | 'always' | null;
}): Record<string, unknown> {
  if (!input.allow) {
    return { action: 'decline', content: null };
  }

  const result: Record<string, unknown> = {
    action: 'accept',
    content: {},
  };
  if (input.persist === 'session' || input.persist === 'always') {
    result._meta = { [MCP_APPROVAL_META.persistKey]: input.persist };
  }
  return result;
}

export function computerUseServerLabel(server: string | null): string {
  if (isComputerUseServerName(server) || server === AEGIS_COMPUTER_USE_SERVER_NAME) {
    return 'Computer Use';
  }
  if (isNodeReplServerName(server)) return 'node_repl';
  return server || 'MCP';
}

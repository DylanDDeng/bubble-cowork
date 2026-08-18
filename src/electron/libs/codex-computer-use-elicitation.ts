import {
  AEGIS_COMPUTER_USE_SERVER_NAME,
  canonicalizeComputerUseApp,
  classifyComputerUseAction,
  isComputerUseMutatingTool,
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
  providerThreadId: string | null;
  turnId: string | null;
  toolCallId: string | null;
  riskLevel: string | null;
  requestType: string | null;
  canonicalApp: string | null;
  grantEligible: boolean;
  rawParams: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function unwrapElicitation(params: Record<string, unknown>): {
  envelope: Record<string, unknown>;
  request: Record<string, unknown>;
} {
  return {
    envelope: params,
    request: isRecord(params.request) ? params.request : params,
  };
}

function readMeta(params: Record<string, unknown>): Record<string, unknown> {
  const direct = isRecord(params._meta)
    ? params._meta
    : isRecord(params.meta)
      ? params.meta
      : {};
  const nested = isRecord(params.params) ? readMeta(params.params) : {};
  const request = isRecord(params.request) ? readMeta(params.request) : {};
  return { ...nested, ...request, ...direct };
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

function isCompatibleApprovalSchema(schema: unknown): boolean {
  if (schema == null) return true;
  if (!isRecord(schema)) return false;
  const props = schema.properties;
  if (props == null) return true;
  if (!isRecord(props)) return false;
  return Object.keys(props).length === 0;
}

export function parseMcpToolApprovalElicitation(
  method: string,
  params: unknown
): McpToolApprovalElicitation | null {
  if (!isMcpElicitationMethod(method) || !isRecord(params)) {
    return null;
  }

  const { envelope, request } = unwrapElicitation(params);
  const meta = readMeta(params);
  const kind = asString(meta[MCP_APPROVAL_META.kindKey]);
  let toolParamsRaw: Record<string, unknown> = {};
  const metaParams = meta[MCP_APPROVAL_META.toolParamsKey];
  if (isRecord(metaParams)) {
    toolParamsRaw = metaParams;
  } else if (isRecord(request.arguments)) {
    toolParamsRaw = request.arguments;
  } else if (isRecord(envelope.arguments)) {
    toolParamsRaw = envelope.arguments;
  } else if (isRecord(envelope.toolArguments)) {
    toolParamsRaw = envelope.toolArguments;
  }
  const server =
    asString(envelope.serverName) ||
    asString(envelope.server) ||
    asString(request.server) ||
    asString(meta.server) ||
    asString(meta.server_name) ||
    asString(meta.connector_name) ||
    null;
  const toolName =
    asString(meta[MCP_APPROVAL_META.toolNameKey]) ||
    asString(request.tool) ||
    asString(envelope.tool) ||
    asString(envelope.toolName) ||
    asString(request.name) ||
    null;
  const toolTitle =
    asString(meta[MCP_APPROVAL_META.toolTitleKey]) ||
    asString(toolParamsRaw.title) ||
    asString(request.title) ||
    asString(envelope.title) ||
    null;
  const message =
    asString(request.message) ||
    asString(envelope.message) ||
    asString(request.question) ||
    asString(envelope.question) ||
    (toolName ? `Allow the ${server || 'MCP'} server to run "${toolName}"?` : null);

  const looksLikeToolApproval =
    kind === MCP_APPROVAL_META.kindMcpToolCall ||
    Boolean(server || toolName || Object.keys(toolParamsRaw).length > 0);
  if (!looksLikeToolApproval || !message) {
    return null;
  }

  const app = canonicalizeComputerUseApp(
    asString(toolParamsRaw.app) || asString(toolParamsRaw.bundle_id) || asString(toolParamsRaw.bundleId)
  );
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
  const requestType = asString(request.type);
  const grantEligible = Boolean(
    kind === MCP_APPROVAL_META.kindMcpToolCall &&
      server === AEGIS_COMPUTER_USE_SERVER_NAME &&
      toolName &&
      isComputerUseMutatingTool(toolName) &&
      !isNodeRepl &&
      app &&
      !isDeniedComputerUseTarget(app) &&
      (requestType == null || requestType === 'form') &&
      isCompatibleApprovalSchema(request.requestedSchema) &&
      action?.kind !== 'script' &&
      action?.kind !== 'unknown'
  );

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
    providerThreadId:
      asString(envelope.threadId) ||
      asString(envelope.conversationId) ||
      asString(request.threadId) ||
      null,
    turnId: asString(envelope.turnId) || asString(request.turnId) || null,
    toolCallId:
      asString(envelope.tool_call_id) ||
      asString(envelope.toolCallId) ||
      asString(meta.tool_call_id) ||
      asString(meta.toolCallId) ||
      null,
    riskLevel: asString(envelope.riskLevel) || asString(meta.risk_level) || asString(meta.riskLevel) || null,
    requestType,
    canonicalApp: app,
    grantEligible,
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

export function wrappedComputerUseElicitationFixture(input: {
  threadId: string;
  tool?: string;
  app?: string;
  persist?: 'session' | 'always';
  message?: string;
}): Record<string, unknown> {
  const tool = input.tool || 'click';
  const app = input.app || 'com.apple.finder';
  return {
    threadId: input.threadId,
    turnId: 'turn-cu-1',
    serverName: AEGIS_COMPUTER_USE_SERVER_NAME,
    request: {
      type: 'form',
      message: input.message || `Allow Computer Use to ${tool}?`,
      requestedSchema: { type: 'object', properties: {} },
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        tool_name: tool,
        tool_title: `Use ${tool}`,
        tool_params: { app },
        ...(input.persist ? { persist: input.persist } : {}),
      },
    },
  };
}

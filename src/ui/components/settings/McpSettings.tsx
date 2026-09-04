import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Plus, Settings, Trash2 } from '../icons';
import { toast } from 'sonner';
import { useAppStore } from '../../store/useAppStore';
import { sendEvent } from '../../hooks/useIPC';
import type { McpServerConfig, McpServerStatus, McpSettingsRuntime } from '../../types';
import type { CodexMcpServerRuntimeStatus } from '../../../shared/types';
import { SegmentedControl, SegmentedControlItem, SettingsToggle } from './SettingsPrimitives';
import { ProviderIcon } from '../AgentModelPicker';
import { confirmDialog } from '../ui/confirm-dialog';

type ServerTool = McpSettingsRuntime;
type GroupId =
  | 'claude-global'
  | 'codex-global'
  | 'opencode-global'
  | 'kimi-global'
  | 'qoder-global'
  | 'bubble-global'
  | 'deepseek-global';

// Component-local page navigation: the settings pane swaps between the grouped
// list and full-page create/edit forms (Codex-desktop style), no router.
type PanelView =
  | { kind: 'list' }
  | { kind: 'edit'; groupId: GroupId; name: string }
  | { kind: 'create'; groupId: GroupId };

interface ServerGroup {
  id: GroupId;
  tool: ServerTool;
  /** Where this group is persisted; shown as muted monospace text in the section header. */
  path: string;
  servers: Record<string, McpServerConfig>;
  allowedTransports: Array<NonNullable<McpServerConfig['type']>>;
}

/**
 * Agent runtimes that expose an MCP catalog, in sidebar order. Rendered as
 * sub-items under "MCP Servers" in the Settings sidebar (see Settings.tsx).
 */
export const MCP_RUNTIMES: ReadonlyArray<{ id: ServerTool; label: string }> = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'kimi', label: 'Kimi' },
  { id: 'qoder', label: 'Qoder' },
  { id: 'bubble', label: 'Bubble' },
  { id: 'deepseek', label: 'DeepSeek Harness' },
];

const ALL_TRANSPORTS: Array<{
  value: NonNullable<McpServerConfig['type']>;
  label: string;
  description: string;
}> = [
  {
    value: 'stdio',
    label: 'STDIO',
    description: 'Run a local process such as npx or uvx.',
  },
  {
    value: 'http',
    label: 'Streamable HTTP',
    description: 'Connect to a persistent MCP server over HTTP.',
  },
  {
    value: 'sse',
    label: 'SSE',
    description: 'Connect to a streaming MCP server over Server-Sent Events.',
  },
];

export function McpSettingsContent() {
  const {
    mcpGlobalServers,
    mcpCodexGlobalServers,
    mcpOpencodeGlobalServers,
    mcpKimiGlobalServers,
    mcpQoderGlobalServers,
    mcpBubbleGlobalServers,
    mcpDeepseekGlobalServers,
    mcpServerStatus,
    showSettings,
    activeSessionId,
    sessions,
    mcpSettingsRuntime: selectedTool,
  } = useAppStore();

  const [view, setView] = useState<PanelView>({ kind: 'list' });
  const currentProjectPath = activeSessionId ? sessions[activeSessionId]?.cwd : undefined;

  // Config + status are re-read on open and whenever the window regains
  // focus. There is no refresh button and no "last checked" label.
  const refreshConfig = useCallback(() => {
    sendEvent({
      type: 'mcp.get-config',
      payload: { projectPath: currentProjectPath },
    });
  }, [currentProjectPath]);

  useEffect(() => {
    if (!showSettings) return;
    refreshConfig();
    const onFocus = () => refreshConfig();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [showSettings, refreshConfig]);

  // Runtime selection lives in the store because the Settings sidebar drives
  // it; leaving the list view when it changes keeps stale editors from lingering.
  useEffect(() => {
    setView({ kind: 'list' });
  }, [selectedTool]);

  // Codex-managed runtime status (auth state per server). Fetched lazily when
  // the Codex tab is open — the query boots the codex app-server if needed.
  const [codexRuntime, setCodexRuntime] = useState<Record<string, CodexMcpServerRuntimeStatus>>({});
  const [codexAuthPending, setCodexAuthPending] = useState<string | null>(null);

  const refreshCodexMcpStatus = useCallback(async () => {
    try {
      const result = await window.electron.listCodexMcpStatus();
      if (result.ok) {
        const map: Record<string, CodexMcpServerRuntimeStatus> = {};
        for (const server of result.servers) map[server.name] = server;
        setCodexRuntime(map);
      }
    } catch {
      // Panel simply renders without runtime badges.
    }
  }, []);

  useEffect(() => {
    if (!showSettings || selectedTool !== 'codex') return;
    void refreshCodexMcpStatus();
    const onFocus = () => void refreshCodexMcpStatus();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [showSettings, selectedTool, refreshCodexMcpStatus]);

  useEffect(() => {
    const onCompleted = (event: Event) => {
      const detail = (
        event as CustomEvent<{ serverName: string; success: boolean; error: string | null }>
      ).detail;
      setCodexAuthPending(null);
      if (detail?.success) {
        toast.success(`MCP server "${detail.serverName}" authorized.`);
      } else {
        toast.error(
          `Authorization failed for "${detail?.serverName}"${detail?.error ? `: ${detail.error}` : '.'}`
        );
      }
      void refreshCodexMcpStatus();
    };
    window.addEventListener('codex-mcp-oauth-completed', onCompleted);
    return () => window.removeEventListener('codex-mcp-oauth-completed', onCompleted);
  }, [refreshCodexMcpStatus]);

  const handleCodexAuthorize = useCallback(async (serverName: string) => {
    setCodexAuthPending(serverName);
    const result = await window.electron.startCodexMcpOauthLogin(serverName);
    if (!result.ok) {
      setCodexAuthPending(null);
      toast.error(result.message || 'Failed to start authorization.');
      return;
    }
    toast.info('Authorization page opened in your browser.');
  }, []);

  const groups = useMemo<ServerGroup[]>(() => {
    const items: ServerGroup[] = [
      {
        id: 'claude-global',
        tool: 'claude',
        path: '~/.claude.json',
        servers: mcpGlobalServers,
        allowedTransports: ['stdio', 'http', 'sse'],
      },
    ];

    items.push({
      id: 'codex-global',
      tool: 'codex',
      path: 'Aegis private config',
      servers: mcpCodexGlobalServers,
      allowedTransports: ['stdio', 'http'],
    });

    items.push({
      id: 'opencode-global',
      tool: 'opencode',
      path: '~/.config/opencode/opencode.json',
      servers: mcpOpencodeGlobalServers,
      allowedTransports: ['stdio', 'http'],
    });

    items.push({
      id: 'kimi-global',
      tool: 'kimi',
      path: '~/.kimi/mcp.json',
      servers: mcpKimiGlobalServers,
      allowedTransports: ['stdio', 'http'],
    });

    items.push({
      id: 'qoder-global',
      tool: 'qoder',
      path: '~/.qoder/mcp.json',
      servers: mcpQoderGlobalServers,
      allowedTransports: ['stdio', 'http'],
    });

    items.push({
      id: 'bubble-global',
      tool: 'bubble',
      path: '~/.bubble/settings.json',
      servers: mcpBubbleGlobalServers,
      allowedTransports: ['stdio', 'http'],
    });

    items.push({
      id: 'deepseek-global',
      tool: 'deepseek',
      path: '~/.aegis/deepseek-mcp.json',
      servers: mcpDeepseekGlobalServers,
      allowedTransports: ['stdio', 'http'],
    });

    return items;
  }, [
    mcpGlobalServers,
    mcpCodexGlobalServers,
    mcpOpencodeGlobalServers,
    mcpKimiGlobalServers,
    mcpQoderGlobalServers,
    mcpBubbleGlobalServers,
    mcpDeepseekGlobalServers,
  ]);

  const dispatchSave = (groupId: GroupId, nextServers: Record<string, McpServerConfig>) => {
    if (groupId === 'claude-global') {
      sendEvent({
        type: 'mcp.save-config',
        payload: { globalServers: nextServers },
      });
      return;
    }
    if (groupId === 'codex-global') {
      sendEvent({
        type: 'mcp.save-config',
        payload: { codexGlobalServers: nextServers },
      });
      return;
    }
    if (groupId === 'opencode-global') {
      sendEvent({
        type: 'mcp.save-config',
        payload: { opencodeGlobalServers: nextServers },
      });
      return;
    }
    if (groupId === 'kimi-global') {
      sendEvent({
        type: 'mcp.save-config',
        payload: { kimiGlobalServers: nextServers },
      });
      return;
    }
    if (groupId === 'qoder-global') {
      sendEvent({
        type: 'mcp.save-config',
        payload: { qoderGlobalServers: nextServers },
      });
      return;
    }
    if (groupId === 'bubble-global') {
      sendEvent({
        type: 'mcp.save-config',
        payload: { bubbleGlobalServers: nextServers },
      });
      return;
    }
    if (groupId === 'deepseek-global') {
      sendEvent({
        type: 'mcp.save-config',
        payload: { deepseekGlobalServers: nextServers },
      });
      return;
    }
  };

  const handleDelete = async (name: string, group: ServerGroup) => {
    const runtimeLabel = MCP_RUNTIMES.find((runtime) => runtime.id === group.tool)?.label ?? group.tool;
    const confirmed = await confirmDialog({
      title: `Remove ${name}?`,
      description: `${runtimeLabel} won't see this server in new sessions. It is removed from ${group.path}.`,
      confirmLabel: 'Remove server',
    });
    if (!confirmed) return;

    const { [name]: _removed, ...rest } = group.servers;
    dispatchSave(group.id, rest);

    setView({ kind: 'list' });
    toast.success(`Deleted "${name}".`);
  };

  const handleSave = (name: string, config: McpServerConfig, group: ServerGroup) => {
    const trimmedName = name.trim();
    const originalName =
      view.kind === 'edit' && view.groupId === group.id ? view.name : null;

    const nextServers =
      originalName && originalName !== trimmedName
        ? renameServer(group.servers, originalName, trimmedName, config)
        : {
            ...group.servers,
            [trimmedName]: config,
          };

    dispatchSave(group.id, nextServers);

    setView({ kind: 'list' });
    toast.success(`${originalName ? 'Updated' : 'Saved'} "${trimmedName}".`);
  };

  // Codex only: `enabled = false` disables the server in Aegis' private catalog.
  // Enabling removes the key entirely instead of writing `enabled = true`.
  const handleToggleEnabled = (name: string, group: ServerGroup, nextEnabled: boolean) => {
    const current = group.servers[name];
    if (!current) return;
    const nextConfig: McpServerConfig = { ...current };
    if (nextEnabled) {
      delete nextConfig.enabled;
    } else {
      nextConfig.enabled = false;
    }
    dispatchSave(group.id, { ...group.servers, [name]: nextConfig });
    toast.success(`${nextEnabled ? 'Enabled' : 'Disabled'} "${name}".`);
  };

  const visibleGroups = useMemo(
    () => groups.filter((group) => group.tool === selectedTool),
    [groups, selectedTool]
  );

  const findStatus = (name: string, group: ServerGroup) =>
    mcpServerStatus.find(
      (entry) => entry.name === name && (!entry.tool || entry.tool === group.tool)
    );

  // Page-style create/edit views replace the list inside the panel.
  if (view.kind !== 'list') {
    const group = groups.find((item) => item.id === view.groupId);
    if (group) {
      if (view.kind === 'create') {
        return (
          <ServerEditorPage
            key={`create-${group.id}`}
            mode="create"
            group={group}
            existingNames={Object.keys(group.servers)}
            onBack={() => setView({ kind: 'list' })}
            onSave={(name, config) => handleSave(name, config, group)}
          />
        );
      }
      const config = group.servers[view.name];
      if (config) {
        return (
          <ServerEditorPage
            key={`edit-${group.id}-${view.name}`}
            mode="edit"
            group={group}
            initialName={view.name}
            initialConfig={config}
            existingNames={Object.keys(group.servers)}
            statusError={findStatus(view.name, group)?.error}
            onBack={() => setView({ kind: 'list' })}
            onSave={(name, nextConfig) => handleSave(name, nextConfig, group)}
            onUninstall={() => void handleDelete(view.name, group)}
          />
        );
      }
    }
    // Target disappeared (deleted or config refreshed) — fall through to list.
  }

  const runtimeLabel = MCP_RUNTIMES.find((runtime) => runtime.id === selectedTool)?.label ?? 'MCP';

  return (
    <div className="pb-8">
      <h1 className="mb-6 flex items-center gap-2 text-[17px] font-semibold tracking-normal text-[var(--text-primary)]">
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center [&>img]:h-5 [&>img]:w-5 [&>svg]:h-5 [&>svg]:w-5">
          <ProviderIcon provider={selectedTool} />
        </span>
        <span>{runtimeLabel}</span>
      </h1>

      <div className="space-y-7">
        {visibleGroups.map((group) => (
          <ServerGroupSection
            key={group.id}
            group={group}
            statusEntries={mcpServerStatus}
            codexRuntime={group.tool === 'codex' ? codexRuntime : undefined}
            codexAuthPending={codexAuthPending}
            onCodexAuthorize={handleCodexAuthorize}
            onAdd={() => setView({ kind: 'create', groupId: group.id })}
            onOpen={(name) => setView({ kind: 'edit', groupId: group.id, name })}
            onToggleEnabled={
              // Only where the target runtime honors a disable flag in its config:
              // codex (config.toml `enabled`) and opencode (opencode.json
              // `enabled`), plus Aegis's DeepSeek runtime config. Claude/Kimi
              // mcpServers formats have no such field.
              group.tool === 'codex' || group.tool === 'opencode' || group.tool === 'deepseek'
                ? (name, nextEnabled) => handleToggleEnabled(name, group, nextEnabled)
                : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}

const CODEX_AUTH_LABELS: Record<CodexMcpServerRuntimeStatus['authStatus'], string | null> = {
  unsupported: null,
  notLoggedIn: 'Not authorized',
  bearerToken: 'Authorized (token)',
  oAuth: 'Authorized (OAuth)',
};

function ServerGroupSection({
  group,
  statusEntries,
  codexRuntime,
  codexAuthPending,
  onCodexAuthorize,
  onAdd,
  onOpen,
  onToggleEnabled,
}: {
  group: ServerGroup;
  statusEntries: McpServerStatus[];
  codexRuntime?: Record<string, CodexMcpServerRuntimeStatus>;
  codexAuthPending?: string | null;
  onCodexAuthorize?: (name: string) => void;
  onAdd: () => void;
  onOpen: (name: string) => void;
  onToggleEnabled?: (name: string, nextEnabled: boolean) => void;
}) {
  const serverEntries = Object.entries(group.servers);

  return (
    <section title={group.path}>
      <div className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="divide-y divide-[var(--border)]">
          {serverEntries.map(([name, config]) => {
              // mcpServerStatus entries are tagged with the reporting agent
              // (tool). Match by name AND tool so Claude/Codex statuses coexist
              // without cross-agent name collisions. Kimi/Grok protocols do not
              // report status, so their rows fall back to the muted dot.
              const status = statusEntries.find(
                (entry) => entry.name === name && (!entry.tool || entry.tool === group.tool)
              );
              return (
                <ServerListRow
                  key={`${group.id}-${name}`}
                  name={name}
                  config={config}
                  status={status}
                  codexRuntime={codexRuntime?.[name]}
                  codexAuthPending={codexAuthPending === name}
                  onAuthorize={onCodexAuthorize ? () => onCodexAuthorize(name) : undefined}
                  onOpen={() => onOpen(name)}
                  onToggleEnabled={
                    onToggleEnabled ? (nextEnabled) => onToggleEnabled(name, nextEnabled) : undefined
                  }
                />
              );
            })}
          <button
            type="button"
            onClick={onAdd}
            className="flex h-9 w-full items-center gap-2 px-3.5 text-left text-[13px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Add server</span>
          </button>
        </div>
      </div>
    </section>
  );
}

function ServerListRow({
  name,
  config,
  status,
  codexRuntime,
  codexAuthPending,
  onAuthorize,
  onOpen,
  onToggleEnabled,
}: {
  name: string;
  config: McpServerConfig;
  status?: McpServerStatus;
  codexRuntime?: CodexMcpServerRuntimeStatus;
  codexAuthPending?: boolean;
  onAuthorize?: () => void;
  onOpen: () => void;
  onToggleEnabled?: (nextEnabled: boolean) => void;
}) {
  const statusMeta = getStatusMeta(status);
  const transport = (config.type || 'stdio').toLowerCase();
  const enabled = config.enabled !== false;
  const needsAuth = codexRuntime?.authStatus === 'notLoggedIn' && Boolean(onAuthorize);
  const isDisabled = Boolean(onToggleEnabled) && !enabled;

  // Status is a dot; text only appears when the user has something to do.
  const dotClass = isDisabled
    ? 'border-[1.5px] border-[var(--text-muted)]'
    : !status
      ? 'bg-[var(--text-muted)] opacity-50'
      : statusMeta.tone === 'success'
        ? 'bg-[var(--success)]'
        : statusMeta.tone === 'error'
          ? 'bg-[var(--error)]'
          : 'bg-[var(--warning)]';
  const dotTitle = isDisabled ? 'Disabled' : statusMeta.label;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      className="group flex h-[38px] cursor-pointer items-center gap-2.5 pl-3.5 pr-3 transition-colors hover:bg-[var(--bg-secondary)] focus-visible:bg-[var(--bg-secondary)] focus-visible:outline-none"
    >
      <span
        aria-label={dotTitle}
        title={dotTitle}
        className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${dotClass}`}
      />
      <span
        className={`truncate text-[13px] font-medium ${isDisabled ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}
      >
        {name}
      </span>
      <span className="flex-shrink-0 text-[12.5px] text-[var(--text-muted)]">{transport}</span>
      {status && statusMeta.tone === 'error' ? (
        <span className="truncate text-[12.5px] text-[var(--error)]" title={status.error}>
          {statusMeta.label}
        </span>
      ) : null}
      {needsAuth ? (
        <button
          type="button"
          disabled={codexAuthPending}
          onClick={(event) => {
            event.stopPropagation();
            if (!codexAuthPending) onAuthorize?.();
          }}
          className={`flex-shrink-0 text-[12.5px] text-[var(--text-secondary)] underline decoration-[var(--border-focus)] underline-offset-[3px] transition-colors ${
            codexAuthPending ? 'cursor-default opacity-60' : 'hover:text-[var(--text-primary)]'
          }`}
        >
          {codexAuthPending ? 'Authorizing…' : 'Authorize'}
        </button>
      ) : null}

      <span className="flex-1" />

      <button
        type="button"
        aria-label={`Configure ${name}`}
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
        className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-[6px] text-[var(--text-muted)] opacity-0 transition-opacity hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Settings className="h-3.5 w-3.5" />
      </button>
      {onToggleEnabled ? (
        <span onClick={(event) => event.stopPropagation()} className="flex flex-shrink-0 items-center">
          <SettingsToggle
            checked={enabled}
            onChange={(value) => onToggleEnabled(value)}
            ariaLabel={`${enabled ? 'Disable' : 'Enable'} ${name}`}
          />
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page-style create/edit form (replaces the list inside the settings pane).
// ---------------------------------------------------------------------------

function ServerEditorPage({
  mode,
  group,
  initialName = '',
  initialConfig,
  existingNames,
  statusError,
  onBack,
  onSave,
  onUninstall,
}: {
  mode: 'create' | 'edit';
  group: ServerGroup;
  initialName?: string;
  initialConfig?: McpServerConfig;
  existingNames: string[];
  statusError?: string;
  onBack: () => void;
  onSave: (name: string, config: McpServerConfig) => void;
  onUninstall?: () => void;
}) {
  const typeOptions = useMemo(
    () => ALL_TRANSPORTS.filter((option) => group.allowedTransports.includes(option.value)),
    [group.allowedTransports]
  );
  const defaultType: NonNullable<McpServerConfig['type']> =
    (initialConfig?.type && group.allowedTransports.includes(initialConfig.type)
      ? initialConfig.type
      : group.allowedTransports[0]) || 'stdio';

  const [name, setName] = useState(initialName);
  const [type, setType] = useState<NonNullable<McpServerConfig['type']>>(defaultType);
  const [command, setCommand] = useState(initialConfig?.command || '');
  const [args, setArgs] = useState<string[]>(initialConfig?.args ? [...initialConfig.args] : []);
  const [url, setUrl] = useState(initialConfig?.url || '');
  const [headers, setHeaders] = useState<Array<{ key: string; value: string }>>(
    initialConfig?.headers
      ? Object.entries(initialConfig.headers).map(([key, value]) => ({ key, value }))
      : []
  );
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>(
    initialConfig?.env
      ? Object.entries(initialConfig.env).map(([key, value]) => ({ key, value }))
      : []
  );
  const [errors, setErrors] = useState<Partial<Record<'name' | 'command' | 'url', string>>>({});

  const existingNamesLower = useMemo(
    () => existingNames.map((item) => item.toLowerCase()),
    [existingNames]
  );

  const validate = () => {
    const nextErrors: Partial<Record<'name' | 'command' | 'url', string>> = {};
    const trimmedName = name.trim();
    const normalizedName = trimmedName.toLowerCase();
    const editingExisting = initialName.trim().toLowerCase();

    if (!trimmedName) {
      nextErrors.name = 'Enter a server name.';
    } else if (normalizedName !== editingExisting && existingNamesLower.includes(normalizedName)) {
      nextErrors.name = 'That name already exists.';
    }

    if (type === 'stdio') {
      if (!command.trim()) {
        nextErrors.command = 'Enter the command used to start this server.';
      }
    } else if (!url.trim()) {
      nextErrors.url = 'Enter the MCP server URL.';
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!validate()) return;

    const trimmedName = name.trim();
    const config: McpServerConfig = { type };

    if (type === 'stdio') {
      config.command = command.trim();
      const cleanArgs = args.map((arg) => arg.trim()).filter(Boolean);
      if (cleanArgs.length > 0) {
        config.args = cleanArgs;
      }
    } else {
      config.url = url.trim();
      const headerMap = collectKeyValues(headers);
      if (Object.keys(headerMap).length > 0) {
        config.headers = headerMap;
      }
    }

    const env = collectKeyValues(envVars);
    if (Object.keys(env).length > 0) {
      config.env = env;
    }

    // Preserve the codex enable/disable flag across edits — the toggle lives
    // on the list row, the form must not silently re-enable a disabled server.
    if (typeof initialConfig?.enabled === 'boolean') {
      config.enabled = initialConfig.enabled;
    }

    onSave(trimmedName, config);
  };

  const title = mode === 'edit' ? `Update ${initialName}` : 'Connect to a custom MCP';

  return (
    <div className="pb-8">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        <span>Back</span>
      </button>

      <h2 className="mt-3 min-w-0 truncate text-[16px] font-semibold text-[var(--text-primary)]">
        {title}
      </h2>

      {statusError ? (
        <div className="mt-3 rounded-[var(--radius-lg)] border border-[var(--error)]/30 bg-[var(--error)]/5 px-3 py-2 text-[12px] leading-5 text-[var(--error)]">
          {statusError}
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        <FormCard>
          <FormField label="Name" error={errors.name}>
            <input
              type="text"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (errors.name) {
                  setErrors((current) => ({ ...current, name: undefined }));
                }
              }}
              placeholder="filesystem"
              className={getInputClassName(Boolean(errors.name))}
            />
          </FormField>

          {typeOptions.length > 1 ? (
            <FormField label="Type">
              <SegmentedControl ariaLabel="Transport type">
                {typeOptions.map((option) => (
                  <SegmentedControlItem
                    key={option.value}
                    active={type === option.value}
                    onClick={() => setType(option.value)}
                    ariaLabel={option.description}
                  >
                    {option.label}
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
            </FormField>
          ) : null}
        </FormCard>

        <FormCard>
          {type === 'stdio' ? (
            <>
              <FormField label="Command to launch" error={errors.command}>
                <input
                  type="text"
                  value={command}
                  onChange={(event) => {
                    setCommand(event.target.value);
                    if (errors.command) {
                      setErrors((current) => ({ ...current, command: undefined }));
                    }
                  }}
                  placeholder="npx"
                  className={getInputClassName(Boolean(errors.command))}
                />
              </FormField>

              <FormField label="Arguments">
                <div className="space-y-2">
                  {args.map((value, index) => (
                    <div key={`arg-${index}`} className="flex items-center gap-2">
                      <input
                        type="text"
                        value={value}
                        onChange={(event) =>
                          setArgs((current) =>
                            current.map((item, itemIndex) =>
                              itemIndex === index ? event.target.value : item
                            )
                          )
                        }
                        placeholder="@modelcontextprotocol/server-filesystem"
                        className={getInputClassName(false)}
                      />
                      <button
                        type="button"
                        aria-label="Remove argument"
                        onClick={() =>
                          setArgs((current) =>
                            current.filter((_, itemIndex) => itemIndex !== index)
                          )
                        }
                        className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[var(--radius-lg)] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--error)]"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  <GhostAddButton
                    label="Add argument"
                    onClick={() => setArgs((current) => [...current, ''])}
                  />
                </div>
              </FormField>
            </>
          ) : (
            <>
              <FormField label="URL" error={errors.url}>
                <input
                  type="text"
                  value={url}
                  onChange={(event) => {
                    setUrl(event.target.value);
                    if (errors.url) {
                      setErrors((current) => ({ ...current, url: undefined }));
                    }
                  }}
                  placeholder={
                    type === 'http' ? 'http://localhost:3000/mcp' : 'http://localhost:3000/sse'
                  }
                  className={getInputClassName(Boolean(errors.url))}
                />
              </FormField>

              <FormField label="Headers">
                <KeyValueEditor
                  entries={headers}
                  onChange={setHeaders}
                  addLabel="Add header"
                  keyPlaceholder="Authorization"
                  valuePlaceholder="Bearer ..."
                  removeLabel="Remove header"
                />
              </FormField>
            </>
          )}

          <FormField label="Environment variables">
            <KeyValueEditor
              entries={envVars}
              onChange={setEnvVars}
              addLabel="Add environment variable"
              keyPlaceholder="KEY"
              valuePlaceholder="value"
              removeLabel="Remove variable"
            />
          </FormField>
        </FormCard>

        {/* One action row: the destructive action sits at the far left as a
            quiet text button, primary actions at the right. Same row keeps it
            aligned and reachable without giving it a colored surface. */}
        <div className="flex items-center gap-2">
          {onUninstall ? (
            <button
              type="button"
              onClick={onUninstall}
              className="inline-flex h-8 items-center rounded-[var(--radius-lg)] px-2 text-[12px] font-medium text-[var(--text-muted)] transition-colors hover:bg-[color-mix(in_srgb,var(--error)_8%,transparent)] hover:text-[var(--error)]"
            >
              Remove server
            </button>
          ) : null}
          <span className="flex-1" />
          <button
            type="button"
            onClick={onBack}
            className="inline-flex h-8 items-center rounded-[var(--radius-lg)] px-3 text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="inline-flex h-8 items-center rounded-[var(--radius-lg)] bg-[var(--accent)] px-4 text-[12px] font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)]"
          >
            Save
          </button>
        </div>
      </form>
    </div>
  );
}

function FormCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-4 rounded-[12px] border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      {children}
    </div>
  );
}

function GhostAddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-8 w-full items-center justify-center gap-1.5 rounded-[var(--radius-lg)] border border-dashed border-[var(--border)] text-[12px] font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
    >
      <Plus className="h-3.5 w-3.5" />
      <span>{label}</span>
    </button>
  );
}

function KeyValueEditor({
  entries,
  onChange,
  addLabel,
  keyPlaceholder,
  valuePlaceholder,
  removeLabel,
}: {
  entries: Array<{ key: string; value: string }>;
  onChange: React.Dispatch<React.SetStateAction<Array<{ key: string; value: string }>>>;
  addLabel: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
  removeLabel: string;
}) {
  return (
    <div className="space-y-2">
      {entries.map((entry, index) => (
        <div key={`kv-${index}`} className="flex items-center gap-2">
          <input
            type="text"
            value={entry.key}
            onChange={(event) =>
              onChange((current) =>
                current.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, key: event.target.value } : item
                )
              )
            }
            placeholder={keyPlaceholder}
            className={getInputClassName(false)}
          />
          <input
            type="text"
            value={entry.value}
            onChange={(event) =>
              onChange((current) =>
                current.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, value: event.target.value } : item
                )
              )
            }
            placeholder={valuePlaceholder}
            className={getInputClassName(false)}
          />
          <button
            type="button"
            aria-label={removeLabel}
            onClick={() => onChange((current) => current.filter((_, itemIndex) => itemIndex !== index))}
            className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[var(--radius-lg)] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--error)]"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <GhostAddButton label={addLabel} onClick={() => onChange((current) => [...current, { key: '', value: '' }])} />
    </div>
  );
}

function FormField({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-[12px] font-medium text-[var(--text-secondary)]">{label}</span>
        {hint ? <span className="text-[11px] text-[var(--text-muted)]">{hint}</span> : null}
      </div>
      {children}
      {error ? <div className="mt-1 text-[11.5px] text-[var(--error)]">{error}</div> : null}
    </div>
  );
}

function collectKeyValues(entries: Array<{ key: string; value: string }>): Record<string, string> {
  return entries.reduce<Record<string, string>>((result, entry) => {
    const key = entry.key.trim();
    if (key) {
      result[key] = entry.value;
    }
    return result;
  }, {});
}

function getStatusMeta(status?: McpServerStatus) {
  if (!status) {
    return {
      label: 'Unknown',
      tone: 'muted' as const,
      description: 'Status has not been reported yet.',
    };
  }

  if (status.status === 'connected') {
    return {
      label: 'Connected',
      tone: 'success' as const,
      description: 'This server is available to the assistant.',
    };
  }

  if (status.status === 'failed') {
    if (status.failureReason === 'reauthenticationRequired') {
      return {
        label: 'Reauthentication required',
        tone: 'error' as const,
        description: 'This server needs a fresh sign-in before it can be used.',
      };
    }
    return {
      label: 'Failed',
      tone: 'error' as const,
      description: 'Check the connection details below.',
    };
  }

  return {
    label: 'Starting',
    tone: 'warning' as const,
    description: 'The app is still trying to connect to this server.',
  };
}

function renameServer(
  servers: Record<string, McpServerConfig>,
  previousName: string,
  nextName: string,
  config: McpServerConfig
) {
  const nextServers = { ...servers };
  delete nextServers[previousName];
  nextServers[nextName] = config;
  return nextServers;
}

function getInputClassName(hasError: boolean) {
  return `h-8 w-full rounded-[var(--radius-lg)] border bg-[var(--bg-primary)] px-2.5 text-[12.5px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] ${
    hasError
      ? 'border-[var(--error)] focus:border-[var(--error)]'
      : 'border-[var(--border)] focus:border-[var(--text-muted)]'
  }`;
}

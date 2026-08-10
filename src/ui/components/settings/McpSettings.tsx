import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Plus, RefreshCw, Settings, Trash2 } from '../icons';
import { toast } from 'sonner';
import { useAppStore } from '../../store/useAppStore';
import { sendEvent } from '../../hooks/useIPC';
import type { McpServerConfig, McpServerStatus } from '../../types';
import type { CodexMcpServerRuntimeStatus } from '../../../shared/types';
import { SegmentedControl, SegmentedControlItem, SettingsToggle } from './SettingsPrimitives';

type ServerTool = 'claude' | 'codex' | 'opencode' | 'kimi' | 'qoder' | 'bubble';
type ServerScope = 'global' | 'project';
type GroupId =
  | 'claude-global'
  | 'claude-project'
  | 'codex-global'
  | 'opencode-global'
  | 'opencode-project'
  | 'kimi-global'
  | 'kimi-project'
  | 'qoder-global'
  | 'bubble-global';

// Component-local page navigation: the settings pane swaps between the grouped
// list and full-page create/edit forms (Codex-desktop style), no router.
type PanelView =
  | { kind: 'list' }
  | { kind: 'edit'; groupId: GroupId; name: string }
  | { kind: 'create'; groupId: GroupId };

interface ServerGroup {
  id: GroupId;
  tool: ServerTool;
  scope: ServerScope;
  title: string;
  description: string;
  servers: Record<string, McpServerConfig>;
  allowedTransports: Array<NonNullable<McpServerConfig['type']>>;
}

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
    mcpProjectServers,
    mcpCodexGlobalServers,
    mcpOpencodeGlobalServers,
    mcpOpencodeProjectServers,
    mcpKimiGlobalServers,
    mcpKimiProjectServers,
    mcpQoderGlobalServers,
    mcpBubbleGlobalServers,
    mcpServerStatus,
    showSettings,
    activeSessionId,
    sessions,
  } = useAppStore();

  const [view, setView] = useState<PanelView>({ kind: 'list' });
  const [selectedTool, setSelectedTool] = useState<ServerTool>('claude');
  const currentProjectPath = activeSessionId ? sessions[activeSessionId]?.cwd : undefined;
  const currentProjectName = currentProjectPath?.split('/').pop() || 'this workspace';

  useEffect(() => {
    if (showSettings) {
      sendEvent({
        type: 'mcp.get-config',
        payload: { projectPath: currentProjectPath },
      });
    }
  }, [showSettings, currentProjectPath]);

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
    if (showSettings && selectedTool === 'codex') {
      void refreshCodexMcpStatus();
    }
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
        scope: 'global',
        title: 'Global Servers',
        description: 'Reusable MCP connections available in every workspace.',
        servers: mcpGlobalServers,
        allowedTransports: ['stdio', 'http', 'sse'],
      },
    ];

    if (currentProjectPath) {
      items.push({
        id: 'claude-project',
        tool: 'claude',
        scope: 'project',
        title: 'Project Servers',
        description: `Connections only available in ${currentProjectName}.`,
        servers: mcpProjectServers,
        allowedTransports: ['stdio', 'http', 'sse'],
      });
    }

    items.push({
      id: 'codex-global',
      tool: 'codex',
      scope: 'global',
      title: 'Global Servers',
      description: 'Written to ~/.codex/config.toml. Codex only supports local (stdio) MCP servers.',
      servers: mcpCodexGlobalServers,
      allowedTransports: ['stdio'],
    });

    items.push({
      id: 'opencode-global',
      tool: 'opencode',
      scope: 'global',
      title: 'Global Servers',
      description: 'Written to ~/.config/opencode/opencode.json. Supports local (stdio) and remote (HTTP) servers.',
      servers: mcpOpencodeGlobalServers,
      allowedTransports: ['stdio', 'http'],
    });

    if (currentProjectPath) {
      items.push({
        id: 'opencode-project',
        tool: 'opencode',
        scope: 'project',
        title: 'Project Servers',
        description: `Written to opencode.json in ${currentProjectName}.`,
        servers: mcpOpencodeProjectServers,
        allowedTransports: ['stdio', 'http'],
      });
    }

    items.push({
      id: 'kimi-global',
      tool: 'kimi',
      scope: 'global',
      title: 'Global Servers',
      description: 'Written to ~/.kimi/mcp.json. Supports local (stdio) and remote (HTTP) servers.',
      servers: mcpKimiGlobalServers,
      allowedTransports: ['stdio', 'http'],
    });

    if (currentProjectPath) {
      items.push({
        id: 'kimi-project',
        tool: 'kimi',
        scope: 'project',
        title: 'Project Servers',
        description: `Written to .kimi-code/mcp.json in ${currentProjectName}.`,
        servers: mcpKimiProjectServers,
        allowedTransports: ['stdio', 'http'],
      });
    }

    items.push({
      id: 'qoder-global',
      tool: 'qoder',
      scope: 'global',
      title: 'Global Servers',
      description: 'Written to ~/.qoder/mcp.json. Supports local (stdio) and remote (HTTP) servers.',
      servers: mcpQoderGlobalServers,
      allowedTransports: ['stdio', 'http'],
    });

    items.push({
      id: 'bubble-global',
      tool: 'bubble',
      scope: 'global',
      title: 'Global Servers',
      description: 'Written to ~/.bubble/settings.json. Supports local (stdio) and remote (HTTP) servers.',
      servers: mcpBubbleGlobalServers,
      allowedTransports: ['stdio', 'http'],
    });

    return items;
  }, [
    mcpGlobalServers,
    mcpProjectServers,
    mcpCodexGlobalServers,
    mcpOpencodeGlobalServers,
    mcpOpencodeProjectServers,
    mcpKimiGlobalServers,
    mcpKimiProjectServers,
    mcpQoderGlobalServers,
    mcpBubbleGlobalServers,
    currentProjectPath,
    currentProjectName,
  ]);

  const dispatchSave = (groupId: GroupId, nextServers: Record<string, McpServerConfig>) => {
    if (groupId === 'claude-global') {
      sendEvent({
        type: 'mcp.save-config',
        payload: { globalServers: nextServers },
      });
      return;
    }
    if (groupId === 'claude-project') {
      sendEvent({
        type: 'mcp.save-config',
        payload: {
          projectServers: nextServers,
          projectPath: currentProjectPath,
        },
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
    if (groupId === 'opencode-project') {
      sendEvent({
        type: 'mcp.save-config',
        payload: {
          opencodeProjectServers: nextServers,
          projectPath: currentProjectPath,
        },
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
    if (groupId === 'kimi-project') {
      sendEvent({
        type: 'mcp.save-config',
        payload: {
          kimiProjectServers: nextServers,
          projectPath: currentProjectPath,
        },
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
    }
  };

  const handleDelete = (name: string, group: ServerGroup) => {
    const confirmed = window.confirm(`Delete the ${group.title} server "${name}"?`);
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

  // Codex only: `enabled = false` disables the server in ~/.codex/config.toml.
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

  const handleRefresh = (group: ServerGroup) => {
    if (group.tool === 'codex') {
      void refreshCodexMcpStatus();
      return;
    }
    sendEvent({
      type: 'mcp.get-config',
      payload: { projectPath: currentProjectPath },
    });
  };

  const visibleGroups = useMemo(
    () => groups.filter((group) => group.tool === selectedTool),
    [groups, selectedTool]
  );

  const counts = useMemo(() => {
    const byTool: Record<ServerTool, number> = { claude: 0, codex: 0, opencode: 0, kimi: 0, qoder: 0, bubble: 0 };
    for (const group of groups) {
      byTool[group.tool] += Object.keys(group.servers).length;
    }
    return byTool;
  }, [groups]);

  const handleSelectTool = (tool: ServerTool) => {
    if (tool === selectedTool) return;
    setSelectedTool(tool);
    setView({ kind: 'list' });
  };

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
            onUninstall={() => handleDelete(view.name, group)}
          />
        );
      }
    }
    // Target disappeared (deleted or config refreshed) — fall through to list.
  }

  return (
    <div className="space-y-5 pb-8">
      <ToolTabBar selected={selectedTool} onSelect={handleSelectTool} counts={counts} />

      {visibleGroups.map((group) => (
        <ServerGroupSection
          key={group.id}
          group={group}
          statusEntries={mcpServerStatus}
          codexRuntime={group.tool === 'codex' ? codexRuntime : undefined}
          codexAuthPending={codexAuthPending}
          onCodexAuthorize={handleCodexAuthorize}
          onRefresh={() => handleRefresh(group)}
          onAdd={() => setView({ kind: 'create', groupId: group.id })}
          onOpen={(name) => setView({ kind: 'edit', groupId: group.id, name })}
          onToggleEnabled={
            // Only where the target CLI honors a disable flag in its config:
            // codex (config.toml `enabled`) and opencode (opencode.json
            // `enabled`). Claude/Kimi mcpServers formats have no such field.
            group.tool === 'codex' || group.tool === 'opencode'
              ? (name, nextEnabled) => handleToggleEnabled(name, group, nextEnabled)
              : undefined
          }
        />
      ))}
    </div>
  );
}

function ToolTabBar({
  selected,
  onSelect,
  counts,
}: {
  selected: ServerTool;
  onSelect: (tool: ServerTool) => void;
  counts: Record<ServerTool, number>;
}) {
  const tabs: Array<{ id: ServerTool; label: string; hint: string }> = [
    {
      id: 'claude',
      label: 'Claude Code',
      hint: '~/.claude.json',
    },
    {
      id: 'codex',
      label: 'Codex',
      hint: '~/.codex/config.toml',
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      hint: '~/.config/opencode/opencode.json',
    },
    {
      id: 'kimi',
      label: 'Kimi',
      hint: '~/.kimi/mcp.json',
    },
    {
      id: 'qoder',
      label: 'Qoder',
      hint: '~/.qoder/mcp.json',
    },
    {
      id: 'bubble',
      label: 'Bubble',
      hint: '~/.bubble/settings.json',
    },
  ];

  return (
    <div role="tablist" aria-label="Agent runtime" className="flex items-center gap-1.5">
      {tabs.map((tab) => {
        const isActive = tab.id === selected;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(tab.id)}
            title={tab.hint}
            className={`flex items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-[13px] transition-colors ${
              isActive
                ? 'bg-[var(--bg-tertiary)] font-semibold text-[var(--text-primary)]'
                : 'font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]'
            }`}
          >
            <span>{tab.label}</span>
            <span className={`font-normal ${isActive ? 'text-[var(--text-muted)]' : 'text-[var(--text-muted)]/70'}`}>
              {counts[tab.id]}
            </span>
          </button>
        );
      })}
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
  onRefresh,
  onAdd,
  onOpen,
  onToggleEnabled,
}: {
  group: ServerGroup;
  statusEntries: McpServerStatus[];
  codexRuntime?: Record<string, CodexMcpServerRuntimeStatus>;
  codexAuthPending?: string | null;
  onCodexAuthorize?: (name: string) => void;
  onRefresh: () => void;
  onAdd: () => void;
  onOpen: (name: string) => void;
  onToggleEnabled?: (name: string, nextEnabled: boolean) => void;
}) {
  const serverEntries = Object.entries(group.servers);

  const emptyDescription = (() => {
    if (group.tool === 'codex') {
      return 'Add a local MCP server for the Codex CLI. Written to ~/.codex/config.toml.';
    }
    if (group.tool === 'opencode') {
      return group.scope === 'project'
        ? 'Add a workspace-only MCP server for the OpenCode CLI. Written to opencode.json in this project.'
        : 'Add an MCP server for the OpenCode CLI. Written to ~/.config/opencode/opencode.json.';
    }
    if (group.tool === 'kimi') {
      return group.scope === 'project'
        ? 'Add a workspace-only MCP server for the Kimi CLI. Written to .kimi-code/mcp.json in this project.'
        : 'Add an MCP server for the Kimi CLI. Written to ~/.kimi/mcp.json.';
    }
    if (group.tool === 'qoder') {
      return 'Add an MCP server for the Qoder CLI. Written to ~/.qoder/mcp.json.';
    }
    if (group.tool === 'bubble') {
      return 'Add an MCP server for the Bubble CLI. Written to ~/.bubble/settings.json.';
    }
    return group.scope === 'global'
      ? 'Add a reusable MCP connection to make tools available in every Claude Code workspace.'
      : 'Add a workspace-only MCP connection for Claude Code.';
  })();

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3 px-1">
        <div className="min-w-0">
          <h2 className="text-[12px] font-medium text-[var(--text-muted)]">{group.title}</h2>
          <p className="mt-0.5 truncate text-[12px] leading-5 text-[var(--text-muted)]">
            {group.description}
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1.5">
          <button
            type="button"
            aria-label={`Refresh ${group.title.toLowerCase()}`}
            title="Refresh"
            onClick={onRefresh}
            className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-lg)] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onAdd}
            className="inline-flex h-7 items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Add server</span>
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-[12px] border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="divide-y divide-[var(--border)]">
          {serverEntries.length === 0 ? (
            <EmptyStateRow
              title="No servers configured"
              description={emptyDescription}
              actionLabel="Add server"
              onAction={onAdd}
            />
          ) : (
            serverEntries.map(([name, config]) => {
              // mcpServerStatus entries are tagged with the reporting agent
              // (tool). Match by name AND tool so Claude/Codex statuses coexist
              // without cross-agent name collisions. Kimi/Grok protocols do not
              // report status (their ACP protocol doesn't expose it), so they
              // stay "Unknown".
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
            })
          )}
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
  const transport = (config.type || 'stdio').toUpperCase();
  const authLabel = codexRuntime ? CODEX_AUTH_LABELS[codexRuntime.authStatus] : null;
  const enabled = config.enabled !== false;
  const sublineParts = status ? [statusMeta.label, transport] : [transport];
  if (authLabel) sublineParts.push(authLabel);
  if (onToggleEnabled && !enabled) sublineParts.push('Disabled');
  const subline = sublineParts.join(' · ');
  const needsAuth = codexRuntime?.authStatus === 'notLoggedIn' && Boolean(onAuthorize);

  return (
    <div
      onClick={onOpen}
      className="flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--bg-secondary)]"
    >
      <div className={`min-w-0 flex-1 ${enabled ? '' : 'opacity-60'}`}>
        <div className="truncate text-[13px] font-medium text-[var(--text-primary)]">{name}</div>
        <div className="mt-0.5 truncate text-[12px] leading-5 text-[var(--text-muted)]">
          {subline}
        </div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-1.5 text-[var(--text-muted)]">
        {needsAuth ? (
          <button
            type="button"
            disabled={codexAuthPending}
            onClick={(event) => {
              event.stopPropagation();
              if (!codexAuthPending) onAuthorize?.();
            }}
            className={`rounded-full border border-[var(--accent)]/40 px-2.5 py-0.5 text-[11px] font-medium text-[var(--accent)] transition-colors ${
              codexAuthPending ? 'cursor-default opacity-60' : 'hover:bg-[var(--accent)]/10'
            }`}
          >
            {codexAuthPending ? 'Authorizing...' : 'Authorize'}
          </button>
        ) : null}
        <button
          type="button"
          aria-label={`Configure ${name}`}
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
          className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-lg)] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
        {onToggleEnabled ? (
          <span onClick={(event) => event.stopPropagation()} className="flex items-center">
            <SettingsToggle
              checked={enabled}
              onChange={(value) => onToggleEnabled(value)}
              ariaLabel={`${enabled ? 'Disable' : 'Enable'} ${name}`}
            />
          </span>
        ) : null}
      </div>
    </div>
  );
}

function EmptyStateRow({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
      <div className="text-[13px] font-medium text-[var(--text-primary)]">{title}</div>
      <div className="max-w-[360px] text-[12px] leading-5 text-[var(--text-muted)]">{description}</div>
      <button
        type="button"
        onClick={onAction}
        className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
      >
        <Plus className="h-3.5 w-3.5" />
        <span>{actionLabel}</span>
      </button>
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
      nextErrors.name = 'That name already exists in this scope.';
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

      <div className="mt-3 flex items-center justify-between gap-3">
        <h2 className="min-w-0 truncate text-[16px] font-semibold text-[var(--text-primary)]">
          {title}
        </h2>
        {onUninstall ? (
          <button
            type="button"
            onClick={onUninstall}
            className="inline-flex h-8 flex-shrink-0 items-center gap-1.5 rounded-full border border-[var(--error)]/30 bg-[var(--error)]/10 px-3 text-[12px] font-medium text-[var(--error)] transition-colors hover:bg-[var(--error)]/15"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>Uninstall</span>
          </button>
        ) : null}
      </div>

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

        <div className="flex items-center justify-end">
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

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, PencilLine, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAppStore } from '../../store/useAppStore';
import { sendEvent } from '../../hooks/useIPC';
import type { McpServerConfig, McpServerStatus } from '../../types';
import { SettingsGroup } from './SettingsPrimitives';

type StatusTone = 'success' | 'warning' | 'error' | 'muted';

type ServerTool = 'claude' | 'codex';
type ServerScope = 'global' | 'project';
type GroupId = 'claude-global' | 'claude-project' | 'codex-global';

interface ActiveEditorState {
  groupId: GroupId;
  name: string | null;
}

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
    label: 'Local command',
    description: 'Run a local process such as npx or uvx.',
  },
  {
    value: 'http',
    label: 'HTTP endpoint',
    description: 'Connect to a persistent MCP server over HTTP.',
  },
  {
    value: 'sse',
    label: 'SSE endpoint',
    description: 'Connect to a streaming MCP server over Server-Sent Events.',
  },
];

export function McpSettingsContent() {
  const {
    mcpGlobalServers,
    mcpProjectServers,
    mcpCodexGlobalServers,
    mcpServerStatus,
    showSettings,
    activeSessionId,
    sessions,
  } = useAppStore();

  const [activeEditor, setActiveEditor] = useState<ActiveEditorState | null>(null);
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

    return items;
  }, [
    mcpGlobalServers,
    mcpProjectServers,
    mcpCodexGlobalServers,
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
    }
  };

  const handleDelete = (name: string, group: ServerGroup) => {
    const confirmed = window.confirm(`Delete the ${group.title} server "${name}"?`);
    if (!confirmed) return;

    const { [name]: _removed, ...rest } = group.servers;
    dispatchSave(group.id, rest);

    if (activeEditor?.groupId === group.id && activeEditor.name === name) {
      setActiveEditor(null);
    }
    toast.success(`Deleted "${name}".`);
  };

  const handleSave = (name: string, config: McpServerConfig, group: ServerGroup) => {
    const trimmedName = name.trim();

    const nextServers =
      activeEditor?.name && activeEditor.name !== trimmedName
        ? renameServer(group.servers, activeEditor.name, trimmedName, config)
        : {
            ...group.servers,
            [trimmedName]: config,
          };

    dispatchSave(group.id, nextServers);

    setActiveEditor(null);
    toast.success(`${activeEditor?.name ? 'Updated' : 'Saved'} "${trimmedName}".`);
  };

  const visibleGroups = useMemo(
    () => groups.filter((group) => group.tool === selectedTool),
    [groups, selectedTool]
  );

  const counts = useMemo(() => {
    const byTool: Record<ServerTool, number> = { claude: 0, codex: 0 };
    for (const group of groups) {
      byTool[group.tool] += Object.keys(group.servers).length;
    }
    return byTool;
  }, [groups]);

  const handleSelectTool = (tool: ServerTool) => {
    if (tool === selectedTool) return;
    setSelectedTool(tool);
    setActiveEditor(null);
  };

  return (
    <div className="space-y-5 pb-8">
      <ToolTabBar selected={selectedTool} onSelect={handleSelectTool} counts={counts} />

      {visibleGroups.map((group) => (
        <ServerGroupSection
          key={group.id}
          group={group}
          statusEntries={mcpServerStatus}
          activeEditor={activeEditor}
          onAddNew={() => setActiveEditor({ groupId: group.id, name: null })}
          onEdit={(name) => setActiveEditor({ groupId: group.id, name })}
          onCancelEdit={() => setActiveEditor(null)}
          onSave={(name, config) => handleSave(name, config, group)}
          onDelete={(name) => handleDelete(name, group)}
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
  ];

  return (
    <div
      role="tablist"
      aria-label="Agent runtime"
      className="flex items-center gap-1 border-b border-[var(--border)]"
    >
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
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium transition-colors ${
              isActive
                ? 'border-[var(--text-primary)] text-[var(--text-primary)]'
                : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]'
            }`}
          >
            <span>{tab.label}</span>
            <span
              className={`inline-flex min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10.5px] leading-[16px] ${
                isActive
                  ? 'bg-[var(--text-primary)] text-[var(--bg-primary)]'
                  : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
              }`}
            >
              {counts[tab.id]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ServerGroupSection({
  group,
  statusEntries,
  activeEditor,
  onAddNew,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete,
}: {
  group: ServerGroup;
  statusEntries: McpServerStatus[];
  activeEditor: ActiveEditorState | null;
  onAddNew: () => void;
  onEdit: (name: string) => void;
  onCancelEdit: () => void;
  onSave: (name: string, config: McpServerConfig) => void;
  onDelete: (name: string) => void;
}) {
  const existingNames = useMemo(() => Object.keys(group.servers), [group.servers]);
  const isAddingNew = activeEditor?.groupId === group.id && activeEditor.name === null;
  const serverEntries = Object.entries(group.servers);

  const emptyDescription = (() => {
    if (group.tool === 'codex') {
      return 'Add a local MCP server for the Codex CLI. Written to ~/.codex/config.toml.';
    }
    return group.scope === 'global'
      ? 'Add a reusable MCP connection to make tools available in every Claude Code workspace.'
      : 'Add a workspace-only MCP connection for Claude Code.';
  })();

  return (
    <SettingsGroup title={group.title} description={group.description}>
      {serverEntries.length === 0 && !isAddingNew ? (
        <EmptyStateRow
          title="No servers configured"
          description={emptyDescription}
          actionLabel="Configure Server"
          onAction={onAddNew}
        />
      ) : null}

      {serverEntries.map(([name, config]) => {
        const isExpanded = activeEditor?.groupId === group.id && activeEditor.name === name;
        // Codex 与 Claude 共用一套 mcpServerStatus，不同工具下重名时状态无法精确区分。
        // 目前只对 Claude 显示状态点，Codex 先保持为 "Unknown"。
        const status =
          group.tool === 'claude'
            ? statusEntries.find((entry) => entry.name === name)
            : undefined;
        return (
          <ServerListRow
            key={`${group.id}-${name}`}
            name={name}
            config={config}
            status={status}
            expanded={isExpanded}
            existingNames={existingNames}
            allowedTransports={group.allowedTransports}
            onToggleExpand={() => {
              if (isExpanded) {
                onCancelEdit();
              } else {
                onEdit(name);
              }
            }}
            onDelete={() => onDelete(name)}
            onSave={(nextName, nextConfig) => onSave(nextName, nextConfig)}
            onCancel={onCancelEdit}
          />
        );
      })}

      <NewServerRow
        group={group}
        expanded={isAddingNew}
        existingNames={existingNames}
        onToggle={() => (isAddingNew ? onCancelEdit() : onAddNew())}
        onSave={(name, config) => onSave(name, config)}
        onCancel={onCancelEdit}
      />
    </SettingsGroup>
  );
}

function ServerListRow({
  name,
  config,
  status,
  expanded,
  existingNames,
  allowedTransports,
  onToggleExpand,
  onDelete,
  onSave,
  onCancel,
}: {
  name: string;
  config: McpServerConfig;
  status?: McpServerStatus;
  expanded: boolean;
  existingNames: string[];
  allowedTransports: Array<NonNullable<McpServerConfig['type']>>;
  onToggleExpand: () => void;
  onDelete: () => void;
  onSave: (name: string, config: McpServerConfig) => void;
  onCancel: () => void;
}) {
  const statusMeta = getStatusMeta(status);
  const sublineParts = [statusMeta.label, (config.type || 'stdio').toUpperCase()];
  const subline = sublineParts.join(' · ');

  return (
    <div>
      <button
        type="button"
        onClick={onToggleExpand}
        aria-expanded={expanded}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--bg-secondary)]"
      >
        <ServerAvatar name={name} tone={statusMeta.tone} />
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium text-[var(--text-primary)]">{name}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[12px] leading-5 text-[var(--text-muted)]">
            <span className={`inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${getStatusDotClassName(statusMeta.tone)}`} />
            <span className="truncate">{subline}</span>
          </div>
        </div>
        <div className="flex items-center gap-1 text-[var(--text-muted)]">
          <RowIconButton
            label={`Edit ${name}`}
            onClick={(event) => {
              event.stopPropagation();
              if (!expanded) onToggleExpand();
            }}
          >
            <PencilLine className="h-3.5 w-3.5" />
          </RowIconButton>
          <RowIconButton
            label={`Delete ${name}`}
            tone="danger"
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </RowIconButton>
          <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {expanded ? (
        <div className="border-t border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-4">
          {status?.error ? (
            <div className="mb-3 rounded-[var(--radius-lg)] border border-[var(--error)]/30 bg-[var(--error)]/5 px-3 py-2 text-[12px] leading-5 text-[var(--error)]">
              {status.error}
            </div>
          ) : null}
          <McpServerForm
            initialName={name}
            initialConfig={config}
            existingNames={existingNames}
            allowedTransports={allowedTransports}
            onSave={onSave}
            onCancel={onCancel}
          />
        </div>
      ) : null}
    </div>
  );
}

function NewServerRow({
  group,
  expanded,
  existingNames,
  onToggle,
  onSave,
  onCancel,
}: {
  group: ServerGroup;
  expanded: boolean;
  existingNames: string[];
  onToggle: () => void;
  onSave: (name: string, config: McpServerConfig) => void;
  onCancel: () => void;
}) {
  const hint =
    group.tool === 'codex'
      ? 'Add a Codex CLI MCP server.'
      : group.scope === 'global'
        ? 'Add a Claude Code global MCP server.'
        : 'Add a Claude Code project MCP server.';

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--bg-secondary)]"
      >
        <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[8px] border border-dashed border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-muted)]">
          <Plus className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-[var(--text-primary)]">New MCP Server</div>
          <div className="mt-0.5 text-[12px] leading-5 text-[var(--text-muted)]">{hint}</div>
        </div>
        <ChevronDown className={`h-4 w-4 text-[var(--text-muted)] transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {expanded ? (
        <div className="border-t border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-4">
          <McpServerForm
            existingNames={existingNames}
            allowedTransports={group.allowedTransports}
            onSave={onSave}
            onCancel={onCancel}
          />
        </div>
      ) : null}
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

function ServerAvatar({ name, tone }: { name: string; tone: StatusTone }) {
  const trimmed = name.trim();
  const letter = (trimmed.charAt(0) || '?').toUpperCase();
  return (
    <span className="relative flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[8px] bg-[var(--accent)] text-[12px] font-semibold text-[var(--accent-foreground)]">
      <span aria-hidden="true">{letter}</span>
      <span
        className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-[var(--bg-primary)] ${getStatusDotClassName(tone)}`}
        aria-hidden="true"
      />
    </span>
  );
}

function RowIconButton({
  label,
  onClick,
  tone = 'default',
  children,
}: {
  label: string;
  onClick: (event: React.MouseEvent<HTMLSpanElement>) => void;
  tone?: 'default' | 'danger';
  children: React.ReactNode;
}) {
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick(event as unknown as React.MouseEvent<HTMLSpanElement>);
        }
      }}
      className={`inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-[var(--radius-lg)] transition-colors hover:bg-[var(--bg-tertiary)] ${
        tone === 'danger'
          ? 'text-[var(--text-muted)] hover:text-[var(--error)]'
          : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
      }`}
    >
      {children}
    </span>
  );
}

function McpServerForm({
  initialName = '',
  initialConfig,
  existingNames,
  allowedTransports,
  onSave,
  onCancel,
}: {
  initialName?: string;
  initialConfig?: McpServerConfig;
  existingNames: string[];
  allowedTransports: Array<NonNullable<McpServerConfig['type']>>;
  onSave: (name: string, config: McpServerConfig) => void;
  onCancel: () => void;
}) {
  const typeOptions = useMemo(
    () => ALL_TRANSPORTS.filter((option) => allowedTransports.includes(option.value)),
    [allowedTransports]
  );
  const defaultType: NonNullable<McpServerConfig['type']> =
    (initialConfig?.type && allowedTransports.includes(initialConfig.type)
      ? initialConfig.type
      : allowedTransports[0]) || 'stdio';

  const [name, setName] = useState(initialName);
  const [type, setType] = useState<NonNullable<McpServerConfig['type']>>(defaultType);
  const [command, setCommand] = useState(initialConfig?.command || '');
  const [args, setArgs] = useState(initialConfig?.args?.join(' ') || '');
  const [url, setUrl] = useState(initialConfig?.url || '');
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>(
    initialConfig?.env
      ? Object.entries(initialConfig.env).map(([key, value]) => ({ key, value }))
      : []
  );
  const [advancedOpen, setAdvancedOpen] = useState(Boolean(initialConfig?.env && Object.keys(initialConfig.env).length > 0));
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
      if (args.trim()) {
        config.args = args
          .split(' ')
          .map((part) => part.trim())
          .filter(Boolean);
      }
    } else {
      config.url = url.trim();
    }

    const env = envVars.reduce<Record<string, string>>((result, entry) => {
      const key = entry.key.trim();
      if (key) {
        result[key] = entry.value;
      }
      return result;
    }, {});

    if (Object.keys(env).length > 0) {
      config.env = env;
    }

    onSave(trimmedName, config);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
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
        <FormField label="Transport">
          <TransportSegmentedControl value={type} options={typeOptions} onChange={setType} />
        </FormField>
      ) : null}

      {type === 'stdio' ? (
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
          <FormField label="Command" error={errors.command}>
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

          <FormField label="Arguments" hint="Space-separated.">
            <input
              type="text"
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              placeholder="@modelcontextprotocol/server-filesystem"
              className={getInputClassName(false)}
            />
          </FormField>
        </div>
      ) : (
        <FormField label="Server URL" error={errors.url}>
          <input
            type="text"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              if (errors.url) {
                setErrors((current) => ({ ...current, url: undefined }));
              }
            }}
            placeholder={type === 'http' ? 'http://localhost:3000/mcp' : 'http://localhost:3000/sse'}
            className={getInputClassName(Boolean(errors.url))}
          />
        </FormField>
      )}

      <div>
        <button
          type="button"
          onClick={() => setAdvancedOpen((current) => !current)}
          className="flex w-full items-center justify-between gap-3 rounded-[var(--radius-lg)] px-1 py-1 text-left transition-colors hover:bg-[var(--bg-primary)]/60"
          aria-expanded={advancedOpen}
        >
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-secondary)]">
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${advancedOpen ? 'rotate-0' : '-rotate-90'}`} />
            <span>Environment variables</span>
            {envVars.length > 0 ? (
              <span className="rounded-full bg-[var(--bg-tertiary)] px-1.5 text-[11px] leading-4 text-[var(--text-muted)]">
                {envVars.length}
              </span>
            ) : null}
          </div>
          <span
            role="button"
            tabIndex={0}
            aria-label="Add variable"
            onClick={(event) => {
              event.stopPropagation();
              setAdvancedOpen(true);
              setEnvVars((current) => [...current, { key: '', value: '' }]);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                setAdvancedOpen(true);
                setEnvVars((current) => [...current, { key: '', value: '' }]);
              }
            }}
            className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-[var(--radius-lg)] px-2 text-[11px] font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
          >
            <Plus className="h-3 w-3" />
            <span>Add</span>
          </span>
        </button>

        {advancedOpen ? (
          <div className="mt-2 space-y-2">
            {envVars.length === 0 ? (
              <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2.5 text-[11.5px] text-[var(--text-muted)]">
                No environment variables configured.
              </div>
            ) : (
              envVars.map((entry, index) => (
                <div
                  key={`env-${index}`}
                  className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto]"
                >
                  <input
                    type="text"
                    value={entry.key}
                    onChange={(event) =>
                      setEnvVars((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, key: event.target.value } : item
                        )
                      )
                    }
                    placeholder="KEY"
                    className={getInputClassName(false)}
                  />
                  <input
                    type="text"
                    value={entry.value}
                    onChange={(event) =>
                      setEnvVars((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, value: event.target.value } : item
                        )
                      )
                    }
                    placeholder="value"
                    className={getInputClassName(false)}
                  />
                  <button
                    type="button"
                    aria-label="Remove variable"
                    onClick={() =>
                      setEnvVars((current) => current.filter((_, itemIndex) => itemIndex !== index))
                    }
                    className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--error)]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-8 items-center rounded-[var(--radius-lg)] px-3 text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="inline-flex h-8 items-center rounded-[var(--radius-lg)] bg-[var(--accent)] px-3 text-[12px] font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)]"
        >
          {initialName ? 'Save' : 'Add Server'}
        </button>
      </div>
    </form>
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

function TransportSegmentedControl({
  value,
  options,
  onChange,
}: {
  value: NonNullable<McpServerConfig['type']>;
  options: typeof ALL_TRANSPORTS;
  onChange: (value: NonNullable<McpServerConfig['type']>) => void;
}) {
  return (
    <div className="inline-flex w-full items-center gap-0.5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] p-0.5">
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={selected}
            title={option.description}
            className={`flex-1 rounded-[var(--radius-lg)] px-2.5 py-1 text-[12px] font-medium transition-colors ${
              selected
                ? 'bg-[var(--accent-light)] text-[var(--text-primary)] shadow-[0_1px_2px_rgba(15,23,42,0.04)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
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

function getStatusDotClassName(tone: 'success' | 'warning' | 'error' | 'muted') {
  if (tone === 'success') return 'bg-green-500';
  if (tone === 'warning') return 'bg-amber-500';
  if (tone === 'error') return 'bg-red-500';
  return 'bg-slate-400';
}

import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, PencilLine, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAppStore } from '../../store/useAppStore';
import { sendEvent } from '../../hooks/useIPC';
import type { McpServerConfig, McpServerStatus } from '../../types';
import { SettingsSection } from './SettingsPrimitives';

type ServerScope = 'global' | 'project';

interface ActiveEditorState {
  scope: ServerScope;
  name: string | null;
}

const TYPE_OPTIONS: Array<{
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
    mcpServerStatus,
    showSettings,
    activeSessionId,
    sessions,
  } = useAppStore();

  const [activeEditor, setActiveEditor] = useState<ActiveEditorState | null>(null);
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

  const handleDelete = (name: string, scope: ServerScope) => {
    const confirmed = window.confirm(`Delete the ${scope} server "${name}"?`);
    if (!confirmed) return;

    if (scope === 'global') {
      const { [name]: deleted, ...rest } = mcpGlobalServers;
      sendEvent({
        type: 'mcp.save-config',
        payload: { globalServers: rest },
      });
    } else {
      const { [name]: deleted, ...rest } = mcpProjectServers;
      sendEvent({
        type: 'mcp.save-config',
        payload: {
          projectServers: rest,
          projectPath: currentProjectPath,
        },
      });
    }

    if (activeEditor?.scope === scope && activeEditor.name === name) {
      setActiveEditor(null);
    }
    toast.success(`Deleted "${name}".`);
  };

  const handleSave = (name: string, config: McpServerConfig, scope: ServerScope) => {
    const trimmedName = name.trim();

    if (scope === 'global') {
      const nextServers =
        activeEditor?.name && activeEditor.name !== trimmedName
          ? renameServer(mcpGlobalServers, activeEditor.name, trimmedName, config)
          : {
              ...mcpGlobalServers,
              [trimmedName]: config,
            };

      sendEvent({
        type: 'mcp.save-config',
        payload: {
          globalServers: nextServers,
        },
      });
    } else {
      const nextServers =
        activeEditor?.name && activeEditor.name !== trimmedName
          ? renameServer(mcpProjectServers, activeEditor.name, trimmedName, config)
          : {
              ...mcpProjectServers,
              [trimmedName]: config,
            };

      sendEvent({
        type: 'mcp.save-config',
        payload: {
          projectServers: nextServers,
          projectPath: currentProjectPath,
        },
      });
    }

    setActiveEditor(null);
    toast.success(`${activeEditor?.name ? 'Updated' : 'Saved'} "${trimmedName}".`);
  };

  const hasProjectScope = Boolean(currentProjectPath);

  return (
    <div className="space-y-6 pb-8">
      <ServerScopeSection
        title="Global Servers"
        description="Reusable MCP connections available in every workspace."
        scope="global"
        servers={mcpGlobalServers}
        statusEntries={mcpServerStatus}
        activeEditor={activeEditor}
        onAddNew={() => setActiveEditor({ scope: 'global', name: null })}
        onEdit={(name) => setActiveEditor({ scope: 'global', name })}
        onCancelEdit={() => setActiveEditor(null)}
        onSave={handleSave}
        onDelete={handleDelete}
      />

      {hasProjectScope ? (
        <ServerScopeSection
          title="Project Servers"
          description={`Connections only available in ${currentProjectName}.`}
          scope="project"
          servers={mcpProjectServers}
          statusEntries={mcpServerStatus}
          activeEditor={activeEditor}
          onAddNew={() => setActiveEditor({ scope: 'project', name: null })}
          onEdit={(name) => setActiveEditor({ scope: 'project', name })}
          onCancelEdit={() => setActiveEditor(null)}
          onSave={handleSave}
          onDelete={handleDelete}
        />
      ) : null}
    </div>
  );
}

function ServerScopeSection({
  title,
  description,
  scope,
  servers,
  statusEntries,
  activeEditor,
  onAddNew,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete,
}: {
  title: string;
  description: string;
  scope: ServerScope;
  servers: Record<string, McpServerConfig>;
  statusEntries: McpServerStatus[];
  activeEditor: ActiveEditorState | null;
  onAddNew: () => void;
  onEdit: (name: string) => void;
  onCancelEdit: () => void;
  onSave: (name: string, config: McpServerConfig, scope: ServerScope) => void;
  onDelete: (name: string, scope: ServerScope) => void;
}) {
  const existingNames = useMemo(() => Object.keys(servers), [servers]);
  const isAddingNew = activeEditor?.scope === scope && activeEditor.name === null;
  const serverEntries = Object.entries(servers);

  return (
    <SettingsSection title={title} description={description}>
      <ServerActionRow
        label="Add Server"
        description={`Create a ${scope === 'global' ? 'reusable' : 'workspace-only'} MCP connection in this scope.`}
        actionLabel={isAddingNew ? 'Adding…' : 'New Server'}
        onClick={onAddNew}
        disabled={isAddingNew}
      />

      {isAddingNew ? (
        <ExpandableRowShell
          title="New server"
          description="Choose a transport and provide only the required connection details first."
          expanded
        >
          <McpServerForm
            scope={scope}
            existingNames={existingNames}
            onSave={(name, config) => onSave(name, config, scope)}
            onCancel={onCancelEdit}
          />
        </ExpandableRowShell>
      ) : null}

      {serverEntries.length === 0 ? (
        <InlineNoticeRow
          title="No servers configured"
          description={`Add a ${scope === 'global' ? 'global' : 'project'} server to make tools available in this scope.`}
        />
      ) : null}

      {serverEntries.map(([name, config]) => {
        const isExpanded = activeEditor?.scope === scope && activeEditor.name === name;
        const status = statusEntries.find((entry) => entry.name === name);

        return (
          <ExpandableServerRow
            key={`${scope}-${name}`}
            name={name}
            config={config}
            scope={scope}
            status={status}
            expanded={isExpanded}
            existingNames={existingNames}
            onToggle={() => {
              if (isExpanded) {
                onCancelEdit();
              } else {
                onEdit(name);
              }
            }}
            onEdit={() => onEdit(name)}
            onDelete={() => onDelete(name, scope)}
            onSave={(nextName, nextConfig) => onSave(nextName, nextConfig, scope)}
            onCancel={onCancelEdit}
          />
        );
      })}
    </SettingsSection>
  );
}

function ServerActionRow({
  label,
  description,
  actionLabel,
  onClick,
  disabled,
}: {
  label: string;
  description: string;
  actionLabel: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(200px,280px)] items-center gap-4 border-b border-[var(--border)] py-3.5">
      <div>
        <div className="text-[14px] font-medium text-[var(--text-primary)]">{label}</div>
        <div className="mt-0.5 text-[13px] leading-5 text-[var(--text-muted)]">{description}</div>
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          className="inline-flex h-9 items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--accent-light)] px-3.5 text-[13px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>{actionLabel}</span>
        </button>
      </div>
    </div>
  );
}

function InlineNoticeRow({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(200px,280px)] gap-4 border-b border-[var(--border)] py-3.5 last:border-b-0">
      <div>
        <div className="text-[14px] font-medium text-[var(--text-primary)]">{title}</div>
        <div className="mt-0.5 text-[13px] leading-5 text-[var(--text-muted)]">{description}</div>
      </div>
      <div className="flex items-center justify-end">
        <span className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border)] px-3 py-2 text-[12px] text-[var(--text-muted)]">
          Empty
        </span>
      </div>
    </div>
  );
}

function ExpandableServerRow({
  name,
  config,
  scope,
  status,
  expanded,
  existingNames,
  onToggle,
  onEdit,
  onDelete,
  onSave,
  onCancel,
}: {
  name: string;
  config: McpServerConfig;
  scope: ServerScope;
  status?: McpServerStatus;
  expanded: boolean;
  existingNames: string[];
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSave: (name: string, config: McpServerConfig) => void;
  onCancel: () => void;
}) {
  const summary = getServerSummary(config);
  const statusMeta = getStatusMeta(status);

  return (
    <ExpandableRowShell
      title={name}
      description={summary}
      expanded={expanded}
      summarySuffix={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <StatusBadge label={statusMeta.label} tone={statusMeta.tone} />
          <MetaBadge label={(config.type || 'stdio').toUpperCase()} />
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-lg)] border border-[var(--border)] px-2.5 text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
          >
            <PencilLine className="h-3.5 w-3.5" />
            <span>Edit</span>
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-lg)] border border-[var(--border)] px-2.5 text-[12px] font-medium text-[var(--error)] transition-colors hover:bg-[var(--bg-tertiary)]"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>Delete</span>
          </button>
          <button
            type="button"
            onClick={onToggle}
            className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] border border-[var(--border)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            aria-label={expanded ? `Collapse ${name}` : `Expand ${name}`}
            aria-expanded={expanded}
          >
            <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
        </div>
      }
      detail={
        status?.error ? (
          <div className="mt-2 text-[12px] leading-5 text-[var(--error)]">
            {status.error}
          </div>
        ) : statusMeta.description ? (
          <div className="mt-2 text-[12px] leading-5 text-[var(--text-muted)]">
            {statusMeta.description}
          </div>
        ) : null
      }
    >
      <McpServerForm
        scope={scope}
        initialName={name}
        initialConfig={config}
        existingNames={existingNames}
        onSave={onSave}
        onCancel={onCancel}
      />
    </ExpandableRowShell>
  );
}

function ExpandableRowShell({
  title,
  description,
  detail,
  summarySuffix,
  expanded,
  children,
}: {
  title: string;
  description: string;
  detail?: React.ReactNode;
  summarySuffix?: React.ReactNode;
  expanded: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="border-b border-[var(--border)] py-3.5 last:border-b-0">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(200px,280px)] gap-4">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-[var(--text-primary)]">{title}</div>
          <div className="mt-0.5 truncate text-[13px] leading-5 text-[var(--text-muted)]">{description}</div>
          {detail}
        </div>
        <div className="flex items-start justify-end">{summarySuffix}</div>
      </div>

      <div
        className={`grid overflow-hidden transition-[grid-template-rows,opacity,margin] duration-200 ${
          expanded ? 'mt-4 grid-rows-[1fr] opacity-100' : 'mt-0 grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          {expanded ? (
            <div className="border-t border-[var(--border)] pt-4">{children}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function McpServerForm({
  scope,
  initialName = '',
  initialConfig,
  existingNames,
  onSave,
  onCancel,
}: {
  scope: ServerScope;
  initialName?: string;
  initialConfig?: McpServerConfig;
  existingNames: string[];
  onSave: (name: string, config: McpServerConfig) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [type, setType] = useState<NonNullable<McpServerConfig['type']>>(initialConfig?.type || 'stdio');
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
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <FieldBlock
          label="Server Name"
          description={`${scope === 'global' ? 'Available in every workspace.' : 'Only available in this workspace.'}`}
          error={errors.name}
        >
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
        </FieldBlock>

        <FieldBlock
          label="Transport"
          description="Pick the connection method that matches how the MCP server is hosted."
        >
          <div className="grid gap-2">
            {TYPE_OPTIONS.map((option) => {
              const selected = type === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setType(option.value)}
                  className={`flex items-start justify-between gap-3 rounded-[var(--radius-lg)] border px-3 py-2.5 text-left transition-colors ${
                    selected
                      ? 'border-[var(--text-muted)] bg-[var(--accent-light)]'
                      : 'border-[var(--border)] bg-[var(--bg-primary)] hover:bg-[var(--bg-tertiary)]'
                  }`}
                  aria-pressed={selected}
                >
                  <div>
                    <div className="text-[13px] font-medium text-[var(--text-primary)]">{option.label}</div>
                    <div className="mt-0.5 text-[12px] leading-5 text-[var(--text-muted)]">
                      {option.description}
                    </div>
                  </div>
                  {selected ? <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--text-primary)]" /> : null}
                </button>
              );
            })}
          </div>
        </FieldBlock>
      </div>

      {type === 'stdio' ? (
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <FieldBlock
            label="Command"
            description="The executable that starts the MCP server."
            error={errors.command}
          >
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
          </FieldBlock>

          <FieldBlock
            label="Arguments"
            description="Optional. Separate arguments with spaces."
          >
            <input
              type="text"
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              placeholder="@modelcontextprotocol/server-filesystem"
              className={getInputClassName(false)}
            />
          </FieldBlock>
        </div>
      ) : (
        <FieldBlock
          label="Server URL"
          description="The HTTP or SSE endpoint for this MCP server."
          error={errors.url}
        >
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
        </FieldBlock>
      )}

      <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)]">
        <button
          type="button"
          onClick={() => setAdvancedOpen((current) => !current)}
          className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left"
          aria-expanded={advancedOpen}
        >
          <div>
            <div className="text-[13px] font-medium text-[var(--text-primary)]">Advanced</div>
            <div className="mt-0.5 text-[12px] leading-5 text-[var(--text-muted)]">
              Environment variables for local commands or authenticated endpoints.
            </div>
          </div>
          <ChevronDown className={`h-4 w-4 flex-shrink-0 text-[var(--text-muted)] transition-transform ${advancedOpen ? 'rotate-180' : ''}`} />
        </button>

        <div
          className={`grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ${
            advancedOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          }`}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="border-t border-[var(--border)] px-3 py-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="text-[12px] text-[var(--text-muted)]">
                  Add only the variables this server needs to start successfully.
                </div>
                <button
                  type="button"
                  onClick={() => setEnvVars((current) => [...current, { key: '', value: '' }])}
                  className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-lg)] border border-[var(--border)] px-2.5 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Add Variable</span>
                </button>
              </div>

              {envVars.length === 0 ? (
                <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border)] px-3 py-3 text-[12px] text-[var(--text-muted)]">
                  No environment variables configured.
                </div>
              ) : (
                <div className="space-y-2">
                  {envVars.map((entry, index) => (
                    <div key={`${entry.key}-${index}`} className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
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
                        onClick={() =>
                          setEnvVars((current) => current.filter((_, itemIndex) => itemIndex !== index))
                        }
                        className="inline-flex h-10 items-center gap-1.5 rounded-[var(--radius-lg)] border border-[var(--border)] px-3 text-[12px] font-medium text-[var(--error)] transition-colors hover:bg-[var(--bg-tertiary)]"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        <span>Remove</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] pt-4">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-9 items-center rounded-[var(--radius-lg)] border border-[var(--border)] px-4 text-[13px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="inline-flex h-9 items-center rounded-[var(--radius-lg)] bg-[var(--accent)] px-4 text-[13px] font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)]"
        >
          Save Server
        </button>
      </div>
    </form>
  );
}

function FieldBlock({
  label,
  description,
  error,
  children,
}: {
  label: string;
  description: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[13px] font-medium text-[var(--text-primary)]">{label}</div>
      <div className="mb-2 text-[12px] leading-5 text-[var(--text-muted)]">{description}</div>
      {children}
      {error ? <div className="mt-1.5 text-[12px] text-[var(--error)]">{error}</div> : null}
    </div>
  );
}

function StatusBadge({
  label,
  tone,
}: {
  label: string;
  tone: 'success' | 'warning' | 'error' | 'muted';
}) {
  return (
    <span className="inline-flex h-8 items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--border)] px-2.5 text-[12px] font-medium text-[var(--text-secondary)]">
      <span className={`h-2 w-2 rounded-full ${getStatusDotClassName(tone)}`} />
      <span>{label}</span>
    </span>
  );
}

function MetaBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex h-8 items-center rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 text-[12px] font-medium text-[var(--text-muted)]">
      {label}
    </span>
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

function getServerSummary(config: McpServerConfig) {
  const type = config.type || 'stdio';
  if (type === 'stdio') {
    const parts = [config.command, ...(config.args || [])].filter(Boolean);
    return parts.length > 0 ? `Runs: ${parts.join(' ')}` : 'Starts a local MCP process.';
  }

  return config.url ? `Endpoint: ${config.url}` : 'Connects to a remote MCP endpoint.';
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
  return `h-10 w-full rounded-[var(--radius-lg)] border bg-[var(--bg-primary)] px-3 text-[13px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] ${
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

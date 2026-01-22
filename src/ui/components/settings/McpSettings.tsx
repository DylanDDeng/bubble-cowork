import { useState, useEffect } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { sendEvent } from '../../hooks/useIPC';
import type { McpServerConfig, McpServerStatus } from '../../types';

type ServerScope = 'global' | 'project';

// MCP 设置内容组件（用于嵌入 Settings 面板）
export function McpSettingsContent() {
  const {
    mcpGlobalServers,
    mcpProjectServers,
    mcpServerStatus,
    showSettings,
    activeSessionId,
    sessions,
  } = useAppStore();

  const [editingServer, setEditingServer] = useState<{
    name: string;
    config: McpServerConfig;
    scope: ServerScope;
  } | null>(null);
  const [isAddingNew, setIsAddingNew] = useState<ServerScope | null>(null);

  // 获取当前项目路径
  const currentProjectPath = activeSessionId ? sessions[activeSessionId]?.cwd : undefined;

  // 请求 MCP 配置
  useEffect(() => {
    if (showSettings) {
      sendEvent({
        type: 'mcp.get-config',
        payload: { projectPath: currentProjectPath },
      });
    }
  }, [showSettings, currentProjectPath]);

  // 获取服务器状态
  const getServerStatus = (name: string): McpServerStatus | undefined => {
    return mcpServerStatus.find((s) => s.name === name);
  };

  // 删除服务器
  const handleDelete = (name: string, scope: ServerScope) => {
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
  };

  // 保存服务器
  const handleSave = (name: string, config: McpServerConfig, scope: ServerScope) => {
    if (scope === 'global') {
      sendEvent({
        type: 'mcp.save-config',
        payload: {
          globalServers: {
            ...mcpGlobalServers,
            [name]: config,
          },
        },
      });
    } else {
      sendEvent({
        type: 'mcp.save-config',
        payload: {
          projectServers: {
            ...mcpProjectServers,
            [name]: config,
          },
          projectPath: currentProjectPath,
        },
      });
    }
    setEditingServer(null);
    setIsAddingNew(null);
  };

  const hasGlobalServers = Object.keys(mcpGlobalServers).length > 0;
  const hasProjectServers = Object.keys(mcpProjectServers).length > 0;
  const hasNoServers = !hasGlobalServers && !hasProjectServers && isAddingNew === null;

  return (
    <div className="flex flex-col h-full">
      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {hasNoServers ? (
          <div className="text-center py-8 text-[var(--text-muted)]">
            <p>No MCP servers configured</p>
            <p className="text-sm mt-2">
              Add MCP servers to extend Claude's capabilities
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* 全局服务器 */}
            <ServerSection
              title="Global Servers"
              description="Available in all projects"
              servers={mcpGlobalServers}
              scope="global"
              editingServer={editingServer}
              isAddingNew={isAddingNew === 'global'}
              getServerStatus={getServerStatus}
              onEdit={(name, config) => setEditingServer({ name, config, scope: 'global' })}
              onDelete={(name) => handleDelete(name, 'global')}
              onSave={(name, config) => handleSave(name, config, 'global')}
              onCancelEdit={() => setEditingServer(null)}
              onAddNew={() => setIsAddingNew('global')}
              onCancelAdd={() => setIsAddingNew(null)}
            />

            {/* 项目级服务器 */}
            {currentProjectPath && (
              <ServerSection
                title="Project Servers"
                description={`Only available in ${currentProjectPath.split('/').pop()}`}
                servers={mcpProjectServers}
                scope="project"
                editingServer={editingServer}
                isAddingNew={isAddingNew === 'project'}
                getServerStatus={getServerStatus}
                onEdit={(name, config) => setEditingServer({ name, config, scope: 'project' })}
                onDelete={(name) => handleDelete(name, 'project')}
                onSave={(name, config) => handleSave(name, config, 'project')}
                onCancelEdit={() => setEditingServer(null)}
                onAddNew={() => setIsAddingNew('project')}
                onCancelAdd={() => setIsAddingNew(null)}
              />
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      {hasNoServers && (
        <div className="p-4 border-t border-[var(--border-primary)] flex gap-2">
          <button
            onClick={() => setIsAddingNew('global')}
            className="px-4 py-2 bg-[var(--accent)] text-white rounded-lg hover:bg-[var(--accent-hover)] transition-colors"
          >
            + Add Global Server
          </button>
          {currentProjectPath && (
            <button
              onClick={() => setIsAddingNew('project')}
              className="px-4 py-2 border border-[var(--border-primary)] rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors"
            >
              + Add Project Server
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// 服务器分区组件
function ServerSection({
  title,
  description,
  servers,
  scope,
  editingServer,
  isAddingNew,
  getServerStatus,
  onEdit,
  onDelete,
  onSave,
  onCancelEdit,
  onAddNew,
  onCancelAdd,
}: {
  title: string;
  description: string;
  servers: Record<string, McpServerConfig>;
  scope: ServerScope;
  editingServer: { name: string; config: McpServerConfig; scope: ServerScope } | null;
  isAddingNew: boolean;
  getServerStatus: (name: string) => McpServerStatus | undefined;
  onEdit: (name: string, config: McpServerConfig) => void;
  onDelete: (name: string) => void;
  onSave: (name: string, config: McpServerConfig) => void;
  onCancelEdit: () => void;
  onAddNew: () => void;
  onCancelAdd: () => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="font-medium">{title}</h3>
          <p className="text-xs text-[var(--text-muted)]">{description}</p>
        </div>
        <button
          onClick={onAddNew}
          disabled={isAddingNew || editingServer !== null}
          className="text-sm text-[var(--accent)] hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
        >
          + Add
        </button>
      </div>

      <div className="space-y-2">
        {Object.entries(servers).map(([name, config]) => {
          const status = getServerStatus(name);
          const isEditing = editingServer?.name === name && editingServer?.scope === scope;

          if (isEditing) {
            return (
              <McpServerForm
                key={name}
                initialName={name}
                initialConfig={config}
                onSave={(n, c) => onSave(n, c)}
                onCancel={onCancelEdit}
              />
            );
          }

          return (
            <ServerCard
              key={name}
              name={name}
              config={config}
              status={status}
              onEdit={() => onEdit(name, config)}
              onDelete={() => onDelete(name)}
            />
          );
        })}

        {Object.keys(servers).length === 0 && !isAddingNew && (
          <div className="text-sm text-[var(--text-muted)] py-2">
            No servers configured
          </div>
        )}

        {isAddingNew && (
          <McpServerForm
            onSave={(n, c) => onSave(n, c)}
            onCancel={onCancelAdd}
          />
        )}
      </div>
    </div>
  );
}

// 服务器卡片
function ServerCard({
  name,
  config,
  status,
  onEdit,
  onDelete,
}: {
  name: string;
  config: McpServerConfig;
  status?: McpServerStatus;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const type = config.type || 'stdio';
  const statusColor = status
    ? status.status === 'connected'
      ? 'bg-green-500'
      : status.status === 'failed'
      ? 'bg-red-500'
      : 'bg-yellow-500'
    : 'bg-gray-500';

  return (
    <div className="bg-[var(--bg-secondary)] rounded-lg p-4">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full ${statusColor}`} />
          <div>
            <div className="font-medium">{name}</div>
            <div className="text-sm text-[var(--text-muted)]">
              {type === 'stdio' ? config.command : config.url}
            </div>
            {status?.error && (
              <div className="text-sm text-red-400 mt-1">{status.error}</div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--text-muted)] px-2 py-1 bg-[var(--bg-tertiary)] rounded">
            {type}
          </span>
          <button
            onClick={onEdit}
            className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
          >
            <EditIcon />
          </button>
          <button
            onClick={onDelete}
            className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-red-400"
          >
            <DeleteIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

// 服务器配置表单
function McpServerForm({
  initialName = '',
  initialConfig,
  onSave,
  onCancel,
}: {
  initialName?: string;
  initialConfig?: McpServerConfig;
  onSave: (name: string, config: McpServerConfig) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [type, setType] = useState<'stdio' | 'http' | 'sse'>(
    initialConfig?.type || 'stdio'
  );
  const [command, setCommand] = useState(initialConfig?.command || '');
  const [args, setArgs] = useState(initialConfig?.args?.join(' ') || '');
  const [url, setUrl] = useState(initialConfig?.url || '');
  const [envVars, setEnvVars] = useState<{ key: string; value: string }[]>(
    initialConfig?.env
      ? Object.entries(initialConfig.env).map(([key, value]) => ({ key, value }))
      : []
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const config: McpServerConfig = { type };

    if (type === 'stdio') {
      config.command = command;
      if (args.trim()) {
        config.args = args.split(' ').filter(Boolean);
      }
    } else {
      config.url = url;
    }

    if (envVars.length > 0) {
      config.env = {};
      for (const { key, value } of envVars) {
        if (key.trim()) {
          config.env[key] = value;
        }
      }
    }

    onSave(name, config);
  };

  const addEnvVar = () => {
    setEnvVars([...envVars, { key: '', value: '' }]);
  };

  const removeEnvVar = (index: number) => {
    setEnvVars(envVars.filter((_, i) => i !== index));
  };

  const updateEnvVar = (index: number, field: 'key' | 'value', value: string) => {
    const updated = [...envVars];
    updated[index][field] = value;
    setEnvVars(updated);
  };

  return (
    <form onSubmit={handleSubmit} className="bg-[var(--bg-secondary)] rounded-lg p-4">
      <div className="space-y-4">
        {/* Name */}
        <div>
          <label className="block text-sm font-medium mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. filesystem"
            className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-primary)] rounded-lg focus:outline-none focus:border-[var(--accent)]"
            disabled={!!initialName}
          />
        </div>

        {/* Type */}
        <div>
          <label className="block text-sm font-medium mb-2">Type</label>
          <div className="flex gap-4">
            {(['stdio', 'http', 'sse'] as const).map((t) => (
              <label key={t} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="type"
                  value={t}
                  checked={type === t}
                  onChange={() => setType(t)}
                  className="accent-[var(--accent)]"
                />
                <span>{t}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Type-specific fields */}
        {type === 'stdio' ? (
          <>
            <div>
              <label className="block text-sm font-medium mb-1">Command</label>
              <input
                type="text"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="e.g. npx"
                className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-primary)] rounded-lg focus:outline-none focus:border-[var(--accent)]"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Arguments</label>
              <input
                type="text"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder="e.g. @modelcontextprotocol/server-filesystem"
                className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-primary)] rounded-lg focus:outline-none focus:border-[var(--accent)]"
              />
            </div>
          </>
        ) : (
          <div>
            <label className="block text-sm font-medium mb-1">URL</label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="e.g. http://localhost:3000/mcp"
              className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-primary)] rounded-lg focus:outline-none focus:border-[var(--accent)]"
            />
          </div>
        )}

        {/* Environment Variables */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium">Environment Variables</label>
            <button
              type="button"
              onClick={addEnvVar}
              className="text-sm text-[var(--accent)] hover:underline"
            >
              + Add
            </button>
          </div>
          {envVars.length > 0 && (
            <div className="space-y-2">
              {envVars.map((env, index) => (
                <div key={index} className="flex gap-2">
                  <input
                    type="text"
                    value={env.key}
                    onChange={(e) => updateEnvVar(index, 'key', e.target.value)}
                    placeholder="KEY"
                    className="flex-1 px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-primary)] rounded-lg focus:outline-none focus:border-[var(--accent)] text-sm"
                  />
                  <input
                    type="text"
                    value={env.value}
                    onChange={(e) => updateEnvVar(index, 'value', e.target.value)}
                    placeholder="value"
                    className="flex-1 px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-primary)] rounded-lg focus:outline-none focus:border-[var(--accent)] text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => removeEnvVar(index)}
                    className="p-2 text-red-400 hover:bg-[var(--bg-tertiary)] rounded"
                  >
                    <DeleteIcon />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="px-4 py-2 bg-[var(--accent)] text-white rounded-lg hover:bg-[var(--accent-hover)] transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </form>
  );
}

// Icons
function EditIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

import { useEffect, useState } from 'react';
import { Bot, FolderOpen, Play, Square } from 'lucide-react';
import { toast } from 'sonner';
import type { AgentProvider, FeishuBridgeConfig, FeishuBridgeStatus } from '../../types';

const DEFAULT_CONFIG: FeishuBridgeConfig = {
  enabled: false,
  appId: '',
  appSecret: '',
  defaultCwd: '',
  provider: 'claude',
  model: '',
  allowedUserIds: '',
  autoStart: false,
};

export function BridgeSettingsContent() {
  const [config, setConfig] = useState<FeishuBridgeConfig>(DEFAULT_CONFIG);
  const [status, setStatus] = useState<FeishuBridgeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [nextConfig, nextStatus] = await Promise.all([
          window.electron.getFeishuBridgeConfig(),
          window.electron.getFeishuBridgeStatus(),
        ]);
        if (!cancelled) {
          setConfig(nextConfig);
          setStatus(nextStatus);
        }
      } catch (error) {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : 'Failed to load bridge settings.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();
    const timer = window.setInterval(() => {
      void window.electron.getFeishuBridgeStatus().then((nextStatus) => {
        if (!cancelled) setStatus(nextStatus);
      }).catch(() => {
        // ignore polling errors
      });
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const updateConfig = <K extends keyof FeishuBridgeConfig>(key: K, value: FeishuBridgeConfig[K]) => {
    setConfig((current) => ({ ...current, [key]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const saved = await window.electron.saveFeishuBridgeConfig(config);
      setConfig(saved);
      toast.success('Bridge settings saved.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save bridge settings.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (action: 'start' | 'stop') => {
    setToggling(true);
    try {
      const nextStatus =
        action === 'start'
          ? await window.electron.startFeishuBridge()
          : await window.electron.stopFeishuBridge();
      setStatus(nextStatus);
      toast.success(action === 'start' ? 'Feishu bridge started.' : 'Feishu bridge stopped.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update bridge status.');
    } finally {
      setToggling(false);
    }
  };

  const handlePickDirectory = async () => {
    try {
      const selected = await window.electron.selectDirectory();
      if (selected) {
        updateConfig('defaultCwd', selected);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to select directory.');
    }
  };

  if (loading) {
    return <div className="text-sm text-[var(--text-secondary)]">Loading bridge settings...</div>;
  }

  const isRunning = status?.running === true;

  return (
    <div className="space-y-8 pb-12">
      <section className="rounded-[20px] border border-[var(--border)] bg-[var(--bg-secondary)] p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-[12px] bg-[var(--bg-tertiary)] text-[var(--text-primary)]">
                <Bot className="h-5 w-5" />
              </div>
              <div>
                <div className="text-[18px] font-semibold text-[var(--text-primary)]">Feishu Bridge</div>
                <div className="mt-1 text-sm text-[var(--text-secondary)]">
                  Bridge Feishu private chats into local Claude/Codex sessions on this machine.
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleToggle('start')}
              disabled={toggling || isRunning}
              className="inline-flex items-center gap-2 rounded-[14px] border border-[var(--border)] bg-[var(--accent-light)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
            >
              <Play className="h-4 w-4" />
              <span>Start</span>
            </button>
            <button
              type="button"
              onClick={() => void handleToggle('stop')}
              disabled={toggling || !isRunning}
              className="inline-flex items-center gap-2 rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
            >
              <Square className="h-3.5 w-3.5" fill="currentColor" />
              <span>Stop</span>
            </button>
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <StatusCard label="State" value={isRunning ? 'Running' : 'Stopped'} />
          <StatusCard label="Connected" value={status?.connected ? 'Yes' : 'No'} />
          <StatusCard label="Bindings" value={String(status?.activeBindings || 0)} />
          <StatusCard label="Bot Open ID" value={status?.botOpenId || 'Unknown'} />
        </div>

        {status?.lastError && (
          <div className="mt-4 rounded-[16px] border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3 text-sm text-[var(--text-secondary)]">
            <span className="font-medium text-[var(--text-primary)]">Last error:</span> {status.lastError}
          </div>
        )}
      </section>

      <section className="rounded-[20px] border border-[var(--border)] bg-[var(--bg-secondary)]">
        <BridgeField
          label="Bridge enabled"
          description="Required before the bridge can start."
        >
          <ToggleButton checked={config.enabled} onChange={(checked) => updateConfig('enabled', checked)} />
        </BridgeField>

        <BridgeField label="App ID" description="From your Feishu self-built app credentials.">
          <input
            value={config.appId}
            onChange={(event) => updateConfig('appId', event.target.value)}
            className="h-10 w-full rounded-[16px] border border-[var(--border)] bg-[var(--bg-primary)] px-4 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--text-muted)]"
          />
        </BridgeField>

        <BridgeField label="App Secret" description="Stored locally on this machine.">
          <input
            type="password"
            value={config.appSecret}
            onChange={(event) => updateConfig('appSecret', event.target.value)}
            className="h-10 w-full rounded-[16px] border border-[var(--border)] bg-[var(--bg-primary)] px-4 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--text-muted)]"
          />
        </BridgeField>

        <BridgeField label="Default workspace" description="Used when a Feishu chat starts a new session.">
          <div className="flex items-center gap-2">
            <input
              value={config.defaultCwd}
              onChange={(event) => updateConfig('defaultCwd', event.target.value)}
              className="h-10 min-w-0 flex-1 rounded-[16px] border border-[var(--border)] bg-[var(--bg-primary)] px-4 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--text-muted)]"
            />
            <button
              type="button"
              onClick={() => void handlePickDirectory()}
              className="inline-flex h-10 items-center gap-2 rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] px-4 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
            >
              <FolderOpen className="h-4 w-4" />
              <span>Browse</span>
            </button>
          </div>
        </BridgeField>

        <BridgeField label="Runtime" description="Choose which agent runtime handles Feishu chats.">
          <div className="inline-flex items-center gap-1 rounded-[14px] bg-[var(--bg-tertiary)] p-1">
            <ProviderModeButton
              label="Claude"
              value="claude"
              current={config.provider}
              onClick={() => updateConfig('provider', 'claude')}
            />
            <ProviderModeButton
              label="Codex"
              value="codex"
              current={config.provider}
              onClick={() => updateConfig('provider', 'codex')}
            />
          </div>
        </BridgeField>

        <BridgeField label="Default model" description="Optional. Leave blank to use the current runtime default.">
          <input
            value={config.model}
            onChange={(event) => updateConfig('model', event.target.value)}
            className="h-10 w-full rounded-[16px] border border-[var(--border)] bg-[var(--bg-primary)] px-4 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--text-muted)]"
          />
        </BridgeField>

        <BridgeField label="Allowed user IDs" description="Comma-separated Feishu user open_ids. Leave blank to allow all private chats.">
          <input
            value={config.allowedUserIds}
            onChange={(event) => updateConfig('allowedUserIds', event.target.value)}
            className="h-10 w-full rounded-[16px] border border-[var(--border)] bg-[var(--bg-primary)] px-4 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--text-muted)]"
          />
        </BridgeField>

        <BridgeField label="Start on launch" description="Automatically start the bridge when the app opens.">
          <ToggleButton checked={config.autoStart} onChange={(checked) => updateConfig('autoStart', checked)} />
        </BridgeField>
      </section>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="rounded-[14px] border border-[var(--border)] bg-[var(--accent-light)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function BridgeField({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(340px,440px)] items-start gap-5 border-b border-[var(--border)] px-6 py-4 last:border-b-0">
      <div className="space-y-1">
        <div className="text-[15px] font-semibold text-[var(--text-primary)]">{label}</div>
        <div className="text-[14px] leading-6 text-[var(--text-secondary)]">{description}</div>
      </div>
      <div className="flex justify-end">{children}</div>
    </div>
  );
}

function StatusCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[16px] border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">{label}</div>
      <div className="mt-2 truncate text-sm font-medium text-[var(--text-primary)]">{value}</div>
    </div>
  );
}

function ProviderModeButton({
  label,
  value,
  current,
  onClick,
}: {
  label: string;
  value: AgentProvider;
  current: AgentProvider;
  onClick: () => void;
}) {
  const active = value === current;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-[14px] px-4 py-2 text-sm transition-colors ${
        active
          ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-[0_1px_2px_rgba(15,23,42,0.08)]'
          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
      }`}
    >
      {label}
    </button>
  );
}

function ToggleButton({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
        checked ? 'bg-[var(--accent)]' : 'bg-[var(--bg-tertiary)]'
      }`}
    >
      <span
        className={`absolute h-5 w-5 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

import { useEffect, useState } from 'react';
import { FolderOpen, Play, Square } from 'lucide-react';
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
      }).catch(() => {});
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
    <div className="space-y-6 pb-8">
      <BridgeSection title="Status">
        <BridgeRow label="State" description="Current bridge connection status.">
          <div className="flex items-center gap-3">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium ${
              isRunning
                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
                : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
            }`}>
              <span className={`h-1.5 w-1.5 rounded-full ${isRunning ? 'bg-emerald-500' : 'bg-[var(--text-muted)]'}`} />
              {isRunning ? 'Running' : 'Stopped'}
            </span>
            {status?.connected && (
              <span className="text-[12px] text-emerald-600 dark:text-emerald-400">Connected</span>
            )}
          </div>
        </BridgeRow>

        <BridgeRow label="Controls" description="Start or stop the bridge service.">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleToggle('start')}
              disabled={toggling || isRunning}
              className="inline-flex items-center gap-1.5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--accent-light)] px-3 py-1.5 text-[13px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" />
              Start
            </button>
            <button
              type="button"
              onClick={() => void handleToggle('stop')}
              disabled={toggling || !isRunning}
              className="inline-flex items-center gap-1.5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-[13px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
            >
              <Square className="h-3 w-3" fill="currentColor" />
              Stop
            </button>
          </div>
        </BridgeRow>

        <BridgeRow label="Active bindings" description="Feishu chats mapped to local sessions.">
          <span className="text-[14px] font-medium text-[var(--text-primary)]">
            {String(status?.activeBindings || 0)}
          </span>
        </BridgeRow>

        {status?.botOpenId && status.botOpenId !== 'Unknown' && (
          <BridgeRow label="Bot Open ID" description="The bot identity used by the bridge.">
            <span className="max-w-[240px] truncate text-[13px] font-mono text-[var(--text-secondary)]">
              {status.botOpenId}
            </span>
          </BridgeRow>
        )}

        {status?.lastError && (
          <BridgeRow label="Last error" description="">
            <span className="max-w-[320px] truncate text-[13px] text-[var(--error)]">
              {status.lastError}
            </span>
          </BridgeRow>
        )}
      </BridgeSection>

      <BridgeSection title="Credentials">
        <BridgeRow label="Bridge enabled" description="Required before the bridge can start.">
          <ToggleButton checked={config.enabled} onChange={(checked) => updateConfig('enabled', checked)} />
        </BridgeRow>

        <BridgeRow label="App ID" description="From your Feishu self-built app credentials.">
          <input
            value={config.appId}
            onChange={(event) => updateConfig('appId', event.target.value)}
            className="h-9 w-full rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-[13px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--text-muted)]"
          />
        </BridgeRow>

        <BridgeRow label="App Secret" description="Stored locally on this machine.">
          <input
            type="password"
            value={config.appSecret}
            onChange={(event) => updateConfig('appSecret', event.target.value)}
            className="h-9 w-full rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-[13px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--text-muted)]"
          />
        </BridgeRow>
      </BridgeSection>

      <BridgeSection title="Runtime">
        <BridgeRow label="Default workspace" description="Used when a Feishu chat starts a new session.">
          <div className="flex items-center gap-2">
            <input
              value={config.defaultCwd}
              onChange={(event) => updateConfig('defaultCwd', event.target.value)}
              className="h-9 min-w-0 flex-1 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-[13px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--text-muted)]"
            />
            <button
              type="button"
              onClick={() => void handlePickDirectory()}
              className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-[13px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              Browse
            </button>
          </div>
        </BridgeRow>

        <BridgeRow label="Runtime" description="Choose which agent runtime handles Feishu chats.">
          <div className="inline-flex items-center gap-0.5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] p-0.5">
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
        </BridgeRow>

        <BridgeRow label="Default model" description="Optional. Leave blank for runtime default.">
          <input
            value={config.model}
            onChange={(event) => updateConfig('model', event.target.value)}
            className="h-9 w-full rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-[13px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--text-muted)]"
          />
        </BridgeRow>

        <BridgeRow label="Allowed user IDs" description="Comma-separated. Leave blank to allow all.">
          <input
            value={config.allowedUserIds}
            onChange={(event) => updateConfig('allowedUserIds', event.target.value)}
            className="h-9 w-full rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-[13px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--text-muted)]"
          />
        </BridgeRow>

        <BridgeRow label="Start on launch" description="Auto-start bridge when the app opens.">
          <ToggleButton checked={config.autoStart} onChange={(checked) => updateConfig('autoStart', checked)} />
        </BridgeRow>
      </BridgeSection>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="h-9 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--accent-light)] px-4 text-[13px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function BridgeSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-[var(--border)] pb-6 last:border-b-0 last:pb-0">
      <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]">
        {title}
      </h2>
      <div>{children}</div>
    </section>
  );
}

function BridgeRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(240px,360px)] items-center gap-4 border-b border-[var(--border)] py-3.5 last:border-b-0">
      <div>
        <div className="text-[14px] font-medium text-[var(--text-primary)]">{label}</div>
        {description ? (
          <div className="mt-0.5 text-[13px] leading-5 text-[var(--text-muted)]">{description}</div>
        ) : null}
      </div>
      <div className="flex justify-end">{children}</div>
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
      className={`rounded-[var(--radius-lg)] px-3 py-1.5 text-[12px] transition-colors ${
        active
          ? 'bg-[var(--accent-light)] font-medium text-[var(--text-primary)] shadow-[0_1px_2px_rgba(15,23,42,0.04)]'
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
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
        checked ? 'bg-[var(--accent)]' : 'bg-[var(--bg-tertiary)]'
      }`}
    >
      <span
        className={`absolute h-4.5 w-4.5 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-5.5' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

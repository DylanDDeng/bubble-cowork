import { useEffect, useState, type ReactNode } from 'react';
import { FolderOpen, Play, Square } from 'lucide-react';
import { toast } from 'sonner';
import type { FeishuBridgeConfig, FeishuBridgeStatus } from '../../types';
import {
  SegmentedControl,
  SegmentedControlItem,
  SettingsGroup,
  SettingsRow,
  SettingsToggle,
} from './SettingsPrimitives';

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

const INPUT_CLASS =
  'h-8 w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 text-[12.5px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--text-muted)]';

const GHOST_BUTTON_CLASS =
  'inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-[12.5px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-secondary)] disabled:opacity-50';

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
      void window.electron
        .getFeishuBridgeStatus()
        .then((nextStatus) => {
          if (!cancelled) setStatus(nextStatus);
        })
        .catch(() => {});
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
    return (
      <div className="px-1 py-2 text-[12.5px] text-[var(--text-muted)]">Loading bridge settings…</div>
    );
  }

  const isRunning = status?.running === true;
  const isConnected = status?.connected === true;
  const stateLabel = isRunning ? (isConnected ? 'Running · Connected' : 'Running') : 'Stopped';
  const stateTone = isRunning
    ? isConnected
      ? 'text-[var(--success)]'
      : 'text-[var(--text-primary)]'
    : 'text-[var(--text-muted)]';
  const stateDot = isRunning
    ? isConnected
      ? 'bg-[var(--success)]'
      : 'bg-[var(--warning)]'
    : 'bg-[var(--text-muted)]';

  return (
    <div className="space-y-6 pb-8">
      <SettingsGroup title="Status">
        <SettingsRow variant="card" label="State" description="Current bridge connection.">
          <span className="inline-flex items-center gap-1.5 text-[12px] font-medium">
            <span className={`h-1.5 w-1.5 rounded-full ${stateDot}`} aria-hidden="true" />
            <span className={stateTone}>{stateLabel}</span>
          </span>
        </SettingsRow>

        <SettingsRow variant="card" label="Controls" description="Start or stop the bridge service.">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleToggle('start')}
              disabled={toggling || isRunning}
              className={GHOST_BUTTON_CLASS}
            >
              <Play className="h-3 w-3" />
              Start
            </button>
            <button
              type="button"
              onClick={() => void handleToggle('stop')}
              disabled={toggling || !isRunning}
              className={GHOST_BUTTON_CLASS}
            >
              <Square className="h-3 w-3" fill="currentColor" />
              Stop
            </button>
          </div>
        </SettingsRow>

        <SettingsRow variant="card" label="Active bindings" description="Feishu chats mapped to local sessions.">
          <span className="text-[13px] font-medium text-[var(--text-primary)]">
            {status?.activeBindings ?? 0}
          </span>
        </SettingsRow>

        {status?.botOpenId && status.botOpenId !== 'Unknown' ? (
          <SettingsRow variant="card" label="Bot Open ID" description="The bot identity used by the bridge.">
            <span className="max-w-[220px] truncate font-mono text-[12px] text-[var(--text-muted)]">
              {status.botOpenId}
            </span>
          </SettingsRow>
        ) : null}

        {status?.lastError ? (
          <SettingsRow variant="card" label="Last error" align="start">
            <span className="max-w-[280px] truncate text-[12px] text-[var(--error)]">
              {status.lastError}
            </span>
          </SettingsRow>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Credentials">
        <SettingsRow
          variant="card"
          label="Bridge enabled"
          description="Required before the bridge can start."
        >
          <SettingsToggle
            checked={config.enabled}
            onChange={(next) => updateConfig('enabled', next)}
            ariaLabel="Toggle bridge enabled"
          />
        </SettingsRow>

        <BridgeFieldRow label="App ID" description="From your Feishu self-built app credentials.">
          <input
            value={config.appId}
            onChange={(event) => updateConfig('appId', event.target.value)}
            className={INPUT_CLASS}
            placeholder="cli_xxxxxxxxxxxx"
          />
        </BridgeFieldRow>

        <BridgeFieldRow label="App Secret" description="Stored locally on this machine.">
          <input
            type="password"
            value={config.appSecret}
            onChange={(event) => updateConfig('appSecret', event.target.value)}
            className={INPUT_CLASS}
            placeholder="••••••••••••••••"
          />
        </BridgeFieldRow>
      </SettingsGroup>

      <SettingsGroup title="Runtime">
        <BridgeFieldRow
          label="Default workspace"
          description="Used when a Feishu chat starts a new session."
        >
          <div className="flex items-center gap-2">
            <input
              value={config.defaultCwd}
              onChange={(event) => updateConfig('defaultCwd', event.target.value)}
              className={`${INPUT_CLASS} flex-1`}
              placeholder="/path/to/project"
            />
            <button
              type="button"
              onClick={() => void handlePickDirectory()}
              className={GHOST_BUTTON_CLASS}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              Browse
            </button>
          </div>
        </BridgeFieldRow>

        <SettingsRow
          variant="card"
          label="Runtime"
          description="Choose which agent runtime handles Feishu chats."
        >
          <SegmentedControl ariaLabel="Agent runtime">
            <SegmentedControlItem
              active={config.provider === 'claude'}
              onClick={() => updateConfig('provider', 'claude')}
            >
              Claude
            </SegmentedControlItem>
            <SegmentedControlItem
              active={config.provider === 'codex'}
              onClick={() => updateConfig('provider', 'codex')}
            >
              Codex
            </SegmentedControlItem>
          </SegmentedControl>
        </SettingsRow>

        <BridgeFieldRow
          label="Default model"
          description="Optional. Leave blank for runtime default."
        >
          <input
            value={config.model}
            onChange={(event) => updateConfig('model', event.target.value)}
            className={INPUT_CLASS}
            placeholder="e.g. claude-sonnet-4-5"
          />
        </BridgeFieldRow>

        <BridgeFieldRow
          label="Allowed user IDs"
          description="Comma-separated open IDs. Leave blank to allow all."
        >
          <input
            value={config.allowedUserIds}
            onChange={(event) => updateConfig('allowedUserIds', event.target.value)}
            className={INPUT_CLASS}
            placeholder="ou_xxx, ou_yyy"
          />
        </BridgeFieldRow>

        <SettingsRow
          variant="card"
          label="Start on launch"
          description="Auto-start bridge when the app opens."
        >
          <SettingsToggle
            checked={config.autoStart}
            onChange={(next) => updateConfig('autoStart', next)}
            ariaLabel="Toggle auto-start on launch"
          />
        </SettingsRow>
      </SettingsGroup>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="inline-flex h-8 items-center rounded-md bg-[var(--accent)] px-4 text-[12.5px] font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// Stacked label-above-input row used for text inputs inside a SettingsGroup.
// Mirrors the `FormField` pattern elsewhere but keeps group-style hairline
// dividers via the parent `SettingsGroup`'s `divide-y`.
function BridgeFieldRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div>
        <div className="text-[13px] font-medium text-[var(--text-primary)]">{label}</div>
        {description ? (
          <div className="mt-0.5 text-[12px] leading-5 text-[var(--text-muted)]">{description}</div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

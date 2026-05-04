import { useEffect, useState } from 'react';
import { ArrowLeft, Server, Settings as SettingsIcon, Sun, Moon, Monitor, ChartColumn, PlugZap, Bot, Users } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { ClaudeUsageSettingsContent } from './ClaudeUsageSettings';
import { CompatibleProviderSettingsContent } from './CompatibleProviderSettings';
import { AgentsSettingsContent } from './AgentsSettings';
import { McpSettingsContent } from './McpSettings';
import { ProviderPicker } from '../ProviderPicker';
import { BridgeSettingsContent } from './BridgeSettings';
import { ThemePackEditor } from './ThemePackEditor';
import { SettingsGroup, SettingsRow } from './SettingsPrimitives';
import type { AppUpdateStatus, ChromeTheme, Theme, ThemeFonts, ThemeState, ThemeVariant } from '../../types';
import { resolveThemeMode, resolveThemePack } from '../../theme/themes';
import { loadPreferredProvider, savePreferredProvider } from '../../utils/provider';

const SETTINGS_TABS = {
  general: {
    label: 'General',
    title: 'Workspace Preferences',
    description: 'Adjust appearance and core workspace behavior.',
    icon: <SettingsIcon className="w-4 h-4" />,
  },
  agents: {
    label: 'Agents',
    title: 'Agent Profiles',
    description: 'Configure global agent profiles used by DMs and project rosters.',
    icon: <Users className="w-4 h-4" />,
  },
  mcp: {
    label: 'MCP Servers',
    title: 'MCP Servers',
    description: 'Manage MCP tool backends for Claude Code and Codex.',
    icon: <Server className="w-4 h-4" />,
  },
  providers: {
    label: 'Providers',
    title: 'Providers',
    description: 'Configure Anthropic-compatible providers and route Claude sessions through them.',
    icon: <PlugZap className="w-4 h-4" />,
  },
  usage: {
    label: 'Usage',
    title: 'Usage',
    description: 'Review token, cost, session, and cache usage across models over time.',
    icon: <ChartColumn className="w-4 h-4" />,
  },
  bridge: {
    label: 'Bridge',
    title: 'Bridge',
    description: 'Connect remote chat channels to this desktop workspace.',
    icon: <Bot className="w-4 h-4" />,
  },
} as const;

// Settings 面板
export function Settings() {
  const {
    showSettings,
    setShowSettings,
    activeSettingsTab,
    setActiveSettingsTab,
    theme,
    setTheme,
    themeState,
    setThemeState,
    updateThemeVariant,
    setThemeVariantCodeThemeId,
    setThemeVariantFonts,
    resetThemeVariant,
    uiFontFamily,
    setUiFontFamily,
    chatCodeFontFamily,
    setChatCodeFontFamily,
    updateStatus,
  } = useAppStore();

  if (!showSettings) return null;

  const resolvedActiveSettingsTab = activeSettingsTab in SETTINGS_TABS
    ? activeSettingsTab
    : 'general';
  const activeMeta = SETTINGS_TABS[resolvedActiveSettingsTab];
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--bg-primary)]">
      <div className="flex h-8 flex-shrink-0">
        <div className="drag-region w-[280px] flex-shrink-0 border-r border-[var(--border)] bg-[var(--bg-tertiary)]" />
        <div className="drag-region flex-1 bg-[var(--bg-primary)]" />
      </div>

      <div className="flex min-h-0 flex-1 bg-[var(--bg-primary)]">
      <aside className="w-[280px] flex-shrink-0 select-none border-r border-[var(--border)] bg-[var(--bg-tertiary)]">
        <div className="flex h-full flex-col px-3 pb-6 pt-4">
          <button
            onClick={() => setShowSettings(false)}
            className="mb-2 flex items-center gap-2 rounded-[var(--radius-lg)] px-3 py-2 text-[13px] text-[var(--text-muted)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back</span>
          </button>

          <div className="mb-3 border-b border-[var(--border)]" />

          <div className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
            Settings
          </div>

          <ul className="space-y-0.5">
            {Object.entries(SETTINGS_TABS).map(([key, tab]) => (
              <SettingsNavItem
                key={key}
                label={tab.label}
                icon={tab.icon}
                active={resolvedActiveSettingsTab === key}
                onClick={() => setActiveSettingsTab(key as keyof typeof SETTINGS_TABS)}
              />
            ))}
          </ul>

        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-10 py-8">
          <header className="mb-6">
            <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              {activeMeta.title}
            </h1>
            <p className="mt-1 text-[12px] leading-5 text-[var(--text-muted)]">
              {activeMeta.description}
            </p>
          </header>

          {resolvedActiveSettingsTab === 'general' && (
            <GeneralSettingsContent
              theme={theme}
              setTheme={setTheme}
              themeState={themeState}
              setThemeState={setThemeState}
              updateThemeVariant={updateThemeVariant}
              setThemeVariantCodeThemeId={setThemeVariantCodeThemeId}
              setThemeVariantFonts={setThemeVariantFonts}
              resetThemeVariant={resetThemeVariant}
              uiFontFamily={uiFontFamily}
              setUiFontFamily={setUiFontFamily}
              chatCodeFontFamily={chatCodeFontFamily}
              setChatCodeFontFamily={setChatCodeFontFamily}
              updateStatus={updateStatus}
            />
          )}
          {resolvedActiveSettingsTab === 'agents' && <AgentsSettingsContent />}
          {resolvedActiveSettingsTab === 'mcp' && <McpSettingsContent />}
          {resolvedActiveSettingsTab === 'providers' && <CompatibleProviderSettingsContent />}
          {resolvedActiveSettingsTab === 'usage' && <ClaudeUsageSettingsContent />}
          {resolvedActiveSettingsTab === 'bridge' && <BridgeSettingsContent />}
        </div>
      </main>
      </div>
    </div>
  );
}

function SettingsNavItem({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        onClick={onClick}
        className={`group flex w-full items-center gap-2.5 rounded-[var(--radius-lg)] px-3 py-2 text-left text-[13px] transition-colors ${
          active
            ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
        }`}
      >
        <span className={`flex h-4 w-4 flex-shrink-0 items-center justify-center ${active ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)] group-hover:text-[var(--text-primary)]'}`}>
          {icon}
        </span>
        <span className="font-medium">{label}</span>
      </button>
    </li>
  );
}

function GeneralSettingsContent({
  theme,
  setTheme,
  themeState,
  setThemeState,
  updateThemeVariant,
  setThemeVariantCodeThemeId,
  setThemeVariantFonts,
  resetThemeVariant,
  uiFontFamily,
  setUiFontFamily,
  chatCodeFontFamily,
  setChatCodeFontFamily,
  updateStatus,
}: {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  themeState: ThemeState;
  setThemeState: (themeState: ThemeState) => void;
  updateThemeVariant: (variant: ThemeVariant, patch: Partial<ChromeTheme>) => void;
  setThemeVariantCodeThemeId: (variant: ThemeVariant, codeThemeId: string) => void;
  setThemeVariantFonts: (variant: ThemeVariant, patch: Partial<ThemeFonts>) => void;
  resetThemeVariant: (variant: ThemeVariant) => void;
  uiFontFamily: string;
  setUiFontFamily: (value: string) => void;
  chatCodeFontFamily: string;
  setChatCodeFontFamily: (value: string) => void;
  updateStatus: AppUpdateStatus;
}) {
  const resolvedMode = resolveThemeMode(theme);
  const [appVersion, setAppVersion] = useState('...');
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [defaultProvider, setDefaultProvider] = useState(loadPreferredProvider());
  const lightTheme = resolveThemePack(themeState, 'light');
  const darkTheme = resolveThemePack(themeState, 'dark');

  useEffect(() => {
    let cancelled = false;

    Promise.all([window.electron.getAppVersion(), window.electron.getUpdateStatus()])
      .then(([version, update]) => {
        if (!cancelled) {
          setAppVersion(version);
          if (
            update.available !== updateStatus.available ||
            update.version !== updateStatus.version ||
            update.autoDetected !== updateStatus.autoDetected
          ) {
            useAppStore.setState({
              updateStatus: {
                available: update.available,
                version: update.version,
                autoDetected: update.autoDetected,
              },
            });
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAppVersion('Unknown');
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleCheckForUpdates = async () => {
    setCheckingUpdates(true);
    try {
      await window.electron.checkForUpdates();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to check for updates.');
    } finally {
      setCheckingUpdates(false);
    }
  };

  return (
    <div className="space-y-6 pb-8">
      <SettingsGroup>
        <SettingsRow variant="card" label="Default Agent" description="New sessions use this agent.">
          <ProviderPicker
            value={defaultProvider}
            onChange={(provider) => {
              setDefaultProvider(provider);
              savePreferredProvider(provider);
            }}
            embedded
          />
        </SettingsRow>

        <SettingsRow variant="card" label="Updates" description={`Version ${appVersion}`}>
          <button
            type="button"
            onClick={() => void handleCheckForUpdates()}
            disabled={checkingUpdates}
            className="inline-flex h-8 items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
          >
            {checkingUpdates ? 'Checking...' : 'Check for Updates'}
            {updateStatus.autoDetected ? (
              <span
                className="inline-flex h-2 w-2 rounded-full bg-[var(--error)]"
                title={updateStatus.version ? `Update ${updateStatus.version} detected automatically` : 'Update detected automatically'}
                aria-label={updateStatus.version ? `Update ${updateStatus.version} detected automatically` : 'Update detected automatically'}
              />
            ) : null}
          </button>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Appearance">
        <SettingsRow variant="card" label="Mode" description="Light, dark, or follow system.">
          <div className="inline-flex items-center gap-0.5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-secondary)] p-0.5">
            <ThemeOption label="Light" value="light" current={theme} onClick={() => setTheme('light')} icon={<Sun className="w-3.5 h-3.5" />} />
            <ThemeOption label="Dark" value="dark" current={theme} onClick={() => setTheme('dark')} icon={<Moon className="w-3.5 h-3.5" />} />
            <ThemeOption label="System" value="system" current={theme} onClick={() => setTheme('system')} icon={<Monitor className="w-3.5 h-3.5" />} />
          </div>
        </SettingsRow>
      </SettingsGroup>

      <div className="space-y-3">
        <ThemePackEditor
          variant="light"
          mode={theme}
          isActive={resolvedMode === 'light'}
          pack={lightTheme}
          themeState={themeState}
          onReset={() => resetThemeVariant('light')}
          onCodeThemeChange={(codeThemeId) => setThemeVariantCodeThemeId('light', codeThemeId)}
          onThemePatch={(patch) => updateThemeVariant('light', patch)}
          onFontPatch={(patch) => setThemeVariantFonts('light', patch)}
          onImportThemeString={setThemeState}
        />
        <ThemePackEditor
          variant="dark"
          mode={theme}
          isActive={resolvedMode === 'dark'}
          pack={darkTheme}
          themeState={themeState}
          onReset={() => resetThemeVariant('dark')}
          onCodeThemeChange={(codeThemeId) => setThemeVariantCodeThemeId('dark', codeThemeId)}
          onThemePatch={(patch) => updateThemeVariant('dark', patch)}
          onFontPatch={(patch) => setThemeVariantFonts('dark', patch)}
          onImportThemeString={setThemeState}
        />
      </div>

      <SettingsGroup title="Typography">
        <SettingsRow
          variant="card"
          label="UI Font Override"
          description="Override the active theme's UI font across the app."
        >
          <input
            type="text"
            value={uiFontFamily}
            onChange={(event) => setUiFontFamily(event.target.value)}
            placeholder="-apple-system, BlinkMacSystemFont..."
            spellCheck={false}
            className="h-8 w-[280px] rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-right text-[12px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
          />
        </SettingsRow>

        <SettingsRow
          variant="card"
          label="Code Font Override"
          description="Override code blocks and inline code in chat."
        >
          <input
            type="text"
            value={chatCodeFontFamily}
            onChange={(event) => setChatCodeFontFamily(event.target.value)}
            placeholder='"JetBrains Mono", monospace'
            spellCheck={false}
            className="h-8 w-[280px] rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-right font-mono text-[12px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
          />
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}

function ThemeOption({
  label,
  value,
  current,
  onClick,
  icon,
}: {
  label: string;
  value: Theme;
  current: Theme;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  const isActive = current === value;
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-[var(--radius-lg)] px-3 py-1.5 text-[12px] transition-colors ${
        isActive
          ? 'bg-[var(--accent-light)] font-medium text-[var(--text-primary)] shadow-[0_1px_2px_rgba(15,23,42,0.04)]'
          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

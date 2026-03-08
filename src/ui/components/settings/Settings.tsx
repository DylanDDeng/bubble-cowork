import { ArrowLeft, Server, Settings as SettingsIcon, Sun, Moon, Monitor, BookOpen, ChartColumn } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { ClaudeUsageSettingsContent } from './ClaudeUsageSettings';
import { McpSettingsContent } from './McpSettings';
import { SkillsSettingsContent } from './SkillsSettings';
import type { Theme } from '../../types';

const SETTINGS_TABS = {
  general: {
    label: 'General',
    title: 'Workspace Preferences',
    description: 'Tune appearance and baseline behavior for the desktop workspace.',
    icon: <SettingsIcon className="w-4 h-4" />,
  },
  mcp: {
    label: 'MCP Servers',
    title: 'MCP Servers',
    description: 'Manage the tool backends available to Claude across global and project scopes.',
    icon: <Server className="w-4 h-4" />,
  },
  skills: {
    label: 'Claude Skills',
    title: 'Claude Skills',
    description: 'Review the user and workspace skills the Claude runner can discover.',
    icon: <BookOpen className="w-4 h-4" />,
  },
  usage: {
    label: 'Claude Usage',
    title: 'Claude Usage',
    description: 'Review token, cost, session, and cache usage across Claude models over time.',
    icon: <ChartColumn className="w-4 h-4" />,
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
  } = useAppStore();

  if (!showSettings) return null;

  const activeMeta = SETTINGS_TABS[activeSettingsTab];

  return (
    <div className="flex h-full min-h-0 min-w-0 bg-[var(--bg-primary)]">
      <aside className="w-[280px] flex-shrink-0 border-r border-[var(--border)] bg-[var(--bg-primary)]">
        <div className="flex h-full flex-col px-3 pb-6 pt-4">
          <button
            onClick={() => setShowSettings(false)}
            className="mb-5 flex items-center gap-2 rounded-xl px-3 py-2 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back to app</span>
          </button>

          <ul className="space-y-1">
            {Object.entries(SETTINGS_TABS).map(([key, tab]) => (
              <SettingsNavItem
                key={key}
                label={tab.label}
                icon={tab.icon}
                active={activeSettingsTab === key}
                onClick={() => setActiveSettingsTab(key as keyof typeof SETTINGS_TABS)}
              />
            ))}
          </ul>

          <div className="mt-auto px-3 pt-5 text-xs leading-5 text-[var(--text-muted)]">
            Settings apply immediately and stay scoped to this desktop workspace.
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-12 py-12">
          <header className="mb-10">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
              {activeMeta.label}
            </div>
            <h1 className="mt-3 text-[40px] font-semibold tracking-[-0.04em] text-[var(--text-primary)]">
              {activeMeta.title}
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-[var(--text-secondary)]">
              {activeMeta.description}
            </p>
          </header>

          {activeSettingsTab === 'general' && (
            <GeneralSettingsContent theme={theme} setTheme={setTheme} />
          )}
          {activeSettingsTab === 'mcp' && <McpSettingsContent />}
          {activeSettingsTab === 'skills' && <SkillsSettingsContent />}
          {activeSettingsTab === 'usage' && <ClaudeUsageSettingsContent />}
        </div>
      </main>
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
        className={`group flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm transition-colors ${
          active
            ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/80 hover:text-[var(--text-primary)]'
        }`}
      >
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-[var(--text-muted)] group-hover:text-[var(--text-primary)]">
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
}: {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}) {
  return (
    <div className="space-y-10 pb-16">
      <SettingsSection title="Appearance">
        <SettingsRow
          label="Theme"
          description="Use light, dark, or follow the current operating system appearance."
        >
          <div className="flex flex-wrap items-center gap-2">
            <ThemeOption
              label="Light"
              value="light"
              current={theme}
              onClick={() => setTheme('light')}
              icon={<Sun className="w-4 h-4" />}
            />
            <ThemeOption
              label="Dark"
              value="dark"
              current={theme}
              onClick={() => setTheme('dark')}
              icon={<Moon className="w-4 h-4" />}
            />
            <ThemeOption
              label="System"
              value="system"
              current={theme}
              onClick={() => setTheme('system')}
              icon={<Monitor className="w-4 h-4" />}
            />
          </div>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}

function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-4 text-[28px] font-semibold tracking-[-0.03em] text-[var(--text-primary)]">
        {title}
      </h2>
      <div className="overflow-hidden rounded-[24px] border border-[var(--border)] bg-[var(--bg-secondary)]">
        {children}
      </div>
    </section>
  );
}

function SettingsRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_320px] items-start gap-6 border-b border-[var(--border)] px-5 py-5 last:border-b-0">
      <div className="space-y-1">
        <div className="text-base font-medium text-[var(--text-primary)]">{label}</div>
        <div className="text-sm leading-6 text-[var(--text-secondary)]">{description}</div>
      </div>
      <div className="flex justify-end">{children}</div>
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
      className={`inline-flex items-center gap-2 rounded-xl border px-4 py-3 text-sm transition-colors ${
        isActive
          ? 'border-[var(--accent)] bg-[var(--accent-light)] text-[var(--text-primary)]'
          : 'border-[var(--border)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:border-[var(--text-muted)] hover:text-[var(--text-primary)]'
      }`}
    >
      {icon}
      <span className="font-medium">{label}</span>
    </button>
  );
}

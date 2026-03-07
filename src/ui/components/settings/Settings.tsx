import { X, Server, Settings as SettingsIcon, Sun, Moon, Monitor, BookOpen } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
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
    <div className="fixed inset-0 z-50 bg-black/20 backdrop-blur-[2px]">
      <div className="flex h-full items-center justify-center p-5">
        <div className="flex h-[min(780px,calc(100vh-40px))] w-full max-w-6xl overflow-hidden rounded-[32px] border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_24px_80px_rgba(0,0,0,0.18)]">
          <aside className="w-[252px] flex-shrink-0 p-5">
            <div className="flex h-full flex-col rounded-[28px] bg-[var(--bg-secondary)]/88 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.6)]">
              <div className="px-3 pb-4 pt-2">
                <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
                  Settings
                </div>
                <div className="mt-2 text-sm text-[var(--text-secondary)]">
                  Keep your workspace calm, consistent, and project-aware.
                </div>
              </div>

              <ul className="space-y-1.5">
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

              <div className="mt-auto px-3 pt-4 text-xs text-[var(--text-muted)]">
                Changes apply immediately. The panel keeps a fixed workspace size across tabs.
              </div>
            </div>
          </aside>

          <div className="min-w-0 flex-1 p-5 pl-0">
            <div className="flex h-full min-w-0 flex-col rounded-[28px] bg-[var(--bg-secondary)]/82 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
              <header className="flex items-start justify-between gap-6 px-8 pb-4 pt-7">
                <div className="min-w-0 space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
                    {activeMeta.label}
                  </div>
                  <div className="text-[28px] font-semibold tracking-[-0.03em] text-[var(--text-primary)]">
                    {activeMeta.title}
                  </div>
                  <p className="max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">
                    {activeMeta.description}
                  </p>
                </div>

                <button
                  onClick={() => setShowSettings(false)}
                  className="flex h-10 w-10 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                >
                  <X className="w-4.5 h-4.5" />
                </button>
              </header>

              <div className="mx-8 h-px bg-[var(--border)]/55" />

              <div className="min-h-0 flex-1 overflow-y-auto">
                {activeSettingsTab === 'general' && (
                  <GeneralSettingsContent theme={theme} setTheme={setTheme} />
                )}
                {activeSettingsTab === 'mcp' && <McpSettingsContent />}
                {activeSettingsTab === 'skills' && <SkillsSettingsContent />}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// 导航项组件
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
        className={`group flex w-full items-center gap-3 rounded-2xl px-3.5 py-3 text-left text-sm transition-all ${
          active
            ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-primary)]/70 hover:text-[var(--text-primary)]'
        }`}
      >
        <span
          className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border transition-colors ${
            active
              ? 'border-[var(--accent)]/25 bg-[var(--accent-light)] text-[var(--accent)]'
              : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-muted)] group-hover:text-[var(--text-primary)]'
          }`}
        >
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
    <div className="p-8 pt-6">
      <SettingsCard
        eyebrow="Appearance"
        title="Theme"
        description="Choose how the workspace should feel throughout the day."
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <ThemeButton
            label="Light"
            description="A calm, paper-like surface for daytime work."
            value="light"
            current={theme}
            onClick={() => setTheme('light')}
            icon={<Sun className="w-4 h-4" />}
          />
          <ThemeButton
            label="Dark"
            description="A lower-glare workspace for focus in dim environments."
            value="dark"
            current={theme}
            onClick={() => setTheme('dark')}
            icon={<Moon className="w-4 h-4" />}
          />
          <ThemeButton
            label="System"
            description="Follow the current operating system appearance automatically."
            value="system"
            current={theme}
            onClick={() => setTheme('system')}
            icon={<Monitor className="w-4 h-4" />}
          />
        </div>
      </SettingsCard>
    </div>
  );
}

function SettingsCard({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[24px] border border-[var(--border)] bg-[var(--bg-primary)]/82 p-6 shadow-[0_10px_30px_rgba(0,0,0,0.04)]">
      <div className="mb-5 space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
          {eyebrow}
        </div>
        <div className="text-lg font-semibold text-[var(--text-primary)]">{title}</div>
        <p className="max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">{description}</p>
      </div>

      {children}
    </section>
  );
}

// Theme Button
function ThemeButton({
  label,
  description,
  value,
  current,
  onClick,
  icon,
}: {
  label: string;
  description: string;
  value: Theme;
  current: Theme;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  const isActive = current === value;
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-start gap-3 rounded-2xl border px-4 py-4 text-left transition-colors ${
        isActive
          ? 'border-[var(--accent)] bg-[var(--accent-light)] text-[var(--text-primary)]'
          : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:border-[var(--text-muted)] hover:text-[var(--text-primary)]'
      }`}
    >
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-sm font-medium">{label}</span>
      </div>
      <p className="text-sm leading-6 text-inherit/80">{description}</p>
    </button>
  );
}

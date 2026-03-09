import { useState } from 'react';
import { ArrowLeft, Server, Settings as SettingsIcon, Sun, Moon, Monitor, BookOpen, ChartColumn, PlugZap, Palette, Eraser, ChevronDown, Check } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { ClaudeUsageSettingsContent } from './ClaudeUsageSettings';
import { CompatibleProviderSettingsContent } from './CompatibleProviderSettings';
import { McpSettingsContent } from './McpSettings';
import { SkillsSettingsContent } from './SkillsSettings';
import type { ColorThemeId, Theme } from '../../types';
import { COLOR_THEME_FAMILIES, getThemePreviewPalette, resolveThemeMode } from '../../theme/themes';

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
  providers: {
    label: 'Providers',
    title: 'Providers',
    description: 'Configure Anthropic-compatible providers and route Claude sessions through them.',
    icon: <PlugZap className="w-4 h-4" />,
  },
  skills: {
    label: 'Claude Skills',
    title: 'Claude Skills',
    description: 'Review the user and workspace skills the Claude runner can discover.',
    icon: <BookOpen className="w-4 h-4" />,
  },
  usage: {
    label: 'Usage',
    title: 'Usage',
    description: 'Review token, cost, session, and cache usage across models over time.',
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
    colorThemeId,
    setColorThemeId,
    customThemeCss,
    setCustomThemeCss,
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
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
              {activeMeta.label}
            </div>
            <h1 className="mt-3 text-[36px] font-semibold tracking-[-0.04em] text-[var(--text-primary)]">
              {activeMeta.title}
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-[var(--text-secondary)]">
              {activeMeta.description}
            </p>
          </header>

          {activeSettingsTab === 'general' && (
            <GeneralSettingsContent
              theme={theme}
              setTheme={setTheme}
              colorThemeId={colorThemeId}
              setColorThemeId={setColorThemeId}
              customThemeCss={customThemeCss}
              setCustomThemeCss={setCustomThemeCss}
            />
          )}
          {activeSettingsTab === 'mcp' && <McpSettingsContent />}
          {activeSettingsTab === 'providers' && <CompatibleProviderSettingsContent />}
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
  colorThemeId,
  setColorThemeId,
  customThemeCss,
  setCustomThemeCss,
}: {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  colorThemeId: ColorThemeId;
  setColorThemeId: (colorThemeId: ColorThemeId) => void;
  customThemeCss: string;
  setCustomThemeCss: (customThemeCss: string) => void;
}) {
  const resolvedMode = resolveThemeMode(theme);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [customCssOpen, setCustomCssOpen] = useState(false);
  const activeTheme = COLOR_THEME_FAMILIES.find((family) => family.id === colorThemeId) || COLOR_THEME_FAMILIES[0];
  const customCssSummary = customThemeCss.trim()
    ? `${customThemeCss.trim().split(/\n+/).length} line${customThemeCss.trim().split(/\n+/).length > 1 ? 's' : ''} of overrides`
    : 'No custom overrides';

  return (
    <div className="space-y-10 pb-16">
      <SettingsSection title="Appearance">
        <SettingsRow
          label="Appearance Mode"
          description="Choose light, dark, or follow the current operating system appearance."
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
        <SettingsRow
          label="Color Theme"
          description={`Pick a theme family. The current appearance resolves to ${resolvedMode}.`}
        >
          <div className="w-full max-w-[320px]">
            <button
              type="button"
              onClick={() => setThemePickerOpen((current) => !current)}
              className="flex w-full items-center gap-3 rounded-[18px] border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-3 text-left text-sm transition-colors hover:border-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]/55"
            >
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                <Palette className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold text-[var(--text-primary)]">{activeTheme.label}</div>
                <div className="mt-1 flex items-center gap-1.5">
                  {getThemePreviewPalette(colorThemeId, theme).map((color, index) => (
                    <span
                      key={`${activeTheme.id}-${index}`}
                      className="h-3.5 flex-1 rounded-full border border-black/5"
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </div>
              <ChevronDown className={`h-4 w-4 flex-shrink-0 text-[var(--text-muted)] transition-transform ${themePickerOpen ? 'rotate-180' : ''}`} />
            </button>

            {themePickerOpen && (
              <div className="mt-2 rounded-[18px] border border-[var(--border)] bg-[var(--bg-primary)] p-2 shadow-sm">
                <div className="space-y-1">
                  {COLOR_THEME_FAMILIES.map((family) => {
                    const selected = family.id === colorThemeId;
                    return (
                      <button
                        key={family.id}
                        type="button"
                        onClick={() => {
                          setColorThemeId(family.id);
                          setThemePickerOpen(false);
                        }}
                        className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
                          selected
                            ? 'bg-[var(--accent-light)] text-[var(--text-primary)]'
                            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/70 hover:text-[var(--text-primary)]'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{family.label}</div>
                        </div>
                        <div className="flex w-[96px] items-center gap-1.5">
                          {getThemePreviewPalette(family.id, theme).map((color, index) => (
                            <span
                              key={`${family.id}-${index}`}
                              className="h-3.5 flex-1 rounded-full border border-black/5"
                              style={{ backgroundColor: color }}
                            />
                          ))}
                        </div>
                        <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-[var(--text-muted)]">
                          {selected ? <Check className="h-4 w-4" /> : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </SettingsRow>

        <SettingsRow
          label="Custom CSS"
          description="Override any theme token with CSS. Keep this for advanced theming only."
        >
          <div className="w-full max-w-[320px]">
            <button
              type="button"
              onClick={() => setCustomCssOpen((current) => !current)}
              className="flex w-full items-center gap-3 rounded-[18px] border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-3 text-left text-sm transition-colors hover:border-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]/55"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold text-[var(--text-primary)]">
                  {customThemeCss.trim() ? 'Theme overrides enabled' : 'No custom CSS'}
                </div>
                <div className="truncate text-[var(--text-secondary)]">{customCssSummary}</div>
              </div>
              <ChevronDown className={`h-4 w-4 flex-shrink-0 text-[var(--text-muted)] transition-transform ${customCssOpen ? 'rotate-180' : ''}`} />
            </button>

            {customCssOpen && (
              <div className="mt-2 rounded-[18px] border border-[var(--border)] bg-[var(--bg-primary)] p-3 shadow-sm">
                <div className="mb-3 flex items-center justify-end">
                  <button
                    type="button"
                    onClick={() => setCustomThemeCss('')}
                    className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-secondary)] transition-colors hover:border-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  >
                    <Eraser className="w-4 h-4" />
                    <span>Clear</span>
                  </button>
                </div>
                <textarea
                  value={customThemeCss}
                  onChange={(event) => setCustomThemeCss(event.target.value)}
                  placeholder={`:root {\n  --bg-primary: #0f1117;\n  --accent: #7aa2f7;\n}\n\n[data-color-theme="rose"] {\n  --accent: #f472b6;\n}`}
                  className="min-h-[180px] w-full rounded-[16px] border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3 font-mono text-sm leading-6 text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--text-muted)]"
                  spellCheck={false}
                />
              </div>
            )}
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
      <h2 className="mb-4 text-[24px] font-semibold tracking-[-0.03em] text-[var(--text-primary)]">
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

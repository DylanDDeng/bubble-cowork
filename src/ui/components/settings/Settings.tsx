import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Server, Settings as SettingsIcon, Sun, Moon, Monitor, BookOpen, ChartColumn, PlugZap, Eraser, ChevronDown, Check, Bot } from 'lucide-react';
import { toast } from 'sonner';
import { useAppStore } from '../../store/useAppStore';
import { ClaudeUsageSettingsContent } from './ClaudeUsageSettings';
import { CompatibleProviderSettingsContent } from './CompatibleProviderSettings';
import { McpSettingsContent } from './McpSettings';
import { ProviderPicker } from '../ProviderPicker';
import { SkillMarketSettingsContent } from './SkillMarketSettings';
import { BridgeSettingsContent } from './BridgeSettings';
import type { ColorThemeId, FontSelection, FontSettingsPayload, FontSlot, ImportedFontFace, SystemFontOption, Theme } from '../../types';
import { BUILTIN_FONT_OPTIONS, getDefaultFontSelections, getFontPreviewLabel } from '../../theme/fonts';
import { COLOR_THEME_FAMILIES, resolveThemeMode } from '../../theme/themes';
import { loadPreferredProvider, savePreferredProvider } from '../../utils/provider';

const SETTINGS_TABS = {
  general: {
    label: 'General',
    title: 'Workspace Preferences',
    description: 'Adjust appearance and core workspace behavior.',
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
    label: 'Skills',
    title: 'Skills',
    description: 'Review installed skills and browse new ones from skills.sh.',
    icon: <BookOpen className="w-4 h-4" />,
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
    colorThemeId,
    setColorThemeId,
    customThemeCss,
    setCustomThemeCss,
    fontSelections,
    importedFonts,
    systemFonts,
    systemFontsLoaded,
    setFontSettings,
  } = useAppStore();

  if (!showSettings) return null;

  const activeMeta = SETTINGS_TABS[activeSettingsTab];
  const isSkillsTab = activeSettingsTab === 'skills';

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--bg-primary)]">
      <div className="flex h-8 flex-shrink-0">
        <div className="drag-region w-[280px] flex-shrink-0 border-r border-[var(--border)] bg-[var(--bg-tertiary)]" />
        <div className="drag-region flex-1 bg-[var(--bg-primary)]" />
      </div>

      <div className="flex min-h-0 flex-1 bg-[var(--bg-primary)]">
      <aside className="w-[280px] flex-shrink-0 border-r border-[var(--border)] bg-[var(--bg-tertiary)]">
        <div className="flex h-full flex-col px-3 pb-6 pt-4">
          <button
            onClick={() => setShowSettings(false)}
            className="mb-5 flex items-center gap-2 rounded-xl px-3 py-2 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
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

        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className={`mx-auto ${isSkillsTab ? 'max-w-[1360px] px-8 py-8' : 'max-w-5xl px-12 py-12'}`}>
          {!isSkillsTab && (
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
          )}

          {activeSettingsTab === 'general' && (
            <GeneralSettingsContent
              theme={theme}
              setTheme={setTheme}
              colorThemeId={colorThemeId}
              setColorThemeId={setColorThemeId}
              customThemeCss={customThemeCss}
              setCustomThemeCss={setCustomThemeCss}
              fontSelections={fontSelections}
              importedFonts={importedFonts}
              systemFonts={systemFonts}
              systemFontsLoaded={systemFontsLoaded}
              setFontSettings={setFontSettings}
            />
          )}
          {activeSettingsTab === 'mcp' && <McpSettingsContent />}
          {activeSettingsTab === 'providers' && <CompatibleProviderSettingsContent />}
          {activeSettingsTab === 'skills' && <SkillMarketSettingsContent />}
          {activeSettingsTab === 'usage' && <ClaudeUsageSettingsContent />}
          {activeSettingsTab === 'bridge' && <BridgeSettingsContent />}
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
        className={`group flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm transition-colors ${
          active
            ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
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
  fontSelections,
  importedFonts,
  systemFonts,
  systemFontsLoaded,
  setFontSettings,
}: {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  colorThemeId: ColorThemeId;
  setColorThemeId: (colorThemeId: ColorThemeId) => void;
  customThemeCss: string;
  setCustomThemeCss: (customThemeCss: string) => void;
  fontSelections: FontSettingsPayload['selections'];
  importedFonts: ImportedFontFace[];
  systemFonts: SystemFontOption[];
  systemFontsLoaded: boolean;
  setFontSettings: (settings: FontSettingsPayload) => void;
}) {
  const resolvedMode = resolveThemeMode(theme);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [customCssOpen, setCustomCssOpen] = useState(false);
  const [appVersion, setAppVersion] = useState('...');
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [defaultProvider, setDefaultProvider] = useState(loadPreferredProvider());
  const activeTheme = COLOR_THEME_FAMILIES.find((family) => family.id === colorThemeId) || COLOR_THEME_FAMILIES[0];
  const customCssSummary = customThemeCss.trim()
    ? `${customThemeCss.trim().split(/\n+/).length} line${customThemeCss.trim().split(/\n+/).length > 1 ? 's' : ''} of overrides`
    : 'No custom overrides';
  const hasColorThemeOverrides = /--(?:bg-primary|bg-secondary|bg-tertiary|text-primary|text-secondary|text-muted|accent|accent-hover|accent-light|accent-foreground|border|sidebar-item-hover|sidebar-item-active|sidebar-item-border)\s*:/.test(
    customThemeCss
  );

  const updateFontSelection = async (slot: FontSlot, nextSelection: FontSelection) => {
    try {
      const saved = await window.electron.saveFontSelections({
        ...fontSelections,
        [slot]: nextSelection,
      });
      setFontSettings(saved);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update font.');
    }
  };

  useEffect(() => {
    let cancelled = false;

    window.electron
      .getAppVersion()
      .then((version) => {
        if (!cancelled) {
          setAppVersion(version);
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
    <div className="space-y-8 pb-12">
      <SettingsSection title="Appearance">
        <SettingsRow
          label="Default Agent"
          description="Used for new sessions by default."
        >
          <ProviderPicker
            value={defaultProvider}
            onChange={(provider) => {
              setDefaultProvider(provider);
              savePreferredProvider(provider);
            }}
            embedded
          />
        </SettingsRow>

        <SettingsRow
          label="Updates"
          description="Check for a new release and view the current version."
        >
          <div className="flex items-center gap-2">
            <div className="rounded-[16px] border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-2 text-sm text-[var(--text-secondary)]">
              Version {appVersion}
            </div>
            <button
              type="button"
              onClick={() => void handleCheckForUpdates()}
              disabled={checkingUpdates}
              className="h-10 rounded-full border border-[var(--sidebar-item-border)] bg-[var(--accent)] px-4 text-sm font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
            >
              {checkingUpdates ? 'Checking...' : 'Check for Updates'}
            </button>
          </div>
        </SettingsRow>

        <SettingsRow
          label="Appearance Mode"
          description="Choose light, dark, or system."
        >
          <div className="inline-flex flex-wrap items-center gap-1 rounded-[18px] bg-[var(--bg-tertiary)] p-1">
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
          description={`Choose a color palette. Current mode: ${resolvedMode}.`}
        >
          <div className="w-full max-w-[260px]">
            <button
              type="button"
              onClick={() => setThemePickerOpen((current) => !current)}
              className="flex w-full items-center rounded-[18px] border border-[var(--sidebar-item-border)] bg-[var(--accent-light)] px-4 py-2.5 text-left text-sm transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-light)]"
            >
              <div className="min-w-0 flex-1 truncate font-semibold text-[var(--text-primary)]">
                {activeTheme.label}
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
                        className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors ${
                          selected
                            ? 'bg-[var(--accent-light)] text-[var(--text-primary)]'
                            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/70 hover:text-[var(--text-primary)]'
                        }`}
                      >
                        <div className="min-w-0 flex-1 truncate text-sm font-medium">{family.label}</div>
                        <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-[var(--text-muted)]">
                          {selected ? <Check className="h-4 w-4" /> : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {hasColorThemeOverrides && (
              <div className="mt-2 rounded-[16px] border border-[var(--border)] bg-[var(--bg-tertiary)]/70 px-3 py-3 text-sm">
                <div className="font-medium text-[var(--text-primary)]">Custom CSS is overriding theme colors</div>
                <div className="mt-1 text-[var(--text-secondary)]">
                  Clear the custom CSS overrides if you want preset color themes to take effect again.
                </div>
                <button
                  type="button"
                  onClick={() => setCustomThemeCss('')}
                  className="mt-3 inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-secondary)] transition-colors hover:border-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  <Eraser className="w-4 h-4" />
                  <span>Clear overrides</span>
                </button>
              </div>
            )}
          </div>
        </SettingsRow>

        <SettingsRow
          label="Custom CSS"
          description="Optional CSS overrides for theme tokens."
        >
          <div className="w-full max-w-[400px]">
            <button
              type="button"
              onClick={() => setCustomCssOpen((current) => !current)}
              className="flex w-full items-center gap-3 rounded-[18px] border border-[var(--sidebar-item-border)] bg-[var(--accent-light)] px-3 py-2.5 text-left text-sm transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-light)]"
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
        <SettingsRow
          label="UI Font"
          description="Used for the sidebar, settings, lists, and UI text."
        >
          <FontSlotControl
            slot="ui"
            selection={fontSelections.ui}
            importedFonts={importedFonts}
            systemFonts={systemFonts}
            systemFontsLoaded={systemFontsLoaded}
            onChange={(selection) => void updateFontSelection('ui', selection)}
          />
        </SettingsRow>

        <SettingsRow
          label="Code Font"
          description="Used for code blocks, logs, paths, and monospace UI."
        >
          <FontSlotControl
            slot="mono"
            selection={fontSelections.mono}
            importedFonts={importedFonts}
            systemFonts={systemFonts}
            systemFontsLoaded={systemFontsLoaded}
            onChange={(selection) => void updateFontSelection('mono', selection)}
          />
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
      <h2 className="mb-3 text-[22px] font-semibold tracking-[-0.03em] text-[var(--text-primary)]">
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
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(340px,440px)] items-start gap-5 border-b border-[var(--border)] px-6 py-3.5 last:border-b-0">
      <div className="space-y-1">
        <div className="text-[15px] font-semibold text-[var(--text-primary)]">{label}</div>
        {description ? (
          <div className="text-[14px] leading-5 text-[var(--text-secondary)]">{description}</div>
        ) : null}
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
      className={`inline-flex items-center gap-2 rounded-[14px] px-4 py-2.5 text-[14px] transition-colors ${
        isActive
          ? 'border border-[var(--sidebar-item-border)] bg-[var(--accent-light)] text-[var(--accent)] shadow-[0_1px_2px_rgba(15,23,42,0.04)]'
          : 'bg-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
      }`}
    >
      {icon}
      <span className="font-medium">{label}</span>
    </button>
  );
}

function FontSlotControl({
  slot,
  selection,
  importedFonts,
  systemFonts,
  systemFontsLoaded,
  onChange,
}: {
  slot: FontSlot;
  selection: FontSelection;
  importedFonts: ImportedFontFace[];
  systemFonts: SystemFontOption[];
  systemFontsLoaded: boolean;
  onChange: (selection: FontSelection) => void;
}) {
  const currentLabel = getFontPreviewLabel(slot, selection, importedFonts);
  const [fontInput, setFontInput] = useState(currentLabel);
  const normalizedInput = fontInput.trim().toLowerCase();
  const options = useMemo(
    () => [
      ...BUILTIN_FONT_OPTIONS[slot].map((option) => ({
        label: option.label,
        selection: { source: 'builtin', id: option.id } as FontSelection,
      })),
      ...systemFonts.map((font) => ({
        label: font.label,
        selection: { source: 'system', id: font.id } as FontSelection,
      })),
      ...importedFonts.map((font) => ({
        label: font.label,
        selection: { source: 'imported', id: font.id } as FontSelection,
      })),
    ],
    [importedFonts, slot, systemFonts]
  );
  const matchingOption = options.find((option) => option.label.toLowerCase() === normalizedInput) || null;
  const listId = `font-options-${slot}`;

  useEffect(() => {
    setFontInput(currentLabel);
  }, [currentLabel]);

  const applySelection = () => {
    const trimmed = fontInput.trim();
    if (!trimmed) {
      onChange(getDefaultFontSelections()[slot]);
      return;
    }

    if (matchingOption) {
      onChange(matchingOption.selection);
      return;
    }

    onChange({
      source: 'system',
      id: trimmed,
    });
  };

  return (
    <div className="w-full max-w-[520px] space-y-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <input
          list={listId}
          value={fontInput}
          onChange={(event) => setFontInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              applySelection();
            }
          }}
          placeholder="Type a font name..."
          className="h-10 w-full min-w-0 rounded-[16px] border border-[var(--border)] bg-[var(--bg-primary)] px-4 text-[14px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--text-muted)] sm:w-[230px]"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              const defaults = getDefaultFontSelections();
              setFontInput(getFontPreviewLabel(slot, defaults[slot], importedFonts));
              onChange(defaults[slot]);
            }}
            className="h-10 rounded-[16px] border border-[var(--border)] bg-[var(--bg-primary)] px-4 text-[14px] font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={applySelection}
            className="h-10 rounded-full border border-[var(--sidebar-item-border)] bg-[var(--accent)] px-4 text-sm font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)]"
          >
            Apply
          </button>
        </div>
      </div>
      <datalist id={listId}>
        {options.map((option) => (
          <option key={`${slot}-${option.selection.source}-${option.selection.id}`} value={option.label} />
        ))}
      </datalist>

      {!systemFontsLoaded && (
        <div className="text-sm text-[var(--text-muted)]">Loading system fonts...</div>
      )}
    </div>
  );
}

import { AppearanceControls } from './AppearanceControls';
import { findSettings, type SettingsSearchEntry } from './settings-search';
import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, Server, Settings as SettingsIcon, Sun, ChartColumn, PlugZap, Bot, Image, Trash2, Globe } from '../icons';
import { useAppStore } from '../../store/useAppStore';
import { ClaudeUsageSettingsContent } from './ClaudeUsageSettings';
import { CompatibleProviderSettingsContent } from './CompatibleProviderSettings';
import { BubbleProviderSettings } from './BubbleProviderSettings';
import { DeepseekProviderSettings } from './DeepseekProviderSettings';
import { BrowserUseSettings } from './BrowserUseSettings';
import { MCP_RUNTIMES, McpSettingsContent } from './McpSettings';
import { ProviderIcon } from '../AgentModelPicker';
import { BridgeSettingsContent } from './BridgeSettings';
import { ThemePackEditor } from './ThemePackEditor';
import { SettingsGroup, SettingsRow } from './SettingsPrimitives';
import { GeneralSettingsContent, PreferenceSelect } from './GeneralSettingsContent';
import { ProfileSettingsGroup } from './ProfileSettingsGroup';
import { Search } from '../icons';
import { toast } from 'sonner';
import type { ChromeTheme, Theme, ThemeFonts, ThemeState, ThemeVariant } from '../../types';
import { consolidateThemeFonts, resolveThemeMode, resolveThemePack } from '../../theme/themes';

const SETTINGS_TABS = {
  general: {
    label: 'General',
    title: 'General',
    description: '',
    icon: <SettingsIcon className="w-4 h-4" />,
  },
  appearance: { label: 'Appearance', title: 'Appearance', description: '', icon: <Sun className="w-4 h-4" /> },
  browser: {
    label: 'Browser',
    title: 'Browser',
    description: 'Manage the built-in browser. Import Chrome login cookies and turn agent browsing on or off.',
    icon: <Globe className="w-4 h-4" />,
  },
  mcp: {
    label: 'MCP Servers',
    title: 'MCP Servers',
    description: 'Manage MCP tool backends for Claude Code, Codex, OpenCode, and Kimi.',
    icon: <Server className="w-4 h-4" />,
  },
  providers: {
    label: 'Providers',
    title: 'Providers',
    description: 'Configure Anthropic-compatible providers for Claude sessions and API keys for the bundled Bubble agent.',
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

type SettingsTabKey = keyof typeof SETTINGS_TABS;

const SETTINGS_NAV_GROUPS: { label: string; tabs: SettingsTabKey[] }[] = [
  { label: 'Personal', tabs: ['general', 'appearance', 'usage'] },
  { label: 'Integrations', tabs: ['browser', 'mcp', 'providers', 'bridge'] },
];

function isSettingsTabKey(value: string): value is SettingsTabKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS_TABS, value);
}

// Settings 面板
export function Settings() {
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState<SettingsSearchEntry | null>(null);

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
    mcpSettingsRuntime,
    setMcpSettingsRuntime,
  } = useAppStore();

  useEffect(() => {
    if (!uiFontFamily && !chatCodeFontFamily) return;
    setThemeState(consolidateThemeFonts(themeState, uiFontFamily, chatCodeFontFamily));
    setUiFontFamily('');
    setChatCodeFontFamily('');
  }, [uiFontFamily, chatCodeFontFamily, themeState, setThemeState, setUiFontFamily, setChatCodeFontFamily]);

  useLayoutEffect(() => {
    if (!showSettings || !target || activeSettingsTab !== target.tab) return;
    const row = Array.from(document.querySelectorAll<HTMLElement>('[data-settings-label]')).find(row => row.dataset.settingsLabel === target.label)
      ?? document.querySelector<HTMLElement>('.aegis-settings-content');
    if (!row) return;
    row.scrollIntoView({ block: 'center' });
    row.setAttribute('tabindex', '-1');
    row.focus({ preventScroll: true });
    row.dataset.searchMatch = 'true';
    const timer = setTimeout(() => { delete row.dataset.searchMatch; }, 1800);
    return () => { clearTimeout(timer); delete row.dataset.searchMatch; row.removeAttribute('tabindex'); };
  }, [showSettings, target, activeSettingsTab]);

  if (!showSettings) return null;

  const resolvedActiveSettingsTab: SettingsTabKey = isSettingsTabKey(activeSettingsTab)
    ? activeSettingsTab
    : 'general';
  const activeMeta = SETTINGS_TABS[resolvedActiveSettingsTab];
  return (
    <div className="aegis-settings flex h-full min-h-0 min-w-0 flex-col bg-[var(--bg-primary)]">
      <div className="flex h-8 flex-shrink-0">
        <div className="aegis-window-left-surface drag-region w-[280px] flex-shrink-0 border-r border-[var(--border)] bg-[var(--bg-primary)]" />
        <div className="drag-region flex-1 bg-[var(--bg-primary)]" />
      </div>

      <div className="flex min-h-0 flex-1 bg-[var(--bg-primary)]">
      <aside className="aegis-window-left-surface w-[280px] flex-shrink-0 select-none border-r border-[var(--border)] bg-[var(--bg-primary)]">
        <div className="flex h-full min-h-0 flex-col px-1.5 pb-4 pt-2">
          <button
            onClick={() => setShowSettings(false)}
            className="mb-2 flex h-[30px] shrink-0 items-center gap-2 rounded-lg px-2 text-[13px] font-normal leading-[18px] text-[var(--text-primary)] transition-colors hover:bg-[var(--sidebar-item-hover)]"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back to app</span>
          </button>

          <div className="mb-4 flex h-[30px] shrink-0 items-center gap-2 rounded-lg bg-[var(--sidebar-item-hover)] px-2 focus-within:ring-1 focus-within:ring-[var(--border-focus)]">
            <Search className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
            <input aria-label="Search settings" role="searchbox" placeholder="Search settings…" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => {
              if (e.key === 'Escape') setSearch('');
              if (e.key === 'Enter') {
                const first = findSettings(search)[0];
                if (first) { setActiveSettingsTab(first.tab); setTarget({ ...first }); setSearch(''); }
              }
            }} className="w-full min-w-0 bg-transparent text-[13px] font-normal leading-[18px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]" />
            {search && <button aria-label="Clear settings search" onClick={() => setSearch('')} className="text-[var(--text-muted)]">×</button>}
          </div>
          {search.trim() ? <div role="region" aria-label="Settings search results" className="min-h-0 overflow-y-auto">
            {findSettings(search).map(entry => <button key={`${entry.tab}:${entry.label}`} onClick={() => { setActiveSettingsTab(entry.tab); setTarget({ ...entry }); setSearch(''); }} className="mb-1 flex w-full flex-col rounded-lg px-3 py-2 text-left text-[13px] text-[var(--text-primary)] hover:bg-[var(--sidebar-item-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
              <span>{entry.label}</span><span className="text-[12px] text-[var(--text-muted)]">{SETTINGS_TABS[entry.tab].label}</span>
            </button>)}
            {findSettings(search).length === 0 && <p className="px-3 text-[13px] text-[var(--text-muted)]">No settings found</p>}
          </div> : <nav aria-label="Settings" className="min-h-0 flex-1 space-y-6 overflow-y-auto">
            {SETTINGS_NAV_GROUPS.map(group => <section key={group.label} aria-label={group.label}>
              <h2 className="mb-1 px-2 text-[13px] font-normal leading-[18px] text-[var(--text-muted)]">{group.label}</h2>
              <ul className="space-y-px">
                {group.tabs.map(key => { const tab = SETTINGS_TABS[key]; return (
                  <SettingsNavItem
                    key={key}
                    label={tab.label}
                    icon={tab.icon}
                    active={resolvedActiveSettingsTab === key}
                    // With runtime sub-items showing, the child carries the highlight.
                    expanded={key === 'mcp' && resolvedActiveSettingsTab === 'mcp'}
                    onClick={() => { setTarget(null); setActiveSettingsTab(key); }}
                  >
                    {/* Runtimes are sub-pages of MCP Servers rather than tabs inside
                        the page: the list scales to any number of runtimes without
                        a horizontal strip that wraps in narrow panes. */}
                    {key === 'mcp' && resolvedActiveSettingsTab === 'mcp' ? (
                      <ul className="relative mb-1 mt-0.5 ml-[19px] space-y-px border-l border-[var(--border-focus)]/60 pl-2">
                        {MCP_RUNTIMES.map((runtime) => {
                          const active = mcpSettingsRuntime === runtime.id;
                          return (
                            <li key={runtime.id}>
                              <button
                                onClick={() => setMcpSettingsRuntime(runtime.id)}
                                className={`flex w-full items-center gap-2 rounded-[6px] py-1.5 pl-2 pr-3 text-left text-[12.5px] transition-colors ${
                                  active
                                    ? 'bg-[var(--sidebar-item-hover)] font-normal text-[var(--text-primary)]'
                                    : 'text-[var(--text-primary)] hover:bg-[var(--sidebar-item-hover)]'
                                }`}
                              >
                                <span
                                  className={`flex h-4 w-4 flex-shrink-0 items-center justify-center transition-opacity ${active ? '' : 'opacity-80 group-hover:opacity-100'}`}
                                >
                                  <ProviderIcon provider={runtime.id} />
                                </span>
                                <span className="truncate">{runtime.label}</span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </SettingsNavItem>
                ); })}
              </ul>
            </section>)}
          </nav>}

        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto bg-[var(--bg-primary)] select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text">
        {/* The usage tab is a centered profile page; pin its title to the
            top-left of the pane so it doesn't crowd the avatar header. */}
        {resolvedActiveSettingsTab === 'usage' ? (
          <div className="px-6 pt-5">
            <h1 data-settings-label={activeMeta.title} className="text-[15px] font-semibold tracking-normal text-[var(--text-primary)]">
              {activeMeta.title}
            </h1>
          </div>
        ) : null}
        <div
          className={`aegis-settings-content mx-auto w-full px-8 py-8 ${resolvedActiveSettingsTab === 'appearance' ? 'max-w-[832px]' : 'max-w-3xl'}`}
        >
          {/* The MCP page renders its own header (runtime name + last-checked). */}
          {resolvedActiveSettingsTab !== 'usage' && resolvedActiveSettingsTab !== 'mcp' ? (
            <header className="mb-6">
              <h1 data-settings-label={activeMeta.title} className="text-[17px] font-semibold tracking-normal text-[var(--text-primary)]">
                {activeMeta.title}
              </h1>
              {activeMeta.description && <p className="mt-1 text-[12px] leading-5 text-[var(--text-muted)]">{activeMeta.description}</p>}
            </header>
          ) : null}

          {resolvedActiveSettingsTab === 'general' && <GeneralSettingsContent />}
          {resolvedActiveSettingsTab === 'appearance' && (
            <AppearanceSettingsContent
              theme={theme}
              setTheme={setTheme}
              themeState={themeState}
              setThemeState={setThemeState}
              updateThemeVariant={updateThemeVariant}
              setThemeVariantCodeThemeId={setThemeVariantCodeThemeId}
              setThemeVariantFonts={setThemeVariantFonts}
              resetThemeVariant={resetThemeVariant}
            />
          )}
          {resolvedActiveSettingsTab === 'browser' && (
            <div className="space-y-5">
              <BrowserUseSettings />
            </div>
          )}
          {resolvedActiveSettingsTab === 'mcp' && (
            <div className="space-y-5">
              <McpSettingsContent />
            </div>
          )}
          {resolvedActiveSettingsTab === 'providers' && (
            <div className="flex flex-col gap-6">
              <CompatibleProviderSettingsContent />
              <BubbleProviderSettings />
              <DeepseekProviderSettings />
            </div>
          )}
          {resolvedActiveSettingsTab === 'usage' && <div className="space-y-8"><ClaudeUsageSettingsContent /><ProfileSettingsGroup /></div>}
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
  expanded = false,
  onClick,
  children,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  expanded?: boolean;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <li>
      <button
        onClick={onClick}
        aria-current={active ? 'page' : undefined}
        className={`group flex h-[30px] w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] font-normal leading-[18px] transition-colors ${
          active && expanded
            ? 'text-[var(--text-primary)]'
            : active
              ? 'bg-[var(--sidebar-item-hover)] text-[var(--text-primary)]'
              : 'text-[var(--text-primary)] hover:bg-[var(--sidebar-item-hover)]'
        }`}
      >
        <span className={`flex h-4 w-4 flex-shrink-0 items-center justify-center [&_svg]:size-3.5 [&_svg]:stroke-[1.5] ${active ? 'text-[var(--text-primary)]' : 'text-[var(--text-primary)]'}`}>
          {icon}
        </span>
        <span>{label}</span>
      </button>
      {children}
    </li>
  );
}

function AppearanceSettingsContent({
  theme,
  setTheme,
  themeState,
  setThemeState,
  updateThemeVariant,
  setThemeVariantCodeThemeId,
  setThemeVariantFonts,
  resetThemeVariant,
}: {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  themeState: ThemeState;
  setThemeState: (themeState: ThemeState) => void;
  updateThemeVariant: (variant: ThemeVariant, patch: Partial<ChromeTheme>) => void;
  setThemeVariantCodeThemeId: (variant: ThemeVariant, codeThemeId: string) => void;
  setThemeVariantFonts: (variant: ThemeVariant, patch: Partial<ThemeFonts>) => void;
  resetThemeVariant: (variant: ThemeVariant) => void;
}) {
  const resolvedMode = resolveThemeMode(theme);
  const lightTheme = resolveThemePack(themeState, 'light');
  const darkTheme = resolveThemePack(themeState, 'dark');
  const skinImageData = useAppStore((s) => s.skinImageData);
  const skinOpacity = useAppStore((s) => s.skinOpacity);
  const setSkinImage = useAppStore((s) => s.setSkinImage);
  const setSkinOpacity = useAppStore((s) => s.setSkinOpacity);
  const clearSkin = useAppStore((s) => s.clearSkin);

  const handleChooseSkin = async () => {
    try {
      const result = await window.electron.selectSkinImage();
      if (!result) return;
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setSkinImage(result.fileName, result.dataUrl);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to set skin image.');
    }
  };

  const handleClearSkin = () => {
    clearSkin();
    window.electron.clearSkinImage().catch(() => {});
  };

  return (
    <div className="space-y-6 pb-8">
      <SettingsGroup title="Theme">
        <SettingsRow variant="card" label="Mode" description="Light, dark, or follow system.">
          <PreferenceSelect label="Theme" value={theme} onChange={value => setTheme(value as Theme)} options={[
            { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'System' },
          ]} />
        </SettingsRow>

        <SettingsRow
          variant="card"
          label="Skin"
          description="Layer a wallpaper image behind the chat area."
        >
          <div className="flex items-center gap-2">
            {skinImageData ? (
              <>
                <img
                  src={skinImageData}
                  alt="Current skin"
                  className="h-8 w-14 rounded-[var(--radius-lg)] border border-[var(--border)] object-cover"
                />
                <button
                  type="button"
                  onClick={() => void handleChooseSkin()}
                  className="inline-flex h-8 items-center rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
                >
                  Replace
                </button>
                <button
                  type="button"
                  onClick={handleClearSkin}
                  aria-label="Remove skin"
                  title="Remove skin"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => void handleChooseSkin()}
                className="inline-flex h-8 items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
              >
                <Image className="h-3.5 w-3.5" />
                Choose Image
              </button>
            )}
          </div>
        </SettingsRow>

        {skinImageData ? (
          <SettingsRow
            variant="card"
            label="Skin Opacity"
            description="How strongly the wallpaper shows through."
          >
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={5}
                max={80}
                step={1}
                value={Math.round(skinOpacity * 100)}
                onChange={(event) => setSkinOpacity(Number(event.target.value) / 100)}
                aria-label="Skin opacity"
                className="w-[180px] accent-[var(--accent)]"
              />
              <span className="w-9 text-right text-[12px] tabular-nums text-[var(--text-muted)]">
                {Math.round(skinOpacity * 100)}%
              </span>
            </div>
          </SettingsRow>
        ) : null}
      </SettingsGroup>

      <div className="space-y-5">
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

      <AppearanceControls />

    </div>
  );
}

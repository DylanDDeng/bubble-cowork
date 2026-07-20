import { useEffect, useMemo, useState, type ReactNode } from 'react';
import * as Dialog from '@/ui/components/ui/dialog';
import {
  BrandGithub,
  Check,
  ChevronRight,
  Globe,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  Search,
  SkillStack,
  X,
} from '../icons';
import { toast } from 'sonner';
import { MDContent } from '../../render/markdown';
import { useAppStore } from '../../store/useAppStore';
import type {
  ProviderListPluginsResult,
  ProviderListSkillsResult,
  ProviderPluginDescriptor,
  ProviderPluginDetail,
  ProviderSkillDescriptor,
} from '../../types';

type CodexTab = 'plugins' | 'skills';
type PluginScope = 'public' | 'personal';

export type PluginEntry = {
  marketplaceName: string;
  marketplacePath: string | null;
  plugin: ProviderPluginDescriptor;
};

const EMPTY_PLUGINS_RESULT: ProviderListPluginsResult = {
  marketplaces: [],
  marketplaceLoadErrors: [],
  remoteSyncError: null,
  featuredPluginIds: [],
  source: 'empty',
  cached: false,
};

const EMPTY_SKILLS_RESULT: ProviderListSkillsResult = {
  skills: [],
  source: 'empty',
  cached: false,
};

const COLLAPSED_SECTION_ROWS = 6;
const SEARCH_RESULT_LIMIT = 60;

function normalizeRemoteErrorMessage(error: unknown, fallback: string): string {
  const rawMessage = error instanceof Error ? error.message : fallback;
  return rawMessage.replace(/^Error invoking remote method '[^']+':\s*/, '').trim();
}

function normalizeSearchText(value: string | undefined): string {
  return (value || '')
    .toLowerCase()
    .replace(/[:/_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function pluginKey(entry: PluginEntry): string {
  return `${entry.marketplacePath || entry.marketplaceName}::${entry.plugin.name}`;
}

function pluginTitle(plugin: ProviderPluginDescriptor): string {
  return plugin.interface?.displayName || plugin.name;
}

// plugin/read and plugin/install resolve remote-marketplace plugins by their
// remote catalog id (`plugin_connector_…`), not by name — names 404 there.
// Local marketplaces resolve by name.
function pluginRequestName(entry: PluginEntry): string {
  if (entry.marketplacePath) return entry.plugin.name;
  return entry.plugin.remotePluginId || entry.plugin.name;
}

function pluginSearchBlob(entry: PluginEntry): string {
  const plugin = entry.plugin;
  return normalizeSearchText(
    [
      entry.marketplaceName,
      plugin.name,
      plugin.interface?.displayName,
      plugin.interface?.shortDescription,
      plugin.interface?.category,
      plugin.interface?.developerName,
    ]
      .filter(Boolean)
      .join('\n')
  );
}

function skillSearchBlob(skill: ProviderSkillDescriptor): string {
  return normalizeSearchText(
    [
      skill.name,
      skill.description,
      skill.interface?.displayName,
      skill.interface?.shortDescription,
      skill.scope,
    ]
      .filter(Boolean)
      .join('\n')
  );
}

function isInstalledPlugin(plugin: ProviderPluginDescriptor): boolean {
  return plugin.installed || plugin.enabled || plugin.installPolicy === 'INSTALLED_BY_DEFAULT';
}

function formatPluginSource(plugin: ProviderPluginDescriptor): string {
  if (plugin.source.type === 'local') return plugin.source.path;
  if (plugin.source.type === 'git') return plugin.source.url || plugin.source.path || 'Git source';
  return 'Remote catalog';
}

function entryScope(entry: PluginEntry): PluginScope {
  return entry.plugin.source.type === 'remote' ? 'public' : 'personal';
}

// Title-cased so 'productivity' / 'Productivity' collapse into one section.
function normalizeCategoryLabel(raw: string | undefined): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return 'Other';
  return trimmed
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function CodexPluginLibraryContent() {
  const { activeSessionId, sessions, projectCwd } = useAppStore();
  const [tab, setTab] = useState<CodexTab>('plugins');
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<PluginScope>('public');
  const [pluginsResult, setPluginsResult] = useState<ProviderListPluginsResult>(EMPTY_PLUGINS_RESULT);
  const [skillsResult, setSkillsResult] = useState<ProviderListSkillsResult>(EMPTY_SKILLS_RESULT);
  const [loadingPlugins, setLoadingPlugins] = useState(false);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [pluginsError, setPluginsError] = useState<string | null>(null);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [pluginDetailOpen, setPluginDetailOpen] = useState(false);
  const [selectedSkillPath, setSelectedSkillPath] = useState<string | null>(null);
  const [skillDetailOpen, setSkillDetailOpen] = useState(false);
  // Keyed by path; loaded BEFORE the dialog opens (see openSkillDetail).
  const [skillContent, setSkillContent] = useState<{
    path: string;
    content: string | null;
    error: string | null;
  } | null>(null);
  const [detail, setDetail] = useState<ProviderPluginDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busyPluginKeys, setBusyPluginKeys] = useState<ReadonlySet<string>>(new Set());

  const activeSession = activeSessionId ? sessions[activeSessionId] : null;
  const discoveryCwd = activeSession?.cwd || projectCwd || undefined;
  const normalizedQuery = normalizeSearchText(query);

  const pluginEntries = useMemo<PluginEntry[]>(() => {
    return pluginsResult.marketplaces.flatMap((marketplace) =>
      marketplace.plugins.map((plugin) => ({
        marketplaceName: marketplace.name,
        marketplacePath: marketplace.path,
        plugin,
      }))
    );
  }, [pluginsResult.marketplaces]);

  const filteredSkills = useMemo(() => {
    if (!normalizedQuery) return skillsResult.skills;
    return skillsResult.skills.filter((skill) => skillSearchBlob(skill).includes(normalizedQuery));
  }, [normalizedQuery, skillsResult.skills]);

  const selectedPlugin = useMemo(() => {
    if (!selectedKey) return null;
    return pluginEntries.find((entry) => pluginKey(entry) === selectedKey) || null;
  }, [pluginEntries, selectedKey]);
  const selectedSkill = useMemo(() => {
    if (!selectedSkillPath) return null;
    return filteredSkills.find((skill) => skill.path === selectedSkillPath) || null;
  }, [filteredSkills, selectedSkillPath]);

  const loadPlugins = async (forceReload = false) => {
    setLoadingPlugins(true);
    setPluginsError(null);
    try {
      const result = await window.electron.listCodexPlugins({
        cwd: discoveryCwd,
        forceReload,
      });
      setPluginsResult(result);
      setSelectedKey((current) => {
        const nextEntries = result.marketplaces.flatMap((marketplace) =>
          marketplace.plugins.map((plugin) => ({
            marketplaceName: marketplace.name,
            marketplacePath: marketplace.path,
            plugin,
          }))
        );
        if (current && nextEntries.some((entry) => pluginKey(entry) === current)) {
          return current;
        }
        return null;
      });
    } catch (error) {
      const message = normalizeRemoteErrorMessage(error, 'Failed to load Codex plugins.');
      setPluginsResult(EMPTY_PLUGINS_RESULT);
      setPluginsError(message);
    } finally {
      setLoadingPlugins(false);
    }
  };

  const loadSkills = async (forceReload = false) => {
    setLoadingSkills(true);
    setSkillsError(null);
    try {
      setSkillsResult(await window.electron.listCodexSkills({ cwd: discoveryCwd, forceReload }));
    } catch (error) {
      const message = normalizeRemoteErrorMessage(error, 'Failed to load Codex skills.');
      setSkillsResult(EMPTY_SKILLS_RESULT);
      setSkillsError(message);
    } finally {
      setLoadingSkills(false);
    }
  };

  useEffect(() => {
    void loadPlugins(false);
  }, [discoveryCwd]);

  useEffect(() => {
    if (tab === 'skills') {
      void loadSkills(false);
    }
  }, [discoveryCwd, tab]);

  useEffect(() => {
    if (!selectedPlugin || !pluginDetailOpen) {
      setDetail(null);
      return;
    }

    let cancelled = false;
    const loadDetail = async () => {
      setDetailLoading(true);
      try {
        const result = await window.electron.readCodexPlugin({
          marketplacePath: selectedPlugin.marketplacePath,
          remoteMarketplaceName: selectedPlugin.marketplacePath ? undefined : selectedPlugin.marketplaceName,
          pluginName: pluginRequestName(selectedPlugin),
        });
        if (!cancelled) {
          setDetail(result.plugin);
        }
      } catch (error) {
        if (!cancelled) {
          setDetail(null);
          toast.error(normalizeRemoteErrorMessage(error, 'Failed to load plugin detail.'));
        }
      } finally {
        if (!cancelled) {
          setDetailLoading(false);
        }
      }
    };

    void loadDetail();
    return () => {
      cancelled = true;
    };
  }, [pluginDetailOpen, selectedPlugin]);

  const refresh = () => {
    if (tab === 'plugins') void loadPlugins(true);
    else void loadSkills(true);
  };

  const openPluginDetail = (entry: PluginEntry) => {
    setSelectedKey(pluginKey(entry));
    setPluginDetailOpen(true);
  };

  // Preload the SKILL.md body before opening: local reads settle in a few ms,
  // so the dialog's first frame is already the full document — no
  // spinner-to-content swap, no dialog height jump. Slow reads (>300ms) open
  // with a spinner instead of blocking the click.
  const openSkillDetail = async (skill: ProviderSkillDescriptor) => {
    const path = skill.path;
    setSelectedSkillPath(path);
    const load = window.electron
      .readCodexSkillContent(path)
      .then((result) => {
        setSkillContent({
          path,
          content:
            result.ok && result.content ? stripMarkdownFrontmatter(result.content) : null,
          error: result.ok ? null : result.message || 'Failed to read the skill file.',
        });
      })
      .catch((error) => {
        setSkillContent({
          path,
          content: null,
          error: normalizeRemoteErrorMessage(error, 'Failed to read the skill file.'),
        });
      });
    await Promise.race([load, new Promise((resolve) => setTimeout(resolve, 300))]);
    setSkillDetailOpen(true);
  };

  const setEntryBusy = (key: string, busy: boolean) => {
    setBusyPluginKeys((current) => {
      const next = new Set(current);
      if (busy) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const installPlugin = async (entry: PluginEntry) => {
    const key = pluginKey(entry);
    if (busyPluginKeys.has(key)) return;
    setEntryBusy(key, true);
    try {
      await window.electron.installCodexPlugin({
        marketplacePath: entry.marketplacePath,
        remoteMarketplaceName: entry.marketplacePath ? undefined : entry.marketplaceName,
        pluginName: pluginRequestName(entry),
      });
      toast.success(`Installed ${pluginTitle(entry.plugin)}`);
      await loadPlugins(false);
    } catch (error) {
      toast.error(normalizeRemoteErrorMessage(error, `Failed to install ${pluginTitle(entry.plugin)}.`));
    } finally {
      setEntryBusy(key, false);
    }
  };

  const uninstallPlugin = async (entry: PluginEntry) => {
    const key = pluginKey(entry);
    if (busyPluginKeys.has(key)) return;
    setEntryBusy(key, true);
    try {
      await window.electron.uninstallCodexPlugin({ pluginId: entry.plugin.id });
      toast.success(`Uninstalled ${pluginTitle(entry.plugin)}`);
      setPluginDetailOpen(false);
      await loadPlugins(false);
    } catch (error) {
      toast.error(normalizeRemoteErrorMessage(error, `Failed to uninstall ${pluginTitle(entry.plugin)}.`));
    } finally {
      setEntryBusy(key, false);
    }
  };

  // Plugin detail is a full page (breadcrumb back to the list), not a modal.
  if (tab === 'plugins' && pluginDetailOpen && selectedPlugin) {
    return (
      <div className="space-y-4 pb-6">
        <PluginDetailPage
          entry={selectedPlugin}
          detail={detail}
          loading={detailLoading}
          busy={busyPluginKeys.has(pluginKey(selectedPlugin))}
          onBack={() => setPluginDetailOpen(false)}
          onInstall={installPlugin}
          onUninstall={uninstallPlugin}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ScopePill active={tab === 'plugins'} onClick={() => setTab('plugins')}>
            Plugins
          </ScopePill>
          <ScopePill active={tab === 'skills'} onClick={() => setTab('skills')}>
            Skills
          </ScopePill>
        </div>

        <button
          type="button"
          onClick={refresh}
          disabled={loadingPlugins || loadingSkills}
          className="inline-flex h-8 items-center gap-2 rounded-full border border-[var(--border)] px-3 text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loadingPlugins || loadingSkills ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          <span>Refresh</span>
        </button>
      </div>

      {tab === 'plugins' ? (
        <PluginMarketplace
          entries={pluginEntries}
          featuredPluginIds={pluginsResult.featuredPluginIds}
          loading={loadingPlugins}
          error={pluginsError || pluginsResult.remoteSyncError}
          query={query}
          normalizedQuery={normalizedQuery}
          scope={scope}
          busyPluginKeys={busyPluginKeys}
          onQueryChange={setQuery}
          onScopeChange={setScope}
          onSelect={openPluginDetail}
          onInstall={installPlugin}
        />
      ) : (
        <SkillListPane
          skills={filteredSkills}
          loading={loadingSkills}
          error={skillsError}
          discoveryCwd={discoveryCwd}
          query={query}
          onQueryChange={setQuery}
          onSelect={openSkillDetail}
        />
      )}
      <CodexSkillDetailDialog
        open={skillDetailOpen}
        onOpenChange={setSkillDetailOpen}
        skill={selectedSkill}
        content={skillContent}
      />
    </div>
  );
}

export function ScopePill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-8 items-center rounded-full px-3.5 text-[13px] transition-colors ${
        active
          ? 'bg-[var(--bg-tertiary)] font-medium text-[var(--text-primary)]'
          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
      }`}
    >
      {children}
    </button>
  );
}

function SearchBox({
  value,
  onChange,
  placeholder = 'Search plugins',
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="relative w-full">
      <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-11 w-full rounded-full border border-[var(--border)] bg-[var(--bg-primary)] pl-11 pr-10 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)]"
      />
      {value.trim() && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          title="Clear"
          className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

export function PluginMarketplace({
  entries,
  featuredPluginIds,
  loading,
  error,
  query,
  normalizedQuery,
  scope,
  busyPluginKeys,
  subtitle = 'Work with Codex across your favorite tools',
  showScopeFilter = true,
  onQueryChange,
  onScopeChange,
  onSelect,
  onInstall,
}: {
  entries: PluginEntry[];
  featuredPluginIds: string[];
  loading: boolean;
  error: string | null;
  query: string;
  normalizedQuery: string;
  scope: PluginScope;
  busyPluginKeys: ReadonlySet<string>;
  subtitle?: string;
  /** Claude's marketplaces are all local catalogs — no Public/Personal split. */
  showScopeFilter?: boolean;
  onQueryChange: (value: string) => void;
  onScopeChange: (scope: PluginScope) => void;
  onSelect: (entry: PluginEntry) => void;
  onInstall: (entry: PluginEntry) => void;
}) {
  const installedEntries = useMemo(
    () => entries.filter((entry) => isInstalledPlugin(entry.plugin)),
    [entries]
  );

  const scopedEntries = useMemo(
    () => (showScopeFilter ? entries.filter((entry) => entryScope(entry) === scope) : entries),
    [entries, scope, showScopeFilter]
  );

  const searchResults = useMemo(() => {
    if (!normalizedQuery) return [];
    return entries.filter((entry) => pluginSearchBlob(entry).includes(normalizedQuery));
  }, [entries, normalizedQuery]);

  const featuredEntries = useMemo(() => {
    if (featuredPluginIds.length === 0) return [];
    const byId = new Map(scopedEntries.map((entry) => [entry.plugin.id, entry]));
    return featuredPluginIds
      .map((id) => byId.get(id))
      .filter((entry): entry is PluginEntry => Boolean(entry));
  }, [featuredPluginIds, scopedEntries]);

  const categorySections = useMemo(() => {
    const buckets = new Map<string, PluginEntry[]>();
    for (const entry of scopedEntries) {
      const label = normalizeCategoryLabel(entry.plugin.interface?.category);
      const bucket = buckets.get(label);
      if (bucket) bucket.push(entry);
      else buckets.set(label, [entry]);
    }
    return Array.from(buckets.entries()).sort((left, right) => {
      if (left[0] === 'Other') return 1;
      if (right[0] === 'Other') return -1;
      return right[1].length - left[1].length;
    });
  }, [scopedEntries]);

  return (
    <section className="mx-auto min-h-[calc(100vh-240px)] w-full max-w-[820px] space-y-6">
      <div className="space-y-1.5">
        <h2 className="text-[30px] font-semibold tracking-[-0.03em] text-[var(--text-primary)]">
          Plugins
        </h2>
        <p className="text-sm text-[var(--text-secondary)]">{subtitle}</p>
      </div>

      <SearchBox value={query} onChange={onQueryChange} />

      {error && <InlineNotice>{error}</InlineNotice>}

      {loading && entries.length === 0 ? (
        <LoadingRows />
      ) : normalizedQuery ? (
        <SearchResultsSection
          results={searchResults}
          busyPluginKeys={busyPluginKeys}
          onSelect={onSelect}
          onInstall={onInstall}
        />
      ) : (
        <>
          {installedEntries.length > 0 && (
            <div className="space-y-3">
              <SectionHeading>Installed</SectionHeading>
              <div className="flex flex-wrap items-center gap-2.5">
                {installedEntries.map((entry) => (
                  <button
                    key={pluginKey(entry)}
                    type="button"
                    onClick={() => onSelect(entry)}
                    title={pluginTitle(entry.plugin)}
                    aria-label={`Open ${pluginTitle(entry.plugin)} details`}
                    className="rounded-[12px] transition-transform hover:scale-105"
                  >
                    <PluginAvatar plugin={entry.plugin} />
                  </button>
                ))}
              </div>
            </div>
          )}

          {showScopeFilter && (
            <div className="flex items-center gap-1.5">
              <ScopePill active={scope === 'public'} onClick={() => onScopeChange('public')}>
                Public
              </ScopePill>
              <ScopePill active={scope === 'personal'} onClick={() => onScopeChange('personal')}>
                Personal
              </ScopePill>
            </div>
          )}

          {scopedEntries.length === 0 ? (
            <EmptyPanel>
              {!showScopeFilter
                ? 'No plugins found.'
                : scope === 'public'
                  ? 'No public catalog plugins available.'
                  : 'No personal plugins found.'}
            </EmptyPanel>
          ) : (
            <>
              {featuredEntries.length > 0 && (
                <PluginSection
                  title="Featured"
                  entries={featuredEntries}
                  busyPluginKeys={busyPluginKeys}
                  onSelect={onSelect}
                  onInstall={onInstall}
                />
              )}
              {categorySections.map(([label, sectionEntries]) => (
                <PluginSection
                  key={label}
                  title={label}
                  entries={sectionEntries}
                  busyPluginKeys={busyPluginKeys}
                  onSelect={onSelect}
                  onInstall={onInstall}
                />
              ))}
            </>
          )}
        </>
      )}
    </section>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <div className="border-b border-[var(--border)] pb-2 text-[15px] font-medium text-[var(--text-primary)]">
      {children}
    </div>
  );
}

function SearchResultsSection({
  results,
  busyPluginKeys,
  onSelect,
  onInstall,
}: {
  results: PluginEntry[];
  busyPluginKeys: ReadonlySet<string>;
  onSelect: (entry: PluginEntry) => void;
  onInstall: (entry: PluginEntry) => void;
}) {
  const visible = results.slice(0, SEARCH_RESULT_LIMIT);

  return (
    <div className="space-y-3">
      <SectionHeading>Results</SectionHeading>
      {results.length === 0 ? (
        <EmptyPanel>No plugins match your search.</EmptyPanel>
      ) : (
        <>
          <PluginRowGrid
            entries={visible}
            busyPluginKeys={busyPluginKeys}
            onSelect={onSelect}
            onInstall={onInstall}
          />
          {results.length > visible.length && (
            <p className="text-xs text-[var(--text-muted)]">
              Showing {visible.length} of {results.length} matches — keep typing to narrow down.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function PluginSection({
  title,
  entries,
  busyPluginKeys,
  onSelect,
  onInstall,
}: {
  title: string;
  entries: PluginEntry[];
  busyPluginKeys: ReadonlySet<string>;
  onSelect: (entry: PluginEntry) => void;
  onInstall: (entry: PluginEntry) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? entries : entries.slice(0, COLLAPSED_SECTION_ROWS);
  const hidden = entries.slice(visible.length);

  return (
    <div className="space-y-3">
      <SectionHeading>{title}</SectionHeading>
      <PluginRowGrid
        entries={visible}
        busyPluginKeys={busyPluginKeys}
        onSelect={onSelect}
        onInstall={onInstall}
      />
      {hidden.length > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="group flex items-center gap-2.5 rounded-full py-1 pr-2 text-left text-[13px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
        >
          <span className="flex -space-x-1.5">
            {hidden.slice(0, 3).map((entry) => (
              <span key={pluginKey(entry)} className="rounded-md ring-2 ring-[var(--bg-primary)]">
                <PluginAvatar plugin={entry.plugin} size="sm" />
              </span>
            ))}
          </span>
          <span>{formatSeeMoreLabel(hidden)}</span>
        </button>
      )}
      {expanded && entries.length > COLLAPSED_SECTION_ROWS && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="rounded-full py-1 text-[13px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
        >
          Show less
        </button>
      )}
    </div>
  );
}

export function formatSeeMoreNames(hiddenNames: string[]): string {
  const names = hiddenNames.slice(0, 2);
  const rest = hiddenNames.length - names.length;
  if (rest <= 0) return `See ${names.join(' and ')}`;
  return `See ${names.join(', ')}, and ${rest} more`;
}

function formatSeeMoreLabel(hidden: PluginEntry[]): string {
  return formatSeeMoreNames(hidden.map((entry) => pluginTitle(entry.plugin)));
}

function PluginRowGrid({
  entries,
  busyPluginKeys,
  onSelect,
  onInstall,
}: {
  entries: PluginEntry[];
  busyPluginKeys: ReadonlySet<string>;
  onSelect: (entry: PluginEntry) => void;
  onInstall: (entry: PluginEntry) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2">
      {entries.map((entry) => (
        <PluginRow
          key={pluginKey(entry)}
          entry={entry}
          busy={busyPluginKeys.has(pluginKey(entry))}
          onSelect={() => onSelect(entry)}
          onInstall={() => onInstall(entry)}
        />
      ))}
    </div>
  );
}

function PluginRow({
  entry,
  busy,
  onSelect,
  onInstall,
}: {
  entry: PluginEntry;
  busy: boolean;
  onSelect: () => void;
  onInstall: () => void;
}) {
  const plugin = entry.plugin;
  const title = pluginTitle(plugin);
  const description = plugin.interface?.shortDescription || formatPluginSource(plugin);
  const installed = isInstalledPlugin(plugin);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      className="group flex cursor-pointer items-center gap-3 rounded-[14px] px-2 py-2 transition-colors hover:bg-[var(--bg-secondary)]"
      aria-label={`Open ${title} details`}
    >
      <PluginAvatar plugin={plugin} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium text-[var(--text-primary)]">{title}</div>
        <div className="truncate text-[13px] text-[var(--text-muted)]">{description}</div>
      </div>
      {installed ? (
        <span
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] opacity-0 transition-opacity group-hover:opacity-100"
          aria-hidden="true"
        >
          <MoreHorizontal className="h-4 w-4" />
        </span>
      ) : plugin.installPolicy === 'AVAILABLE' ? (
        <button
          type="button"
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation();
            onInstall();
          }}
          className="inline-flex h-8 shrink-0 items-center justify-center rounded-full border border-[var(--border)] px-3.5 text-[13px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : 'Install'}
        </button>
      ) : null}
    </div>
  );
}

function PluginAvatar({
  plugin,
  size = 'md',
}: {
  plugin: ProviderPluginDescriptor;
  size?: 'sm' | 'md' | 'lg';
}) {
  const [failed, setFailed] = useState(false);
  const logo = plugin.interface?.logoUrl || plugin.interface?.logo;
  const title = pluginTitle(plugin);
  const brandColor = plugin.interface?.brandColor;
  const frame =
    size === 'sm'
      ? 'h-6 w-6 rounded-md text-[11px]'
      : size === 'lg'
        ? 'h-14 w-14 rounded-[16px] text-[22px]'
        : 'h-10 w-10 rounded-[10px] text-[15px]';

  if (logo && !failed) {
    return (
      <img
        src={logo}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        className={`${frame} shrink-0 border border-[color-mix(in_srgb,var(--border)_70%,transparent)] bg-white object-cover`}
      />
    );
  }

  return (
    <span
      className={`${frame} flex shrink-0 items-center justify-center border border-[color-mix(in_srgb,var(--border)_70%,transparent)] font-semibold ${
        brandColor ? 'text-white' : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
      }`}
      style={brandColor ? { backgroundColor: brandColor } : undefined}
      aria-hidden="true"
    >
      {title.charAt(0).toUpperCase()}
    </span>
  );
}

export function PluginDetailPage({
  entry,
  detail,
  loading,
  busy,
  onBack,
  onInstall,
  onUninstall,
}: {
  entry: PluginEntry;
  detail: ProviderPluginDetail | null;
  loading: boolean;
  busy: boolean;
  onBack: () => void;
  onInstall: (entry: PluginEntry) => void;
  onUninstall: (entry: PluginEntry) => void;
}) {
  const plugin = detail?.summary || entry.plugin;
  const title = pluginTitle(plugin);
  const installed = isInstalledPlugin(plugin);
  const shortDescription = plugin.interface?.shortDescription;
  const longDescription =
    detail?.description || plugin.interface?.longDescription || null;
  const heroPrompt = plugin.interface?.defaultPrompt?.[0];
  const heroBase = plugin.interface?.brandColor || '#8B8BF0';

  const infoRows: Array<[string, ReactNode]> = [
    ...(plugin.interface?.capabilities?.length
      ? [['Capabilities', plugin.interface.capabilities.join(', ')] as [string, ReactNode]]
      : []),
    ...(plugin.interface?.developerName
      ? [['Developer', plugin.interface.developerName] as [string, ReactNode]]
      : []),
    ...(plugin.interface?.category
      ? [['Category', plugin.interface.category] as [string, ReactNode]]
      : []),
    ...(plugin.version ? [['Version', plugin.version] as [string, ReactNode]] : []),
    ['Source', formatPluginSource(plugin)],
    ...(plugin.interface?.websiteUrl
      ? [['Website', <ExternalLinkGlobe key="web" url={plugin.interface.websiteUrl} />] as [string, ReactNode]]
      : []),
    ...(plugin.interface?.privacyPolicyUrl
      ? [['Privacy Policy', <ExternalLinkGlobe key="privacy" url={plugin.interface.privacyPolicyUrl} />] as [string, ReactNode]]
      : []),
    ...(plugin.interface?.termsOfServiceUrl
      ? [['Terms of Service', <ExternalLinkGlobe key="tos" url={plugin.interface.termsOfServiceUrl} />] as [string, ReactNode]]
      : []),
  ];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-[13px] text-[var(--text-muted)]">
        <button
          type="button"
          onClick={onBack}
          className="rounded px-0.5 transition-colors hover:text-[var(--text-primary)]"
        >
          Plugins
        </button>
        <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="text-[var(--text-primary)]">{title}</span>
      </div>

      <div className="mx-auto w-full max-w-[680px] space-y-6 pt-5">
        <PluginAvatar plugin={plugin} size="lg" />

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2 className="text-[24px] font-semibold tracking-[-0.02em] text-[var(--text-primary)]">
              {title}
            </h2>
            {shortDescription && (
              <p className="text-sm text-[var(--text-secondary)]">{shortDescription}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2 pt-1">
            {loading && <LoaderCircle className="h-4 w-4 animate-spin text-[var(--text-muted)]" />}
            {installed ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => onUninstall(entry)}
                className="inline-flex h-8 items-center justify-center rounded-full border border-[var(--border)] px-3.5 text-[13px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : 'Uninstall'}
              </button>
            ) : plugin.installPolicy === 'AVAILABLE' ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => onInstall(entry)}
                className="inline-flex h-8 items-center justify-center rounded-full bg-[var(--accent)] px-4 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : 'Install'}
              </button>
            ) : null}
          </div>
        </div>

        {heroPrompt && (
          <div
            className="flex items-center justify-center rounded-[18px] px-6 py-9"
            style={{
              background: `linear-gradient(115deg, color-mix(in srgb, ${heroBase} 34%, #c7d2fe), color-mix(in srgb, ${heroBase} 14%, #ede9fe) 55%, color-mix(in srgb, ${heroBase} 26%, #ddd6fe))`,
            }}
          >
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(heroPrompt);
                toast.success('Prompt copied');
              }}
              title="Copy prompt"
              className="flex max-w-full items-center gap-2.5 rounded-full bg-white/95 py-2 pl-3.5 pr-2 text-left shadow-[0_8px_24px_rgba(15,23,42,0.14)] transition-transform hover:scale-[1.01]"
            >
              <PluginAvatar plugin={plugin} size="sm" />
              <span className="min-w-0 text-[13px] leading-snug text-[#1f2937]">
                <span className="font-semibold">{title}</span>{' '}
                <span className="line-clamp-2">{heroPrompt}</span>
              </span>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#f3f4f6] text-[#374151]">
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
            </button>
          </div>
        )}

        {longDescription && (
          <p className="text-sm leading-7 text-[var(--text-secondary)]">{longDescription}</p>
        )}

        {detail?.apps.length ? (
          <DetailListSection title="Apps" count={detail.apps.length}>
            {detail.apps.map((app) => (
              <div key={app.id} className="flex items-center gap-3 py-2.5">
                <PluginAvatar plugin={plugin} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium text-[var(--text-primary)]">
                    {app.name}
                  </div>
                  {app.description && (
                    <div className="truncate text-[13px] text-[var(--text-muted)]">
                      {app.description}
                    </div>
                  )}
                </div>
                {app.needsAuth && <SmallBadge>auth</SmallBadge>}
              </div>
            ))}
          </DetailListSection>
        ) : null}

        {detail?.skills.length ? (
          <DetailListSection title="Skills" count={detail.skills.length}>
            {detail.skills.map((skill) => (
              <div key={`${skill.path}:${skill.name}`} className="flex items-center gap-3 py-2.5">
                <PluginAvatar plugin={plugin} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium text-[var(--text-primary)]">
                    {skill.interface?.displayName || skill.name}
                  </div>
                  {(skill.interface?.shortDescription || skill.description) && (
                    <div className="truncate text-[13px] text-[var(--text-muted)]">
                      {skill.interface?.shortDescription || skill.description}
                    </div>
                  )}
                </div>
                <SkillEnabledDot enabled={skill.enabled} />
              </div>
            ))}
          </DetailListSection>
        ) : null}

        {detail?.mcpServers.length ? (
          <DetailListSection title="MCP servers" count={detail.mcpServers.length}>
            <div className="flex flex-wrap gap-2 py-2.5">
              {detail.mcpServers.map((server) => (
                <SmallBadge key={server}>{server}</SmallBadge>
              ))}
            </div>
          </DetailListSection>
        ) : null}

        <DetailListSection title="Information">
          <div className="space-y-0.5 py-2">
            {infoRows.map(([label, value]) => (
              <div key={label} className="flex items-center gap-6 py-1.5 text-[13px]">
                <span className="w-32 shrink-0 text-[var(--text-muted)]">{label}</span>
                <span className="min-w-0 break-words text-[var(--text-primary)]">{value}</span>
              </div>
            ))}
          </div>
        </DetailListSection>
      </div>
    </div>
  );
}

function DetailListSection({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="flex items-baseline gap-2 border-b border-[var(--border)] pb-2">
        <h3 className="text-[15px] font-medium text-[var(--text-primary)]">{title}</h3>
        {typeof count === 'number' && (
          <span className="text-[13px] text-[var(--text-muted)]">{count}</span>
        )}
      </div>
      <div className="divide-y divide-[color-mix(in_srgb,var(--border)_55%,transparent)]">
        {children}
      </div>
    </section>
  );
}

/** Read-only enablement indicator — skill toggles are managed by Codex. */
function SkillEnabledDot({ enabled }: { enabled: boolean }) {
  return (
    <span
      title={enabled ? 'Enabled' : 'Disabled'}
      aria-label={enabled ? 'Enabled' : 'Disabled'}
      className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full px-0.5 transition-colors ${
        enabled ? 'justify-end bg-[var(--accent)]' : 'justify-start bg-[var(--bg-tertiary)]'
      }`}
    >
      <span className="h-4 w-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.2)]" />
    </span>
  );
}

function ExternalLinkGlobe({ url }: { url: string }) {
  return (
    <button
      type="button"
      onClick={() => void window.electron.openExternalUrl(url)}
      title={url}
      aria-label={`Open ${url}`}
      className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
    >
      <Globe className="h-3.5 w-3.5" />
    </button>
  );
}

function skillScopeSectionLabel(scope: string | undefined): string {
  const normalized = (scope || '').toLowerCase();
  if (!normalized || normalized === 'user' || normalized === 'personal') return 'Personal';
  if (normalized === 'repo' || normalized === 'project' || normalized === 'workspace') {
    return 'Project';
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

const SKILL_SCOPE_SECTION_ORDER = ['Personal', 'Project', 'System'];

export function SkillListPane({
  skills,
  loading,
  error,
  discoveryCwd,
  query,
  subtitle = 'Extend Codex with task-specific skills',
  onQueryChange,
  onSelect,
}: {
  skills: ProviderSkillDescriptor[];
  loading: boolean;
  error: string | null;
  discoveryCwd?: string;
  query: string;
  subtitle?: string;
  onQueryChange: (value: string) => void;
  onSelect: (skill: ProviderSkillDescriptor) => void;
}) {
  const sections = useMemo(() => {
    const buckets = new Map<string, ProviderSkillDescriptor[]>();
    for (const skill of skills) {
      const label = skillScopeSectionLabel(skill.scope);
      const bucket = buckets.get(label);
      if (bucket) bucket.push(skill);
      else buckets.set(label, [skill]);
    }
    return Array.from(buckets.entries()).sort((left, right) => {
      const leftIndex = SKILL_SCOPE_SECTION_ORDER.indexOf(left[0]);
      const rightIndex = SKILL_SCOPE_SECTION_ORDER.indexOf(right[0]);
      return (
        (leftIndex === -1 ? SKILL_SCOPE_SECTION_ORDER.length : leftIndex) -
        (rightIndex === -1 ? SKILL_SCOPE_SECTION_ORDER.length : rightIndex)
      );
    });
  }, [skills]);

  return (
    <section className="mx-auto min-h-[calc(100vh-240px)] w-full max-w-[820px] space-y-6">
      <div className="space-y-1.5">
        <h2 className="text-[30px] font-semibold tracking-[-0.03em] text-[var(--text-primary)]">
          Skills
        </h2>
        <p className="text-sm text-[var(--text-secondary)]" title={discoveryCwd}>
          {subtitle}
        </p>
      </div>

      <SearchBox value={query} onChange={onQueryChange} placeholder="Search skills" />

      {error && <InlineNotice>{error}</InlineNotice>}
      {loading && skills.length === 0 ? (
        <LoadingRows />
      ) : skills.length === 0 ? (
        <EmptyPanel>No Codex skills found.</EmptyPanel>
      ) : (
        sections.map(([label, sectionSkills]) => (
          <SkillSection
            key={label}
            title={label}
            skills={sectionSkills}
            onSelect={onSelect}
          />
        ))
      )}
    </section>
  );
}

function SkillSection({
  title,
  skills,
  onSelect,
}: {
  title: string;
  skills: ProviderSkillDescriptor[];
  onSelect: (skill: ProviderSkillDescriptor) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? skills : skills.slice(0, COLLAPSED_SECTION_ROWS);
  const hidden = skills.slice(visible.length);

  return (
    <div className="space-y-3">
      <SectionHeading>{title}</SectionHeading>
      <div className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2">
        {visible.map((skill) => (
          <SkillRow
            key={`${skill.path}:${skill.name}`}
            skill={skill}
            onSelect={() => onSelect(skill)}
          />
        ))}
      </div>
      {hidden.length > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="rounded-full py-1 text-[13px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
        >
          {formatSeeMoreNames(
            hidden.map((skill) => skill.interface?.displayName || skill.name),
          )}
        </button>
      )}
      {expanded && skills.length > COLLAPSED_SECTION_ROWS && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="rounded-full py-1 text-[13px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
        >
          Show less
        </button>
      )}
    </div>
  );
}

function SkillRow({
  skill,
  onSelect,
}: {
  skill: ProviderSkillDescriptor;
  onSelect: () => void;
}) {
  const title = skill.interface?.displayName || skill.name;
  const description = skill.interface?.shortDescription || skill.description || skill.path;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      className="group flex cursor-pointer items-center gap-3 rounded-[14px] px-2 py-2 transition-colors hover:bg-[var(--bg-secondary)]"
      aria-label={`Open ${title} skill detail`}
    >
      <SkillAvatar skill={skill} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium text-[var(--text-primary)]">{title}</div>
        <div className="truncate text-[13px] text-[var(--text-muted)]">{description}</div>
      </div>
      {skill.enabled && (
        <Check
          className="h-4 w-4 shrink-0 text-[var(--text-muted)]"
          aria-label="Enabled"
        />
      )}
    </div>
  );
}

// Skills without their own assets get a glyph inferred from the skill name
// (matching the codex app), then the generic skill cube.
export function inferSkillGlyph(name: string): typeof SkillStack {
  const tokens = name.toLowerCase().split(/[^a-z0-9]+/);
  if (tokens.includes('github') || tokens.includes('git')) return BrandGithub;
  if (tokens.includes('browser') || tokens.includes('chrome') || tokens.includes('web')) {
    return Globe;
  }
  return SkillStack;
}

/**
 * The unified default skill mark from the codex app: an isometric cube with
 * amber / violet / orange faces on a neutral tile.
 */
export function SkillCubeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M12 4 L18.8 7.9 L12 11.8 L5.2 7.9 Z" fill="#FFAD33" />
      <path d="M5.2 7.9 L12 11.8 V19.6 L5.2 15.7 Z" fill="#8B5CF6" />
      <path d="M18.8 7.9 L12 11.8 V19.6 L18.8 15.7 Z" fill="#FB7A2E" />
    </svg>
  );
}

function SkillAvatar({ skill }: { skill: ProviderSkillDescriptor }) {
  const [failed, setFailed] = useState(false);
  const icon = skill.interface?.iconLarge || skill.interface?.iconSmall;
  const brandColor = skill.interface?.brandColor;

  if (icon && !failed) {
    return (
      <img
        src={icon}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        className="h-10 w-10 shrink-0 rounded-[10px] border border-[color-mix(in_srgb,var(--border)_70%,transparent)] bg-white object-cover"
      />
    );
  }

  const frame =
    'flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-[color-mix(in_srgb,var(--border)_55%,transparent)]';

  if (brandColor) {
    const Glyph = inferSkillGlyph(skill.name);
    return (
      <span className={`${frame} text-white`} style={{ backgroundColor: brandColor }} aria-hidden="true">
        <Glyph className="h-[18px] w-[18px]" />
      </span>
    );
  }

  const Glyph = inferSkillGlyph(skill.name);
  return (
    <span className={`${frame} bg-[var(--bg-tertiary)] text-[var(--text-primary)]`} aria-hidden="true">
      {Glyph === SkillStack ? (
        <SkillCubeMark className="h-[22px] w-[22px]" />
      ) : (
        <Glyph className="h-[18px] w-[18px]" />
      )}
    </span>
  );
}

export function stripMarkdownFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

export function CodexSkillDetailDialog({
  open,
  onOpenChange,
  skill,
  content,
  mentionPrefix = '$',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skill: ProviderSkillDescriptor | null;
  /** Preloaded by openSkillDetail; only trusted when it matches skill.path. */
  content: { path: string; content: string | null; error: string | null } | null;
  /** Composer token prefix used by Try now ('$' for codex, '/' for opencode, '/skill:' for kimi). */
  mentionPrefix?: '/' | '$' | '/skill:';
}) {
  const { activeSessionId, setShowSettings } = useAppStore();

  const title = skill?.interface?.displayName || skill?.name || 'Skill';
  const description = skill?.interface?.shortDescription || skill?.description || '';
  const loaded = content;
  const ready = Boolean(skill && loaded?.path === skill.path);

  const tryNow = () => {
    if (!skill || !activeSessionId) return;
    const mention = `${mentionPrefix}${skill.name.trim().replace(/\s+/g, '-')} `;
    const text = skill.interface?.defaultPrompt || mention;
    onOpenChange(false);
    setShowSettings(false);
    window.requestAnimationFrame(() => {
      window.dispatchEvent(
        new CustomEvent('aegis-composer-set-prompt', {
          detail: { sessionId: activeSessionId, text },
        })
      );
    });
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/35 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[81] flex max-h-[86vh] w-[min(860px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[22px] border border-[var(--border)] bg-[var(--bg-secondary)] shadow-[0_24px_80px_rgba(0,0,0,0.22)]">
          {!skill ? (
            <div className="p-6 text-sm text-[var(--text-muted)]">Select a skill card to inspect its instructions.</div>
          ) : (
            <>
              <div className="flex items-start justify-between gap-3 px-7 pt-6">
                <SkillAvatar skill={skill} />
                <div className="flex items-center gap-2.5">
                  <SkillEnabledDot enabled={skill.enabled} />
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                      aria-label="Close skill detail"
                      title="Close"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </Dialog.Close>
                </div>
              </div>

              <div className="space-y-1 px-7 pb-5 pt-4">
                <h4 className="break-words text-[22px] font-semibold tracking-[-0.02em] text-[var(--text-primary)]">
                  {title} <span className="font-normal text-[var(--text-muted)]">Skill</span>
                </h4>
                {description && (
                  <p className="break-words text-sm leading-6 text-[var(--text-secondary)]">
                    {description}
                  </p>
                )}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-7">
                <div className="rounded-[16px] border border-[color-mix(in_srgb,var(--border)_75%,transparent)] bg-[var(--bg-primary)] px-6 py-5">
                  {!ready ? (
                    <div className="flex min-h-32 items-center justify-center">
                      <LoaderCircle className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
                    </div>
                  ) : loaded?.error ? (
                    <p className="text-sm text-[var(--text-muted)]">{loaded.error}</p>
                  ) : loaded?.content ? (
                    <MDContent
                      content={loaded.content}
                      allowHtml={false}
                      className="project-markdown-preview"
                    />
                  ) : (
                    <p className="text-sm text-[var(--text-muted)]">This skill file is empty.</p>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 px-7 py-5">
                {/* Virtual paths (kimi builtin://, qoder://) have no file to reveal. */}
                {skill.path.startsWith('/') ? (
                  <button
                    type="button"
                    onClick={() => void window.electron.revealPath(skill.path)}
                    className="inline-flex h-8 items-center rounded-full border border-[var(--border)] px-3.5 text-[13px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                  >
                    Reveal in Finder
                  </button>
                ) : (
                  <span />
                )}
                {activeSessionId ? (
                  <button
                    type="button"
                    onClick={tryNow}
                    className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--text-primary)] px-4 text-[13px] font-medium text-[var(--bg-primary)] transition-opacity hover:opacity-90"
                  >
                    Try now
                  </button>
                ) : null}
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SmallBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center rounded-full bg-[var(--bg-tertiary)] px-2.5 py-1 text-[11px] leading-4 text-[var(--text-muted)]">
      {children}
    </span>
  );
}

function InlineNotice({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2 rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-xs leading-5 text-[var(--text-muted)]">
      {children}
    </div>
  );
}

function EmptyPanel({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-32 items-center justify-center rounded-[var(--radius-xl)] border border-dashed border-[var(--border)] bg-[var(--bg-primary)] px-5 py-6 text-center text-sm text-[var(--text-muted)]">
      {children}
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-2">
      {['a', 'b', 'c', 'd'].map((id) => (
        <div key={id} className="h-[56px] animate-pulse rounded-[var(--radius-xl)] bg-[var(--bg-primary)]" />
      ))}
    </div>
  );
}

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Boxes, CheckCircle2, LoaderCircle, Plug, RefreshCw, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAppStore } from '../../store/useAppStore';
import type {
  ProviderListPluginsResult,
  ProviderListSkillsResult,
  ProviderPluginDescriptor,
  ProviderPluginDetail,
  ProviderSkillDescriptor,
} from '../../types';

type CodexTab = 'plugins' | 'skills';

type PluginEntry = {
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

function pluginKey(entry: PluginEntry): string {
  return `${entry.marketplacePath || entry.marketplaceName}::${entry.plugin.name}`;
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

export function CodexPluginLibraryContent() {
  const { activeSessionId, sessions, projectCwd } = useAppStore();
  const [tab, setTab] = useState<CodexTab>('plugins');
  const [query, setQuery] = useState('');
  const [pluginsResult, setPluginsResult] = useState<ProviderListPluginsResult>(EMPTY_PLUGINS_RESULT);
  const [skillsResult, setSkillsResult] = useState<ProviderListSkillsResult>(EMPTY_SKILLS_RESULT);
  const [loadingPlugins, setLoadingPlugins] = useState(false);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [pluginsError, setPluginsError] = useState<string | null>(null);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProviderPluginDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

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

  const filteredPlugins = useMemo(() => {
    if (!normalizedQuery) return pluginEntries;
    return pluginEntries.filter((entry) => pluginSearchBlob(entry).includes(normalizedQuery));
  }, [normalizedQuery, pluginEntries]);

  const filteredSkills = useMemo(() => {
    if (!normalizedQuery) return skillsResult.skills;
    return skillsResult.skills.filter((skill) => skillSearchBlob(skill).includes(normalizedQuery));
  }, [normalizedQuery, skillsResult.skills]);

  const selectedPlugin = useMemo(() => {
    if (!selectedKey) return filteredPlugins[0] || null;
    return filteredPlugins.find((entry) => pluginKey(entry) === selectedKey) || filteredPlugins[0] || null;
  }, [filteredPlugins, selectedKey]);

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
        return nextEntries[0] ? pluginKey(nextEntries[0]) : null;
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
    if (!discoveryCwd) {
      setSkillsResult(EMPTY_SKILLS_RESULT);
      setSkillsError('Open a project or Codex session first to resolve workspace skills.');
      return;
    }

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
    if (!selectedPlugin) {
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
          pluginName: selectedPlugin.plugin.name,
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
  }, [selectedPlugin]);

  const refresh = () => {
    if (tab === 'plugins') void loadPlugins(true);
    else void loadSkills(true);
  };

  return (
    <div className="space-y-4 pb-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setTab('plugins')}
            className={`rounded-lg border px-3 py-1.5 text-[15px] transition-colors ${
              tab === 'plugins'
                ? 'border-[var(--border)] bg-[var(--bg-secondary)] font-medium text-[var(--text-primary)]'
                : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
            }`}
          >
            Plugins
          </button>
          <button
            type="button"
            onClick={() => setTab('skills')}
            className={`rounded-lg border px-3 py-1.5 text-[15px] transition-colors ${
              tab === 'skills'
                ? 'border-[var(--border)] bg-[var(--bg-secondary)] font-medium text-[var(--text-primary)]'
                : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
            }`}
          >
            Skills
          </button>
        </div>

        <div className="flex min-w-[260px] items-center gap-2">
          <SearchBox value={query} onChange={setQuery} />
          <button
            type="button"
            onClick={refresh}
            disabled={loadingPlugins || loadingSkills}
            className="inline-flex h-10 items-center gap-2 rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loadingPlugins || loadingSkills ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {tab === 'plugins' ? (
        <div className="grid min-h-[calc(100vh-220px)] gap-4 lg:grid-cols-[minmax(300px,420px)_minmax(0,1fr)]">
          <PluginListPane
            entries={filteredPlugins}
            loading={loadingPlugins}
            error={pluginsError || pluginsResult.remoteSyncError}
            selectedKey={selectedPlugin ? pluginKey(selectedPlugin) : null}
            onSelect={(entry) => setSelectedKey(pluginKey(entry))}
          />
          <PluginDetailPane entry={selectedPlugin} detail={detail} loading={detailLoading} />
        </div>
      ) : (
        <SkillListPane
          skills={filteredSkills}
          loading={loadingSkills}
          error={skillsError}
          discoveryCwd={discoveryCwd}
        />
      )}
    </div>
  );
}

function SearchBox({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative flex-1">
      <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search Codex"
        className="h-10 w-full rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] pl-9 pr-9 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
      />
      {value.trim() && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          title="Clear"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function PluginListPane({
  entries,
  loading,
  error,
  selectedKey,
  onSelect,
}: {
  entries: PluginEntry[];
  loading: boolean;
  error: string | null;
  selectedKey: string | null;
  onSelect: (entry: PluginEntry) => void;
}) {
  return (
    <section className="min-h-0 rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--bg-secondary)]">
      <div className="border-b border-[var(--border)] px-4 py-3">
        <div className="text-sm font-medium text-[var(--text-primary)]">Codex plugins</div>
        <div className="mt-0.5 text-xs text-[var(--text-muted)]">
          {entries.length} {entries.length === 1 ? 'plugin' : 'plugins'}
        </div>
      </div>
      <div className="max-h-[calc(100vh-310px)] overflow-y-auto p-2">
        {error && <InlineNotice>{error}</InlineNotice>}
        {loading && entries.length === 0 ? (
          <LoadingRows />
        ) : entries.length === 0 ? (
          <EmptyPanel>No Codex plugins found.</EmptyPanel>
        ) : (
          <div className="space-y-1">
            {entries.map((entry) => (
              <PluginRow
                key={pluginKey(entry)}
                entry={entry}
                selected={selectedKey === pluginKey(entry)}
                onClick={() => onSelect(entry)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function PluginRow({
  entry,
  selected,
  onClick,
}: {
  entry: PluginEntry;
  selected: boolean;
  onClick: () => void;
}) {
  const plugin = entry.plugin;
  const title = plugin.interface?.displayName || plugin.name;
  const description = plugin.interface?.shortDescription || formatPluginSource(plugin);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-start gap-3 rounded-[var(--radius-xl)] px-3 py-3 text-left transition-colors ${
        selected
          ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
      }`}
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-xl)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
        <Plug className="h-4.5 w-4.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="truncate text-sm font-medium">{title}</div>
          {isInstalledPlugin(plugin) && (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
          )}
        </div>
        <div className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--text-muted)]">
          {description}
        </div>
        <div className="mt-2 text-[11px] text-[var(--text-muted)]">{entry.marketplaceName}</div>
      </div>
    </button>
  );
}

function PluginDetailPane({
  entry,
  detail,
  loading,
}: {
  entry: PluginEntry | null;
  detail: ProviderPluginDetail | null;
  loading: boolean;
}) {
  if (!entry) {
    return <EmptyPanel>Select a plugin to inspect its Codex capabilities.</EmptyPanel>;
  }

  const plugin = detail?.summary || entry.plugin;
  const title = plugin.interface?.displayName || plugin.name;
  const description =
    detail?.description ||
    plugin.interface?.longDescription ||
    plugin.interface?.shortDescription ||
    'No plugin description available.';

  return (
    <section className="rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--bg-secondary)]">
      <div className="border-b border-[var(--border)] px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-2xl)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
            <Plug className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-lg font-semibold tracking-[-0.02em] text-[var(--text-primary)]">
                {title}
              </h3>
              <StatusBadge active={plugin.enabled} installed={isInstalledPlugin(plugin)} />
            </div>
            <p className="mt-1 text-xs text-[var(--text-muted)]">{entry.marketplaceName}</p>
          </div>
          {loading && <LoaderCircle className="h-4 w-4 animate-spin text-[var(--text-muted)]" />}
        </div>
      </div>

      <div className="space-y-5 px-5 py-5">
        <p className="text-sm leading-6 text-[var(--text-secondary)]">{description}</p>

        <MetadataGrid
          rows={[
            ['Name', plugin.name],
            ['Install', plugin.installPolicy],
            ['Auth', plugin.authPolicy],
            ['Source', formatPluginSource(plugin)],
            ...(plugin.interface?.developerName ? [['Developer', plugin.interface.developerName] as [string, string]] : []),
            ...(plugin.interface?.category ? [['Category', plugin.interface.category] as [string, string]] : []),
          ]}
        />

        {plugin.interface?.capabilities?.length ? (
          <DetailSection title="Capabilities">
            <TagList items={plugin.interface.capabilities} />
          </DetailSection>
        ) : null}

        {detail?.skills.length ? (
          <DetailSection title="Skills">
            <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
              {detail.skills.map((skill) => (
                <SkillMiniCard key={`${skill.path}:${skill.name}`} skill={skill} />
              ))}
            </div>
          </DetailSection>
        ) : null}

        {detail?.apps.length ? (
          <DetailSection title="Apps">
            <TagList items={detail.apps.map((app) => `${app.name}${app.needsAuth ? ' · auth' : ''}`)} />
          </DetailSection>
        ) : null}

        {detail?.mcpServers.length ? (
          <DetailSection title="MCP servers">
            <TagList items={detail.mcpServers} />
          </DetailSection>
        ) : null}

        <div className="rounded-[var(--radius-xl)] border border-dashed border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3 text-xs leading-5 text-[var(--text-muted)]">
          Install, uninstall, OAuth, and dynamic tool execution are intentionally disabled in this first pass.
        </div>
      </div>
    </section>
  );
}

function SkillListPane({
  skills,
  loading,
  error,
  discoveryCwd,
}: {
  skills: ProviderSkillDescriptor[];
  loading: boolean;
  error: string | null;
  discoveryCwd?: string;
}) {
  return (
    <section className="rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--bg-secondary)]">
      <div className="border-b border-[var(--border)] px-4 py-3">
        <div className="text-sm font-medium text-[var(--text-primary)]">Codex skills</div>
        <div className="mt-0.5 text-xs text-[var(--text-muted)]">
          {discoveryCwd || 'No active workspace'}
        </div>
      </div>
      <div className="p-4">
        {error && <InlineNotice>{error}</InlineNotice>}
        {loading && skills.length === 0 ? (
          <LoadingRows />
        ) : skills.length === 0 ? (
          <EmptyPanel>No Codex skills found.</EmptyPanel>
        ) : (
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {skills.map((skill) => (
              <SkillMiniCard key={`${skill.path}:${skill.name}`} skill={skill} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function SkillMiniCard({ skill }: { skill: ProviderSkillDescriptor }) {
  return (
    <article className="rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-3">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-xl)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
          <Boxes className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-[var(--text-primary)]">
            {skill.interface?.displayName || skill.name}
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--text-muted)]">
            {skill.interface?.shortDescription || skill.description || skill.path}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {skill.scope && <SmallBadge>{skill.scope}</SmallBadge>}
            {skill.enabled && <SmallBadge>enabled</SmallBadge>}
          </div>
        </div>
      </div>
    </article>
  );
}

function MetadataGrid({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div className="grid grid-cols-1 gap-2 text-xs md:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="rounded-[var(--radius-xl)] bg-[var(--bg-primary)] px-3 py-2">
          <div className="font-medium text-[var(--text-primary)]">{label}</div>
          <div className="mt-1 break-words text-[var(--text-muted)]">{value}</div>
        </div>
      ))}
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-medium text-[var(--text-primary)]">{title}</h4>
      {children}
    </section>
  );
}

function TagList({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <SmallBadge key={item}>{item}</SmallBadge>
      ))}
    </div>
  );
}

function SmallBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center rounded-full bg-[var(--bg-tertiary)] px-2.5 py-1 text-[11px] leading-4 text-[var(--text-muted)]">
      {children}
    </span>
  );
}

function StatusBadge({ active, installed }: { active: boolean; installed: boolean }) {
  const label = active ? 'Enabled' : installed ? 'Installed' : 'Available';
  return (
    <span className="inline-flex items-center rounded-full bg-[var(--bg-tertiary)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-muted)]">
      {label}
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
        <div key={id} className="h-[66px] animate-pulse rounded-[var(--radius-xl)] bg-[var(--bg-primary)]" />
      ))}
    </div>
  );
}

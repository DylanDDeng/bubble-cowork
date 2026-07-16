import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { LoaderCircle, RefreshCw } from '../icons';
import type { ProviderListPluginsResult, ProviderPluginDetail } from '../../types';
import {
  PluginDetailPage,
  PluginMarketplace,
  ScopePill,
  pluginKey,
  type PluginEntry,
} from './CodexPluginLibrary';
import { SkillsSettingsContentInner } from './SkillsSettings';

/**
 * The "Claude" tab of the skill library: Plugins (local marketplaces managed
 * by the claude CLI) and the existing Claude skills pane, mirroring the Codex
 * tab's structure.
 */
export function ClaudeLibraryContent() {
  const [tab, setTab] = useState<'plugins' | 'skills'>('plugins');
  const [refreshToken, setRefreshToken] = useState(0);
  const [pluginsLoading, setPluginsLoading] = useState(false);

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

        {tab === 'plugins' ? (
          <button
            type="button"
            onClick={() => setRefreshToken((token) => token + 1)}
            disabled={pluginsLoading}
            className="inline-flex h-8 items-center gap-2 rounded-full border border-[var(--border)] px-3 text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pluginsLoading ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            <span>Refresh</span>
          </button>
        ) : null}
      </div>

      {tab === 'plugins' ? (
        <ClaudePluginLibraryContent
          refreshToken={refreshToken}
          onLoadingChange={setPluginsLoading}
        />
      ) : (
        <SkillsSettingsContentInner embedded />
      )}
    </div>
  );
}

const EMPTY_RESULT: ProviderListPluginsResult = {
  marketplaces: [],
  marketplaceLoadErrors: [],
  remoteSyncError: null,
  featuredPluginIds: [],
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

export function ClaudePluginLibraryContent({
  refreshToken = 0,
  onLoadingChange,
}: {
  /** Incremented by the host's Refresh button to force a reload. */
  refreshToken?: number;
  onLoadingChange?: (loading: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<ProviderListPluginsResult>(EMPTY_RESULT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<ProviderPluginDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busyPluginIds, setBusyPluginIds] = useState<ReadonlySet<string>>(new Set());

  const normalizedQuery = normalizeSearchText(query);

  const entries = useMemo<PluginEntry[]>(
    () =>
      result.marketplaces.flatMap((marketplace) =>
        marketplace.plugins.map((plugin) => ({
          marketplaceName: marketplace.name,
          marketplacePath: marketplace.path,
          plugin,
        }))
      ),
    [result.marketplaces]
  );

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.plugin.id === selectedId) || null,
    [entries, selectedId]
  );

  const loadPlugins = async () => {
    setLoading(true);
    onLoadingChange?.(true);
    setError(null);
    try {
      const next = await window.electron.listClaudePlugins();
      setResult(next);
      const loadError = next.marketplaceLoadErrors[0];
      if (loadError) setError(loadError.message);
    } catch (loadFailure) {
      setResult(EMPTY_RESULT);
      setError(normalizeRemoteErrorMessage(loadFailure, 'Failed to load Claude plugins.'));
    } finally {
      setLoading(false);
      onLoadingChange?.(false);
    }
  };

  useEffect(() => {
    void loadPlugins();
  }, [refreshToken]);

  useEffect(() => {
    if (!detailOpen || !selectedEntry) {
      setDetail(null);
      return;
    }

    let cancelled = false;
    setDetailLoading(true);
    void window.electron
      .readClaudePlugin(selectedEntry.plugin.id)
      .then((response) => {
        if (!cancelled) setDetail(response.plugin);
      })
      .catch((readError) => {
        if (!cancelled) {
          setDetail(null);
          toast.error(normalizeRemoteErrorMessage(readError, 'Failed to load plugin detail.'));
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [detailOpen, selectedEntry]);

  const setBusy = (pluginId: string, busy: boolean) => {
    setBusyPluginIds((current) => {
      const next = new Set(current);
      if (busy) next.add(pluginId);
      else next.delete(pluginId);
      return next;
    });
  };

  const installPlugin = async (entry: PluginEntry) => {
    const pluginId = entry.plugin.id;
    const busyKey = pluginKey(entry);
    if (busyPluginIds.has(busyKey)) return;
    setBusy(busyKey, true);
    try {
      await window.electron.installClaudePlugin(pluginId);
      toast.success(`Installed ${entry.plugin.interface?.displayName || entry.plugin.name}`);
      await loadPlugins();
    } catch (installError) {
      toast.error(normalizeRemoteErrorMessage(installError, `Failed to install ${entry.plugin.name}.`));
    } finally {
      setBusy(busyKey, false);
    }
  };

  const uninstallPlugin = async (entry: PluginEntry) => {
    const pluginId = entry.plugin.id;
    const busyKey = pluginKey(entry);
    if (busyPluginIds.has(busyKey)) return;
    setBusy(busyKey, true);
    try {
      await window.electron.uninstallClaudePlugin(pluginId);
      toast.success(`Uninstalled ${entry.plugin.interface?.displayName || entry.plugin.name}`);
      setDetailOpen(false);
      await loadPlugins();
    } catch (uninstallError) {
      toast.error(
        normalizeRemoteErrorMessage(uninstallError, `Failed to uninstall ${entry.plugin.name}.`)
      );
    } finally {
      setBusy(busyKey, false);
    }
  };

  if (detailOpen && selectedEntry) {
    return (
      <PluginDetailPage
        entry={selectedEntry}
        detail={detail}
        loading={detailLoading}
        busy={busyPluginIds.has(pluginKey(selectedEntry))}
        onBack={() => setDetailOpen(false)}
        onInstall={installPlugin}
        onUninstall={uninstallPlugin}
      />
    );
  }

  return (
    <PluginMarketplace
      entries={entries}
      featuredPluginIds={result.featuredPluginIds}
      loading={loading}
      error={error}
      query={query}
      normalizedQuery={normalizedQuery}
      scope="personal"
      busyPluginKeys={busyPluginIds}
      subtitle="Work with Claude across your favorite tools"
      showScopeFilter={false}
      onQueryChange={setQuery}
      onScopeChange={() => {}}
      onSelect={(entry) => {
        setSelectedId(entry.plugin.id);
        setDetailOpen(true);
      }}
      onInstall={installPlugin}
    />
  );
}

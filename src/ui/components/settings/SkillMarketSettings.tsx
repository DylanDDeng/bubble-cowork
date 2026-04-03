import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  Boxes,
  CheckCircle2,
  Download,
  ExternalLink,
  LoaderCircle,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { sendEvent } from '../../hooks/useIPC';
import { useAppStore } from '../../store/useAppStore';
import type { SkillMarketDetail, SkillMarketItem } from '../../types';
import { SkillsSettingsContentInner } from './SkillsSettings';

const DEFAULT_HOT_LIMIT = 60;
const DEFAULT_SEARCH_LIMIT = 80;
const SEARCH_DEBOUNCE_MS = 250;
const NARROW_MARKET_BREAKPOINT = 860;
const MEDIUM_MARKET_BREAKPOINT = 1180;
const SKILLS_MIN_WINDOW_WIDTH = 900;
const DEFAULT_MIN_WINDOW_WIDTH = 800;
const DEFAULT_MIN_WINDOW_HEIGHT = 600;

function normalizeRemoteErrorMessage(error: unknown, fallback: string): string {
  const rawMessage = error instanceof Error ? error.message : fallback;
  return rawMessage.replace(/^Error invoking remote method '[^']+':\s*/, '').trim();
}

async function setWindowMinSizeSafely(width: number, height: number): Promise<void> {
  try {
    await window.electron.setWindowMinSize(width, height);
  } catch (error) {
    const message = normalizeRemoteErrorMessage(error, 'Failed to set window minimum size.');
    if (message.includes("No handler registered for 'set-window-min-size'")) {
      return;
    }
    console.warn('[Skills] Failed to set window minimum size:', error);
  }
}

export function SkillMarketSettingsContent() {
  const {
    activeSessionId,
    sessions,
    claudeUserSkills,
    claudeProjectSkills,
  } = useAppStore();
  const [view, setView] = useState<'skills' | 'market'>('market');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<SkillMarketItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillMarketDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installOutput, setInstallOutput] = useState<string | null>(null);
  const [windowWidth, setWindowWidth] = useState(() =>
    typeof window === 'undefined' ? 1280 : window.innerWidth
  );
  const [narrowPane, setNarrowPane] = useState<'list' | 'detail'>('list');

  const currentProjectPath = activeSessionId ? sessions[activeSessionId]?.cwd : undefined;
  const installedSkillNames = useMemo(
    () =>
      new Set([
        ...claudeUserSkills.map((skill) => skill.name),
        ...claudeProjectSkills.map((skill) => skill.name),
      ]),
    [claudeProjectSkills, claudeUserSkills]
  );
  const trimmedQuery = query.trim();
  const marketLayout =
    windowWidth < NARROW_MARKET_BREAKPOINT
      ? 'narrow'
      : windowWidth < MEDIUM_MARKET_BREAKPOINT
        ? 'medium'
        : 'wide';

  useEffect(() => {
    void setWindowMinSizeSafely(SKILLS_MIN_WINDOW_WIDTH, DEFAULT_MIN_WINDOW_HEIGHT);
    return () => {
      void setWindowMinSizeSafely(DEFAULT_MIN_WINDOW_WIDTH, DEFAULT_MIN_WINDOW_HEIGHT);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        const nextItems = trimmedQuery
          ? await window.electron.searchSkillMarket(trimmedQuery, DEFAULT_SEARCH_LIMIT)
          : await window.electron.getSkillMarketHot(DEFAULT_HOT_LIMIT);
        if (cancelled) {
          return;
        }

        setItems(nextItems);
        setSelectedId((current) => {
          if (current && nextItems.some((item) => item.id === current)) {
            return current;
          }
          return nextItems[0]?.id || null;
        });
      } catch (nextError) {
        if (!cancelled) {
          setItems([]);
          setError(normalizeRemoteErrorMessage(nextError, 'Failed to load skills.'));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    const timer = window.setTimeout(load, trimmedQuery ? SEARCH_DEBOUNCE_MS : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [trimmedQuery]);

  useEffect(() => {
    if (view !== 'market') {
      return;
    }

    const updateWindowWidth = () => setWindowWidth(window.innerWidth);
    updateWindowWidth();
    window.addEventListener('resize', updateWindowWidth);
    return () => {
      window.removeEventListener('resize', updateWindowWidth);
    };
  }, [view]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }

    let cancelled = false;
    const loadDetail = async () => {
      setDetailLoading(true);
      try {
        const nextDetail = await window.electron.getSkillMarketDetail(selectedId);
        if (!cancelled) {
          setDetail(nextDetail);
        }
      } catch (nextError) {
        if (!cancelled) {
          setDetail(null);
          toast.error(normalizeRemoteErrorMessage(nextError, 'Failed to load skill detail.'));
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
  }, [selectedId]);

  useEffect(() => {
    if (view === 'market') {
      setNarrowPane('list');
    }
  }, [trimmedQuery, view]);

  const handleInstall = async (item: SkillMarketItem) => {
    setInstallingId(item.id);
    setInstallOutput(null);

    try {
      const result = await window.electron.installSkillFromMarket(item.id);
      setInstallOutput(result.output || null);
      if (!result.ok) {
        toast.error(result.message || 'Skill install failed.');
        return;
      }

      toast.success(`Installed ${item.name}`);
      sendEvent({
        type: 'skills.list',
        payload: { projectPath: currentProjectPath },
      });
    } catch (nextError) {
      toast.error(normalizeRemoteErrorMessage(nextError, 'Skill install failed.'));
    } finally {
      setInstallingId((current) => (current === item.id ? null : current));
    }
  };

  const handleSelectItem = (itemId: string) => {
    setSelectedId(itemId);
    if (marketLayout === 'narrow') {
      setNarrowPane('detail');
    }
  };

  const listPane = (
    <MarketListPane
      query={query}
      trimmedQuery={trimmedQuery}
      items={items}
      error={error}
      loading={loading}
      installedSkillNames={installedSkillNames}
      selectedId={selectedId}
      onQueryChange={setQuery}
      onClearQuery={() => setQuery('')}
      onSelectItem={handleSelectItem}
    />
  );

  const detailPane = (
    <MarketDetailPane
      detail={detail}
      detailLoading={detailLoading}
      installedSkillNames={installedSkillNames}
      installingId={installingId}
      installOutput={installOutput}
      onInstall={handleInstall}
    />
  );

  return (
    <div className="space-y-4 pb-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="text-[28px] font-semibold tracking-[-0.03em] text-[var(--text-primary)]">
            Skills
          </div>
          <button
            type="button"
            onClick={() => setView('skills')}
            className={`rounded-lg border px-3 py-1.5 text-[15px] transition-colors ${
              view === 'skills'
                ? 'border-[var(--border)] bg-[var(--bg-secondary)] font-medium text-[var(--text-primary)]'
                : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
            }`}
          >
            My Skills
          </button>
          <button
            type="button"
            onClick={() => setView('market')}
            className={`rounded-lg border px-3 py-1.5 text-[15px] transition-colors ${
              view === 'market'
                ? 'border-[var(--border)] bg-[var(--bg-secondary)] font-medium text-[var(--text-primary)]'
                : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
            }`}
          >
            Marketplace
          </button>
        </div>

        <div className="flex items-center gap-2 text-[13px] text-[var(--text-muted)]">
          <Sparkles className="h-3.5 w-3.5" />
          <span>
            {view === 'market'
              ? 'Install skills from skills.sh without leaving the app.'
              : 'Browse installed user and project skills in one place.'}
          </span>
        </div>
      </div>

      {view === 'skills' ? (
        <SkillsSettingsContentInner embedded />
      ) : (
        marketLayout === 'narrow' ? (
          narrowPane === 'detail' && selectedId ? (
            <MarketDetailPane
              detail={detail}
              detailLoading={detailLoading}
              installedSkillNames={installedSkillNames}
              installingId={installingId}
              installOutput={installOutput}
              onInstall={handleInstall}
              backAction={
                <button
                  type="button"
                  onClick={() => setNarrowPane('list')}
                  className="inline-flex items-center gap-1.5 rounded-[var(--radius-xl)] border border-[var(--border)] px-3 py-1.5 text-[13px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  <span>Back to results</span>
                </button>
              }
              className="min-h-[calc(100vh-180px)]"
            />
          ) : (
            <div className="space-y-3">
              {selectedId && (
                <div className="flex items-center justify-between rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-3 text-[13px] text-[var(--text-secondary)]">
                  <span>Browse results, then open a skill detail.</span>
                  {detail && (
                    <button
                      type="button"
                      onClick={() => setNarrowPane('detail')}
                      className="inline-flex items-center gap-1.5 rounded-[var(--radius-xl)] bg-[var(--accent)] px-3 py-1.5 font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)]"
                    >
                      <span>Open detail</span>
                    </button>
                  )}
                </div>
              )}
              <MarketListPane
                query={query}
                trimmedQuery={trimmedQuery}
                items={items}
                error={error}
                loading={loading}
                installedSkillNames={installedSkillNames}
                selectedId={selectedId}
                onQueryChange={setQuery}
                onClearQuery={() => setQuery('')}
                onSelectItem={handleSelectItem}
                className="min-h-[calc(100vh-240px)]"
              />
            </div>
          )
        ) : (
          <div
            className={`grid min-h-[calc(100vh-180px)] gap-4 ${
              marketLayout === 'wide'
                ? 'grid-cols-[280px_minmax(0,1fr)]'
                : 'grid-cols-[236px_minmax(0,1fr)]'
            }`}
          >
            {listPane}
            {detailPane}
          </div>
        )
      )}
    </div>
  );
}

function MarketListPane({
  query,
  trimmedQuery,
  items,
  error,
  loading,
  installedSkillNames,
  selectedId,
  onQueryChange,
  onClearQuery,
  onSelectItem,
  className = 'min-h-[720px]',
}: {
  query: string;
  trimmedQuery: string;
  items: SkillMarketItem[];
  error: string | null;
  loading: boolean;
  installedSkillNames: Set<string>;
  selectedId: string | null;
  onQueryChange: (value: string) => void;
  onClearQuery: () => void;
  onSelectItem: (itemId: string) => void;
  className?: string;
}) {
  return (
    <section className={`flex flex-col overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--bg-secondary)] ${className}`}>
      <div className="border-b border-[var(--border)] p-3">
        <div className="relative">
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]">
            <Search className="h-3.5 w-3.5" />
          </div>
          <input
            type="text"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search Skills.sh..."
            className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] pl-9 pr-9 text-[14px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--border)]"
          />
          {trimmedQuery && (
            <button
              type="button"
              onClick={onClearQuery}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
              aria-label="Clear market search"
              title="Clear"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {error ? (
          <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--bg-primary)] p-4 text-[14px] text-[var(--error)]">
            {error}
          </div>
        ) : loading ? (
          <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-4 text-[14px] text-[var(--text-secondary)]">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            <span>Loading skills…</span>
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--bg-primary)] p-4 text-[14px] text-[var(--text-muted)]">
            {trimmedQuery ? 'No skills matched this search.' : 'No skills available right now.'}
          </div>
        ) : (
          <div className="space-y-1.5">
            {items.map((item) => (
              <MarketListItem
                key={item.id}
                item={item}
                installed={installedSkillNames.has(item.skillId)}
                selected={selectedId === item.id}
                onSelect={() => onSelectItem(item.id)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function MarketDetailPane({
  detail,
  detailLoading,
  installedSkillNames,
  installingId,
  installOutput,
  onInstall,
  backAction,
  className = 'min-h-[720px]',
}: {
  detail: SkillMarketDetail | null;
  detailLoading: boolean;
  installedSkillNames: Set<string>;
  installingId: string | null;
  installOutput: string | null;
  onInstall: (item: SkillMarketItem) => Promise<void>;
  backAction?: ReactNode;
  className?: string;
}) {
  return (
    <aside className={`flex flex-col overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--bg-secondary)] ${className}`}>
      {detailLoading ? (
        <div className="flex flex-1 items-center justify-center gap-2 p-6 text-[14px] text-[var(--text-secondary)]">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          <span>Loading skill details…</span>
        </div>
      ) : detail ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--border)] px-6 py-5">
            <div className="min-w-0 flex-1 space-y-3">
              {backAction}
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Boxes className="h-4 w-4 text-[var(--text-secondary)]" />
                  <div className="truncate text-[30px] font-semibold tracking-[-0.03em] text-[var(--text-primary)]">
                    {detail.name}
                  </div>
                  {installedSkillNames.has(detail.skillId) && (
                    <span className="inline-flex items-center gap-1 rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--accent-light)] px-2 py-0.5 text-[11px] font-medium text-[var(--accent)]">
                      <CheckCircle2 className="h-3 w-3" />
                      <span>Installed</span>
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[14px] text-[var(--text-muted)]">
                  <span>{detail.source}</span>
                  <a
                    href={detail.repoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 transition-colors hover:text-[var(--text-primary)]"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    <span>Repo</span>
                  </a>
                  {detail.weeklyInstallsLabel && <span>{detail.weeklyInstallsLabel}</span>}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void onInstall(detail)}
                disabled={installingId === detail.id}
                className="inline-flex items-center gap-2 rounded-[var(--radius-xl)] bg-[var(--accent)] px-4 py-2 text-[14px] font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {installingId === detail.id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                <span>{installingId === detail.id ? 'Installing…' : 'Install'}</span>
              </button>
              <a
                href={detail.detailUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-[var(--radius-xl)] border border-[var(--border)] px-3 py-2 text-[14px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
              >
                <ExternalLink className="h-4 w-4" />
                <span>Open</span>
              </a>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <div className="space-y-6">
              <section className="space-y-3">
                <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
                  Overview
                </div>
                <p className="text-[16px] leading-8 text-[var(--text-primary)]">
                  {detail.description}
                </p>
              </section>

              <section className="space-y-3">
                <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
                  Install
                </div>
                <div className="rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] p-4">
                  <code className="block break-words font-mono text-[13px] leading-6 text-[var(--text-primary)]">
                    {detail.installCommand}
                  </code>
                </div>
              </section>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <DetailPanelCard label="Repo" value={detail.repo} />
                <DetailPanelCard
                  label="Weekly installs"
                  value={detail.weeklyInstallsLabel || formatInstallCount(detail.installs)}
                />
              </div>

              {detail.originalSource && detail.originalSource !== detail.source && (
                <div className="text-[14px] text-[var(--text-secondary)]">
                  Originally from <span className="font-medium text-[var(--text-primary)]">{detail.originalSource}</span>
                </div>
              )}

              {detail.securityAudits && detail.securityAudits.length > 0 && (
                <section className="space-y-3">
                  <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    <span>Security audits</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {detail.securityAudits.map((audit) => (
                      <span
                        key={`${audit.name}-${audit.status}`}
                        className="rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 py-1 text-xs text-[var(--text-secondary)]"
                      >
                        {audit.name}: {audit.status}
                      </span>
                    ))}
                  </div>
                </section>
              )}

              {installOutput && installingId !== detail.id && (
                <section className="space-y-3">
                  <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
                    Last install output
                  </div>
                  <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] p-4 font-mono text-[13px] text-[var(--text-secondary)]">
                    {installOutput}
                  </pre>
                </section>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center p-6 text-[14px] leading-7 text-[var(--text-muted)]">
          Select a skill to inspect its description, install command, and repository details.
        </div>
      )}
    </aside>
  );
}

function MarketListItem({
  item,
  installed,
  selected,
  onSelect,
}: {
  item: SkillMarketItem;
  installed: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-start gap-3 rounded-[var(--radius-xl)] border px-3 py-3 text-left transition-colors ${
        selected
          ? 'border-[var(--sidebar-item-border)] bg-[var(--sidebar-item-active)]'
          : 'border-transparent hover:bg-[var(--sidebar-item-hover)]'
      }`}
    >
      <div className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[var(--radius-xl)] bg-[var(--bg-primary)] text-[var(--text-secondary)]">
        <Boxes className="h-4 w-4" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="truncate text-[15px] font-semibold text-[var(--text-primary)]">{item.name}</div>
          {installed && (
            <span className="inline-flex items-center gap-1 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--accent-light)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)]">
              <CheckCircle2 className="h-3 w-3" />
              <span>Installed</span>
            </span>
          )}
        </div>
        <div className="truncate text-[13px] text-[var(--text-muted)]">{item.source}</div>
        <div className="mt-1 text-[13px] text-[var(--text-secondary)]">
          {formatInstallCount(item.installs)}
          {typeof item.change === 'number' && item.change > 0 ? ` · +${item.change} hot` : ''}
        </div>
      </div>
    </button>
  );
}

function DetailPanelCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] p-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--text-muted)]">
        {label}
      </div>
      <div className="mt-2 break-words text-[15px] font-medium text-[var(--text-primary)]">{value}</div>
    </div>
  );
}

function formatInstallCount(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K installs`;
  }

  return `${value} installs`;
}

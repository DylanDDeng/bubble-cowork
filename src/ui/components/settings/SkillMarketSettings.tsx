import { useEffect, useMemo, useState, type ReactNode } from 'react';
import * as Dialog from '@/ui/components/ui/dialog';
import {
  CheckCircle2,
  Download,
  ExternalLink,
  LoaderCircle,
  Search,
  ShieldCheck,
  X,
} from '../icons';
import { toast } from 'sonner';
import { sendEvent } from '../../hooks/useIPC';
import { useAppStore } from '../../store/useAppStore';
import type { SkillMarketDetail, SkillMarketItem } from '../../types';
import { CodexPluginLibraryContent, SkillTile } from './CodexPluginLibrary';
import { ClaudeLibraryContent } from './ClaudePluginLibrary';
import { OpenCodeSkillLibraryContent } from './OpenCodeSkillLibrary';
import { KimiSkillLibraryContent } from './KimiSkillLibrary';
import { QoderSkillLibraryContent } from './QoderSkillLibrary';

const DEFAULT_HOT_LIMIT = 60;
const DEFAULT_SEARCH_LIMIT = 80;
const SEARCH_DEBOUNCE_MS = 250;
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
  const [view, setView] = useState<'skills' | 'market' | 'codex' | 'opencode' | 'kimi' | 'qoder'>('skills');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<SkillMarketItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<SkillMarketDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installOutput, setInstallOutput] = useState<string | null>(null);

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
        setSelectedId((current) => current && nextItems.some((item) => item.id === current) ? current : null);
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
    if (!selectedId || !detailOpen) {
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
  }, [detailOpen, selectedId]);

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
    setDetailOpen(true);
  };

  const getTopTabClassName = (targetView: typeof view) =>
    `border-b-2 px-0 pb-2 pt-1 text-[15px] transition-colors ${
      view === targetView
        ? 'border-[var(--text-primary)] font-medium text-[var(--text-primary)]'
        : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
    }`;

  return (
    <div className="space-y-4 pb-6">
      <div className="space-y-3">
        <div className="text-[28px] font-semibold tracking-[-0.03em] text-[var(--text-primary)]">
          Skills
        </div>

        <div className="border-b border-[var(--border)]">
          <div className="-mb-px flex items-center gap-7" role="tablist" aria-label="Skill library views">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'market'}
              onClick={() => setView('market')}
              className={getTopTabClassName('market')}
            >
              Marketplace
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'skills'}
              onClick={() => setView('skills')}
              className={getTopTabClassName('skills')}
            >
              Claude
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'codex'}
              onClick={() => setView('codex')}
              className={getTopTabClassName('codex')}
            >
              Codex
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'opencode'}
              onClick={() => setView('opencode')}
              className={getTopTabClassName('opencode')}
            >
              OpenCode
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'kimi'}
              onClick={() => setView('kimi')}
              className={getTopTabClassName('kimi')}
            >
              Kimi
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'qoder'}
              onClick={() => setView('qoder')}
              className={getTopTabClassName('qoder')}
            >
              Qoder
            </button>
          </div>
        </div>
      </div>

      {view === 'skills' ? (
        <ClaudeLibraryContent />
      ) : view === 'codex' ? (
        <CodexPluginLibraryContent />
      ) : view === 'opencode' ? (
        <OpenCodeSkillLibraryContent />
      ) : view === 'kimi' ? (
        <KimiSkillLibraryContent />
      ) : view === 'qoder' ? (
        <QoderSkillLibraryContent />
      ) : (
        <>
          <MarketCardGrid
            query={query}
            trimmedQuery={trimmedQuery}
            items={items}
            error={error}
            loading={loading}
            installedSkillNames={installedSkillNames}
            onQueryChange={setQuery}
            onClearQuery={() => setQuery('')}
            onSelectItem={handleSelectItem}
          />
          <MarketDetailDialog
            open={detailOpen}
            onOpenChange={setDetailOpen}
            detail={detail}
            detailLoading={detailLoading}
            installedSkillNames={installedSkillNames}
            installingId={installingId}
            installOutput={installOutput}
            onInstall={handleInstall}
          />
        </>
      )}
    </div>
  );
}

function MarketCardGrid({
  query,
  trimmedQuery,
  items,
  error,
  loading,
  installedSkillNames,
  onQueryChange,
  onClearQuery,
  onSelectItem,
}: {
  query: string;
  trimmedQuery: string;
  items: SkillMarketItem[];
  error: string | null;
  loading: boolean;
  installedSkillNames: Set<string>;
  onQueryChange: (value: string) => void;
  onClearQuery: () => void;
  onSelectItem: (itemId: string) => void;
}) {
  return (
    <section className="min-h-[calc(100vh-220px)] space-y-4">
      <div className="flex w-full max-w-[520px] items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            type="text"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search Skills.sh..."
            className="h-10 w-full rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] pl-9 pr-9 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--border)]"
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

      {error ? (
        <div className="rounded-[var(--radius-xl)] border border-dashed border-[var(--border)] bg-[var(--bg-secondary)] p-4 text-[14px] text-[var(--error)]">
          {error}
        </div>
      ) : loading ? (
        <div className="flex items-center gap-2 rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-4 text-[14px] text-[var(--text-secondary)]">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          <span>Loading skills...</span>
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-[var(--radius-xl)] border border-dashed border-[var(--border)] bg-[var(--bg-secondary)] p-4 text-[14px] text-[var(--text-muted)]">
          {trimmedQuery ? 'No skills matched this search.' : 'No skills available right now.'}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2 2xl:grid-cols-3">
          {items.map((item) => (
            <MarketSkillCard
              key={item.id}
              item={item}
              installed={installedSkillNames.has(item.skillId)}
              onSelect={() => onSelectItem(item.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function MarketDetailDialog({
  open,
  onOpenChange,
  detail,
  detailLoading,
  installedSkillNames,
  installingId,
  installOutput,
  onInstall,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: SkillMarketDetail | null;
  detailLoading: boolean;
  installedSkillNames: Set<string>;
  installingId: string | null;
  installOutput: string | null;
  onInstall: (item: SkillMarketItem) => Promise<void>;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/35 backdrop-blur-[2px]" />
        {/* Same shell as the provider skill dialogs (see SkillsSettings). */}
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[81] flex max-h-[86vh] w-[min(860px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[22px] border border-[var(--border)] bg-[var(--bg-secondary)] shadow-[0_24px_80px_rgba(0,0,0,0.22)]">
          <MarketDetailContent
            detail={detail}
            detailLoading={detailLoading}
            installedSkillNames={installedSkillNames}
            installingId={installingId}
            installOutput={installOutput}
            onInstall={onInstall}
            onClose={() => onOpenChange(false)}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function MarketDetailContent({
  detail,
  detailLoading,
  installedSkillNames,
  installingId,
  installOutput,
  onInstall,
  onClose,
}: {
  detail: SkillMarketDetail | null;
  detailLoading: boolean;
  installedSkillNames: Set<string>;
  installingId: string | null;
  installOutput: string | null;
  onInstall: (item: SkillMarketItem) => Promise<void>;
  onClose: () => void;
}) {
  if (detailLoading) {
    return (
      <div className="flex min-h-[420px] items-center justify-center gap-2 p-6 text-[14px] text-[var(--text-secondary)]">
        <LoaderCircle className="h-4 w-4 animate-spin" />
        <span>Loading skill details...</span>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex min-h-[320px] items-center justify-center p-6 text-[14px] leading-7 text-[var(--text-muted)]">
        Select a skill to inspect its description, install command, and repository details.
      </div>
    );
  }

  const installing = installingId === detail.id;
  const installed = installedSkillNames.has(detail.skillId);

  return (
    <>
      <div className="flex items-start justify-between gap-3 px-7 pt-6">
        <SkillTile name={detail.skillId || detail.name} />
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
          aria-label="Close skill detail"
          title="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-1 px-7 pb-5 pt-4">
        <h4 className="flex flex-wrap items-center gap-2 break-words text-[22px] font-semibold tracking-[-0.02em] text-[var(--text-primary)]">
          <span>
            {detail.name} <span className="font-normal text-[var(--text-muted)]">Skill</span>
          </span>
          {installed && (
            <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-secondary)]">
              <CheckCircle2 className="h-3 w-3" />
              <span>Installed</span>
            </span>
          )}
        </h4>
        {detail.description && (
          <p className="break-words text-sm leading-6 text-[var(--text-secondary)]">
            {detail.description}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-[13px] text-[var(--text-muted)]">
          <span className="truncate">{detail.source}</span>
          <span aria-hidden="true">·</span>
          <a
            href={detail.repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 transition-colors hover:text-[var(--text-primary)]"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span>Repo</span>
          </a>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-7">
        <div className="space-y-5 rounded-[16px] border border-[color-mix(in_srgb,var(--border)_75%,transparent)] bg-[var(--bg-primary)] px-6 py-5">
          <section className="space-y-2">
            <DetailSectionLabel>Install</DetailSectionLabel>
            <code className="block break-words rounded-[10px] bg-[var(--bg-secondary)] px-3.5 py-2.5 font-mono text-[12.5px] leading-6 text-[var(--text-primary)]">
              {detail.installCommand}
            </code>
          </section>

          <section className="grid grid-cols-1 gap-4 border-t border-[color-mix(in_srgb,var(--border)_60%,transparent)] pt-4 sm:grid-cols-2">
            <DetailField label="Repo" value={detail.repo} />
            <DetailField
              label="Weekly installs"
              value={detail.weeklyInstallsLabel || formatInstallCount(detail.installs)}
            />
            {detail.originalSource && detail.originalSource !== detail.source && (
              <DetailField label="Originally from" value={detail.originalSource} />
            )}
          </section>

          {detail.securityAudits && detail.securityAudits.length > 0 && (
            <section className="space-y-2 border-t border-[color-mix(in_srgb,var(--border)_60%,transparent)] pt-4">
              <DetailSectionLabel>
                <ShieldCheck className="h-3.5 w-3.5" />
                <span>Security audits</span>
              </DetailSectionLabel>
              <div className="flex flex-wrap gap-2">
                {detail.securityAudits.map((audit) => (
                  <span
                    key={`${audit.name}-${audit.status}`}
                    className="rounded-full border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1 text-xs text-[var(--text-secondary)]"
                  >
                    {audit.name}: {audit.status}
                  </span>
                ))}
              </div>
            </section>
          )}

          {installOutput && !installing && (
            <section className="space-y-2 border-t border-[color-mix(in_srgb,var(--border)_60%,transparent)] pt-4">
              <DetailSectionLabel>Last install output</DetailSectionLabel>
              <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-[10px] bg-[var(--bg-secondary)] p-3.5 font-mono text-[12.5px] text-[var(--text-secondary)]">
                {installOutput}
              </pre>
            </section>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 px-7 py-5">
        <a
          href={detail.detailUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--border)] px-3.5 text-[13px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open on Skills.sh
        </a>
        <button
          type="button"
          onClick={() => void onInstall(detail)}
          disabled={installing}
          className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--text-primary)] px-4 text-[13px] font-medium text-[var(--bg-primary)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {installing ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {installing ? 'Installing...' : installed ? 'Reinstall' : 'Install'}
        </button>
      </div>
    </>
  );
}

function DetailSectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--text-muted)]">
      {children}
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <DetailSectionLabel>{label}</DetailSectionLabel>
      <div className="break-words text-[14px] text-[var(--text-primary)]">{value}</div>
    </div>
  );
}

function MarketSkillCard({
  item,
  installed,
  onSelect,
}: {
  item: SkillMarketItem;
  installed: boolean;
  onSelect: () => void;
}) {
  return (
    <article
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      // Same internals as the provider skill rows: tile, title + source, one
      // trailing stat.
      className="flex cursor-pointer items-center gap-3 rounded-[14px] border border-[color-mix(in_srgb,var(--border)_60%,transparent)] bg-[var(--bg-secondary)] px-3 py-2.5 transition-colors hover:bg-[var(--bg-tertiary)]"
      aria-label={`Open ${item.name} skill detail`}
    >
      <SkillTile name={item.skillId || item.name} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <h5 className="truncate text-[14px] font-medium text-[var(--text-primary)]">
            {item.name}
          </h5>
          {installed && (
            <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent)]" />
          )}
        </div>
        <div className="truncate text-[13px] text-[var(--text-muted)]" title={item.source}>
          {item.source}
        </div>
      </div>
      <span className="shrink-0 text-[12px] tabular-nums text-[var(--text-muted)]">
        {formatInstallCount(item.installs)}
      </span>
    </article>
  );
}

function formatInstallCount(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K installs`;
  }

  return `${value} installs`;
}

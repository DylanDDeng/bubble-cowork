import { useEffect, useMemo, useState, type ReactNode } from 'react';
import claudeLogo from '../../assets/claude-color.svg';
import deepseekLogo from '../../assets/deepseek-color.svg';
import grokLogo from '../../assets/grok.svg';
import minimaxLogo from '../../assets/minimax-color.svg';
import moonshotLogo from '../../assets/moonshot.svg';
import openaiLogo from '../../assets/openai.svg';
import piLogo from '../../assets/pi-logo-auto.svg';
import zhipuLogo from '../../assets/zhipu-color.svg';
import { OpenCodeLogo } from '../OpenCodeLogo';
import type {
  AgentProvider,
  ClaudePlanUsageReport,
  ClaudePlanUsageWindow,
  ClaudeUsageDailyPoint,
  ClaudeUsageReport,
  CodexRateLimitReport,
  CodexRateLimitSnapshot,
  CodexRateLimitWindow,
} from '../../types';
import type { UserProfile } from '../../../shared/types';
import { useUserProfile } from '../../hooks/useUserProfile';
import { SettingsGroup } from './SettingsPrimitives';

const MODEL_COLORS = ['#315EFB', '#0F9D90', '#D97757', '#7C3AED', '#F59E0B', '#E11D48'];
const HEATMAP_LEVEL_COLORS = ['#d3e5fa', '#a8cbf6', '#6ba5ec', '#3b82d8', '#1d5fb8'];

type UsageProviderCard = {
  id: AgentProvider;
  title: string;
  logo: ReactNode;
  report: ClaudeUsageReport | null;
  loading: boolean;
  error: string | null;
};

type ProviderUsageState = {
  report: ClaudeUsageReport | null;
  loading: boolean;
  error: string | null;
};

const USAGE_PROVIDERS: Array<{ id: AgentProvider; title: string; logoSrc?: string }> = [
  { id: 'claude', title: 'Claude Code', logoSrc: claudeLogo },
  { id: 'codex', title: 'Codex CLI', logoSrc: openaiLogo },
  { id: 'opencode', title: 'OpenCode' },
  { id: 'kimi', title: 'Kimi', logoSrc: moonshotLogo },
  { id: 'grok', title: 'Grok', logoSrc: grokLogo },
  { id: 'pi', title: 'Pi', logoSrc: piLogo },
];

const INITIAL_PROVIDER_USAGE: Record<AgentProvider, ProviderUsageState> = Object.fromEntries(
  USAGE_PROVIDERS.map((provider) => [provider.id, { report: null, loading: true, error: null }])
) as Record<AgentProvider, ProviderUsageState>;

type ActivityViewMode = 'daily' | 'weekly' | 'cumulative';

export function ClaudeUsageSettingsContent() {
  const [activeProvider, setActiveProvider] = useState<AgentProvider>('claude');
  const [usageByProvider, setUsageByProvider] =
    useState<Record<AgentProvider, ProviderUsageState>>(INITIAL_PROVIDER_USAGE);
  const [codexRateLimits, setCodexRateLimits] = useState<CodexRateLimitReport | null>(null);
  const [codexRateLimitsLoading, setCodexRateLimitsLoading] = useState(true);
  const [codexRateLimitsError, setCodexRateLimitsError] = useState<string | null>(null);
  const [claudePlanUsage, setClaudePlanUsage] = useState<ClaudePlanUsageReport | null>(null);
  const [claudePlanUsageLoading, setClaudePlanUsageLoading] = useState(true);
  const [claudePlanUsageError, setClaudePlanUsageError] = useState<string | null>(null);
  const userProfile = useUserProfile();

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const results = await Promise.allSettled(
        USAGE_PROVIDERS.map((provider) => window.electron.getAgentUsageReport(provider.id, 365))
      );

      if (cancelled) {
        return;
      }

      setUsageByProvider(() => {
        const next = {} as Record<AgentProvider, ProviderUsageState>;
        USAGE_PROVIDERS.forEach((provider, index) => {
          const result = results[index];
          next[provider.id] =
            result.status === 'fulfilled'
              ? { report: result.value, loading: false, error: null }
              : {
                  report: null,
                  loading: false,
                  error: normalizeUsageLoadError(result.reason, 'get-agent-usage-report'),
                };
        });
        return next;
      });
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadRateLimits = async () => {
      setCodexRateLimitsLoading(true);
      setCodexRateLimitsError(null);

      try {
        const report = await window.electron.getCodexRateLimits();
        if (cancelled) {
          return;
        }
        setCodexRateLimits(report);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setCodexRateLimits(null);
        setCodexRateLimitsError(normalizeUsageLoadError(error, 'get-codex-rate-limits'));
      } finally {
        if (!cancelled) {
          setCodexRateLimitsLoading(false);
        }
      }
    };

    void loadRateLimits();
    const refreshTimer = window.setInterval(() => {
      void loadRateLimits();
    }, 60_000);

    return () => {
      cancelled = true;
      window.clearInterval(refreshTimer);
    };
  }, []);

  useEffect(() => {
    // The Claude probe spawns a short-lived CLI session, so only poll while
    // the Claude provider is in view (main process caches between ticks).
    if (activeProvider !== 'claude') {
      return;
    }

    let cancelled = false;

    const loadPlanUsage = async () => {
      setClaudePlanUsageLoading(true);
      setClaudePlanUsageError(null);

      try {
        const report = await window.electron.getClaudePlanUsage();
        if (cancelled) {
          return;
        }
        setClaudePlanUsage(report);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setClaudePlanUsageError(normalizeUsageLoadError(error, 'get-claude-plan-usage'));
      } finally {
        if (!cancelled) {
          setClaudePlanUsageLoading(false);
        }
      }
    };

    void loadPlanUsage();
    const refreshTimer = window.setInterval(() => {
      void loadPlanUsage();
    }, 60_000);

    return () => {
      cancelled = true;
      window.clearInterval(refreshTimer);
    };
  }, [activeProvider]);

  const providers = useMemo<UsageProviderCard[]>(
    () =>
      USAGE_PROVIDERS.map((provider) => ({
        id: provider.id,
        title: provider.title,
        logo: provider.logoSrc ? (
          <img src={provider.logoSrc} alt="" className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
        ) : (
          <OpenCodeLogo className="h-3.5 w-3.5 flex-shrink-0" />
        ),
        ...usageByProvider[provider.id],
      })),
    [usageByProvider]
  );

  const activeProviderCard = providers.find((provider) => provider.id === activeProvider) || providers[0];
  const activeReport = activeProviderCard.report;
  const estimatedCost = activeReport?.costMode === 'estimated';
  const stats = useMemo(() => (activeReport ? computeUsageStats(activeReport) : null), [activeReport]);

  return (
    <div className="space-y-8 pb-10">
      <UsageProfileHeader
        profile={userProfile}
        provider={activeProviderCard}
        providers={providers}
        onSelectProvider={setActiveProvider}
      />

      {renderUsageState(activeProviderCard) || (
        <>
          <UsageStatStrip stats={stats!} estimatedCost={estimatedCost} />

          <TokenActivitySection daily={activeReport!.daily} />

          <div className="grid grid-cols-1 gap-x-12 gap-y-8 md:grid-cols-2">
            <ActivityInsights report={activeReport!} stats={stats!} />
            <TopModels report={activeReport!} />
          </div>
        </>
      )}

      {activeProviderCard.id === 'claude' ? (
        <ClaudePlanUsagePanel
          report={claudePlanUsage}
          loading={claudePlanUsageLoading}
          error={claudePlanUsageError}
        />
      ) : null}

      {activeProviderCard.id === 'codex' ? (
        <CodexRateLimitsPanel
          report={codexRateLimits}
          loading={codexRateLimitsLoading}
          error={codexRateLimitsError}
        />
      ) : null}
    </div>
  );
}

/* ---------- Profile header ---------- */

const AVATAR_COLORS = ['#0F9D90', '#315EFB', '#D97757', '#7C3AED', '#DB2777', '#B45309', '#15803D'];

function avatarColorFor(name: string): string {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0][0]}${words[1][0]}`.toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

function UsageProfileHeader({
  profile,
  provider,
  providers,
  onSelectProvider,
}: {
  profile: UserProfile | null;
  provider: UsageProviderCard;
  providers: UsageProviderCard[];
  onSelectProvider: (id: AgentProvider) => void;
}) {
  const handle = profile?.handle ? `@${profile.handle}` : '';

  return (
    <div className="flex flex-col items-center gap-3">
      {profile ? (
        <div
          className="flex h-16 w-16 items-center justify-center rounded-full text-[22px] font-semibold text-white shadow-[0_1px_2px_rgba(15,23,42,0.1)]"
          style={{ backgroundColor: avatarColorFor(profile.displayName) }}
          aria-hidden="true"
        >
          {initialsOf(profile.displayName)}
        </div>
      ) : (
        // Neutral skeleton for the first-ever load; never flash wrong initials.
        <div className="h-16 w-16 rounded-full bg-[var(--bg-tertiary)]" aria-hidden="true" />
      )}
      <div className="text-center">
        <div className="min-h-[30px] text-[20px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
          {profile?.displayName ?? ' '}
        </div>
        <div className="mt-1 min-h-[18px] text-center text-[12.5px] text-[var(--text-muted)]">
          {handle}
        </div>
      </div>

      <div className="mt-1 flex items-center justify-center gap-2.5" role="group" aria-label="Select provider">
        {providers.map((entry) => {
          const active = entry.id === provider.id;
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => onSelectProvider(entry.id)}
              title={entry.title}
              aria-label={entry.title}
              aria-pressed={active}
              className={`flex h-9 w-9 items-center justify-center rounded-full border bg-[var(--bg-primary)] transition-all [&_img]:h-4 [&_img]:w-4 [&_svg]:h-4 [&_svg]:w-4 ${
                active
                  ? 'border-[var(--accent)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_18%,transparent)]'
                  : 'border-[var(--border)] opacity-45 grayscale hover:opacity-90 hover:grayscale-0'
              }`}
            >
              {entry.logo}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- Stat strip ---------- */

interface UsageStats {
  totalTokens: number;
  peakDayTokens: number;
  peakDayDate: string | null;
  totalCostUsd: number;
  currentStreak: number;
  longestStreak: number;
  activeDays: number;
}

function computeUsageStats(report: ClaudeUsageReport): UsageStats {
  const daily = report.daily;
  let dailyTotalTokens = 0;
  let peakDayTokens = 0;
  let peakDayDate: string | null = null;
  let activeDays = 0;
  let longestStreak = 0;
  let runningStreak = 0;

  for (const point of daily) {
    dailyTotalTokens += point.totalTokens;
    if (point.totalTokens > peakDayTokens) {
      peakDayTokens = point.totalTokens;
      peakDayDate = point.date;
    }
    if (point.totalTokens > 0) {
      activeDays += 1;
      runningStreak += 1;
      longestStreak = Math.max(longestStreak, runningStreak);
    } else {
      runningStreak = 0;
    }
  }

  // Current streak counts back from the last day; an empty "today" doesn't
  // break a streak that is still alive as of yesterday.
  let currentStreak = 0;
  let index = daily.length - 1;
  if (index >= 0 && daily[index].totalTokens <= 0) {
    index -= 1;
  }
  while (index >= 0 && daily[index].totalTokens > 0) {
    currentStreak += 1;
    index -= 1;
  }

  return {
    // Sum of the daily series so the strip, heatmap, and cumulative views all
    // agree; report.totals counts from a different source (result.usage).
    totalTokens: dailyTotalTokens,
    peakDayTokens,
    peakDayDate,
    totalCostUsd: report.totals.totalCostUsd,
    currentStreak,
    longestStreak,
    activeDays,
  };
}

function UsageStatStrip({ stats, estimatedCost }: { stats: UsageStats; estimatedCost: boolean }) {
  const cells = [
    { value: formatCompactNumber(stats.totalTokens), label: 'Total tokens' },
    { value: formatCompactNumber(stats.peakDayTokens), label: 'Peak day tokens' },
    { value: formatCurrency(stats.totalCostUsd, estimatedCost), label: 'Total cost' },
    { value: `${stats.currentStreak}d`, label: 'Current streak' },
    { value: `${stats.longestStreak}d`, label: 'Longest streak' },
  ];

  return (
    <div className="grid grid-cols-2 overflow-hidden rounded-2xl border border-[var(--border)] sm:grid-cols-3 lg:grid-cols-5 lg:divide-x lg:divide-[var(--border)]">
      {cells.map((cell) => (
        <div key={cell.label} className="px-4 py-4 text-center">
          <div className="text-[17px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
            {cell.value}
          </div>
          <div className="mt-1 text-[12px] text-[var(--text-muted)]">{cell.label}</div>
        </div>
      ))}
    </div>
  );
}

/* ---------- Token activity ---------- */

function TokenActivitySection({ daily }: { daily: ClaudeUsageDailyPoint[] }) {
  const [mode, setMode] = useState<ActivityViewMode>('daily');

  return (
    <div>
      <div className="flex items-center justify-between">
        <div className="text-[13.5px] font-semibold text-[var(--text-primary)]">Token activity</div>
        <div className="flex items-center gap-4 text-[12.5px]">
          {(
            [
              ['daily', 'Daily'],
              ['weekly', 'Weekly'],
              ['cumulative', 'Cumulative'],
            ] as Array<[ActivityViewMode, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              className={`transition-colors ${
                mode === value
                  ? 'font-medium text-[var(--text-primary)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4">
        <ActivityHeatmap daily={daily} mode={mode} />
      </div>
    </div>
  );
}

function quantileThresholds(values: number[]): number[] {
  const sorted = values.filter((value) => value > 0).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return [0, 0, 0, 0];
  }
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return [pick(0.2), pick(0.4), pick(0.6), pick(0.8)];
}

function heatLevel(value: number, thresholds: number[]): number {
  if (value <= 0) return 0;
  if (value <= thresholds[0]) return 1;
  if (value <= thresholds[1]) return 2;
  if (value <= thresholds[2]) return 3;
  if (value <= thresholds[3]) return 4;
  return 5;
}

function heatFill(level: number): string {
  return level === 0 ? 'var(--bg-tertiary)' : HEATMAP_LEVEL_COLORS[level - 1];
}

function parseDateKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface HeatmapTip {
  /** Cell anchor position as percentages of the svg box. */
  xPct: number;
  yPct: number;
  title: string;
  detail: string;
}

function HeatmapHoverTip({ tip }: { tip: HeatmapTip | null }) {
  if (!tip) return null;
  const transform =
    tip.xPct < 12
      ? 'translate(0, -100%)'
      : tip.xPct > 88
        ? 'translate(-100%, -100%)'
        : 'translate(-50%, -100%)';

  return (
    <div
      className="pointer-events-none absolute z-10 whitespace-nowrap rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-[11px] leading-4 shadow-[0_10px_28px_rgba(15,23,42,0.14)]"
      style={{ left: `${tip.xPct}%`, top: `${tip.yPct}%`, transform, marginTop: '-7px' }}
    >
      <div className="font-medium text-[var(--text-primary)]">{tip.title}</div>
      <div className="text-[var(--text-muted)]">{tip.detail}</div>
    </div>
  );
}

function formatTokenDetail(tokens: number): string {
  return tokens > 0 ? `${tokens.toLocaleString('en-US')} tokens` : 'No tokens';
}

function ActivityHeatmap({ daily, mode }: { daily: ClaudeUsageDailyPoint[]; mode: ActivityViewMode }) {
  const cell = 10;
  const gap = 3;
  const pitch = cell + gap;
  const labelBand = 20;

  const { weeks, monthLabels, weekSums, weekStartDates, cumulativeByDate } = useMemo(() => {
    const firstWeekday = daily.length > 0 ? parseDateKey(daily[0].date).getDay() : 0;
    const weekCount = Math.ceil((firstWeekday + daily.length) / 7);
    const grid: Array<Array<ClaudeUsageDailyPoint | null>> = Array.from({ length: weekCount }, () =>
      Array.from({ length: 7 }, () => null)
    );
    const weekSums: number[] = Array.from({ length: weekCount }, () => 0);
    const weekStartDates: Array<string | null> = Array.from({ length: weekCount }, () => null);
    const cumulativeByDate = new Map<string, number>();
    let running = 0;
    daily.forEach((point, index) => {
      const slot = firstWeekday + index;
      const weekIndex = Math.floor(slot / 7);
      grid[weekIndex][slot % 7] = point;
      weekSums[weekIndex] += point.totalTokens;
      if (!weekStartDates[weekIndex]) {
        weekStartDates[weekIndex] = point.date;
      }
      running += point.totalTokens;
      cumulativeByDate.set(point.date, running);
    });

    const labels: Array<{ week: number; label: string }> = [];
    let lastMonth = -1;
    grid.forEach((week, weekIndex) => {
      const firstPoint = week.find((point) => point !== null);
      if (!firstPoint) return;
      const month = parseDateKey(firstPoint.date).getMonth();
      if (month !== lastMonth) {
        const lastLabel = labels[labels.length - 1];
        if (!lastLabel || weekIndex - lastLabel.week >= 3) {
          labels.push({ week: weekIndex, label: MONTH_LABELS[month] });
        }
        lastMonth = month;
      }
    });

    return { weeks: grid, monthLabels: labels, weekSums, weekStartDates, cumulativeByDate };
  }, [daily]);

  // Same calendar grid in every mode; only the value a cell encodes changes:
  // its day, its whole week, or the running total up to that day.
  const cellValue = (point: ClaudeUsageDailyPoint, weekIndex: number): number => {
    if (mode === 'weekly') return weekSums[weekIndex];
    if (mode === 'cumulative') return cumulativeByDate.get(point.date) || 0;
    return point.totalTokens;
  };

  const thresholds = useMemo(() => {
    if (mode === 'weekly') return quantileThresholds(weekSums);
    if (mode === 'cumulative') return quantileThresholds(Array.from(cumulativeByDate.values()));
    return quantileThresholds(daily.map((point) => point.totalTokens));
  }, [cumulativeByDate, daily, mode, weekSums]);

  const cellTip = (
    point: ClaudeUsageDailyPoint,
    weekIndex: number,
    dayIndex: number,
    width: number,
    height: number
  ): HeatmapTip => {
    const anchor = {
      xPct: ((weekIndex * pitch + cell / 2) / width) * 100,
      yPct: ((dayIndex * pitch) / height) * 100,
    };
    if (mode === 'weekly') {
      const start = weekStartDates[weekIndex];
      return {
        ...anchor,
        title: start ? `Week of ${formatLongDate(start)}` : 'Week',
        detail: formatTokenDetail(weekSums[weekIndex]),
      };
    }
    if (mode === 'cumulative') {
      const cumulative = cumulativeByDate.get(point.date) || 0;
      return {
        ...anchor,
        title: formatLongDate(point.date),
        detail: cumulative > 0 ? `${cumulative.toLocaleString('en-US')} tokens to date` : 'No tokens yet',
      };
    }
    return {
      ...anchor,
      title: formatLongDate(point.date),
      detail: formatTokenDetail(point.totalTokens),
    };
  };

  const [tip, setTip] = useState<HeatmapTip | null>(null);
  useEffect(() => {
    setTip(null);
  }, [mode]);
  const width = weeks.length * pitch - gap;
  const height = 7 * pitch - gap + labelBand;

  return (
    <div className="relative" onMouseLeave={() => setTip(null)}>
      <HeatmapHoverTip tip={tip} />
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${mode} token activity heatmap`}
      >
        {weeks.map((week, weekIndex) =>
          week.map((point, dayIndex) => {
            if (!point) return null;
            const level = heatLevel(cellValue(point, weekIndex), thresholds);
            return (
              <rect
                key={point.date}
                x={weekIndex * pitch}
                y={dayIndex * pitch}
                width={cell}
                height={cell}
                rx={2.5}
                fill={heatFill(level)}
                onMouseEnter={() => setTip(cellTip(point, weekIndex, dayIndex, width, height))}
              />
            );
          })
        )}
        {monthLabels.map((entry) => (
          <text
            key={`${entry.week}-${entry.label}`}
            x={entry.week * pitch}
            y={height - 4}
            fontSize="10"
            fill="var(--text-muted)"
          >
            {entry.label}
          </text>
        ))}
      </svg>
    </div>
  );
}
/* ---------- Insight columns ---------- */

function InsightRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <span className="text-[13px] text-[var(--text-secondary)]">{label}</span>
      <span className="text-[13px] font-medium text-[var(--text-primary)]">{value}</span>
    </div>
  );
}

function ActivityInsights({ report, stats }: { report: ClaudeUsageReport; stats: UsageStats }) {
  const topModel = report.models[0] || null;
  const modelTokenSum = report.models.reduce((sum, model) => sum + model.totalTokens, 0);
  const topModelShare =
    topModel && modelTokenSum > 0 ? Math.round((topModel.totalTokens / modelTokenSum) * 100) : 0;

  return (
    <div>
      <div className="text-[13.5px] font-semibold text-[var(--text-primary)]">Activity insights</div>
      <div className="mt-2">
        <InsightRow label="Cache hit rate" value={formatPercent(report.totals.cacheHitRate)} />
        {topModel ? (
          <InsightRow label="Most used model" value={`${shortModelName(topModel.model)} · ${topModelShare}%`} />
        ) : null}
        <InsightRow label="Sessions" value={report.totals.sessionCount.toLocaleString('en-US')} />
        <InsightRow label="Active days" value={`${stats.activeDays} / ${report.rangeDays}`} />
        <InsightRow
          label="Busiest day"
          value={stats.peakDayDate ? formatLongDate(stats.peakDayDate) : '—'}
        />
      </div>
    </div>
  );
}

function TopModels({ report }: { report: ClaudeUsageReport }) {
  const modelColors = useMemo(
    () =>
      Object.fromEntries(
        report.models.map((model, index) => [model.model, MODEL_COLORS[index % MODEL_COLORS.length]])
      ) as Record<string, string>,
    [report.models]
  );
  const top = report.models
    .filter((model) => model.totalTokens > 0 || model.totalCostUsd > 0)
    .slice(0, 5);

  return (
    <div>
      <div className="text-[13.5px] font-semibold text-[var(--text-primary)]">Top models</div>
      <div className="mt-2">
        {top.length > 0 ? (
          top.map((model) => (
            <div key={model.model} className="flex items-center justify-between gap-4 py-2.5">
              <div className="flex min-w-0 items-center gap-2.5">
                <ModelProviderLogo model={model.model} color={modelColors[model.model]} />
                <span className="truncate text-[13px] font-medium text-[var(--text-primary)]">
                  {model.model}
                </span>
              </div>
              <span className="shrink-0 text-[13px] text-[var(--text-muted)]">
                {formatCompactNumber(model.totalTokens)} tokens
              </span>
            </div>
          ))
        ) : (
          <div className="py-2.5 text-[13px] text-[var(--text-muted)]">No model activity yet.</div>
        )}
      </div>
    </div>
  );
}

function shortModelName(model: string): string {
  return model.length > 26 ? `${model.slice(0, 24)}…` : model;
}

/* ---------- States ---------- */

function renderUsageState(provider: UsageProviderCard) {
  if (provider.loading && !provider.report) {
    return <InlineEmpty label="Loading usage…" />;
  }

  if (provider.error && !provider.loading) {
    return (
      <div className="px-4 py-4 text-center text-[12px] text-[var(--error)]">
        <span className="font-medium">Unable to load usage.</span> {provider.error}
      </div>
    );
  }

  if (!provider.report && !provider.loading && !provider.error) {
    return (
      <InlineEmpty
        label={
          provider.id === 'opencode'
            ? 'OpenCode usage pipeline is not wired up yet.'
            : 'No usage recorded yet.'
        }
      />
    );
  }

  if (provider.report && provider.report.totals.totalTokens <= 0) {
    return <InlineEmpty label="No usage recorded in the last year." />;
  }

  return null;
}

function InlineEmpty({ label }: { label: string }) {
  return (
    <div className="px-4 py-10 text-center text-[12px] text-[var(--text-muted)]">{label}</div>
  );
}

function normalizeUsageLoadError(error: unknown, channel: string): string {
  const rawMessage = error instanceof Error ? error.message : 'Failed to load usage.';
  return rawMessage.includes(`No handler registered for '${channel}'`)
    ? 'Usage needs an Electron restart to load the new main-process handler.'
    : rawMessage;
}

function MetricTile({
  title,
  value,
  subtitle,
}: {
  title: string;
  value: string;
  subtitle?: string;
}) {
  return (
    <div className="bg-[var(--bg-primary)] px-4 py-3">
      <div className="text-[11.5px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
        {title}
      </div>
      <div className="mt-1 text-[20px] font-semibold tracking-[-0.02em] text-[var(--text-primary)]">
        {value}
      </div>
      {subtitle ? (
        <div className="mt-0.5 truncate text-[11.5px] text-[var(--text-muted)]">{subtitle}</div>
      ) : null}
    </div>
  );
}

/* ---------- Codex limits ---------- */

function ClaudePlanUsagePanel({
  report,
  loading,
  error,
}: {
  report: ClaudePlanUsageReport | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <SettingsGroup title="Claude plan limits">
      {renderClaudePlanUsageState(report, loading, error) || (
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <img src={claudeLogo} alt="" className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                <span className="truncate text-[13px] font-medium text-[var(--text-primary)]">
                  Claude Code
                </span>
              </div>
              <div className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
                Updated {formatLocalTime(report!.fetchedAt)}
              </div>
            </div>
            {report!.subscriptionType ? (
              <span className="rounded-[6px] border border-[var(--border)] px-2 py-1 text-[11.5px] font-medium text-[var(--text-secondary)]">
                {`Claude ${formatPlanName(report!.subscriptionType)}`}
              </span>
            ) : null}
          </div>

          <div className="grid grid-cols-1 gap-px border-t border-[var(--border)] bg-[var(--border)] sm:grid-cols-2 xl:grid-cols-4">
            <CodexRateLimitWindowTile
              title="5-hour remaining"
              window={claudePlanWindowToTile(report!.fiveHour, 300)}
            />
            <CodexRateLimitWindowTile
              title="Weekly remaining"
              window={claudePlanWindowToTile(report!.sevenDay, 10_080)}
            />
            {report!.sevenDayOpus ? (
              <CodexRateLimitWindowTile
                title="Opus weekly remaining"
                window={claudePlanWindowToTile(report!.sevenDayOpus, 10_080)}
              />
            ) : null}
            {report!.sevenDaySonnet ? (
              <CodexRateLimitWindowTile
                title="Sonnet weekly remaining"
                window={claudePlanWindowToTile(report!.sevenDaySonnet, 10_080)}
              />
            ) : null}
            {report!.modelScoped.map((entry) => (
              <CodexRateLimitWindowTile
                key={entry.displayName}
                title={`${entry.displayName} weekly remaining`}
                window={claudePlanWindowToTile(entry, 10_080)}
              />
            ))}
            {report!.extraUsage?.isEnabled ? (
              <MetricTile
                title="Extra usage"
                value={
                  report!.extraUsage.utilization === null
                    ? '—'
                    : `${Math.round(report!.extraUsage.utilization)}%`
                }
                subtitle={formatClaudeExtraUsage(report!.extraUsage)}
              />
            ) : null}
          </div>
        </div>
      )}
    </SettingsGroup>
  );
}

function renderClaudePlanUsageState(
  report: ClaudePlanUsageReport | null,
  loading: boolean,
  error: string | null
) {
  if (loading && !report) {
    return <InlineEmpty label="Loading Claude plan usage…" />;
  }

  if (error && !report) {
    return (
      <div className="px-4 py-4 text-[12px] text-[var(--error)]">
        <span className="font-medium">Unable to load Claude plan usage.</span> {error}
      </div>
    );
  }

  if (!report) {
    return <InlineEmpty label="No Claude plan usage data available." />;
  }

  if (!report.rateLimitsAvailable) {
    return (
      <InlineEmpty label="Plan limits do not apply to this account (API key or third-party provider session)." />
    );
  }

  return null;
}

function claudePlanWindowToTile(
  window: ClaudePlanUsageWindow | null,
  windowDurationMins: number
): CodexRateLimitWindow | null {
  if (!window || window.utilization === null) {
    return null;
  }
  return {
    usedPercent: window.utilization,
    remainingPercent: 100 - window.utilization,
    windowDurationMins,
    resetsAt: window.resetsAt,
  };
}

function formatClaudeExtraUsage(extra: NonNullable<ClaudePlanUsageReport['extraUsage']>): string {
  const currency = extra.currency || 'USD';
  if (extra.usedCredits !== null && extra.monthlyLimit !== null) {
    return `${formatClaudeCredits(extra.usedCredits, currency)} of ${formatClaudeCredits(extra.monthlyLimit, currency)} used`;
  }
  if (extra.monthlyLimit !== null) {
    return `Monthly limit ${formatClaudeCredits(extra.monthlyLimit, currency)}`;
  }
  return 'Extra usage enabled';
}

function formatClaudeCredits(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

function CodexRateLimitsPanel({
  report,
  loading,
  error,
}: {
  report: CodexRateLimitReport | null;
  loading: boolean;
  error: string | null;
}) {
  const entries = getCodexRateLimitEntries(report);
  const mainEntry = entries.find((entry) => entry.id === 'codex') || entries[0] || null;
  const mainLimit = mainEntry?.snapshot || null;
  const extraEntries = entries.filter((entry) => entry.id !== mainEntry?.id);

  return (
    <SettingsGroup title="Codex limits">
      {renderCodexRateLimitState(report, loading, error) || (
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <img src={openaiLogo} alt="" className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                <span className="truncate text-[13px] font-medium text-[var(--text-primary)]">
                  {mainLimit ? getCodexRateLimitName(mainEntry!.id, mainLimit) : 'Codex'}
                </span>
              </div>
              <div className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
                Updated {formatLocalTime(report!.fetchedAt)}
              </div>
            </div>
            {mainLimit?.planType ? (
              <span className="rounded-[6px] border border-[var(--border)] px-2 py-1 text-[11.5px] font-medium text-[var(--text-secondary)]">
                {formatPlanName(mainLimit.planType)}
              </span>
            ) : null}
          </div>

          <div className="grid grid-cols-1 gap-px border-t border-[var(--border)] bg-[var(--border)] sm:grid-cols-2 xl:grid-cols-4">
            <CodexRateLimitWindowTile
              title={`${formatRateLimitWindowName(mainLimit?.primary, 'Primary')} remaining`}
              window={mainLimit?.primary || null}
            />
            <CodexRateLimitWindowTile
              title={`${formatRateLimitWindowName(mainLimit?.secondary, 'Secondary')} remaining`}
              window={mainLimit?.secondary || null}
            />
            <CodexCreditsTile snapshot={mainLimit} />
            <CodexRateLimitStatusTile snapshot={mainLimit} />
          </div>

          {extraEntries.length > 0 ? (
            <div className="border-t border-[var(--border)] px-4 py-3">
              <div className="mb-2 text-[11.5px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
                Additional buckets
              </div>
              <div className="divide-y divide-[var(--border)]">
                {extraEntries.map((entry) => (
                  <CodexRateLimitBucketRow key={entry.id} id={entry.id} snapshot={entry.snapshot} />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </SettingsGroup>
  );
}

function renderCodexRateLimitState(
  report: CodexRateLimitReport | null,
  loading: boolean,
  error: string | null
) {
  if (loading && !report) {
    return <InlineEmpty label="Loading Codex limits…" />;
  }

  if (error && !loading) {
    return (
      <div className="px-4 py-4 text-[12px] text-[var(--error)]">
        <span className="font-medium">Unable to load Codex limits.</span> {error}
      </div>
    );
  }

  if (!getCodexRateLimitEntries(report).length) {
    return <InlineEmpty label="No Codex limit data available." />;
  }

  return null;
}

function CodexRateLimitWindowTile({
  title,
  window,
}: {
  title: string;
  window: CodexRateLimitWindow | null;
}) {
  const remaining = window ? Math.round(window.remainingPercent) : null;
  const used = window ? Math.round(window.usedPercent) : null;

  return (
    <div className="bg-[var(--bg-primary)] px-4 py-3">
      <div className="text-[11.5px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
        {title}
      </div>
      <div className="mt-1 text-[20px] font-semibold text-[var(--text-primary)]">
        {remaining === null ? '—' : `${remaining}%`}
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
        <div
          className="h-full rounded-full bg-[#0F9D90]"
          style={{ width: `${Math.max(0, Math.min(100, remaining || 0))}%` }}
        />
      </div>
      <div className="mt-1.5 truncate text-[11.5px] text-[var(--text-muted)]">
        {window ? `${used}% used · ${formatResetLabel(window.resetsAt)}` : 'Not reported'}
      </div>
    </div>
  );
}

function CodexCreditsTile({ snapshot }: { snapshot: CodexRateLimitSnapshot | null }) {
  const credits = snapshot?.credits || null;
  const value = credits
    ? credits.unlimited
      ? 'Unlimited'
      : credits.balance || '0'
    : '—';
  const subtitle = snapshot?.planType
    ? `${formatPlanName(snapshot.planType)} plan`
    : credits
      ? credits.hasCredits
        ? 'Credits available'
        : 'No credits balance'
      : 'Not reported';

  return <MetricTile title="Credits" value={value} subtitle={subtitle} />;
}

function CodexRateLimitStatusTile({ snapshot }: { snapshot: CodexRateLimitSnapshot | null }) {
  const limited = Boolean(snapshot?.rateLimitReachedType);
  const value = limited ? 'Limited' : 'Available';
  const subtitle = snapshot?.rateLimitReachedType
    ? formatRateLimitReachedType(snapshot.rateLimitReachedType)
    : 'No limit reached';

  return <MetricTile title="Status" value={value} subtitle={subtitle} />;
}

function CodexRateLimitBucketRow({
  id,
  snapshot,
}: {
  id: string;
  snapshot: CodexRateLimitSnapshot;
}) {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-1 py-2 text-[12.5px] sm:grid-cols-[minmax(0,1.2fr)_90px_90px_130px]">
      <div className="min-w-0">
        <div className="truncate font-medium text-[var(--text-primary)]">
          {getCodexRateLimitName(id, snapshot)}
        </div>
        <div className="mt-0.5 truncate text-[11.5px] text-[var(--text-muted)]">{id}</div>
      </div>
      <div className="text-[var(--text-primary)]">
        <span className="text-[var(--text-muted)] sm:hidden">5h </span>
        {formatRemaining(snapshot.primary)}
      </div>
      <div className="text-[var(--text-primary)]">
        <span className="text-[var(--text-muted)] sm:hidden">Week </span>
        {formatRemaining(snapshot.secondary)}
      </div>
      <div className="truncate text-[var(--text-muted)]">
        {formatNearestReset(snapshot.primary, snapshot.secondary)}
      </div>
    </div>
  );
}

function getCodexRateLimitEntries(report: CodexRateLimitReport | null): Array<{
  id: string;
  snapshot: CodexRateLimitSnapshot;
}> {
  if (!report) {
    return [];
  }

  const entries = Object.entries(report.rateLimitsByLimitId).map(([id, snapshot]) => ({
    id,
    snapshot,
  }));

  if (report.rateLimits) {
    const id = report.rateLimits.limitId || 'codex';
    const existing = entries.some((entry) => entry.id === id);
    if (!existing) {
      entries.unshift({ id, snapshot: report.rateLimits });
    }
  }

  return entries.sort((left, right) => {
    if (left.id === 'codex') return -1;
    if (right.id === 'codex') return 1;
    return getCodexRateLimitName(left.id, left.snapshot).localeCompare(
      getCodexRateLimitName(right.id, right.snapshot)
    );
  });
}

function getCodexRateLimitName(id: string, snapshot: CodexRateLimitSnapshot): string {
  return snapshot.limitName || snapshot.limitId || id || 'Codex';
}

function formatRateLimitWindowName(window: CodexRateLimitWindow | null | undefined, fallback: string): string {
  const minutes = window?.windowDurationMins;
  if (!minutes) return fallback;
  if (minutes === 300) return '5-hour';
  if (minutes === 10_080) return 'Weekly';
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function formatRemaining(window: CodexRateLimitWindow | null): string {
  return window ? `${Math.round(window.remainingPercent)}%` : '—';
}

function formatNearestReset(
  primary: CodexRateLimitWindow | null,
  secondary: CodexRateLimitWindow | null
): string {
  const resets = [primary?.resetsAt, secondary?.resetsAt].filter((value): value is number =>
    typeof value === 'number' && Number.isFinite(value)
  );
  if (!resets.length) return 'No reset time';
  return formatResetLabel(Math.min(...resets));
}

function formatResetLabel(value: number | null): string {
  if (!value) return 'No reset time';
  return `Resets ${formatLocalTime(normalizeTimestampMs(value))}`;
}

function formatLocalTime(value: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }

  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function normalizeTimestampMs(value: number): number {
  return value < 10_000_000_000 ? value * 1000 : value;
}

function formatPlanName(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatRateLimitReachedType(value: string): string {
  return formatPlanName(value.replace(/_/g, ' '));
}

/* ---------- Shared formatting ---------- */

function ModelProviderLogo({
  model,
  color,
  className = 'h-4 w-4',
}: {
  model: string;
  color: string;
  className?: string;
}) {
  const logo = getProviderLogoForModel(model);

  if (!logo) {
    return (
      <span
        className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
    );
  }

  return <img src={logo} alt="" className={`${className} flex-shrink-0`} aria-hidden="true" />;
}

function getProviderLogoForModel(model: string): string | null {
  const normalized = model.trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  if (
    normalized.startsWith('gpt-') ||
    normalized.startsWith('codex') ||
    normalized === 'chatgpt' ||
    /^o[134]/.test(normalized)
  ) {
    return openaiLogo;
  }

  if (
    normalized.startsWith('claude-') ||
    normalized === 'opus' ||
    normalized === 'sonnet' ||
    normalized === 'haiku'
  ) {
    return claudeLogo;
  }

  if (normalized.startsWith('glm')) {
    return zhipuLogo;
  }

  if (normalized.startsWith('grok')) {
    return grokLogo;
  }

  if (normalized === 'pi' || normalized.startsWith('pi-') || normalized.startsWith('inflection')) {
    return piLogo;
  }

  if (normalized.startsWith('kimi')) {
    return moonshotLogo;
  }

  if (normalized.startsWith('deepseek')) {
    return deepseekLogo;
  }

  if (normalized.startsWith('minimax')) {
    return minimaxLogo;
  }

  return null;
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000_000) {
    return `${trimTrailingZero((value / 1_000_000_000).toFixed(1))}B`;
  }
  if (value >= 1_000_000) {
    return `${trimTrailingZero((value / 1_000_000).toFixed(1))}M`;
  }
  if (value >= 1_000) {
    return `${trimTrailingZero((value / 1_000).toFixed(1))}K`;
  }
  return value.toLocaleString('en-US');
}

function formatCurrency(value: number, estimated = false): string {
  if (value === 0) {
    return '$0.00';
  }

  if (value < 0.01) {
    return `${estimated ? '≈' : ''}$${value.toFixed(4)}`;
  }

  return `${estimated ? '≈' : ''}${value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatLongDate(dateKey: string): string {
  const date = parseDateKey(dateKey);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function trimTrailingZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value;
}

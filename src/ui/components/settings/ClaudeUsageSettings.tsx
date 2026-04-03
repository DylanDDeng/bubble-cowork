import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import claudeLogo from '../../assets/claude-color.svg';
import deepseekLogo from '../../assets/deepseek-color.svg';
import minimaxLogo from '../../assets/minimax-color.svg';
import moonshotLogo from '../../assets/moonshot.svg';
import openaiLogo from '../../assets/openai.svg';
import zhipuLogo from '../../assets/zhipu-color.svg';
import { OpenCodeLogo } from '../OpenCodeLogo';
import type {
  AgentProvider,
  ClaudeUsageDailyPoint,
  ClaudeUsageModelSummary,
  ClaudeUsageRangeDays,
  ClaudeUsageReport,
} from '../../types';

const RANGE_OPTIONS: ClaudeUsageRangeDays[] = [7, 30, 90];
const MODEL_COLORS = ['#315EFB', '#0F9D90', '#D97757', '#7C3AED', '#F59E0B', '#E11D48'];

export function ClaudeUsageSettingsContent() {
  const [rangeDays, setRangeDays] = useState<ClaudeUsageRangeDays>(7);
  const [activeProvider, setActiveProvider] = useState<AgentProvider>('claude');
  const [claudeReport, setClaudeReport] = useState<ClaudeUsageReport | null>(null);
  const [codexReport, setCodexReport] = useState<ClaudeUsageReport | null>(null);
  const [opencodeReport, setOpencodeReport] = useState<ClaudeUsageReport | null>(null);
  const [claudeLoading, setClaudeLoading] = useState(true);
  const [codexLoading, setCodexLoading] = useState(true);
  const [opencodeLoading, setOpencodeLoading] = useState(true);
  const [claudeError, setClaudeError] = useState<string | null>(null);
  const [codexError, setCodexError] = useState<string | null>(null);
  const [opencodeError, setOpencodeError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setClaudeLoading(true);
      setCodexLoading(true);
      setOpencodeLoading(true);
      setClaudeError(null);
      setCodexError(null);
      setOpencodeError(null);

      const [claudeResult, codexResult, opencodeResult] = await Promise.allSettled([
        window.electron.getClaudeUsageReport(rangeDays),
        window.electron.getCodexUsageReport(rangeDays),
        window.electron.getOpencodeUsageReport(rangeDays),
      ]);

      if (cancelled) {
        return;
      }

      if (claudeResult.status === 'fulfilled') {
        setClaudeReport(claudeResult.value);
      } else {
        setClaudeReport(null);
        setClaudeError(normalizeUsageLoadError(claudeResult.reason, 'get-claude-usage-report'));
      }

      if (codexResult.status === 'fulfilled') {
        setCodexReport(codexResult.value);
      } else {
        setCodexReport(null);
        setCodexError(normalizeUsageLoadError(codexResult.reason, 'get-codex-usage-report'));
      }

      if (opencodeResult.status === 'fulfilled') {
        setOpencodeReport(opencodeResult.value);
      } else {
        setOpencodeReport(null);
        setOpencodeError(normalizeUsageLoadError(opencodeResult.reason, 'get-opencode-usage-report'));
      }

      setClaudeLoading(false);
      setCodexLoading(false);
      setOpencodeLoading(false);
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [rangeDays]);

  const providers = useMemo<UsageProviderCard[]>(() => ([
    {
      id: 'claude',
      title: 'Claude Code',
      description: 'Actual token, cache, and spend data from Claude sessions started in Aegis.',
      logo: <img src={claudeLogo} alt="" className="h-5 w-5 flex-shrink-0" aria-hidden="true" />,
      report: claudeReport,
      loading: claudeLoading,
      error: claudeError,
      status: buildProviderUsageStatus(claudeReport, claudeLoading, claudeError, false),
    },
    {
      id: 'codex',
      title: 'Codex CLI ACP',
      description: 'Token usage comes from local Codex session data. Cost is estimated from a model price table and may not match ChatGPT-plan billing.',
      logo: <img src={openaiLogo} alt="" className="h-5 w-5 flex-shrink-0" aria-hidden="true" />,
      report: codexReport,
      loading: codexLoading,
      error: codexError,
      status: buildProviderUsageStatus(codexReport, codexLoading, codexError, true),
    },
    {
      id: 'opencode',
      title: 'OpenCode ACP',
      description: 'Actual token and cost data from local OpenCode sessions launched in Aegis.',
      logo: <OpenCodeLogo className="h-5 w-5 flex-shrink-0" />,
      report: opencodeReport,
      loading: opencodeLoading,
      error: opencodeError,
      status: buildProviderUsageStatus(opencodeReport, opencodeLoading, opencodeError, false),
    },
  ]), [claudeError, claudeLoading, claudeReport, codexError, codexLoading, codexReport, opencodeError, opencodeLoading, opencodeReport]);

  const activeProviderCard = providers.find((provider) => provider.id === activeProvider) || providers[0];

  return (
    <div className="pb-16">
      <div className="grid gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
        <PanelCard className="h-fit p-4">
          <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--text-muted)]">
            Providers
          </div>
          <div className="mt-4 space-y-2">
            {providers.map((provider) => (
              <UsageProviderRailItem
                key={provider.id}
                provider={provider}
                selected={provider.id === activeProviderCard.id}
                onSelect={() => setActiveProvider(provider.id)}
              />
            ))}
          </div>
        </PanelCard>

        <div className="space-y-4">
          <PanelCard className="p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="min-w-0">
                  <div className="text-xl font-semibold text-[var(--text-primary)]">{activeProviderCard.title}</div>
                  <div className="mt-1 text-sm text-[var(--text-secondary)]">{activeProviderCard.description}</div>
                </div>
                {activeProviderCard.report?.note ? (
                  <div className="mt-3 text-sm text-[var(--text-muted)]">{activeProviderCard.report.note}</div>
                ) : null}
              </div>

              <div className="flex items-center gap-2">
                {RANGE_OPTIONS.map((days) => {
                  const isActive = days === rangeDays;
                  return (
                    <button
                      key={days}
                      type="button"
                      onClick={() => setRangeDays(days)}
                      className={`rounded-[var(--radius-xl)] border px-3 py-1.5 text-sm font-medium transition-colors ${
                        isActive
                          ? 'border-[var(--border)] bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                          : 'border-transparent bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      {days}D
                    </button>
                  );
                })}
              </div>
            </div>
          </PanelCard>

          <ProviderUsageDetail provider={activeProviderCard} />
        </div>
      </div>
    </div>
  );
}

function normalizeUsageLoadError(error: unknown, channel: string): string {
  const rawMessage = error instanceof Error ? error.message : 'Failed to load usage.';
  return rawMessage.includes(`No handler registered for '${channel}'`)
    ? 'Usage needs an Electron restart to load the new main-process handler.'
    : rawMessage;
}

type UsageProviderCard = {
  id: AgentProvider;
  title: string;
  description: string;
  logo: ReactNode;
  report: ClaudeUsageReport | null;
  loading: boolean;
  error: string | null;
  status: {
    label: string;
    tone: string;
    dot: string;
    summary: string;
  };
};

function buildProviderUsageStatus(
  report: ClaudeUsageReport | null,
  loading: boolean,
  error: string | null,
  estimatedCost: boolean
) {
  if (loading) {
    return {
      label: 'Loading',
      tone: 'text-[var(--text-secondary)]',
      dot: 'bg-[var(--text-muted)]',
      summary: 'Refreshing usage data…',
    };
  }

  if (error) {
    return {
      label: 'Error',
      tone: 'text-[#b42318]',
      dot: 'bg-[#ef4444]',
      summary: 'Unable to load usage right now.',
    };
  }

  if (!report || report.totals.totalTokens <= 0) {
    return {
      label: 'Idle',
      tone: 'text-[var(--text-secondary)]',
      dot: 'bg-[var(--text-muted)]',
      summary: 'No usage recorded in this period.',
    };
  }

  return {
    label: estimatedCost ? 'Estimated' : 'Actual',
    tone: estimatedCost ? 'text-[#b54708]' : 'text-[#067647]',
    dot: estimatedCost ? 'bg-[#f59e0b]' : 'bg-[#22c55e]',
    summary: `${formatCompactNumber(report.totals.totalTokens)} tokens · ${formatCurrency(
      report.totals.totalCostUsd,
      estimatedCost
    )}`,
  };
}

function UsageProviderRailItem({
  provider,
  selected,
  onSelect,
}: {
  provider: UsageProviderCard;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`group flex w-full items-start gap-3 rounded-[var(--radius-2xl)] border px-3.5 py-3 text-left transition-colors ${
        selected
          ? 'border-[var(--sidebar-item-border)] bg-[var(--sidebar-item-active)] shadow-sm'
          : 'border-transparent bg-[var(--bg-secondary)]/92 hover:bg-[var(--bg-tertiary)]/55'
      }`}
    >
      <div className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center">
        {provider.logo}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <div className="truncate text-sm font-medium text-[var(--text-primary)]">{provider.title}</div>
          <div className="flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-full ${provider.status.dot}`} />
            <span className={`text-[11px] font-medium ${provider.status.tone}`}>{provider.status.label}</span>
          </div>
        </div>
        <div className="mt-1 line-clamp-2 text-[12px] leading-5 text-[var(--text-secondary)]">
          {provider.status.summary}
        </div>
      </div>

      <div className="flex flex-shrink-0 items-center gap-2 pt-0.5 text-[var(--text-muted)]">
        <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </div>
    </button>
  );
}

function ProviderUsageDetail({ provider }: { provider: UsageProviderCard }) {
  const modelColors = useMemo(() => {
    const entries = provider.report?.models || [];
    return Object.fromEntries(
      entries.map((model, index) => [model.model, MODEL_COLORS[index % MODEL_COLORS.length]])
    ) as Record<string, string>;
  }, [provider.report]);

  return (
    <section className="space-y-4">
      {provider.loading && !provider.report ? (
        <PanelCard className="px-5 py-10 text-sm text-[var(--text-secondary)]">
          Loading usage...
        </PanelCard>
      ) : null}

      {provider.error && !provider.loading ? (
        <PanelCard className="px-5 py-5">
          <div className="text-sm font-medium text-[var(--text-primary)]">Unable to load usage</div>
          <div className="mt-2 text-sm text-[var(--text-secondary)]">{provider.error}</div>
        </PanelCard>
      ) : null}

      {!provider.report && !provider.loading && !provider.error ? (
        <PanelCard className="px-5 py-10">
          <div className="text-base font-semibold text-[var(--text-primary)]">Usage tracking is coming soon</div>
          <div className="mt-2 max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">
            OpenCode is listed in the provider rail now, but the detailed usage pipeline is not connected yet.
            Once the local stats source is wired in, this panel will show the same metrics, charts, and model breakdown.
          </div>
        </PanelCard>
      ) : null}

      {provider.report && !provider.error ? (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              title="Total Tokens"
              value={formatCompactNumber(provider.report.totals.totalTokens)}
              subtitle={`In ${formatCompactNumber(provider.report.totals.inputTokens)}  Out ${formatCompactNumber(provider.report.totals.outputTokens)}`}
            />
            <MetricCard
              title="Total Cost"
              value={formatCurrency(provider.report.totals.totalCostUsd, provider.report.costMode === 'estimated')}
              subtitle={provider.report.models[0] ? `${provider.report.models.length} models active` : 'No usage yet'}
            />
            <MetricCard
              title="Sessions"
              value={provider.report.totals.sessionCount.toLocaleString('en-US')}
              subtitle={`${provider.report.rangeDays}-day window`}
            />
            <MetricCard
              title="Cache Hit Rate"
              value={formatPercent(provider.report.totals.cacheHitRate)}
              subtitle={`${formatCompactNumber(provider.report.totals.cacheReadTokens)} cached`}
            />
          </div>

          <PanelCard className="p-5">
            <div className="mb-5">
              <div className="text-xl font-semibold text-[var(--text-primary)]">Daily Token Usage</div>
              <div className="mt-1 text-sm text-[var(--text-secondary)]">
                Stacked daily tokens by model over the last {provider.report.rangeDays} days.
              </div>
            </div>

            {provider.report.totals.totalTokens > 0 ? (
              <UsageChart
                daily={provider.report.daily}
                models={provider.report.models}
                modelColors={modelColors}
                costEstimated={provider.report.costMode === 'estimated'}
              />
            ) : (
              <div className="rounded-[var(--radius-2xl)] border border-dashed border-[var(--border)] px-5 py-12 text-center text-sm text-[var(--text-secondary)]">
                No usage recorded in this period.
              </div>
            )}
          </PanelCard>

          {provider.report.models.length > 0 ? (
            <PanelCard className="overflow-hidden">
              <div className="border-b border-[var(--border)] px-5 py-4">
                <div className="text-xl font-semibold text-[var(--text-primary)]">Model Breakdown</div>
                <div className="mt-1 text-sm text-[var(--text-secondary)]">
                  Token, spend, session, and cache usage by model.
                </div>
              </div>

              <div className="grid grid-cols-[minmax(0,1.4fr)_1fr_120px_100px_120px] gap-4 px-5 py-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
                <div>Model</div>
                <div>Tokens</div>
                <div>Cost</div>
                <div>Sessions</div>
                <div>Cache</div>
              </div>

              {provider.report.models.map((model) => (
                <div
                  key={model.model}
                  className="grid grid-cols-[minmax(0,1.4fr)_1fr_120px_100px_120px] gap-4 border-t border-[var(--border)] px-5 py-4 text-sm"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <ModelProviderLogo model={model.model} color={modelColors[model.model]} />
                      <span className="truncate font-medium text-[var(--text-primary)]">{model.model}</span>
                    </div>
                    <div className="mt-1 text-[var(--text-secondary)]">
                      In {formatCompactNumber(model.inputTokens)}  Out {formatCompactNumber(model.outputTokens)}
                    </div>
                  </div>
                  <div className="font-medium text-[var(--text-primary)]">{formatCompactNumber(model.totalTokens)}</div>
                  <div className="font-medium text-[var(--text-primary)]">
                    {formatCurrency(model.totalCostUsd, provider.report.costMode === 'estimated')}
                  </div>
                  <div className="text-[var(--text-primary)]">{model.sessionCount.toLocaleString('en-US')}</div>
                  <div className="text-[var(--text-secondary)]">{formatCompactNumber(model.cacheReadTokens)}</div>
                </div>
              ))}
            </PanelCard>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

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

  if (normalized.startsWith('claude-') || normalized === 'opus' || normalized === 'sonnet' || normalized === 'haiku') {
    return claudeLogo;
  }

  if (normalized.startsWith('glm')) {
    return zhipuLogo;
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

function MetricCard({
  title,
  value,
  subtitle,
}: {
  title: string;
  value: string;
  subtitle: string;
}) {
  return (
    <PanelCard className="px-5 py-4">
      <div className="text-sm text-[var(--text-secondary)]">{title}</div>
      <div className="mt-3 text-[34px] font-semibold tracking-[-0.04em] text-[var(--text-primary)]">
        {value}
      </div>
      <div className="mt-2 text-sm text-[var(--text-secondary)]">{subtitle}</div>
    </PanelCard>
  );
}

function PanelCard({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--bg-secondary)] ${className}`}>
      {children}
    </div>
  );
}

function UsageChart({
  daily,
  models,
  modelColors,
  costEstimated = false,
}: {
  daily: ClaudeUsageDailyPoint[];
  models: ClaudeUsageModelSummary[];
  modelColors: Record<string, string>;
  costEstimated?: boolean;
}) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const viewBoxWidth = 960;
  const viewBoxHeight = 340;
  const marginTop = 14;
  const marginRight = 16;
  const marginBottom = 56;
  const marginLeft = 58;
  const plotWidth = viewBoxWidth - marginLeft - marginRight;
  const plotHeight = viewBoxHeight - marginTop - marginBottom;
  const maxValue = Math.max(...daily.map((entry) => entry.totalTokens), 1);
  const yMax = getNiceMax(maxValue);
  const tickCount = 4;
  const ticks = Array.from({ length: tickCount + 1 }, (_, index) => (yMax / tickCount) * index);
  const slotWidth = plotWidth / Math.max(daily.length, 1);
  const barWidth = Math.max(8, Math.min(28, slotWidth * 0.64));
  const labelStep = Math.max(1, Math.ceil(daily.length / 14));
  const modelOrder = models.map((model) => model.model);
  const hoveredPoint = hoveredIndex !== null ? daily[hoveredIndex] : null;
  const hoveredCostMap = hoveredPoint?.byModelCostUsd || {};
  const hoveredCenterX =
    hoveredIndex !== null ? marginLeft + slotWidth * hoveredIndex + slotWidth / 2 : null;
  const hoveredRows = hoveredPoint
    ? models
        .map((model) => {
          const tokens = hoveredPoint.byModel[model.model] || 0;
          const actualCostUsd = hoveredCostMap[model.model];
          const estimatedCostUsd =
            typeof actualCostUsd === 'number'
              ? actualCostUsd
              : model.totalTokens > 0 && tokens > 0
                ? (model.totalCostUsd * tokens) / model.totalTokens
                : 0;

          return {
            model: model.model,
            tokens,
            costUsd: estimatedCostUsd,
            isEstimated: costEstimated || (typeof actualCostUsd !== 'number' && estimatedCostUsd > 0),
          };
        })
        .filter((row) => row.tokens > 0 || row.costUsd > 0)
        .sort((left, right) => right.tokens - left.tokens || right.costUsd - left.costUsd)
    : [];
  const tooltipAlign =
    hoveredCenterX === null
      ? 'center'
      : hoveredCenterX < 190
        ? 'left'
        : hoveredCenterX > viewBoxWidth - 190
          ? 'right'
          : 'center';
  const tooltipTransform =
    tooltipAlign === 'left'
      ? 'translateX(0)'
      : tooltipAlign === 'right'
        ? 'translateX(-100%)'
        : 'translateX(-50%)';

  return (
    <div className="relative" onMouseLeave={() => setHoveredIndex(null)}>
      {hoveredPoint && hoveredCenterX !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 w-[240px] rounded-2xl border border-[var(--border)] bg-[var(--bg-primary)]/96 px-4 py-3 shadow-[0_18px_45px_rgba(15,23,42,0.12)] backdrop-blur"
          style={{
            left: `${(hoveredCenterX / viewBoxWidth) * 100}%`,
            transform: tooltipTransform,
          }}
        >
          <div className="text-sm font-semibold text-[var(--text-primary)]">
            {formatLongDate(hoveredPoint.date)}
          </div>
          <div className="mt-1 text-sm text-[var(--text-secondary)]">
            {formatCompactNumber(hoveredPoint.totalTokens)} total tokens
          </div>

          <div className="mt-3 space-y-2">
            {hoveredRows.length > 0 ? (
              hoveredRows.map((row) => (
                <div key={row.model} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <ModelProviderLogo
                        model={row.model}
                        color={modelColors[row.model]}
                        className="h-3.5 w-3.5"
                      />
                      <span className="truncate text-sm font-medium text-[var(--text-primary)]">
                        {row.model}
                      </span>
                    </div>
                  </div>
                  <div className="text-right text-sm text-[var(--text-secondary)]">
                    <div>{formatCompactNumber(row.tokens)}</div>
                    <div>{formatCurrency(row.costUsd, row.isEstimated)}</div>
                  </div>
                </div>
              ))
            ) : (
              <div className="text-sm text-[var(--text-secondary)]">No usage on this day.</div>
            )}
          </div>
        </div>
      )}

      <svg viewBox={`0 0 ${viewBoxWidth} ${viewBoxHeight}`} className="h-auto w-full">
        {ticks.map((tick) => {
          const y = marginTop + plotHeight - (tick / yMax) * plotHeight;
          return (
            <g key={tick}>
              <line
                x1={marginLeft}
                x2={marginLeft + plotWidth}
                y1={y}
                y2={y}
                stroke="var(--border)"
                strokeDasharray="4 6"
              />
              <text
                x={marginLeft - 10}
                y={y + 4}
                textAnchor="end"
                fontSize="12"
                fill="var(--text-secondary)"
              >
                {formatAxisTick(tick)}
              </text>
            </g>
          );
        })}

        {daily.map((entry, index) => {
          const slotX = marginLeft + slotWidth * index;
          const x = marginLeft + slotWidth * index + (slotWidth - barWidth) / 2;
          let stackedHeight = 0;
          const entryCostMap = entry.byModelCostUsd || {};
          const costOnlyModels = modelOrder.filter(
            (modelName) =>
              (entry.byModel[modelName] || 0) <= 0 && (entryCostMap[modelName] || 0) > 0
          );

          return (
            <g key={entry.date}>
              {hoveredIndex === index && (
                <rect
                  x={slotX}
                  y={marginTop}
                  width={slotWidth}
                  height={plotHeight}
                  rx="10"
                  fill="var(--bg-tertiary)"
                  opacity="0.65"
                />
              )}

              {modelOrder.map((modelName) => {
                const value = entry.byModel[modelName] || 0;
                if (value <= 0) {
                  return null;
                }

                const height = (value / yMax) * plotHeight;
                const y = marginTop + plotHeight - stackedHeight - height;
                stackedHeight += height;

                return (
                  <rect
                    key={`${entry.date}-${modelName}`}
                    x={x}
                    y={y}
                    width={barWidth}
                    height={Math.max(height, 1)}
                    fill={modelColors[modelName]}
                  />
                );
              })}

              {costOnlyModels.map((modelName, markerIndex) => {
                const markerHeight = 5;
                const markerGap = 2;
                const y =
                  marginTop +
                  plotHeight -
                  stackedHeight -
                  (markerIndex + 1) * (markerHeight + markerGap);

                return (
                  <rect
                    key={`${entry.date}-${modelName}-marker`}
                    x={x}
                    y={y}
                    width={barWidth}
                    height={markerHeight}
                    fill={modelColors[modelName]}
                    opacity="0.95"
                  />
                );
              })}

              {(index % labelStep === 0 || index === daily.length - 1) && (
                <text
                  x={x + barWidth / 2}
                  y={viewBoxHeight - 18}
                  textAnchor="middle"
                  fontSize="12"
                  fill="var(--text-secondary)"
                >
                  {formatShortDate(entry.date)}
                </text>
              )}

              <rect
                x={slotX}
                y={marginTop}
                width={slotWidth}
                height={plotHeight}
                fill="transparent"
                onMouseEnter={() => setHoveredIndex(index)}
                onMouseMove={() => setHoveredIndex(index)}
              />
            </g>
          );
        })}
      </svg>

      <div className="mt-2 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm text-[var(--text-secondary)]">
        {models.map((model) => (
          <div key={model.model} className="flex items-center gap-2">
            <ModelProviderLogo
              model={model.model}
              color={modelColors[model.model]}
              className="h-3.5 w-3.5"
            />
            <span>{model.model}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function getNiceMax(value: number): number {
  if (value <= 1000) {
    return 1000;
  }

  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;

  if (normalized <= 1) return magnitude;
  if (normalized <= 2) return 2 * magnitude;
  if (normalized <= 5) return 5 * magnitude;
  return 10 * magnitude;
}

function formatCompactNumber(value: number): string {
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

function formatAxisTick(value: number): string {
  if (value === 0) {
    return '0';
  }
  if (value >= 1000) {
    return `${trimTrailingZero((value / 1000).toFixed(1))}K`;
  }
  return value.toLocaleString('en-US');
}

function formatShortDate(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(year, (month || 1) - 1, day || 1);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function formatLongDate(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(year, (month || 1) - 1, day || 1);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function trimTrailingZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value;
}

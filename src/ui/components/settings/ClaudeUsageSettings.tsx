import { useEffect, useMemo, useState, type ReactNode } from 'react';
import claudeLogo from '../../assets/claude-color.svg';
import deepseekLogo from '../../assets/deepseek-color.svg';
import minimaxLogo from '../../assets/minimax-color.svg';
import moonshotLogo from '../../assets/moonshot.svg';
import zhipuLogo from '../../assets/zhipu-color.svg';
import type {
  ClaudeUsageDailyPoint,
  ClaudeUsageModelSummary,
  ClaudeUsageRangeDays,
  ClaudeUsageReport,
} from '../../types';

const RANGE_OPTIONS: ClaudeUsageRangeDays[] = [7, 30, 90];
const MODEL_COLORS = ['#315EFB', '#0F9D90', '#D97757', '#7C3AED', '#F59E0B', '#E11D48'];

export function ClaudeUsageSettingsContent() {
  const [rangeDays, setRangeDays] = useState<ClaudeUsageRangeDays>(7);
  const [report, setReport] = useState<ClaudeUsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const nextReport = await window.electron.getClaudeUsageReport(rangeDays);
        if (!cancelled) {
          setReport(nextReport);
        }
      } catch (loadError) {
        if (!cancelled) {
          const rawMessage = loadError instanceof Error ? loadError.message : 'Failed to load usage.';
          const message = rawMessage.includes("No handler registered for 'get-claude-usage-report'")
            ? 'Usage needs an Electron restart to load the new main-process handler.'
            : rawMessage;
          setError(message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [rangeDays]);

  const modelColors = useMemo(() => {
    const entries = report?.models || [];
    return Object.fromEntries(
      entries.map((model, index) => [model.model, MODEL_COLORS[index % MODEL_COLORS.length]])
    ) as Record<string, string>;
  }, [report]);

  return (
    <div className="space-y-8 pb-16">
      <div className="flex items-center gap-2">
        {RANGE_OPTIONS.map((days) => {
          const isActive = days === rangeDays;
          return (
            <button
              key={days}
              type="button"
              onClick={() => setRangeDays(days)}
              className={`rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
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

      {loading && !report && (
        <PanelCard className="px-5 py-10 text-sm text-[var(--text-secondary)]">
          Loading usage...
        </PanelCard>
      )}

      {error && !loading && (
        <PanelCard className="px-5 py-5">
          <div className="text-sm font-medium text-[var(--text-primary)]">Unable to load usage</div>
          <div className="mt-2 text-sm text-[var(--text-secondary)]">{error}</div>
        </PanelCard>
      )}

      {report && !error && (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              title="Total Tokens"
              value={formatCompactNumber(report.totals.totalTokens)}
              subtitle={`In ${formatCompactNumber(report.totals.inputTokens)}  Out ${formatCompactNumber(report.totals.outputTokens)}`}
            />
            <MetricCard
              title="Total Cost"
              value={formatCurrency(report.totals.totalCostUsd)}
              subtitle={report.models[0] ? `${report.models.length} models active` : 'No usage yet'}
            />
            <MetricCard
              title="Sessions"
              value={report.totals.sessionCount.toLocaleString('en-US')}
              subtitle={`${report.rangeDays}-day window`}
            />
            <MetricCard
              title="Cache Hit Rate"
              value={formatPercent(report.totals.cacheHitRate)}
              subtitle={`${formatCompactNumber(report.totals.cacheReadTokens)} cached`}
            />
          </div>

          <PanelCard className="p-5">
            <div className="mb-5">
              <div className="text-xl font-semibold text-[var(--text-primary)]">Daily Token Usage</div>
              <div className="mt-1 text-sm text-[var(--text-secondary)]">
                Stacked daily tokens by Claude model over the last {report.rangeDays} days.
              </div>
            </div>

            {report.totals.totalTokens > 0 ? (
              <UsageChart daily={report.daily} models={report.models} modelColors={modelColors} />
            ) : (
              <div className="rounded-[20px] border border-dashed border-[var(--border)] px-5 py-12 text-center text-sm text-[var(--text-secondary)]">
                No usage recorded in this period.
              </div>
            )}
          </PanelCard>

          {report.models.length > 0 && (
            <PanelCard className="overflow-hidden">
              <div className="border-b border-[var(--border)] px-5 py-4">
                <div className="text-xl font-semibold text-[var(--text-primary)]">Model Breakdown</div>
                <div className="mt-1 text-sm text-[var(--text-secondary)]">
                  Token, spend, session, and cache usage by Claude model.
                </div>
              </div>

              <div className="grid grid-cols-[minmax(0,1.4fr)_1fr_120px_100px_120px] gap-4 px-5 py-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
                <div>Model</div>
                <div>Tokens</div>
                <div>Cost</div>
                <div>Sessions</div>
                <div>Cache</div>
              </div>

              {report.models.map((model) => (
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
                  <div className="font-medium text-[var(--text-primary)]">{formatCurrency(model.totalCostUsd)}</div>
                  <div className="text-[var(--text-primary)]">{model.sessionCount.toLocaleString('en-US')}</div>
                  <div className="text-[var(--text-secondary)]">{formatCompactNumber(model.cacheReadTokens)}</div>
                </div>
              ))}
            </PanelCard>
          )}
        </>
      )}
    </div>
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
    <div className={`rounded-[24px] border border-[var(--border)] bg-[var(--bg-secondary)] ${className}`}>
      {children}
    </div>
  );
}

function UsageChart({
  daily,
  models,
  modelColors,
}: {
  daily: ClaudeUsageDailyPoint[];
  models: ClaudeUsageModelSummary[];
  modelColors: Record<string, string>;
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
            isEstimated: typeof actualCostUsd !== 'number' && estimatedCostUsd > 0,
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
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: modelColors[model.model] }}
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

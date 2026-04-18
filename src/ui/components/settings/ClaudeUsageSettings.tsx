import { useEffect, useMemo, useState, type ReactNode } from 'react';
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
import { SegmentedControl, SegmentedControlItem, SettingsGroup } from './SettingsPrimitives';

const RANGE_OPTIONS: ClaudeUsageRangeDays[] = [7, 30, 90];
const MODEL_COLORS = ['#315EFB', '#0F9D90', '#D97757', '#7C3AED', '#F59E0B', '#E11D48'];

type UsageProviderCard = {
  id: AgentProvider;
  title: string;
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

  const providers = useMemo<UsageProviderCard[]>(
    () => [
      {
        id: 'claude',
        title: 'Claude Code',
        logo: <img src={claudeLogo} alt="" className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />,
        report: claudeReport,
        loading: claudeLoading,
        error: claudeError,
        status: buildProviderUsageStatus(claudeReport, claudeLoading, claudeError, false),
      },
      {
        id: 'codex',
        title: 'Codex CLI',
        logo: <img src={openaiLogo} alt="" className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />,
        report: codexReport,
        loading: codexLoading,
        error: codexError,
        status: buildProviderUsageStatus(codexReport, codexLoading, codexError, true),
      },
      {
        id: 'opencode',
        title: 'OpenCode',
        logo: <OpenCodeLogo className="h-3.5 w-3.5 flex-shrink-0" />,
        report: opencodeReport,
        loading: opencodeLoading,
        error: opencodeError,
        status: buildProviderUsageStatus(opencodeReport, opencodeLoading, opencodeError, false),
      },
    ],
    [
      claudeError,
      claudeLoading,
      claudeReport,
      codexError,
      codexLoading,
      codexReport,
      opencodeError,
      opencodeLoading,
      opencodeReport,
    ]
  );

  const activeProviderCard = providers.find((provider) => provider.id === activeProvider) || providers[0];
  const activeReport = activeProviderCard.report;
  const showReadyState = Boolean(activeReport && !activeProviderCard.error);
  const modelColors = useMemo(() => {
    const entries = activeReport?.models || [];
    return Object.fromEntries(
      entries.map((model, index) => [model.model, MODEL_COLORS[index % MODEL_COLORS.length]])
    ) as Record<string, string>;
  }, [activeReport]);

  const estimatedCost = activeProviderCard.report?.costMode === 'estimated';

  return (
    <div className="space-y-6 pb-8">
      <SettingsGroup>
        <div className="px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <ProviderSegmentedControl
              providers={providers}
              activeId={activeProviderCard.id}
              onSelect={setActiveProvider}
            />
            <RangeSegmentedControl
              value={rangeDays}
              onChange={setRangeDays}
            />
          </div>

          {activeProviderCard.report?.note ? (
            <div className="mt-3 text-[11.5px] leading-5 text-[var(--text-muted)]">
              {activeProviderCard.report.note}
            </div>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-px border-t border-[var(--border)] bg-[var(--border)] xl:grid-cols-4">
          <MetricTile
            title="Tokens"
            value={
              activeReport
                ? formatCompactNumber(activeReport.totals.totalTokens)
                : activeProviderCard.loading
                  ? '—'
                  : '0'
            }
            subtitle={
              activeReport
                ? `In ${formatCompactNumber(activeReport.totals.inputTokens)} · Out ${formatCompactNumber(activeReport.totals.outputTokens)}`
                : undefined
            }
          />
          <MetricTile
            title="Cost"
            value={
              activeReport
                ? formatCurrency(activeReport.totals.totalCostUsd, estimatedCost)
                : activeProviderCard.loading
                  ? '—'
                  : '$0.00'
            }
            subtitle={activeReport ? (estimatedCost ? 'Estimated' : 'Actual') : undefined}
          />
          <MetricTile
            title="Sessions"
            value={
              activeReport
                ? activeReport.totals.sessionCount.toLocaleString('en-US')
                : activeProviderCard.loading
                  ? '—'
                  : '0'
            }
            subtitle={activeReport ? `${activeReport.rangeDays}d window` : undefined}
          />
          <MetricTile
            title="Cache hit"
            value={
              activeReport
                ? formatPercent(activeReport.totals.cacheHitRate)
                : activeProviderCard.loading
                  ? '—'
                  : '0%'
            }
            subtitle={
              activeReport
                ? `${formatCompactNumber(activeReport.totals.cacheReadTokens)} cached`
                : undefined
            }
          />
        </div>
      </SettingsGroup>

      <SettingsGroup title="Daily usage">
        {renderUsageState(activeProviderCard) || (
          <div className="px-4 py-4">
            {showReadyState && activeReport!.totals.totalTokens > 0 ? (
              <UsageChart
                daily={activeReport!.daily}
                models={activeReport!.models}
                modelColors={modelColors}
                costEstimated={activeReport!.costMode === 'estimated'}
              />
            ) : (
              <InlineEmpty label="No usage in this range." />
            )}
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup title="Model breakdown">
        {renderUsageState(activeProviderCard) ||
          (activeReport && activeReport.models.length > 0 ? (
            <div>
              <div className="grid grid-cols-[minmax(0,1.4fr)_1fr_110px_90px_110px] gap-4 px-4 py-2 text-[10.5px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
                <div>Model</div>
                <div>Tokens</div>
                <div>Cost</div>
                <div>Sessions</div>
                <div>Cache</div>
              </div>

              <div className="divide-y divide-[var(--border)] border-t border-[var(--border)]">
                {activeReport.models.map((model) => (
                  <div
                    key={model.model}
                    className="grid grid-cols-[minmax(0,1.4fr)_1fr_110px_90px_110px] gap-4 px-4 py-3 text-[12.5px]"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <ModelProviderLogo model={model.model} color={modelColors[model.model]} />
                        <span className="truncate font-medium text-[var(--text-primary)]">{model.model}</span>
                      </div>
                      <div className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
                        In {formatCompactNumber(model.inputTokens)} · Out {formatCompactNumber(model.outputTokens)}
                      </div>
                    </div>
                    <div className="font-medium text-[var(--text-primary)]">
                      {formatCompactNumber(model.totalTokens)}
                    </div>
                    <div className="font-medium text-[var(--text-primary)]">
                      {formatCurrency(model.totalCostUsd, activeReport.costMode === 'estimated')}
                    </div>
                    <div className="text-[var(--text-primary)]">{model.sessionCount.toLocaleString('en-US')}</div>
                    <div className="text-[var(--text-muted)]">{formatCompactNumber(model.cacheReadTokens)}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <InlineEmpty label="No model activity in this range." />
          ))}
      </SettingsGroup>
    </div>
  );
}

function renderUsageState(provider: UsageProviderCard) {
  if (provider.loading && !provider.report) {
    return <InlineEmpty label="Loading usage…" />;
  }

  if (provider.error && !provider.loading) {
    return (
      <div className="px-4 py-4 text-[12px] text-[var(--error)]">
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
            : 'No usage recorded in this range.'
        }
      />
    );
  }

  return null;
}

function InlineEmpty({ label }: { label: string }) {
  return (
    <div className="px-4 py-8 text-center text-[12px] text-[var(--text-muted)]">{label}</div>
  );
}

function ProviderSegmentedControl({
  providers,
  activeId,
  onSelect,
}: {
  providers: UsageProviderCard[];
  activeId: AgentProvider;
  onSelect: (id: AgentProvider) => void;
}) {
  return (
    <SegmentedControl ariaLabel="Select provider">
      {providers.map((provider) => (
        <SegmentedControlItem
          key={provider.id}
          active={provider.id === activeId}
          onClick={() => onSelect(provider.id)}
          ariaLabel={provider.title}
        >
          {provider.logo}
          <span>{provider.title}</span>
          <span className={`h-1.5 w-1.5 rounded-full ${provider.status.dot}`} aria-hidden="true" />
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}

function RangeSegmentedControl({
  value,
  onChange,
}: {
  value: ClaudeUsageRangeDays;
  onChange: (value: ClaudeUsageRangeDays) => void;
}) {
  return (
    <SegmentedControl ariaLabel="Select time range">
      {RANGE_OPTIONS.map((days) => (
        <SegmentedControlItem
          key={days}
          active={value === days}
          onClick={() => onChange(days)}
          className="min-w-[38px]"
        >
          {days}D
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}

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
          className="pointer-events-none absolute top-0 z-10 w-[240px] rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)]/96 px-4 py-3 shadow-[0_18px_45px_rgba(15,23,42,0.12)] backdrop-blur"
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

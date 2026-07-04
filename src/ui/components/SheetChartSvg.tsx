import { useMemo } from 'react';
import type { ResolvedXlsxChart } from '../utils/xlsx-charts';

// Fallback palette when the chart XML carries no explicit series colors.
const SERIES_PALETTE = ['#1F77B4', '#D62728', '#2CA02C', '#9467BD', '#FF7F0E', '#8C564B', '#E377C2', '#7F7F7F', '#BCBD22', '#17BECF'];

const WIDTH = 640;
const HEIGHT = 280;
const MARGIN = { top: 16, right: 16, bottom: 42, left: 56 };
const PLOT_W = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_H = HEIGHT - MARGIN.top - MARGIN.bottom;

function seriesColor(color: string | null, index: number): string {
  return color || SERIES_PALETTE[index % SERIES_PALETTE.length];
}

function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) {
    max = min === 0 ? 1 : min + Math.abs(min) * 0.1;
  }
  const span = max - min;
  const step = Math.pow(10, Math.floor(Math.log10(span / count)));
  const err = (count * step) / span;
  const factor = err <= 0.15 ? 10 : err <= 0.35 ? 5 : err <= 0.75 ? 2 : 1;
  const niceStep = step * factor;
  const start = Math.floor(min / niceStep) * niceStep;
  const ticks: number[] = [];
  for (let value = start; value <= max + niceStep / 2; value += niceStep) {
    ticks.push(Math.round(value * 1e6) / 1e6);
  }
  return ticks;
}

function formatTick(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 10_000) return `${(value / 1_000).toFixed(0)}K`;
  if (abs > 0 && abs < 1) return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return String(Math.round(value * 100) / 100);
}

function useChartScale(chart: ResolvedXlsxChart) {
  return useMemo(() => {
    const all = chart.series.flatMap((entry) => entry.values.filter((v): v is number => v !== null));
    const dataMin = all.length ? Math.min(...all, 0) : 0;
    const dataMax = all.length ? Math.max(...all, 0) : 1;
    const ticks = niceTicks(dataMin, dataMax);
    const min = ticks[0];
    const max = ticks[ticks.length - 1];
    const scale = (value: number) => PLOT_H - ((value - min) / (max - min || 1)) * PLOT_H;
    return { min, max, ticks, scale };
  }, [chart]);
}

function CategoryLabels({ categories }: { categories: string[] }) {
  const count = categories.length || 1;
  const step = Math.ceil(count / 10);
  const band = PLOT_W / count;
  return (
    <>
      {categories.map((label, index) =>
        index % step === 0 ? (
          <text
            key={index}
            x={MARGIN.left + band * (index + 0.5)}
            y={HEIGHT - MARGIN.bottom + 14}
            textAnchor="middle"
            fontSize={9}
            fill="var(--text-muted)"
          >
            {label.length > 12 ? `${label.slice(0, 11)}…` : label}
          </text>
        ) : null
      )}
    </>
  );
}

function Axes({ ticks, scale }: { ticks: number[]; scale: (v: number) => number }) {
  return (
    <>
      {ticks.map((tick) => (
        <g key={tick}>
          <line
            x1={MARGIN.left}
            x2={WIDTH - MARGIN.right}
            y1={MARGIN.top + scale(tick)}
            y2={MARGIN.top + scale(tick)}
            stroke="var(--border)"
            strokeWidth={tick === 0 ? 1.2 : 0.5}
          />
          <text
            x={MARGIN.left - 6}
            y={MARGIN.top + scale(tick) + 3}
            textAnchor="end"
            fontSize={9}
            fill="var(--text-muted)"
          >
            {formatTick(tick)}
          </text>
        </g>
      ))}
    </>
  );
}

function Legend({ chart }: { chart: ResolvedXlsxChart }) {
  return (
    <div className="mt-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5">
      {chart.series.map((entry, index) => (
        <span key={index} className="flex items-center gap-1 text-[10px] text-[var(--text-secondary)]">
          <span
            className="inline-block h-2 w-2 rounded-[2px]"
            style={{ backgroundColor: seriesColor(entry.color, index) }}
          />
          {entry.name}
        </span>
      ))}
    </div>
  );
}

function BarChartSvg({ chart }: { chart: ResolvedXlsxChart }) {
  const { ticks, scale } = useChartScale(chart);
  const count = chart.categories.length || Math.max(...chart.series.map((s) => s.values.length), 1);
  const band = PLOT_W / count;
  const barSlot = band * 0.72;
  const barWidth = Math.max(1, barSlot / chart.series.length);
  const zeroY = MARGIN.top + scale(Math.max(ticks[0], Math.min(0, ticks[ticks.length - 1])));

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full">
      <Axes ticks={ticks} scale={scale} />
      {chart.series.map((entry, seriesIndex) =>
        entry.values.map((value, index) => {
          if (value === null || index >= count) return null;
          const y = MARGIN.top + scale(value);
          const x = MARGIN.left + band * index + (band - barSlot) / 2 + barWidth * seriesIndex;
          return (
            <rect
              key={`${seriesIndex}:${index}`}
              x={x}
              y={Math.min(y, zeroY)}
              width={Math.max(barWidth - 0.5, 0.5)}
              height={Math.max(Math.abs(zeroY - y), 0.5)}
              fill={seriesColor(entry.color, seriesIndex)}
            />
          );
        })
      )}
      <CategoryLabels categories={chart.categories} />
    </svg>
  );
}

function BarHChartSvg({ chart }: { chart: ResolvedXlsxChart }) {
  const { ticks, min, max } = useChartScale(chart);
  const count = chart.categories.length || Math.max(...chart.series.map((s) => s.values.length), 1);
  const band = PLOT_H / count;
  const slot = band * 0.72;
  const barHeight = Math.max(1, slot / chart.series.length);
  const scaleX = (value: number) => ((value - min) / (max - min || 1)) * PLOT_W;
  const zeroX = MARGIN.left + scaleX(Math.max(min, Math.min(0, max)));

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full">
      {ticks.map((tick) => (
        <g key={tick}>
          <line
            x1={MARGIN.left + scaleX(tick)}
            x2={MARGIN.left + scaleX(tick)}
            y1={MARGIN.top}
            y2={HEIGHT - MARGIN.bottom}
            stroke="var(--border)"
            strokeWidth={tick === 0 ? 1.2 : 0.5}
          />
          <text
            x={MARGIN.left + scaleX(tick)}
            y={HEIGHT - MARGIN.bottom + 14}
            textAnchor="middle"
            fontSize={9}
            fill="var(--text-muted)"
          >
            {formatTick(tick)}
          </text>
        </g>
      ))}
      {chart.series.map((entry, seriesIndex) =>
        entry.values.map((value, index) => {
          if (value === null || index >= count) return null;
          const x = MARGIN.left + scaleX(value);
          const y = MARGIN.top + band * index + (band - slot) / 2 + barHeight * seriesIndex;
          return (
            <rect
              key={`${seriesIndex}:${index}`}
              x={Math.min(x, zeroX)}
              y={y}
              width={Math.max(Math.abs(x - zeroX), 0.5)}
              height={Math.max(barHeight - 0.5, 0.5)}
              fill={seriesColor(entry.color, seriesIndex)}
            />
          );
        })
      )}
      {chart.categories.map((label, index) => (
        <text
          key={index}
          x={MARGIN.left - 6}
          y={MARGIN.top + band * (index + 0.5) + 3}
          textAnchor="end"
          fontSize={9}
          fill="var(--text-muted)"
        >
          {label.length > 8 ? `${label.slice(0, 7)}…` : label}
        </text>
      ))}
    </svg>
  );
}

function LineChartSvg({ chart }: { chart: ResolvedXlsxChart }) {
  const { ticks, scale } = useChartScale(chart);
  const count = chart.categories.length || Math.max(...chart.series.map((s) => s.values.length), 1);
  const band = PLOT_W / count;

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full">
      <Axes ticks={ticks} scale={scale} />
      {chart.series.map((entry, seriesIndex) => {
        const color = seriesColor(entry.color, seriesIndex);
        const points = entry.values
          .map((value, index) =>
            value === null
              ? null
              : `${MARGIN.left + band * (index + 0.5)},${MARGIN.top + scale(value)}`
          )
          .filter((point): point is string => point !== null);
        return (
          <g key={seriesIndex}>
            <polyline points={points.join(' ')} fill="none" stroke={color} strokeWidth={1.8} />
            {count <= 40 &&
              entry.values.map((value, index) =>
                value === null ? null : (
                  <circle
                    key={index}
                    cx={MARGIN.left + band * (index + 0.5)}
                    cy={MARGIN.top + scale(value)}
                    r={2}
                    fill={color}
                  />
                )
              )}
          </g>
        );
      })}
      <CategoryLabels categories={chart.categories} />
    </svg>
  );
}

function PieChartSvg({ chart }: { chart: ResolvedXlsxChart }) {
  const values = (chart.series[0]?.values || []).map((value) => (value !== null && value > 0 ? value : 0));
  const total = values.reduce((sum, value) => sum + value, 0);
  const cx = WIDTH / 2;
  const cy = (HEIGHT - 20) / 2 + 10;
  const radius = Math.min(PLOT_W, PLOT_H) / 2;
  let angle = -Math.PI / 2;

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full">
      {total > 0 &&
        values.map((value, index) => {
          const slice = (value / total) * Math.PI * 2;
          const x1 = cx + radius * Math.cos(angle);
          const y1 = cy + radius * Math.sin(angle);
          angle += slice;
          const x2 = cx + radius * Math.cos(angle);
          const y2 = cy + radius * Math.sin(angle);
          const large = slice > Math.PI ? 1 : 0;
          return (
            <path
              key={index}
              d={`M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} Z`}
              fill={SERIES_PALETTE[index % SERIES_PALETTE.length]}
              stroke="var(--bg-primary)"
              strokeWidth={1}
            />
          );
        })}
    </svg>
  );
}

export function SheetChartSvg({ chart }: { chart: ResolvedXlsxChart }) {
  const hasData = chart.series.some((entry) => entry.values.some((value) => value !== null && value !== 0));

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-3 pb-2 pt-2.5">
      {chart.title ? (
        <div className="pb-1 text-center text-xs font-medium text-[var(--text-primary)]">{chart.title}</div>
      ) : null}
      {!hasData ? (
        <div className="py-6 text-center text-xs text-[var(--text-muted)]">
          No cached data for this chart — open the file in Excel to view it.
        </div>
      ) : chart.type === 'line' || chart.type === 'area' ? (
        <LineChartSvg chart={chart} />
      ) : chart.type === 'barH' ? (
        <BarHChartSvg chart={chart} />
      ) : chart.type === 'pie' ? (
        <PieChartSvg chart={chart} />
      ) : (
        <BarChartSvg chart={chart} />
      )}
      {chart.type === 'pie' ? (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5">
          {chart.categories.map((label, index) => (
            <span key={index} className="flex items-center gap-1 text-[10px] text-[var(--text-secondary)]">
              <span
                className="inline-block h-2 w-2 rounded-[2px]"
                style={{ backgroundColor: SERIES_PALETTE[index % SERIES_PALETTE.length] }}
              />
              {label}
            </span>
          ))}
        </div>
      ) : (
        <Legend chart={chart} />
      )}
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import * as DropdownMenu from '@/ui/components/ui/dropdown-menu';
import { Check, ChevronDown } from './icons';
import { parseDelimitedText, sniffDelimiter, type SheetRows } from '../utils/delimited-text';
import {
  createWorkbookRangeResolver,
  sanitizeXlsxForPreview,
  workbookToRichSheets,
  type RichCell,
  type RichSheet,
} from '../utils/xlsx-preview';
import { extractXlsxCharts, resolveXlsxChart, type ResolvedXlsxChart } from '../utils/xlsx-charts';
import { SheetChartSvg } from './SheetChartSvg';

// Rendering caps keep huge sheets from freezing the preview panel; the file
// itself is already size-capped by the main process before it gets here.
const MAX_PREVIEW_ROWS = 500;
const MAX_PREVIEW_COLS = 60;

// ── Shared table renderer ───────────────────────────────────────────────────

function SheetTable({ rows, label }: { rows: SheetRows; label: string }) {
  const totalRows = rows.length;
  const totalCols = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const visibleRows = rows.slice(0, MAX_PREVIEW_ROWS);
  const colCount = Math.min(totalCols, MAX_PREVIEW_COLS);
  const truncatedRows = totalRows > MAX_PREVIEW_ROWS;
  const truncatedCols = totalCols > MAX_PREVIEW_COLS;

  if (totalRows === 0 || colCount === 0) {
    return <div className="text-sm text-[var(--text-muted)]">This sheet is empty.</div>;
  }

  const [headerRow, ...bodyRows] = visibleRows;

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="min-h-0 overflow-auto rounded-md border border-[var(--border)]">
        <table className="w-max min-w-full border-collapse text-[12px] leading-[18px]">
          <thead>
            <tr>
              <th className="sticky top-0 z-10 border-b border-r border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-right font-normal text-[var(--text-muted)]">
                &nbsp;
              </th>
              {Array.from({ length: colCount }, (_, colIndex) => (
                <th
                  key={colIndex}
                  className="sticky top-0 z-10 max-w-[320px] truncate border-b border-r border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-left font-medium text-[var(--text-primary)]"
                  title={headerRow?.[colIndex] || ''}
                >
                  {headerRow?.[colIndex] ?? ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bodyRows.map((row, rowIndex) => (
              <tr key={rowIndex} className="odd:bg-[var(--bg-primary)] even:bg-[color-mix(in_srgb,var(--bg-secondary)_45%,transparent)]">
                <td className="border-b border-r border-[var(--border)] px-2 py-1 text-right tabular-nums text-[var(--text-muted)]">
                  {rowIndex + 2}
                </td>
                {Array.from({ length: colCount }, (_, colIndex) => (
                  <td
                    key={colIndex}
                    className="max-w-[320px] truncate border-b border-r border-[var(--border)] px-2 py-1 text-[var(--text-secondary)]"
                    title={row[colIndex] || ''}
                  >
                    {row[colIndex] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-xs text-[var(--text-muted)]">
        {label} · {totalRows.toLocaleString()} rows × {totalCols} columns
        {truncatedRows ? ` · showing first ${MAX_PREVIEW_ROWS} rows` : ''}
        {truncatedCols ? ` · showing first ${MAX_PREVIEW_COLS} columns` : ''}
      </div>
    </div>
  );
}

// ── CSV / TSV ────────────────────────────────────────────────────────────────

export function CsvPreview({ text, ext }: { text: string; ext: string }) {
  const rows = useMemo(
    () => parseDelimitedText(text, sniffDelimiter(text, ext)),
    [text, ext]
  );
  return <SheetTable rows={rows} label={ext === '.tsv' ? 'TSV' : 'CSV'} />;
}

// ── XLSX ─────────────────────────────────────────────────────────────────────

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function columnLetter(index: number): string {
  let label = '';
  let value = index + 1;
  while (value > 0) {
    const rem = (value - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

const ZOOM_LEVELS = [50, 75, 100, 125, 150];

// Excel-like grid: column letters across the top, row numbers down the left,
// merged cells, per-cell fills/fonts, and Excel column widths.
function RichSheetGrid({ sheet, zoom }: { sheet: RichSheet; zoom: number }) {
  const totalRows = sheet.rows.length;
  const totalCols = sheet.rows.reduce((max, cells) => Math.max(max, cells.length), 0);
  const rows = sheet.rows.slice(0, MAX_PREVIEW_ROWS);
  const colCount = Math.min(totalCols, MAX_PREVIEW_COLS);
  const truncatedRows = totalRows > MAX_PREVIEW_ROWS;
  const truncatedCols = totalCols > MAX_PREVIEW_COLS;

  if (totalRows === 0 || colCount === 0) {
    return <div className="text-sm text-[var(--text-muted)]">This sheet is empty.</div>;
  }

  const scale = zoom / 100;

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="min-h-0 overflow-auto rounded-md border border-[var(--border)]">
        <div
          style={{
            transform: scale === 1 ? undefined : `scale(${scale})`,
            transformOrigin: 'top left',
            width: scale === 1 ? undefined : `${100 / scale}%`,
          }}
        >
          <table className="w-max min-w-full border-collapse text-[12px] leading-[18px]" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: 40 }} />
              {Array.from({ length: colCount }, (_, colIndex) => (
                <col key={colIndex} style={{ width: sheet.columnWidths[colIndex] || 72 }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th className="sticky top-0 z-10 border-b border-r border-[var(--border)] bg-[var(--bg-secondary)] px-1 py-0.5 text-center text-[10px] font-normal text-[var(--text-muted)]">
                  &nbsp;
                </th>
                {Array.from({ length: colCount }, (_, colIndex) => (
                  <th
                    key={colIndex}
                    className="sticky top-0 z-10 border-b border-r border-[var(--border)] bg-[var(--bg-secondary)] px-1 py-0.5 text-center text-[10px] font-normal text-[var(--text-muted)]"
                  >
                    {columnLetter(colIndex)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((cells, rowIndex) => (
                <tr key={rowIndex}>
                  <td className="border-b border-r border-[var(--border)] bg-[var(--bg-secondary)] px-1 py-0.5 text-center text-[10px] tabular-nums text-[var(--text-muted)]">
                    {rowIndex + 1}
                  </td>
                  {Array.from({ length: colCount }, (_, colIndex) => {
                    const cell: RichCell = cells[colIndex] || { text: '' };
                    if (cell.skip) return null;
                    return (
                      <td
                        key={colIndex}
                        colSpan={cell.colSpan && cell.colSpan > 1 ? Math.min(cell.colSpan, colCount - colIndex) : undefined}
                        rowSpan={cell.rowSpan && cell.rowSpan > 1 ? cell.rowSpan : undefined}
                        className="overflow-hidden text-ellipsis whitespace-nowrap border-b border-r border-[var(--border)] px-1.5 py-0.5"
                        style={{
                          fontWeight: cell.bold ? 600 : undefined,
                          fontStyle: cell.italic ? 'italic' : undefined,
                          color: cell.color || 'var(--text-secondary)',
                          backgroundColor: cell.bg,
                          textAlign: cell.align,
                        }}
                        title={cell.text || undefined}
                      >
                        {cell.text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="text-xs text-[var(--text-muted)]">
        {sheet.name} · {totalRows.toLocaleString()} rows × {totalCols} columns
        {truncatedRows ? ` · showing first ${MAX_PREVIEW_ROWS} rows` : ''}
        {truncatedCols ? ` · showing first ${MAX_PREVIEW_COLS} columns` : ''}
      </div>
    </div>
  );
}

interface ParsedRichWorkbook {
  sheets: RichSheet[];
  chartsBySheet: Map<string, ResolvedXlsxChart[]>;
}

export function XlsxPreview({ dataBase64, path }: { dataBase64: string; path: string }) {
  const [workbook, setWorkbook] = useState<ParsedRichWorkbook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [zoom, setZoom] = useState(100);

  useEffect(() => {
    let cancelled = false;

    const parse = async () => {
      setWorkbook(null);
      setError(null);
      setSheetIndex(0);

      try {
        // exceljs is heavy; load it only when an .xlsx preview is opened.
        const ExcelJS = await import('exceljs');
        const bytes = base64ToUint8Array(dataBase64);
        let wb = new ExcelJS.Workbook();
        try {
          await wb.xlsx.load(bytes.buffer as ArrayBuffer);
        } catch {
          // Non-Excel producers (openpyxl etc.) trip exceljs on drawings,
          // charts and table parts; retry on cell data alone.
          wb = new ExcelJS.Workbook();
          await wb.xlsx.load(sanitizeXlsxForPreview(bytes).buffer as ArrayBuffer);
        }
        if (cancelled) return;

        // Charts parse straight from the original zip (independent of the
        // sanitized exceljs load) and resolve their ranges against live cells.
        const chartsBySheet = new Map<string, ResolvedXlsxChart[]>();
        try {
          const resolver = createWorkbookRangeResolver(wb as never);
          for (const [sheetName, charts] of extractXlsxCharts(bytes)) {
            chartsBySheet.set(
              sheetName,
              charts.map((chart) => resolveXlsxChart(chart, resolver))
            );
          }
        } catch {
          // Chart extraction is best-effort; the grid still renders.
        }

        setWorkbook({ sheets: workbookToRichSheets(wb as never), chartsBySheet });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };

    void parse();
    return () => {
      cancelled = true;
    };
  }, [dataBase64, path]);

  if (error) {
    return <div className="text-sm text-[var(--error)]">Failed to parse workbook: {error}</div>;
  }
  if (!workbook) {
    return <div className="text-sm text-[var(--text-muted)]">Parsing workbook...</div>;
  }
  if (workbook.sheets.length === 0) {
    return <div className="text-sm text-[var(--text-muted)]">This workbook has no sheets.</div>;
  }

  const safeIndex = Math.min(Math.max(sheetIndex, 0), workbook.sheets.length - 1);
  const activeSheet = workbook.sheets[safeIndex];
  const activeCharts = workbook.chartsBySheet.get(activeSheet.name) || [];

  // Reference-style tab strip: a few visible tabs plus an "N more" dropdown,
  // all on one row with the zoom control. The active sheet is always visible.
  const MAX_VISIBLE_TABS = 4;
  const allTabs = workbook.sheets.map((sheet, index) => ({ name: sheet.name, index }));
  let visibleTabs = allTabs.slice(0, MAX_VISIBLE_TABS);
  if (safeIndex >= MAX_VISIBLE_TABS) {
    visibleTabs = [...allTabs.slice(0, MAX_VISIBLE_TABS - 1), allTabs[safeIndex]];
  }
  const visibleIndexSet = new Set(visibleTabs.map((tab) => tab.index));
  const overflowTabs = allTabs.filter((tab) => !visibleIndexSet.has(tab.index));

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center gap-1 no-drag">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {workbook.sheets.length > 1 &&
            visibleTabs.map((tab) => (
              <button
                key={`${tab.name}:${tab.index}`}
                type="button"
                onClick={() => setSheetIndex(tab.index)}
                className={`max-w-[140px] truncate rounded-md border px-2 py-0.5 text-xs transition-colors ${
                  tab.index === safeIndex
                    ? 'border-[var(--border)] bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                    : 'border-transparent text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-secondary)]'
                }`}
                title={tab.name}
              >
                {tab.name}
              </button>
            ))}
          {overflowTabs.length > 0 && (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  className="flex flex-shrink-0 items-center gap-0.5 rounded-md px-2 py-0.5 text-xs text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-secondary)]"
                >
                  {overflowTabs.length} more
                  <ChevronDown className="h-3 w-3" aria-hidden="true" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="start"
                  sideOffset={6}
                  className="z-50 max-h-[280px] w-[200px] overflow-y-auto rounded-[10px] border border-[var(--border)] bg-[var(--bg-primary)] p-1 shadow-[0_8px_30px_rgba(15,23,42,0.12)]"
                >
                  {overflowTabs.map((tab) => (
                    <DropdownMenu.Item
                      key={`${tab.name}:${tab.index}`}
                      onSelect={() => setSheetIndex(tab.index)}
                      className="flex cursor-default items-center gap-2 rounded-[6px] px-2 py-1 text-xs text-[var(--text-primary)] outline-none data-[highlighted]:bg-[var(--bg-tertiary)]"
                    >
                      <span className="min-w-0 flex-1 truncate">{tab.name}</span>
                      {tab.index === safeIndex ? (
                        <Check className="h-3 w-3 flex-shrink-0 text-[var(--accent)]" />
                      ) : null}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
        </div>
        <select
          value={zoom}
          onChange={(event) => setZoom(Number(event.target.value))}
          className="flex-shrink-0 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-1.5 py-0.5 text-xs text-[var(--text-secondary)] outline-none"
          aria-label="Zoom"
        >
          {ZOOM_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}%
            </option>
          ))}
        </select>
      </div>
      <RichSheetGrid sheet={activeSheet} zoom={zoom} />
      {activeCharts.length > 0 && (
        <div className="grid grid-cols-1 gap-3 pb-1 xl:grid-cols-2">
          {activeCharts.map((chart, index) => (
            <SheetChartSvg key={`${activeSheet.name}:${index}`} chart={chart} />
          ))}
        </div>
      )}
    </div>
  );
}

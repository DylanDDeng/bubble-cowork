// Pure helpers that turn an exceljs Workbook into plain string grids for the
// spreadsheet preview. Kept free of exceljs imports (the workbook comes in as
// a structural type) so the verify script can load this file directly with
// node --experimental-strip-types.

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { SheetRows } from './delimited-text';

// exceljs chokes on workbooks written by non-Excel producers (openpyxl et al):
// their drawing XML uses default namespaces instead of the xdr: prefix
// ("Cannot read properties of undefined (reading 'anchors')") and their rels
// use absolute targets like /xl/tables/table1.xml that exceljs cannot resolve
// ("... (reading 'name')"). The preview only renders cell values, so when a
// straight load fails we strip every drawing/chart/table part plus the
// references to them and retry on plain cell data.
export function sanitizeXlsxForPreview(bytes: Uint8Array): Uint8Array {
  const entries = unzipSync(bytes);
  const kept: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(entries)) {
    if (
      name.startsWith('xl/drawings/') ||
      name.startsWith('xl/charts/') ||
      name.startsWith('xl/tables/')
    ) {
      continue;
    }
    let out = data;
    if (/^xl\/worksheets\/sheet[^/]*\.xml$/.test(name)) {
      out = strToU8(
        strFromU8(data)
          .replace(/<drawing[^>]*\/>/g, '')
          .replace(/<tableParts[\s\S]*?<\/tableParts>/g, '')
          .replace(/<tableParts[^>]*\/>/g, '')
      );
    }
    if (/^xl\/worksheets\/_rels\//.test(name)) {
      out = strToU8(strFromU8(data).replace(/<Relationship[^>]*(drawing|table|chart)[^>]*\/>/g, ''));
    }
    kept[name] = out;
  }
  return zipSync(kept);
}

export type ParsedSheet = { name: string; rows: SheetRows };

type WorksheetLike = {
  name: string;
  eachRow: (
    opts: { includeEmpty: boolean },
    cb: (row: { values: unknown }) => void
  ) => void;
};

type WorkbookLike = { worksheets: WorksheetLike[] };

export function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    // exceljs cell shapes: rich text, hyperlinks, formula results, error cells.
    if (Array.isArray(v.richText)) {
      return (v.richText as { text?: string }[]).map((part) => part.text || '').join('');
    }
    if ('text' in v && typeof v.text === 'string') return v.text;
    if ('result' in v) return cellToString(v.result);
    if ('error' in v && typeof v.error === 'string') return v.error;
    return String(value);
  }
  return String(value);
}

// ── Rich (styled) extraction ─────────────────────────────────────────────────

export interface RichCell {
  text: string;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  bg?: string;
  align?: 'left' | 'center' | 'right';
  colSpan?: number;
  rowSpan?: number;
  /** Covered by a merge; not rendered. */
  skip?: boolean;
}

export interface RichSheet {
  name: string;
  rows: RichCell[][];
  /** Pixel widths per column (0-based), best-effort from Excel char widths. */
  columnWidths: number[];
}

function argbToCss(argb: unknown): string | undefined {
  if (typeof argb !== 'string' || argb.length < 6) return undefined;
  const hex = argb.length === 8 ? argb.slice(2) : argb;
  if (!/^[0-9a-f]{6}$/i.test(hex)) return undefined;
  return `#${hex.toUpperCase()}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatDateForFmt(date: Date, numFmt: string): string {
  const base = `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
  if (/h/i.test(numFmt) && (date.getUTCHours() || date.getUTCMinutes())) {
    return `${base} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
  }
  return base;
}

function groupThousands(integerPart: string): string {
  return integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Best-effort Excel number-format rendering. Covers the formats that matter
 * for readability — percent, thousands separators, decimals, currency symbols
 * and financial parentheses — rather than the full ECMA-376 grammar.
 */
export function formatCellDisplay(value: unknown, numFmt?: string | null): string {
  if (value instanceof Date) {
    return formatDateForFmt(value, numFmt || '');
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return cellToString(value);
  }
  const fmt = (numFmt || '').split(';')[0];
  if (!fmt || /^general$/i.test(fmt)) {
    return String(value);
  }

  if (/[ymd]/i.test(fmt) && !/[#0]/.test(fmt) && value > 20000 && value < 80000) {
    return formatDateForFmt(new Date(Math.round((value - 25569) * 86400000)), fmt);
  }

  const decimalsMatch = fmt.match(/[#0]\.([0#]+)/);
  const decimals = decimalsMatch ? decimalsMatch[1].length : 0;

  if (fmt.includes('%')) {
    return `${(value * 100).toFixed(decimals)}%`;
  }

  const currencyMatch = fmt.match(/\[\$([^\]-]+)[^\]]*\]/) || fmt.match(/([¥$€£])/);
  const currency = currencyMatch ? currencyMatch[1] : '';
  const negativeInParens = (numFmt || '').includes('(');
  const absolute = Math.abs(value);
  let body = absolute.toFixed(decimals);
  if (fmt.includes(',')) {
    const [intPart, fracPart] = body.split('.');
    body = fracPart ? `${groupThousands(intPart)}.${fracPart}` : groupThousands(intPart);
  }
  const withCurrency = `${currency}${body}`;
  if (value < 0) {
    return negativeInParens ? `(${withCurrency})` : `-${withCurrency}`;
  }
  return withCurrency;
}

type RichCellLike = {
  value?: unknown;
  numFmt?: string;
  font?: { bold?: boolean; italic?: boolean; color?: { argb?: string } };
  fill?: { type?: string; fgColor?: { argb?: string } };
  alignment?: { horizontal?: string };
};

type RichRowLike = {
  eachCell: (opts: { includeEmpty: boolean }, cb: (cell: RichCellLike, colNumber: number) => void) => void;
};

type RichWorksheetLike = {
  name: string;
  rowCount: number;
  columnCount: number;
  columns?: Array<{ width?: number } | undefined> | null;
  model?: { merges?: string[] };
  eachRow: (opts: { includeEmpty: boolean }, cb: (row: RichRowLike, rowNumber: number) => void) => void;
};

type RichWorkbookLike = { worksheets: RichWorksheetLike[] };

function parseMergeRange(range: string): { top: number; left: number; bottom: number; right: number } | null {
  const match = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if (!match) return null;
  const colToIndex = (letters: string) =>
    letters
      .toUpperCase()
      .split('')
      .reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0);
  return {
    left: colToIndex(match[1]),
    top: Number(match[2]),
    right: colToIndex(match[3]),
    bottom: Number(match[4]),
  };
}

const DEFAULT_COLUMN_PX = 72;

export function workbookToRichSheets(workbook: RichWorkbookLike): RichSheet[] {
  return workbook.worksheets.map((sheet) => {
    const rows: RichCell[][] = [];
    sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const cells: RichCell[] = [];
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const rich: RichCell = { text: formatCellDisplay(unwrapRichValue(cell.value), cell.numFmt) };
        if (cell.font?.bold) rich.bold = true;
        if (cell.font?.italic) rich.italic = true;
        const color = argbToCss(cell.font?.color?.argb);
        if (color && color !== '#000000') rich.color = color;
        if (cell.fill?.type === 'pattern') {
          const bg = argbToCss(cell.fill.fgColor?.argb);
          if (bg && bg !== '#FFFFFF') rich.bg = bg;
        }
        const align = cell.alignment?.horizontal;
        if (align === 'center' || align === 'right' || align === 'left') rich.align = align;
        cells[colNumber - 1] = rich;
      });
      rows[rowNumber - 1] = cells;
    });

    // Normalize: dense grid with empty cells filled in.
    const columnCount = Math.max(sheet.columnCount || 0, ...rows.map((cells) => cells?.length || 0));
    const grid: RichCell[][] = [];
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const source = rows[rowIndex] || [];
      const target: RichCell[] = [];
      for (let colIndex = 0; colIndex < columnCount; colIndex += 1) {
        target[colIndex] = source[colIndex] || { text: '' };
      }
      grid[rowIndex] = target;
    }

    for (const merge of sheet.model?.merges || []) {
      const range = parseMergeRange(merge);
      if (!range) continue;
      const master = grid[range.top - 1]?.[range.left - 1];
      if (!master) continue;
      master.rowSpan = range.bottom - range.top + 1;
      master.colSpan = range.right - range.left + 1;
      for (let rowIndex = range.top; rowIndex <= range.bottom; rowIndex += 1) {
        for (let colIndex = range.left; colIndex <= range.right; colIndex += 1) {
          if (rowIndex === range.top && colIndex === range.left) continue;
          const covered = grid[rowIndex - 1]?.[colIndex - 1];
          if (covered) covered.skip = true;
        }
      }
    }

    const columnWidths: number[] = [];
    for (let colIndex = 0; colIndex < columnCount; colIndex += 1) {
      const width = sheet.columns?.[colIndex]?.width;
      columnWidths[colIndex] =
        typeof width === 'number' && width > 0 ? Math.round(width * 7.5) : DEFAULT_COLUMN_PX;
    }

    return { name: sheet.name, rows: grid, columnWidths };
  });
}

function unwrapRichValue(value: unknown): unknown {
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const v = value as Record<string, unknown>;
    if ('result' in v) return unwrapRichValue(v.result);
    if (Array.isArray(v.richText)) {
      return (v.richText as { text?: string }[]).map((part) => part.text || '').join('');
    }
    if ('text' in v && typeof v.text === 'string') return v.text;
  }
  return value;
}

/**
 * Range resolver over an exceljs workbook for chart data: unwraps formula
 * results and rich text while preserving numbers and dates.
 */
export function createWorkbookRangeResolver(workbook: {
  getWorksheet: (name: string) => { getRow: (row: number) => { getCell: (col: number) => { value?: unknown } } } | undefined;
}): (ref: { sheet: string; startCol: number; startRow: number; endCol: number; endRow: number }) => Array<unknown> | null {
  return (ref) => {
    const sheet = workbook.getWorksheet(ref.sheet);
    if (!sheet) return null;
    const values: Array<unknown> = [];
    if (ref.startRow === ref.endRow) {
      const row = sheet.getRow(ref.startRow);
      for (let col = ref.startCol; col <= ref.endCol; col += 1) {
        values.push(unwrapRichValue(row.getCell(col).value));
      }
    } else {
      for (let rowIndex = ref.startRow; rowIndex <= ref.endRow; rowIndex += 1) {
        values.push(unwrapRichValue(sheet.getRow(rowIndex).getCell(ref.startCol).value));
      }
    }
    return values;
  };
}

export function workbookToSheets(workbook: WorkbookLike): ParsedSheet[] {
  return workbook.worksheets.map((sheet) => {
    const rows: SheetRows = [];
    sheet.eachRow({ includeEmpty: true }, (row) => {
      const values: string[] = [];
      // row.values is 1-based with index 0 unused.
      const rawValues = Array.isArray(row.values) ? row.values.slice(1) : [];
      for (const cell of rawValues) {
        values.push(cellToString(cell));
      }
      rows.push(values);
    });
    return { name: sheet.name, rows };
  });
}

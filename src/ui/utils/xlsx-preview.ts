// Pure helpers that turn an exceljs Workbook into plain string grids for the
// spreadsheet preview. Kept free of exceljs imports (the workbook comes in as
// a structural type) so the verify script can load this file directly with
// node --experimental-strip-types.

import type { SheetRows } from './delimited-text';

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

import { useEffect, useMemo, useState } from 'react';
import { parseDelimitedText, sniffDelimiter, type SheetRows } from '../utils/delimited-text';
import { workbookToSheets, type ParsedSheet } from '../utils/xlsx-preview';

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

export function XlsxPreview({ dataBase64, path }: { dataBase64: string; path: string }) {
  const [workbook, setWorkbook] = useState<ParsedSheet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const parse = async () => {
      setWorkbook(null);
      setError(null);
      setSheetIndex(0);

      try {
        // exceljs is heavy; load it only when an .xlsx preview is opened.
        const ExcelJS = await import('exceljs');
        const wb = new ExcelJS.Workbook();
        const bytes = base64ToUint8Array(dataBase64);
        await wb.xlsx.load(bytes.buffer as ArrayBuffer);
        if (cancelled) return;
        setWorkbook(workbookToSheets(wb));
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
  if (workbook.length === 0) {
    return <div className="text-sm text-[var(--text-muted)]">This workbook has no sheets.</div>;
  }

  const safeIndex = Math.min(Math.max(sheetIndex, 0), workbook.length - 1);
  const activeSheet = workbook[safeIndex];

  return (
    <div className="flex min-h-0 flex-col gap-2">
      {workbook.length > 1 && (
        <div className="flex flex-wrap items-center gap-1 no-drag">
          {workbook.map((sheet, index) => (
            <button
              key={`${sheet.name}:${index}`}
              type="button"
              onClick={() => setSheetIndex(index)}
              className={`rounded-md border px-2 py-0.5 text-xs transition-colors ${
                index === safeIndex
                  ? 'border-[var(--border)] bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                  : 'border-transparent text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-secondary)]'
              }`}
              title={sheet.name}
            >
              {sheet.name}
            </button>
          ))}
        </div>
      )}
      <SheetTable rows={activeSheet.rows} label={activeSheet.name} />
    </div>
  );
}

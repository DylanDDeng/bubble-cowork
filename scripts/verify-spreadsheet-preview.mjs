#!/usr/bin/env node
// Checks the CSV/XLSX preview feature: parser correctness (loaded from the
// real TS source via --experimental-strip-types) and main/renderer wiring.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// ── Parser behavior (runs the actual TS module) ─────────────────────────────

const parserTest = `
import assert from 'node:assert/strict';
import { parseDelimitedText, sniffDelimiter } from ${JSON.stringify(
  path.join(root, 'src/ui/utils/delimited-text.ts')
)};

// Plain rows, trailing newline dropped
assert.deepEqual(parseDelimitedText('a,b\\n1,2\\n', ','), [['a', 'b'], ['1', '2']]);

// Quoted fields: embedded delimiter, newline, escaped quotes
assert.deepEqual(
  parseDelimitedText('name,note\\n"Smith, J","line1\\nline2"\\n"say ""hi"""," x "', ','),
  [['name', 'note'], ['Smith, J', 'line1\\nline2'], ['say "hi"', ' x ']]
);

// CRLF endings and empty fields
assert.deepEqual(parseDelimitedText('a,,c\\r\\n,,\\r\\n', ','), [['a', '', 'c'], ['', '', '']]);

// Delimiter sniffing: tsv ext wins, semicolons detected, quoted commas ignored
assert.equal(sniffDelimiter('a\\tb', '.tsv'), '\\t');
assert.equal(sniffDelimiter('a;b;c\\n1;2;3', '.csv'), ';');
assert.equal(sniffDelimiter('"1;2;3",x\\n', '.csv'), ',');

console.log('parser assertions passed');
`;

const parserRun = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', parserTest],
  { encoding: 'utf8' }
);
if (parserRun.status !== 0) {
  console.error(parserRun.stdout);
  console.error(parserRun.stderr);
  process.exit(1);
}
assert.ok(parserRun.stdout.includes('parser assertions passed'), 'parser test must run');

// ── XLSX roundtrip (real exceljs workbook through the shipped extractor) ────

const xlsxTest = `
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { workbookToSheets } from ${JSON.stringify(
  path.join(root, 'src/ui/utils/xlsx-preview.ts')
)};

const wb = new ExcelJS.Workbook();
const sales = wb.addWorksheet('Sales');
sales.addRow(['product', 'qty', 'price']);
sales.addRow(['widget', 3, 2.5]);
sales.addRow([
  { richText: [{ text: 'bold' }, { text: '-part' }] },
  { formula: 'B2*2', result: 6 },
  null,
]);
const empty = wb.addWorksheet('Empty');

const buffer = await wb.xlsx.writeBuffer();
const wb2 = new ExcelJS.Workbook();
await wb2.xlsx.load(buffer);

const sheets = workbookToSheets(wb2);
assert.equal(sheets.length, 2);
assert.equal(sheets[0].name, 'Sales');
assert.deepEqual(sheets[0].rows[0], ['product', 'qty', 'price']);
assert.deepEqual(sheets[0].rows[1], ['widget', '3', '2.5']);
assert.equal(sheets[0].rows[2][0], 'bold-part');
assert.equal(sheets[0].rows[2][1], '6');
assert.equal(sheets[1].name, 'Empty');
assert.deepEqual(sheets[1].rows, []);

console.log('xlsx roundtrip passed');
`;

const xlsxRun = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', xlsxTest],
  { cwd: root, encoding: 'utf8' }
);
if (xlsxRun.status !== 0) {
  console.error(xlsxRun.stdout);
  console.error(xlsxRun.stderr);
  process.exit(1);
}
assert.ok(xlsxRun.stdout.includes('xlsx roundtrip passed'), 'xlsx roundtrip must run');

// ── Sanitizer: openpyxl-style workbooks that crash a straight exceljs load ──

const sanitizeTest = `
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { sanitizeXlsxForPreview } from ${JSON.stringify(
  path.join(root, 'src/ui/utils/xlsx-preview.ts')
)};

// Build a normal workbook, then poison it the way openpyxl does: an
// unprefixed-namespace drawing part wired through an absolute-target rel.
const wb = new ExcelJS.Workbook();
const sheet = wb.addWorksheet('Data');
sheet.addRow(['a', 'b']);
sheet.addRow([1, 2]);
const buffer = new Uint8Array(await wb.xlsx.writeBuffer());

const entries = unzipSync(buffer);
entries['xl/drawings/drawing1.xml'] = strToU8(
  '<wsDr xmlns="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"><twoCellAnchor/></wsDr>'
);
entries['xl/worksheets/_rels/sheet1.xml.rels'] = strToU8(
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="/xl/drawings/drawing1.xml" Id="rId9" /></Relationships>'
);
entries['xl/worksheets/sheet1.xml'] = strToU8(
  strFromU8(entries['xl/worksheets/sheet1.xml']).replace(
    '</worksheet>',
    '<drawing xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId9" /></worksheet>'
  )
);
const poisoned = zipSync(entries);

let direct = 'loaded';
try {
  await new ExcelJS.Workbook().xlsx.load(poisoned.buffer);
} catch {
  direct = 'crashed';
}
assert.equal(direct, 'crashed', 'the poisoned workbook must reproduce the exceljs crash');

const wb2 = new ExcelJS.Workbook();
await wb2.xlsx.load(sanitizeXlsxForPreview(poisoned).buffer);
assert.equal(wb2.worksheets[0].name, 'Data');
assert.equal(wb2.worksheets[0].rowCount, 2);

console.log('xlsx sanitize passed');
`;

const sanitizeRun = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', sanitizeTest],
  { cwd: root, encoding: 'utf8' }
);
if (sanitizeRun.status !== 0) {
  console.error(sanitizeRun.stdout);
  console.error(sanitizeRun.stderr);
  process.exit(1);
}
assert.ok(sanitizeRun.stdout.includes('xlsx sanitize passed'), 'xlsx sanitize must run');

const spreadsheetComponent = read('src/ui/components/SpreadsheetPreview.tsx');
assert.ok(
  spreadsheetComponent.includes('sanitizeXlsxForPreview'),
  'XlsxPreview must retry a failed load with the sanitized workbook'
);
assert.ok(
  spreadsheetComponent.includes('RichSheetGrid') &&
    spreadsheetComponent.includes('extractXlsxCharts') &&
    spreadsheetComponent.includes('ZOOM_LEVELS'),
  'XlsxPreview must render the rich grid, charts and zoom control'
);

// ── Rich extraction: styles, number formats, merges, chart resolution ───────

const richTest = `
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {
  formatCellDisplay,
  workbookToRichSheets,
  createWorkbookRangeResolver,
} from ${JSON.stringify(path.join(root, 'src/ui/utils/xlsx-preview.ts'))};
import { parseRangeRef, resolveXlsxChart } from ${JSON.stringify(
  path.join(root, 'src/ui/utils/xlsx-charts.ts')
)};

// Number formats
assert.equal(formatCellDisplay(0.4785, '0.0%'), '47.9%');
assert.equal(formatCellDisplay(1234567.891, '#,##0.00'), '1,234,567.89');
assert.equal(formatCellDisplay(-31.02, '¥#,##0.0;(¥#,##0.0)'), '(¥31.0)');
assert.equal(formatCellDisplay(59.5, 'General'), '59.5');

// Styled workbook roundtrip
const wb = new ExcelJS.Workbook();
const sheet = wb.addWorksheet('Styled');
sheet.getCell('A1').value = 'Head';
sheet.getCell('A1').font = { bold: true, color: { argb: 'FFFFFFFF' } };
sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF244062' } };
sheet.mergeCells('A1:B1');
sheet.getCell('A2').value = 0.5;
sheet.getCell('A2').numFmt = '0.0%';
const loaded = new ExcelJS.Workbook();
await loaded.xlsx.load(await wb.xlsx.writeBuffer());
const rich = workbookToRichSheets(loaded)[0];
const head = rich.rows[0][0];
assert.equal(head.text, 'Head');
assert.equal(head.bold, true);
assert.equal(head.bg, '#244062');
assert.equal(head.colSpan, 2);
assert.equal(rich.rows[0][1].skip, true);
assert.equal(rich.rows[1][0].text, '50.0%');

// Range parsing + chart resolution against live cells (caches lie: openpyxl
// caches zeros, so resolved values must win over the cached ones).
const ref = parseRangeRef("'My Sheet'!\$B\$2:\$D\$2");
assert.deepEqual(ref, { sheet: 'My Sheet', startCol: 2, startRow: 2, endCol: 4, endRow: 2 });
const dataWb = new ExcelJS.Workbook();
const dataSheet = dataWb.addWorksheet('Data');
dataSheet.getRow(2).getCell(2).value = 10;
dataSheet.getRow(2).getCell(3).value = { formula: 'B2*2', result: 20 };
dataSheet.getRow(2).getCell(4).value = 30;
const resolver = createWorkbookRangeResolver(dataWb);
const resolved = resolveXlsxChart(
  {
    type: 'bar',
    title: 't',
    categories: ['a', 'b', 'c'],
    categoriesRef: null,
    series: [
      {
        name: 's1',
        color: null,
        values: [0, 0, 0],
        valuesRef: { sheet: 'Data', startCol: 2, startRow: 2, endCol: 4, endRow: 2 },
      },
    ],
  },
  resolver
);
assert.deepEqual(resolved.series[0].values, [10, 20, 30]);

console.log('rich extraction passed');
`;

const richRun = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', richTest],
  { cwd: root, encoding: 'utf8' }
);
if (richRun.status !== 0) {
  console.error(richRun.stdout);
  console.error(richRun.stderr);
  process.exit(1);
}
assert.ok(richRun.stdout.includes('rich extraction passed'), 'rich extraction test must run');

// ── Main-process wiring ─────────────────────────────────────────────────────

const ipc = read('src/electron/ipc-handlers.ts');
assert.ok(
  ipc.includes("ext === '.csv' || ext === '.tsv'") && ipc.includes("kind: 'csv'"),
  'read-project-file-preview must classify .csv/.tsv as csv previews'
);
assert.ok(
  ipc.includes("ext === '.xlsx'") && ipc.includes("kind: 'xlsx'"),
  'read-project-file-preview must classify .xlsx as xlsx previews'
);
assert.ok(
  /'\.docx' \|\| ext === '\.xls'/.test(ipc),
  'legacy .xls must fall back to the binary (system viewer) path'
);

// ── Renderer wiring ─────────────────────────────────────────────────────────

const panel = read('src/ui/components/ProjectTreePanel.tsx');
assert.ok(
  panel.includes("selectedPreview?.kind === 'csv'") && panel.includes('<CsvPreview'),
  'ProjectTreePanel must render CsvPreview for csv previews'
);
assert.ok(
  panel.includes("selectedPreview?.kind === 'xlsx'") && panel.includes('<XlsxPreview'),
  'ProjectTreePanel must render XlsxPreview for xlsx previews'
);

const spreadsheet = read('src/ui/components/SpreadsheetPreview.tsx');
assert.ok(
  spreadsheet.includes("await import('exceljs')"),
  'exceljs must load lazily so it stays out of the initial bundle'
);

const packageJson = JSON.parse(read('package.json'));
assert.ok(packageJson.dependencies?.exceljs, 'package.json must depend on exceljs');

console.log('verify-spreadsheet-preview: OK');

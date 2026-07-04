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

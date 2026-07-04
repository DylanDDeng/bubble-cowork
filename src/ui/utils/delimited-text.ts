// Pure delimited-text helpers for the spreadsheet preview. No imports so the
// verify script can load this file directly with node --experimental-strip-types.

export type SheetRows = string[][];

// RFC 4180-style parsing: quoted fields may contain the delimiter, newlines,
// and doubled quotes as escapes. Both \n and \r\n row endings are accepted.
export function parseDelimitedText(text: string, delimiter: string): SheetRows {
  const rows: SheetRows = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      pushField();
    } else if (ch === '\n') {
      pushRow();
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      pushRow();
    } else {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    pushRow();
  }

  // A trailing newline produces one empty last row; drop it.
  const last = rows[rows.length - 1];
  if (last && last.length === 1 && last[0] === '') {
    rows.pop();
  }

  return rows;
}

// Pick the delimiter that splits the first line into the most fields.
// Quotes are respected by counting only delimiters outside quoted runs.
export function sniffDelimiter(text: string, ext: string): string {
  if (ext === '.tsv') return '\t';

  const newlineIndex = text.indexOf('\n');
  const firstLine = text.slice(0, newlineIndex === -1 ? text.length : newlineIndex);
  let best = ',';
  let bestCount = 0;
  for (const candidate of [',', ';', '\t']) {
    let count = 0;
    let inQuotes = false;
    for (const ch of firstLine) {
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === candidate && !inQuotes) count += 1;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

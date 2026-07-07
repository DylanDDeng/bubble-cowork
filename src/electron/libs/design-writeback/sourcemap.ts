// Minimal inline-sourcemap decoding for anchor resolution.
//
// Modern @vitejs/plugin-react (esbuild jsxDev path) reports fiber debugSource
// line numbers in TRANSFORMED module coordinates (the refresh preamble shifts
// everything down), not original source lines. The dev server serves each
// module with an inline base64 sourcemap — decoding it maps the fiber's
// generated position back to the real source line. No dependency; standard
// VLQ per the Source Map v3 spec.

export interface ParsedSourceMap {
  version: number;
  sources: string[];
  mappings: string;
  sourceRoot?: string;
}

export function extractInlineSourceMap(moduleCode: string): ParsedSourceMap | null {
  const match = /\/\/#\s*sourceMappingURL=data:application\/json[^,]*;base64,([A-Za-z0-9+/=]+)/.exec(moduleCode);
  if (!match) return null;
  try {
    const parsed = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) as ParsedSourceMap;
    if (!parsed || typeof parsed.mappings !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CHAR_TO_INT = new Map<string, number>([...BASE64_CHARS].map((char, index) => [char, index]));

function decodeVlqSegment(segment: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = CHAR_TO_INT.get(char);
    if (digit === undefined) return values;
    const continuation = digit & 32;
    value += (digit & 31) << shift;
    if (continuation) {
      shift += 5;
    } else {
      const negative = value & 1;
      value >>>= 1;
      values.push(negative ? -value : value);
      value = 0;
      shift = 0;
    }
  }
  return values;
}

export interface OriginalPosition {
  /** Index into map.sources. */
  sourceIndex: number;
  /** 1-based original line. */
  line: number;
  /** 0-based original column. */
  column: number;
}

/**
 * Map a generated position to its original position. generatedLine is
 * 1-based, generatedColumn 0-based (spec convention). Picks the last mapping
 * segment at or before the requested column on that line; falls back to the
 * line's first segment (fiber columns vary in convention across toolchains,
 * and for line remapping the line component is what matters).
 */
export function originalPositionFor(
  map: ParsedSourceMap,
  generatedLine: number,
  generatedColumn: number
): OriginalPosition | null {
  const lines = map.mappings.split(';');
  if (generatedLine < 1 || generatedLine > lines.length) return null;

  // VLQ fields are deltas across the whole file — walk from the start.
  let sourceIndex = 0;
  let originalLine = 0; // 0-based accumulator
  let originalColumn = 0;
  let best: OriginalPosition | null = null;
  let first: OriginalPosition | null = null;

  for (let lineIndex = 0; lineIndex < generatedLine; lineIndex += 1) {
    const segments = lines[lineIndex].split(',');
    let generatedCol = 0;
    for (const segment of segments) {
      if (!segment) continue;
      const fields = decodeVlqSegment(segment);
      if (fields.length === 0) continue;
      generatedCol += fields[0];
      if (fields.length >= 4) {
        sourceIndex += fields[1];
        originalLine += fields[2];
        originalColumn += fields[3];
        if (lineIndex === generatedLine - 1) {
          const position: OriginalPosition = {
            sourceIndex,
            line: originalLine + 1,
            column: originalColumn,
          };
          if (!first) first = position;
          if (generatedCol <= generatedColumn) best = position;
        }
      }
    }
  }
  return best ?? first;
}

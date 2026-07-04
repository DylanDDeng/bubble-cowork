// Chart extraction for the xlsx preview. Charts are re-rendered from the
// cached data points (`numCache`/`strCache`) that every chart XML part embeds,
// so no formula/range resolution is needed. Parsing is namespace-agnostic
// (localName-based) because Excel writes `c:`-prefixed nodes while openpyxl
// writes the same tree in a default namespace. Uses @xmldom/xmldom so the
// verify script can run this file under plain node.

import { unzipSync, strFromU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';

export interface XlsxRangeRef {
  sheet: string;
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
}

export interface XlsxChartSeries {
  name: string;
  color: string | null;
  /** Cached values from the chart part; unreliable (openpyxl caches zeros). */
  values: Array<number | null>;
  valuesRef: XlsxRangeRef | null;
}

export interface XlsxChart {
  type: 'bar' | 'barH' | 'line' | 'pie' | 'area';
  title: string;
  categories: Array<string | null>;
  categoriesRef: XlsxRangeRef | null;
  series: XlsxChartSeries[];
}

/** Chart with refs resolved against live sheet data, ready to render. */
export interface ResolvedXlsxChart {
  type: XlsxChart['type'];
  title: string;
  categories: string[];
  series: Array<{ name: string; color: string | null; values: Array<number | null> }>;
}

export type XlsxRangeResolver = (ref: XlsxRangeRef) => Array<unknown> | null;

type XmlNode = {
  nodeType: number;
  localName?: string | null;
  childNodes?: ArrayLike<XmlNode>;
  getAttribute?: (name: string) => string | null;
  textContent?: string | null;
};

function childrenByLocalName(node: XmlNode, localName: string): XmlNode[] {
  const result: XmlNode[] = [];
  const children = node.childNodes;
  if (!children) return result;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child.nodeType === 1 && child.localName === localName) {
      result.push(child);
    }
  }
  return result;
}

function firstByPath(node: XmlNode, path: string[]): XmlNode | null {
  let current: XmlNode | null = node;
  for (const segment of path) {
    if (!current) return null;
    current = childrenByLocalName(current, segment)[0] ?? null;
  }
  return current;
}

function descendantsByLocalName(node: XmlNode, localName: string, limit = Infinity): XmlNode[] {
  const result: XmlNode[] = [];
  const walk = (current: XmlNode) => {
    if (result.length >= limit) return;
    const children = current.childNodes;
    if (!children) return;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child.nodeType !== 1) continue;
      if (child.localName === localName) {
        result.push(child);
        if (result.length >= limit) return;
      }
      walk(child);
    }
  };
  walk(node);
  return result;
}

// Resolve a relationship target against the directory of the .rels owner.
// openpyxl writes absolute targets ("/xl/charts/chart1.xml"), Excel writes
// relative ones ("../charts/chart1.xml").
function resolveRelTarget(target: string, baseDir: string): string {
  if (target.startsWith('/')) {
    return target.slice(1);
  }
  const parts = `${baseDir}/${target}`.split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '..') resolved.pop();
    else if (part !== '.' && part !== '') resolved.push(part);
  }
  return resolved.join('/');
}

function parseXml(entries: Record<string, Uint8Array>, path: string): XmlNode | null {
  const data = entries[path];
  if (!data) return null;
  try {
    return new DOMParser().parseFromString(strFromU8(data), 'text/xml') as unknown as XmlNode;
  } catch {
    return null;
  }
}

function readRels(
  entries: Record<string, Uint8Array>,
  ownerPath: string
): Map<string, { type: string; target: string }> {
  const result = new Map<string, { type: string; target: string }>();
  const dir = ownerPath.split('/').slice(0, -1).join('/');
  const name = ownerPath.split('/').pop() || '';
  const relsDoc = parseXml(entries, `${dir}/_rels/${name}.rels`);
  if (!relsDoc) return result;
  for (const rel of descendantsByLocalName(relsDoc, 'Relationship')) {
    const id = rel.getAttribute?.('Id') || '';
    const type = rel.getAttribute?.('Type') || '';
    const target = rel.getAttribute?.('Target') || '';
    if (id && target) {
      result.set(id, { type, target: resolveRelTarget(target, dir) });
    }
  }
  return result;
}

function readCachePoints(cacheNode: XmlNode | null): Array<string | null> {
  if (!cacheNode) return [];
  const countAttr = firstByPath(cacheNode, ['ptCount'])?.getAttribute?.('val');
  const count = countAttr ? Number(countAttr) : 0;
  const points: Array<string | null> = new Array(Number.isFinite(count) ? count : 0).fill(null);
  for (const pt of childrenByLocalName(cacheNode, 'pt')) {
    const idx = Number(pt.getAttribute?.('idx') || '');
    const value = childrenByLocalName(pt, 'v')[0]?.textContent ?? null;
    if (Number.isFinite(idx)) {
      if (idx >= points.length) points.length = idx + 1;
      points[idx] = value;
    }
  }
  return points;
}

function readSeriesCache(
  container: XmlNode | null
): { strings: Array<string | null>; numbers: Array<string | null>; ref: XlsxRangeRef | null } {
  if (!container) return { strings: [], numbers: [], ref: null };
  const ref = childrenByLocalName(container, 'strRef')[0] || childrenByLocalName(container, 'numRef')[0];
  const source = ref ?? container;
  const formula = ref ? childrenByLocalName(ref, 'f')[0]?.textContent : null;
  return {
    strings: readCachePoints(childrenByLocalName(source, 'strCache')[0] ?? null),
    numbers: readCachePoints(childrenByLocalName(source, 'numCache')[0] ?? null),
    ref: parseRangeRef(formula),
  };
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function serialDateLabel(serial: number): string {
  const date = new Date(Math.round((serial - 25569) * 86400000));
  return `${MONTH_LABELS[date.getUTCMonth()]}-${String(date.getUTCFullYear() % 100).padStart(2, '0')}`;
}

// Excel serial date → "Jan-25" style label. Only applied when every numeric
// category falls in a plausible date range, so plain numeric axes stay numeric.
function formatCategoryLabels(raw: Array<unknown>): string[] {
  const numbers = raw.map((value) =>
    typeof value === 'number' ? value : value == null || value === '' ? NaN : Number(value)
  );
  const allSerialDates =
    numbers.length > 0 &&
    numbers.every((value) => Number.isFinite(value) && value > 20000 && value < 80000);
  if (allSerialDates) {
    return numbers.map(serialDateLabel);
  }
  return raw.map((value) => {
    if (value == null) return '';
    if (value instanceof Date) {
      return `${MONTH_LABELS[value.getUTCMonth()]}-${String(value.getUTCFullYear() % 100).padStart(2, '0')}`;
    }
    return String(value);
  });
}

// Parse "'03_月度利润表'!$C$3:$Z$3" (quotes optional, single cells allowed).
export function parseRangeRef(formula: string | null | undefined): XlsxRangeRef | null {
  if (!formula) return null;
  const match = formula
    .trim()
    .match(/^(?:'((?:[^']|'')+)'|([^'!]+))!\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i);
  if (!match) return null;
  const sheet = (match[1] ? match[1].replace(/''/g, "'") : match[2] || '').trim();
  const colToIndex = (letters: string) =>
    letters
      .toUpperCase()
      .split('')
      .reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0);
  const startCol = colToIndex(match[3]);
  const startRow = Number(match[4]);
  const endCol = match[5] ? colToIndex(match[5]) : startCol;
  const endRow = match[6] ? Number(match[6]) : startRow;
  if (!sheet || !Number.isFinite(startRow) || !Number.isFinite(endRow)) return null;
  return {
    sheet,
    startCol: Math.min(startCol, endCol),
    startRow: Math.min(startRow, endRow),
    endCol: Math.max(startCol, endCol),
    endRow: Math.max(startRow, endRow),
  };
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Resolve a chart's ranges against live sheet data. Chart parts cache their
 * data points, but non-Excel producers cache zeros (openpyxl never evaluates
 * formulas) or omit the cache entirely, so live values win whenever the
 * resolver can produce anything non-empty.
 */
export function resolveXlsxChart(chart: XlsxChart, resolve: XlsxRangeResolver): ResolvedXlsxChart {
  const resolveOrNull = (ref: XlsxRangeRef | null): Array<unknown> | null => {
    if (!ref) return null;
    try {
      const values = resolve(ref);
      return values && values.some((value) => value != null && value !== '') ? values : null;
    } catch {
      return null;
    }
  };

  const categoriesSource = resolveOrNull(chart.categoriesRef) ?? chart.categories;
  const categories = formatCategoryLabels(categoriesSource);

  const series = chart.series.map((entry) => {
    const resolved = resolveOrNull(entry.valuesRef);
    const values = resolved
      ? resolved.map(toNumberOrNull)
      : entry.values;
    return { name: entry.name, color: entry.color, values };
  });

  return { type: chart.type, title: chart.title, categories, series };
}

function readSeriesColor(serNode: XmlNode): string | null {
  const spPr = childrenByLocalName(serNode, 'spPr')[0];
  if (!spPr) return null;
  const srgb = descendantsByLocalName(spPr, 'srgbClr', 1)[0];
  const value = srgb?.getAttribute?.('val');
  return value ? `#${value}` : null;
}

function readChartTitle(chartSpace: XmlNode): string {
  const title = firstByPath(chartSpace, ['chart', 'title']);
  if (!title) return '';
  return descendantsByLocalName(title, 't')
    .map((node) => node.textContent || '')
    .join('')
    .trim();
}

const PLOT_NODE_TYPES: Array<{ local: string; type: XlsxChart['type'] }> = [
  { local: 'barChart', type: 'bar' },
  { local: 'lineChart', type: 'line' },
  { local: 'pieChart', type: 'pie' },
  { local: 'doughnutChart', type: 'pie' },
  { local: 'areaChart', type: 'area' },
];

function parseChartXml(doc: XmlNode): XlsxChart | null {
  const chartSpace = childrenByLocalName(doc, 'chartSpace')[0] ?? doc;
  const plotArea = firstByPath(chartSpace, ['chart', 'plotArea']);
  if (!plotArea) return null;

  for (const { local, type } of PLOT_NODE_TYPES) {
    const plot = childrenByLocalName(plotArea, local)[0];
    if (!plot) continue;

    let chartType: XlsxChart['type'] = type;
    if (local === 'barChart') {
      const barDir = childrenByLocalName(plot, 'barDir')[0]?.getAttribute?.('val');
      chartType = barDir === 'bar' ? 'barH' : 'bar';
    }

    let categories: Array<string | null> = [];
    let categoriesRef: XlsxRangeRef | null = null;
    const series: XlsxChartSeries[] = [];
    for (const ser of childrenByLocalName(plot, 'ser')) {
      const tx = childrenByLocalName(ser, 'tx')[0];
      const txCache = readSeriesCache(tx ?? null);
      const inlineName = tx ? childrenByLocalName(tx, 'v')[0]?.textContent : null;
      const name = (inlineName || txCache.strings.find(Boolean) || `Series ${series.length + 1}`).trim();

      const catCache = readSeriesCache(childrenByLocalName(ser, 'cat')[0] ?? null);
      const rawCategories = catCache.strings.length > 0 ? catCache.strings : catCache.numbers;
      if (rawCategories.length > categories.length) {
        categories = rawCategories;
      }
      if (!categoriesRef && catCache.ref) {
        categoriesRef = catCache.ref;
      }

      const valCache = readSeriesCache(childrenByLocalName(ser, 'val')[0] ?? null);
      const values = valCache.numbers.map((value) => {
        if (value === null || value === '') return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      });

      series.push({ name, color: readSeriesColor(ser), values, valuesRef: valCache.ref });
    }

    if (series.length === 0) return null;
    return { type: chartType, title: readChartTitle(chartSpace), categories, categoriesRef, series };
  }

  return null;
}

/**
 * Extract every chart in the workbook, grouped by sheet name (in workbook
 * sheet order, charts in drawing order). Returns an empty map when the file
 * has no charts or any structural piece is missing.
 */
export function extractXlsxCharts(bytes: Uint8Array): Map<string, XlsxChart[]> {
  const result = new Map<string, XlsxChart[]>();
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    return result;
  }

  const workbookDoc = parseXml(entries, 'xl/workbook.xml');
  if (!workbookDoc) return result;
  const workbookRels = readRels(entries, 'xl/workbook.xml');

  for (const sheetNode of descendantsByLocalName(workbookDoc, 'sheet')) {
    const sheetName = sheetNode.getAttribute?.('name') || '';
    const relId =
      sheetNode.getAttribute?.('r:id') || sheetNode.getAttribute?.('id') || '';
    const sheetTarget = workbookRels.get(relId)?.target;
    if (!sheetName || !sheetTarget) continue;

    const sheetRels = readRels(entries, sheetTarget);
    const charts: XlsxChart[] = [];
    for (const rel of sheetRels.values()) {
      if (!rel.type.endsWith('/drawing')) continue;
      const drawingRels = readRels(entries, rel.target);
      for (const drawingRel of drawingRels.values()) {
        if (!drawingRel.type.endsWith('/chart')) continue;
        const chartDoc = parseXml(entries, drawingRel.target);
        if (!chartDoc) continue;
        const chart = parseChartXml(chartDoc);
        if (chart) charts.push(chart);
      }
    }
    if (charts.length > 0) {
      result.set(sheetName, charts);
    }
  }

  return result;
}

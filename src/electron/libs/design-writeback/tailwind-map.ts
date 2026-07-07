// Deterministic CSS edit → Tailwind class mapping.
//
// The mapping is UNCONDITIONALLY total for supported properties: exact
// standard-scale tokens when the value matches, arbitrary values (`p-[22px]`)
// otherwise. That is what makes path 1 of the write-back engine deterministic
// without ever parsing the user's tailwind config (v4 may not even have a JS
// config). Scale mismatches against a customized config are caught by the
// verify loop, not here.
import { twMerge } from 'tailwind-merge';

export interface ClassMapping {
  /** The tailwind class to add, e.g. "p-6" or "p-[22px]". */
  className: string;
  /**
   * CSS properties this class is EXPECTED to change besides the requested one
   * (e.g. text-lg also sets line-height). The verify loop must not treat
   * these as collateral damage.
   */
  alsoAffects: string[];
}

/** Tailwind numeric spacing scale (rem*4 = the number; value in px). */
const SPACING_PX = new Map<number, string>([
  [0, '0'], [1, 'px'], [2, '0.5'], [4, '1'], [6, '1.5'], [8, '2'],
  [10, '2.5'], [12, '3'], [14, '3.5'], [16, '4'], [20, '5'], [24, '6'],
  [28, '7'], [32, '8'], [36, '9'], [40, '10'], [44, '11'], [48, '12'],
  [56, '14'], [64, '16'], [80, '20'], [96, '24'], [112, '28'], [128, '32'],
]);

/** font-size px → text-* token (Tailwind default type scale). */
const FONT_SIZE_PX = new Map<number, string>([
  [12, 'text-xs'], [14, 'text-sm'], [16, 'text-base'], [18, 'text-lg'],
  [20, 'text-xl'], [24, 'text-2xl'], [30, 'text-3xl'], [36, 'text-4xl'],
  [48, 'text-5xl'], [60, 'text-6xl'],
]);

const FONT_WEIGHT = new Map<number, string>([
  [100, 'font-thin'], [200, 'font-extralight'], [300, 'font-light'],
  [400, 'font-normal'], [500, 'font-medium'], [600, 'font-semibold'],
  [700, 'font-bold'], [800, 'font-extrabold'], [900, 'font-black'],
]);

/** border-radius px → rounded-* (Tailwind v4 naming). */
const RADIUS_PX_V4 = new Map<number, string>([
  [0, 'rounded-none'], [2, 'rounded-xs'], [4, 'rounded-sm'], [6, 'rounded-md'],
  [8, 'rounded-lg'], [12, 'rounded-xl'], [16, 'rounded-2xl'], [24, 'rounded-3xl'],
]);

const SPACING_PREFIX: Record<string, string> = {
  'padding': 'p',
  'padding-top': 'pt',
  'padding-right': 'pr',
  'padding-bottom': 'pb',
  'padding-left': 'pl',
  'padding-inline': 'px',
  'padding-block': 'py',
  'margin': 'm',
  'margin-top': 'mt',
  'margin-right': 'mr',
  'margin-bottom': 'mb',
  'margin-left': 'ml',
  'margin-inline': 'mx',
  'margin-block': 'my',
  'gap': 'gap',
  'column-gap': 'gap-x',
  'row-gap': 'gap-y',
  'width': 'w',
  'height': 'h',
};

const COLOR_PREFIX: Record<string, string> = {
  'color': 'text',
  'background-color': 'bg',
  'border-color': 'border',
};

function parsePx(value: string): number | null {
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]);
}

/** Arbitrary-value escaping: spaces become underscores per Tailwind rules. */
function arbitrary(prefix: string, rawValue: string): string {
  return `${prefix}-[${rawValue.trim().replace(/\s+/g, '_')}]`;
}

/**
 * Map a single CSS property edit to a Tailwind class. Returns null only for
 * properties the mapper does not support at all (caller should fall back to
 * another write path / agent), never for unsupported values.
 */
export function mapEditToClass(property: string, value: string): ClassMapping | null {
  const prop = property.trim().toLowerCase();
  const spacingPrefix = SPACING_PREFIX[prop];
  if (spacingPrefix) {
    const px = parsePx(value);
    if (px !== null && px >= 0 && SPACING_PX.has(px)) {
      return { className: `${spacingPrefix}-${SPACING_PX.get(px)}`, alsoAffects: [] };
    }
    return { className: arbitrary(spacingPrefix, value), alsoAffects: [] };
  }

  const colorPrefix = COLOR_PREFIX[prop];
  if (colorPrefix) {
    // Colors are ALWAYS arbitrary values: matching against the palette would
    // require the resolved theme (oklch in v4) and buys nothing — the picker
    // hands us a concrete color anyway.
    return { className: arbitrary(colorPrefix, value), alsoAffects: [] };
  }

  if (prop === 'font-size') {
    const px = parsePx(value);
    const scaled = px !== null ? FONT_SIZE_PX.get(px) : undefined;
    if (scaled) {
      // Scale tokens also set line-height — declare it so the verify loop
      // whitelists the co-change instead of flagging collateral damage.
      return { className: scaled, alsoAffects: ['line-height'] };
    }
    return { className: arbitrary('text', value), alsoAffects: [] };
  }

  if (prop === 'font-weight') {
    const numeric = Number(value.trim());
    const token = FONT_WEIGHT.get(numeric);
    if (token) return { className: token, alsoAffects: [] };
    return { className: arbitrary('font', value), alsoAffects: [] };
  }

  if (prop === 'border-radius') {
    const px = parsePx(value);
    const token = px !== null ? RADIUS_PX_V4.get(px) : undefined;
    if (token) return { className: token, alsoAffects: [] };
    if (value.trim() === '9999px') return { className: 'rounded-full', alsoAffects: [] };
    return { className: arbitrary('rounded', value), alsoAffects: [] };
  }

  if (prop === 'opacity') {
    const numeric = Number(value.trim());
    if (Number.isFinite(numeric) && numeric >= 0 && numeric <= 1) {
      const pct = Math.round(numeric * 100);
      if (pct % 5 === 0) return { className: `opacity-${pct}`, alsoAffects: [] };
      return { className: arbitrary('opacity', String(numeric)), alsoAffects: [] };
    }
    return null;
  }

  return null;
}

/**
 * An arbitrary value whose class group tailwind-merge cannot infer reliably:
 * bare CSS variable / var() without a type hint (`text-[var(--x)]` — color or
 * size?). Red-team finding B4: twMerge may drop these as false conflicts.
 */
function isAmbiguousArbitrary(token: string): boolean {
  const bracket = /\[([^\]]*)\]/.exec(token);
  if (!bracket) return false;
  const inner = bracket[1];
  if (/^[a-z-]+:/.test(inner)) return false; // typed hint like [color:var(--x)]
  return inner.includes('var(');
}

export interface MergeResult {
  merged: string;
  /** Original tokens twMerge dropped and we deliberately restored. */
  preserved: string[];
}

/**
 * Merge a new class into an existing className string via twMerge, then
 * restore any ambiguous var()-arbitrary tokens twMerge dropped (we refuse to
 * delete what we cannot classify — the verify loop arbitrates the outcome).
 */
export function mergeClassName(existing: string, addition: string): MergeResult {
  const merged = twMerge(`${existing} ${addition}`.trim());
  const mergedTokens = new Set(merged.split(/\s+/).filter(Boolean));
  const preserved: string[] = [];
  for (const token of existing.split(/\s+/).filter(Boolean)) {
    if (!mergedTokens.has(token) && isAmbiguousArbitrary(token)) {
      preserved.push(token);
    }
  }
  const finalMerged = preserved.length > 0 ? `${preserved.join(' ')} ${merged}` : merged;
  return { merged: finalMerged, preserved };
}

/**
 * Responsive/state variant awareness (red-team C4): when the currently
 * winning class for the edited property carries a variant prefix (md:, lg:,
 * hover:), the replacement must target the same variant or it will be
 * overridden right back.
 */
export function applyVariantHint(className: string, variantHint: string | null | undefined): string {
  const hint = (variantHint || '').trim();
  if (!hint) return className;
  const prefix = hint.endsWith(':') ? hint : `${hint}:`;
  return `${prefix}${className}`;
}

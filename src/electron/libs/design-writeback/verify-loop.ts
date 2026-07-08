// Pure decision core of the verify loop. The service feeds it measurements
// taken AFTER stripping the preview (red-team A1) and AFTER the settle poll
// (red-team A3); this module only classifies. Three-state outcome per the
// v2 plan: verified / failed(with category) / unverified(kept, flagged).

export interface EditedPropCheck {
  /** Property as edited (may be shorthand like 'padding'). */
  property: string;
  /** Expected value, e.g. '24px' or '#1a2b3c'. */
  expected: string;
}

export interface VerificationInput {
  /** Element re-located after HMR? */
  found: boolean;
  /** Settle poll gave up waiting for the added classes to appear. */
  timedOut: boolean;
  /** Vite build-error overlay present (category a → auto rollback). */
  viteErrorOverlay: boolean;
  /** After stripping the preview, computed ALREADY equalled the target — the measurement cannot distinguish success from leftover preview. */
  sanitySuspect: boolean;
  /** class attribute after settle. */
  classList: string | null;
  addedClasses: string[];
  removedClasses: string[];
  edits: EditedPropCheck[];
  /** Computed snapshot at selection time (pre-edit). */
  baseline: Record<string, string> | null;
  /** Computed snapshot after settle. */
  current: Record<string, string> | null;
  /** Properties the mapping legitimately co-changes (e.g. line-height). */
  alsoAffects: string[];
}

export type VerificationVerdict =
  | { state: 'verified'; detail: string }
  | { state: 'unverified'; reason: 'element-missing' | 'hmr-timeout' | 'sanity-suspect'; detail: string }
  | {
      state: 'failed';
      reason: 'build-error' | 'not-applied' | 'overridden' | 'collateral';
      detail: string;
      autoRollback: boolean;
    };

/** Shorthand edit → the computed longhand properties it must land on. */
export function expandEditProperties(property: string): string[] {
  switch (property) {
    case 'padding':
      return ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'];
    case 'padding-inline':
      return ['padding-left', 'padding-right'];
    case 'padding-block':
      return ['padding-top', 'padding-bottom'];
    case 'margin':
      return ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'];
    case 'margin-inline':
      return ['margin-left', 'margin-right'];
    case 'margin-block':
      return ['margin-top', 'margin-bottom'];
    case 'gap':
      return ['column-gap', 'row-gap'];
    default:
      return [property];
  }
}

function normalizeColor(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(trimmed);
  if (hex) {
    let raw = hex[1];
    if (raw.length === 3) raw = raw.split('').map((c) => c + c).join('');
    const r = parseInt(raw.slice(0, 2), 16);
    const g = parseInt(raw.slice(2, 4), 16);
    const b = parseInt(raw.slice(4, 6), 16);
    return `rgb(${r}, ${g}, ${b})`;
  }
  return trimmed.replace(/\s+/g, ' ').replace(/,\s*/g, ', ');
}

const PX_TOLERANCE = 0.75;

export function valuesMatch(expected: string, measured: string | undefined | null): boolean {
  if (measured === undefined || measured === null) return false;
  const expectedPx = /^(-?\d+(?:\.\d+)?)px$/.exec(expected.trim());
  const measuredPx = /^(-?\d+(?:\.\d+)?)px$/.exec(measured.trim());
  if (expectedPx && measuredPx) {
    return Math.abs(Number(expectedPx[1]) - Number(measuredPx[1])) <= PX_TOLERANCE;
  }
  if (expected.trim().startsWith('#') || /^rgb/.test(expected.trim())) {
    return normalizeColor(expected) === normalizeColor(measured);
  }
  return expected.trim() === measured.trim();
}

/** Geometry follows from spacing edits legitimately — never collateral. */
const COLLATERAL_EXEMPT = new Set(['width', 'height', 'rect']);

/**
 * Properties whose initial value is `currentColor`: editing `color` changes
 * their computed value as pure CSS semantics, not collateral damage.
 */
const CURRENT_COLOR_DERIVED = [
  'border-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'caret-color',
  'outline-color',
  'text-decoration-color',
  'column-rule-color',
];

export function classifyVerification(input: VerificationInput): VerificationVerdict {
  if (input.viteErrorOverlay) {
    return {
      state: 'failed',
      reason: 'build-error',
      detail: 'the dev server reported a build error after the write',
      autoRollback: true,
    };
  }
  if (!input.found) {
    return {
      state: 'unverified',
      reason: 'element-missing',
      detail: 'element not present after update (conditional UI / remount) — write kept, re-verify by reproducing the UI state',
    };
  }
  if (input.timedOut) {
    return {
      state: 'unverified',
      reason: 'hmr-timeout',
      detail: 'no page update observed (dev server without HMR?) — write kept, not rolled back',
    };
  }

  const classTokens = new Set((input.classList || '').split(/\s+/).filter(Boolean));
  const missingAdded = input.addedClasses.filter((token) => !classTokens.has(token));
  if (missingAdded.length > 0) {
    return {
      state: 'failed',
      reason: 'not-applied',
      detail: `written classes never reached the DOM: ${missingAdded.join(' ')}`,
      autoRollback: true,
    };
  }
  const lingeringRemoved = input.removedClasses.filter((token) => classTokens.has(token));
  if (lingeringRemoved.length > 0) {
    return {
      state: 'failed',
      reason: 'collateral',
      detail: `classes removed in source still on the element: ${lingeringRemoved.join(' ')}`,
      autoRollback: false,
    };
  }

  const mismatches: string[] = [];
  for (const edit of input.edits) {
    for (const prop of expandEditProperties(edit.property)) {
      const measured = input.current?.[prop];
      if (!valuesMatch(edit.expected, measured)) {
        mismatches.push(`${prop}: expected ${edit.expected}, got ${measured ?? 'n/a'}`);
      }
    }
  }
  if (mismatches.length > 0) {
    return {
      state: 'failed',
      reason: 'overridden',
      // Category (b): the source edit may be exactly what the user wants —
      // a higher-priority rule is overriding it. Keep the code, let the user
      // choose (keep / rollback / hand to agent).
      detail: mismatches.join('; '),
      autoRollback: false,
    };
  }

  if (input.baseline && input.current) {
    const allowed = new Set<string>(input.alsoAffects);
    for (const edit of input.edits) {
      for (const prop of expandEditProperties(edit.property)) allowed.add(prop);
    }
    if (allowed.has('color')) {
      for (const prop of CURRENT_COLOR_DERIVED) allowed.add(prop);
    }
    const collateral: string[] = [];
    for (const prop of Object.keys(input.baseline)) {
      if (allowed.has(prop) || COLLATERAL_EXEMPT.has(prop)) continue;
      const before = input.baseline[prop];
      const after = input.current[prop];
      if (before !== undefined && after !== undefined && before.trim() !== after.trim()) {
        collateral.push(`${prop}: ${before} → ${after}`);
      }
    }
    if (collateral.length > 0) {
      return {
        state: 'failed',
        reason: 'collateral',
        detail: `unrelated properties changed: ${collateral.slice(0, 5).join('; ')}${collateral.length > 5 ? ' …' : ''}`,
        autoRollback: false,
      };
    }
  }

  if (input.sanitySuspect) {
    return {
      state: 'unverified',
      reason: 'sanity-suspect',
      detail: 'computed already matched the target before the write landed — verification cannot distinguish success from a stale measurement',
    };
  }

  return { state: 'verified', detail: 'all edited properties landed; no collateral changes' };
}

import assert from 'node:assert/strict';
import {
  classifyVerification,
  expandEditProperties,
  valuesMatch,
  type VerificationInput,
} from '../../src/electron/libs/design-writeback/verify-loop';

function base(overrides: Partial<VerificationInput>): VerificationInput {
  return {
    found: true,
    timedOut: false,
    viteErrorOverlay: false,
    sanitySuspect: false,
    classList: 'p-6 bg-blue-500',
    addedClasses: ['p-6'],
    removedClasses: ['px-4', 'py-2'],
    edits: [{ property: 'padding', expected: '24px' }],
    baseline: {
      'padding-top': '8px', 'padding-right': '16px', 'padding-bottom': '8px', 'padding-left': '16px',
      'color': 'rgb(0, 0, 0)', 'background-color': 'rgb(59, 130, 246)',
    },
    current: {
      'padding-top': '24px', 'padding-right': '24px', 'padding-bottom': '24px', 'padding-left': '24px',
      'color': 'rgb(0, 0, 0)', 'background-color': 'rgb(59, 130, 246)',
    },
    alsoAffects: [],
    ...overrides,
  };
}

// ── value matching: px tolerance, hex↔rgb colors ────────────────────────────
{
  assert.ok(valuesMatch('24px', '24px'));
  assert.ok(valuesMatch('24px', '24.5px'), 'sub-tolerance px diff matches');
  assert.ok(!valuesMatch('24px', '18.3px'), 'transition mid-value must NOT match');
  assert.ok(valuesMatch('#1a2b3c', 'rgb(26, 43, 60)'), 'hex vs computed rgb');
  assert.ok(valuesMatch('600', '600'));
  assert.ok(!valuesMatch('24px', null));
}

// ── shorthand expansion ──────────────────────────────────────────────────────
{
  assert.deepEqual(expandEditProperties('padding'), ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']);
  assert.deepEqual(expandEditProperties('margin-inline'), ['margin-left', 'margin-right']);
  assert.deepEqual(expandEditProperties('gap'), ['column-gap', 'row-gap']);
  assert.deepEqual(expandEditProperties('color'), ['color']);
}

// ── happy path: verified ─────────────────────────────────────────────────────
{
  const verdict = classifyVerification(base({}));
  assert.equal(verdict.state, 'verified');
}

// ── build error → auto rollback (category a) ─────────────────────────────────
{
  const verdict = classifyVerification(base({ viteErrorOverlay: true }));
  assert.ok(verdict.state === 'failed' && verdict.reason === 'build-error' && verdict.autoRollback);
}

// ── element missing → unverified, write KEPT (red-team A4) ──────────────────
{
  const verdict = classifyVerification(base({ found: false, classList: null, current: null }));
  assert.ok(verdict.state === 'unverified' && verdict.reason === 'element-missing');
}

// ── HMR timeout → unverified, never rollback a possibly-correct write ────────
{
  const verdict = classifyVerification(base({ timedOut: true, classList: 'px-4 py-2 bg-blue-500' }));
  assert.ok(verdict.state === 'unverified' && verdict.reason === 'hmr-timeout');
}

// ── classes never landed → not-applied, auto rollback ────────────────────────
{
  const verdict = classifyVerification(base({ classList: 'px-4 py-2 bg-blue-500' }));
  assert.ok(verdict.state === 'failed' && verdict.reason === 'not-applied' && verdict.autoRollback);
}

// ── target overridden (category b) → failed, KEEP code, no auto rollback ─────
{
  const verdict = classifyVerification(
    base({
      current: {
        'padding-top': '32px', 'padding-right': '32px', 'padding-bottom': '32px', 'padding-left': '32px',
        'color': 'rgb(0, 0, 0)', 'background-color': 'rgb(59, 130, 246)',
      },
    })
  );
  assert.ok(verdict.state === 'failed' && verdict.reason === 'overridden' && !verdict.autoRollback);
}

// ── collateral damage (red-team A5/B2/B4): unrelated property changed ────────
{
  const verdict = classifyVerification(
    base({
      current: {
        'padding-top': '24px', 'padding-right': '24px', 'padding-bottom': '24px', 'padding-left': '24px',
        'color': 'rgb(0, 0, 0)',
        'background-color': 'rgb(255, 255, 255)', // silently lost
      },
    })
  );
  assert.ok(verdict.state === 'failed' && verdict.reason === 'collateral' && !verdict.autoRollback);
}

// ── removed classes still on the element → collateral ────────────────────────
{
  const verdict = classifyVerification(base({ classList: 'p-6 px-4 bg-blue-500' }));
  assert.ok(verdict.state === 'failed' && verdict.reason === 'collateral');
}

// ── alsoAffects whitelists expected co-changes (text-lg → line-height) ───────
{
  const verdict = classifyVerification(
    base({
      addedClasses: ['text-lg'],
      removedClasses: ['text-sm'],
      classList: 'text-lg bg-blue-500',
      edits: [{ property: 'font-size', expected: '18px' }],
      baseline: { 'font-size': '14px', 'line-height': '20px', 'color': 'rgb(0, 0, 0)' },
      current: { 'font-size': '18px', 'line-height': '28px', 'color': 'rgb(0, 0, 0)' },
      alsoAffects: ['line-height'],
    })
  );
  assert.equal(verdict.state, 'verified');
}

// ── sanity suspect (red-team A1): success indistinguishable from stale preview
{
  const verdict = classifyVerification(base({ sanitySuspect: true }));
  assert.ok(verdict.state === 'unverified' && verdict.reason === 'sanity-suspect');
}

// ── editing `color` legitimately moves currentColor-derived properties ──────
//    (field report: border-color followed a text-color edit and the verify
//    loop misreported "Applied but not effective")
{
  const verdict = classifyVerification(
    base({
      addedClasses: ['text-[#060ef9]'],
      removedClasses: [],
      classList: 'text-[#060ef9] bg-blue-500',
      edits: [{ property: 'color', expected: '#060ef9' }],
      baseline: {
        'color': 'rgb(31, 41, 55)',
        'border-color': 'oklch(0.278 0.033 256.848)',
        'background-color': 'rgb(59, 130, 246)',
      },
      current: {
        'color': 'rgb(6, 14, 249)',
        'border-color': 'rgb(6, 14, 249)', // follows currentColor — expected
        'background-color': 'rgb(59, 130, 246)',
      },
    })
  );
  assert.equal(verdict.state, 'verified', `currentColor-derived change is not collateral (got ${JSON.stringify(verdict)})`);
}

// ── geometry consequences of spacing edits are exempt from collateral ────────
{
  const verdict = classifyVerification(
    base({
      baseline: { ...base({}).baseline!, width: '100px', height: '40px' },
      current: { ...base({}).current!, width: '116px', height: '56px' },
    })
  );
  assert.equal(verdict.state, 'verified', 'width/height shifts from padding are not collateral');
}

console.log('design-verify.test.ts passed');

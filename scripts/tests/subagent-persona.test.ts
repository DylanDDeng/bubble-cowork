import assert from 'node:assert/strict';
import { getSubagentPersona } from '../../src/ui/utils/subagent-persona';

// ── Determinism: same id → identical persona/color, every time ─────────────
{
  const a = getSubagentPersona('toolu_01ABC', 'Explore', '产品视角调研');
  const b = getSubagentPersona('toolu_01ABC', 'Explore', '产品视角调研');
  assert.equal(a.persona, b.persona);
  assert.equal(a.colorHue, b.colorHue);
  assert.equal(a.functionalName, b.functionalName);
}

// ── Persona/color depend ONLY on id, not on type/description (no reassignment,
//    no order dependence — the streaming-jitter guarantee). ─────────────────
{
  const withDesc = getSubagentPersona('toolu_stable', 'Explore', 'first description');
  const later = getSubagentPersona('toolu_stable', 'general-purpose', 'a totally different task');
  assert.equal(withDesc.persona, later.persona, 'persona is stable even if type/desc change');
  assert.equal(withDesc.colorHue, later.colorHue, 'color is stable even if type/desc change');
}

// ── Functional name is the primary, self-explanatory label ─────────────────
{
  const p = getSubagentPersona('toolu_x', 'Explore', '产品/文档视角');
  assert.equal(p.functionalName, 'Explore · 产品/文档视角');
}
{
  const p = getSubagentPersona('toolu_y', 'general-purpose', null);
  assert.equal(p.functionalName, 'General-purpose', 'no description → type only');
}
{
  const p = getSubagentPersona('toolu_z', null, null);
  assert.equal(p.functionalName, 'Subagent', 'missing type → Subagent fallback');
}

// ── Long descriptions truncate to a chip-friendly length with ellipsis ─────
{
  const long = 'a'.repeat(100);
  const p = getSubagentPersona('toolu_long', 'Explore', long);
  assert.ok(p.functionalName.length < 60, 'long description is truncated');
  assert.ok(p.functionalName.endsWith('…'), 'truncation adds an ellipsis');
}

// ── Multi-line description uses only the first line ─────────────────────────
{
  const p = getSubagentPersona('toolu_ml', 'Explore', 'first line\nsecond line');
  assert.equal(p.functionalName, 'Explore · first line');
}

// ── Hue is within range; persona is from the pool ──────────────────────────
{
  for (const id of ['a', 'b', 'toolu_01', 'x'.repeat(30)]) {
    const p = getSubagentPersona(id);
    assert.ok(p.colorHue >= 0 && p.colorHue < 360, 'hue in [0,360)');
    assert.ok(p.persona.length > 0, 'persona non-empty');
  }
}

// ── Different ids generally get different personas (distribution sanity) ────
{
  const personas = new Set<string>();
  for (let i = 0; i < 20; i += 1) {
    personas.add(getSubagentPersona(`toolu_${i}`).persona);
  }
  assert.ok(personas.size >= 10, 'a spread of ids yields a spread of personas');
}

// ── shortId is the last 4 chars of the id ──────────────────────────────────
{
  const p = getSubagentPersona('toolu_01ABCDEF');
  assert.equal(p.shortId, 'CDEF');
}

console.log('subagent-persona.test.ts passed');

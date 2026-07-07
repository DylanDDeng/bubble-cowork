import assert from 'node:assert/strict';
import { getSubagentPersona, getSubagentSprite } from '../../src/ui/utils/subagent-persona';

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

// ── Pixel sprite: deterministic, mirrored, readable across many ids ─────────
{
  const ids = ['toolu_01ABC', 'a', 'x'.repeat(30), ...Array.from({ length: 30 }, (_, i) => `toolu_${i}`)];
  for (const id of ids) {
    const grid = getSubagentSprite(id);
    assert.equal(grid.length, 25, '5×5 grid');
    assert.deepEqual(grid, getSubagentSprite(id), 'same id → identical sprite');
    for (const cell of grid) {
      assert.ok(cell === 0 || cell === 1 || cell === 2, 'cells are 0/1/2');
    }
    for (let row = 0; row < 5; row += 1) {
      assert.equal(grid[row * 5], grid[row * 5 + 4], 'cols 0/4 mirror');
      assert.equal(grid[row * 5 + 1], grid[row * 5 + 3], 'cols 1/3 mirror');
    }
    const filled = grid.filter((c) => c !== 0).length;
    assert.ok(filled >= 4, `sprite never near-empty (got ${filled} for ${id})`);
  }
}

// ── Different ids generally get different sprites ────────────────────────────
{
  const sprites = new Set<string>();
  for (let i = 0; i < 20; i += 1) {
    sprites.add(getSubagentSprite(`toolu_${i}`).join(''));
  }
  assert.ok(sprites.size >= 15, 'a spread of ids yields a spread of sprites');
}

console.log('subagent-persona.test.ts passed');

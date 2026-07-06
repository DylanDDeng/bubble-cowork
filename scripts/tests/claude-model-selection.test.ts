import assert from 'node:assert/strict';
import { isSameClaudeModelSelection } from '../../src/electron/libs/claude-model-selection';

// Regression: a session started on a family alias gets its stored model
// overwritten at init with the CLI-resolved CONCRETE id; the composer keeps
// sending the alias. Reading that as a model change made EVERY follow-up
// message abort the warm runner (cold respawn + "Operation aborted" noise).
assert.equal(
  isSameClaudeModelSelection('opus', 'claude-opus-4-8'),
  true,
  'alias vs the concrete id it resolved to is the same selection'
);
assert.equal(
  isSameClaudeModelSelection('claude-opus-4-8', 'opus'),
  true,
  'symmetric: stored alias vs requested concrete of the same family'
);
assert.equal(
  isSameClaudeModelSelection('sonnet', 'claude-sonnet-4-9-20260112'),
  true,
  'any concrete version of the family matches its alias'
);
assert.equal(
  isSameClaudeModelSelection('opus', 'claude-opus-4-8[1m]'),
  true,
  'the 1m-context variant belongs to the same family (betas carry the 1m change)'
);

// Identical strings and normalization equivalences.
assert.equal(isSameClaudeModelSelection('opus', 'opus'), true);
assert.equal(isSameClaudeModelSelection('Opus', 'opus'), true, 'aliases normalize case');
assert.equal(
  isSameClaudeModelSelection('claude-opus-4-8', 'claude-opus-4-8'),
  true,
  'identical concrete ids match'
);

// Real changes must still read as changes.
assert.equal(isSameClaudeModelSelection('opus', 'sonnet'), false, 'different aliases differ');
assert.equal(
  isSameClaudeModelSelection('sonnet', 'claude-opus-4-8'),
  false,
  'alias vs a concrete id of a DIFFERENT family is a change'
);
assert.equal(
  isSameClaudeModelSelection('claude-opus-4-8', 'claude-opus-4-9'),
  false,
  'two different concrete ids are a real change (explicit pins stay honored)'
);
assert.equal(
  isSameClaudeModelSelection(undefined, 'opus'),
  false,
  'missing vs present is a change'
);
assert.equal(isSameClaudeModelSelection('opus', undefined), false);
assert.equal(isSameClaudeModelSelection(undefined, undefined), true, 'both unset is unchanged');

// Unknown model shapes never accidentally match an alias.
assert.equal(
  isSameClaudeModelSelection('opus', 'gpt-omega'),
  false,
  'non-Claude shapes are not family members'
);
assert.equal(
  isSameClaudeModelSelection('opus', 'claude-opusx-1'),
  false,
  'family match requires a word boundary, not a prefix'
);

console.log('claude-model-selection.test: all assertions passed');

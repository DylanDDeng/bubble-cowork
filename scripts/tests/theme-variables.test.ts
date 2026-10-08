import assert from 'node:assert/strict';
import { contrastRatio, hexToOklch, oklchToHex } from '../../src/ui/theme/color';
import { THEME_PRESETS } from '../../src/ui/theme/theme-presets';
import {
  DEFAULT_APPEARANCE,
  applyPreset,
  choiceFor,
  exportTheme,
  importTheme,
  normalizeAppearance,
  parseTheme,
  patchRecipe,
  presetRecipe,
  themeVariables,
} from '../../src/ui/theme/themes';
import type { ThemeVariant } from '../../src/ui/theme/theme-types';

const tokens = (presetId: string, variant: ThemeVariant, contrast?: number) => {
  const recipe = presetRecipe(presetId, variant);
  return themeVariables({ presetId, recipe: contrast === undefined ? recipe : { ...recipe, contrast } }, variant);
};
const solid = /^#[0-9a-f]{6}$/;
const alphaOf = (value: string) => Number(/rgba\([^)]*,\s*([\d.]+)\)$/.exec(value)?.[1]);
const lightness = (hex: string) => hexToOklch(hex).l;

// OKLCH round trip stays within one step per channel.
for (const hex of ['#000000', '#ffffff', '#2563eb', '#cc7d5e', '#1e1e2e', '#1eff5a']) {
  const back = oklchToHex(hexToOklch(hex));
  const delta = Math.max(...[1, 3, 5].map((i) => Math.abs(Number.parseInt(hex.slice(i, i + 2), 16) - Number.parseInt(back.slice(i, i + 2), 16))));
  assert.ok(delta <= 1, `${hex} round-trips (${back})`);
}

// Every preset × variant produces a complete, legible set of tokens.
let checked = 0;
for (const preset of THEME_PRESETS) {
  for (const variant of ['light', 'dark'] as const) {
    if (!preset.variants[variant]) continue;
    const vars = tokens(preset.id, variant);
    const recipe = presetRecipe(preset.id, variant);
    for (const key of ['--bg-primary', '--bg-secondary', '--bg-tertiary', '--app-chrome-bg', '--accent', '--popover-bg']) {
      assert.match(vars[key], solid, `${preset.id}/${variant} ${key} is a solid color`);
    }
    assert.ok(contrastRatio(vars['--accent-foreground'], vars['--accent']) >= 3, `${preset.id}/${variant} text on accent reads`);
    assert.ok(contrastRatio(vars['--code-token-function'], recipe.surface) >= 4.4, `${preset.id}/${variant} accent text reads on the surface`);
    assert.ok(contrastRatio(recipe.ink, vars['--bg-primary']) >= 4.5, `${preset.id}/${variant} body text reads on the canvas`);
    checked += 1;
  }
}
assert.ok(checked >= 34, `checked every preset variant (${checked})`);

// Layers keep their order: raised surfaces sit further toward the ink than the panel.
for (const variant of ['light', 'dark'] as const) {
  const vars = tokens('aegis', variant);
  const toward = variant === 'dark' ? 1 : -1;
  assert.ok((lightness(vars['--bg-tertiary']) - lightness(vars['--bg-secondary'])) * toward > 0, `${variant}: raised is a step past the panel`);
  assert.ok((lightness(vars['--code-block-bg']) - lightness(vars['--bg-tertiary'])) * toward > 0, `${variant}: code blocks are a step past raised`);
}

// Contrast moves the whole hierarchy in one direction.
for (const variant of ['light', 'dark'] as const) {
  const low = tokens('aegis', variant, 10);
  const high = tokens('aegis', variant, 90);
  assert.ok(alphaOf(high['--border']) > alphaOf(low['--border']), `${variant}: borders strengthen`);
  assert.ok(alphaOf(high['--text-muted']) > alphaOf(low['--text-muted']), `${variant}: muted text strengthens`);
  const gap = (vars: Record<string, string>) => Math.abs(lightness(vars['--bg-tertiary']) - lightness(presetRecipe('aegis', variant).surface));
  assert.ok(gap(high) > gap(low), `${variant}: raised layers separate further`);
}

// Window material: translucent sidebars mix with transparency, opaque ones are solid.
assert.match(tokens('aegis', 'light')['--app-sidebar-surface'], /^color-mix\(in srgb, #[0-9a-f]{6} 74%, transparent\)$/);
assert.match(tokens('linear', 'light')['--app-sidebar-surface'], solid);
assert.notEqual(tokens('aegis', 'dark')['--app-sidebar-surface'], tokens('absolutely', 'dark')['--app-sidebar-surface']);
assert.notEqual(tokens('aegis', 'light')['--sidebar-item-hover'], tokens('absolutely', 'light')['--sidebar-item-hover']);

// Signals drive status and code colors; skill chips use the skill color.
const catppuccin = tokens('catppuccin', 'dark');
assert.equal(catppuccin['--success'], '#a6e3a1');
assert.equal(catppuccin['--error'], '#f38ba8');
assert.match(catppuccin['--composer-skill-chip-bg'], /^rgba\(245, 194, 231,/);

// Saved state: old preset ids map to their new names; unknown or unsupported ids fall back.
const migrated = normalizeAppearance({ codeThemeIds: { light: 'codex', dark: 'dp-code' } });
assert.deepEqual(migrated.codeThemeIds, { light: 'aegis', dark: 'harbor' });
assert.equal(normalizeAppearance({ codeThemeIds: { light: 'tokyo-night', dark: 'nope' } }).codeThemeIds.light, 'aegis');
const partial = normalizeAppearance({ chromeThemes: { dark: { surface: '#ABCDEF', ink: 'bad', contrast: 400 } } });
assert.equal(partial.chromeThemes.dark.surface, '#abcdef');
assert.equal(partial.chromeThemes.dark.ink, presetRecipe('aegis', 'dark').ink);
assert.equal(partial.chromeThemes.dark.contrast, 100);

// Presets keep the user's fonts; edits merge.
let state = patchRecipe(DEFAULT_APPEARANCE, 'dark', { fonts: { ui: '"Inter"', code: null } });
state = applyPreset(state, 'dark', 'sentry');
assert.equal(state.codeThemeIds.dark, 'sentry');
assert.equal(state.chromeThemes.dark.surface, presetRecipe('sentry', 'dark').surface);
assert.equal(state.chromeThemes.dark.fonts.ui, '"Inter"');

// Share strings: ours round-trip; Codex-style strings (plain or URI-encoded) import.
const shared = exportTheme('dark', choiceFor(state, 'dark'));
assert.ok(shared.startsWith('aegis-theme-v1:'));
assert.deepEqual(choiceFor(importTheme(DEFAULT_APPEARANCE, 'dark', shared), 'dark'), choiceFor(state, 'dark'));
const foreign = { codeThemeId: 'linear', variant: 'light', theme: { surface: '#fcfcfd', ink: '#1b1b1b', accent: '#5e6ad2', accentSource: 'custom', contrast: 52, opaqueWindows: true, fonts: { ui: 'Inter', code: null }, semanticColors: { diffAdded: '#00a240', diffRemoved: '#ba2623', skill: '#924ff7' } } };
for (const text of [`codex-theme-v1:${JSON.stringify(foreign)}`, `codex-theme-v1:${encodeURIComponent(JSON.stringify(foreign))}`]) {
  const parsed = parseTheme(text);
  assert.equal(parsed.choice.presetId, 'linear');
  assert.equal(parsed.choice.recipe.contrast, 52);
  assert.equal(parsed.choice.recipe.semanticColors.skill, '#924ff7');
}
assert.throws(() => importTheme(DEFAULT_APPEARANCE, 'dark', `codex-theme-v1:${JSON.stringify(foreign)}`), /light theme/);
assert.throws(() => parseTheme('something else'), /aegis-theme-v1/);
assert.throws(() => parseTheme('aegis-theme-v1:{not json'), /valid JSON/);

console.log('theme variables: checks passed');

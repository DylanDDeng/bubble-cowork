import assert from 'node:assert/strict';
import { normalizeAppPreferences } from '../../src/shared/app-preferences';
import { consolidateThemeFonts, DEFAULT_THEME_STATE, DEFAULT_UI_FONT_FAMILY, setThemePackFonts } from '../../src/ui/theme/themes';

const original = setThemePackFonts(DEFAULT_THEME_STATE, 'dark', {ui:'"Georgia"',code:'"Monaco"'});
assert.equal(consolidateThemeFonts(original, DEFAULT_UI_FONT_FAMILY, ''), original, 'old default does not erase theme fonts');
const migrated = consolidateThemeFonts(original, '"Arial"', '"Menlo"');
for (const variant of ['light','dark'] as const) {
  assert.deepEqual(migrated.chromeThemes[variant].fonts, {ui:'"Arial"',code:'"Menlo"'});
  assert.equal(migrated.chromeThemes[variant].accent, original.chromeThemes[variant].accent);
}
assert.equal(consolidateThemeFonts(migrated, '', ''), migrated, 'migration is idempotent');
assert.equal(original.chromeThemes.dark.fonts.ui, '"Georgia"', 'migration does not mutate input');
assert.deepEqual(normalizeAppPreferences({uiFontSize:NaN,codeFontSize:Infinity}),normalizeAppPreferences({}));
assert.equal(normalizeAppPreferences({uiFontSize:100}).uiFontSize,24);
assert.equal(normalizeAppPreferences({codeFontSize:-10}).codeFontSize,10);
assert.equal(normalizeAppPreferences({reduceMotion:'invalid'}).reduceMotion,'system');
for (const reduceMotion of ['system','on','off']) assert.equal(normalizeAppPreferences({reduceMotion}).reduceMotion,reduceMotion);
console.log('Appearance: font migration and preference normalization passed');

// Selected local faces and content inheritance survive export/import and normalization.
const face = {family:'Menlo',fullName:'Menlo Bold',postscriptName:'Menlo-Bold',style:'Bold'};
const withContent = setThemePackFonts(original, 'light', { content:'"Menlo"', contentFace:face });
import { createThemeShareString, importThemeShareString, resolveThemePack, buildThemeVariables } from '../../src/ui/theme/themes';
const imported = importThemeShareString(DEFAULT_THEME_STATE,'light',createThemeShareString('light',resolveThemePack(withContent,'light')));
assert.deepEqual(imported.chromeThemes.light.fonts.contentFace,face);
assert(buildThemeVariables(resolveThemePack(imported,'light'),'light','','')['--font-content'].includes('Menlo-Bold'));
const cleared = setThemePackFonts(imported,'light',{content:null,contentFace:undefined});
const variables = buildThemeVariables(resolveThemePack(cleared,'light'),'light','','');
assert.equal(variables['--font-content'],variables['--font-sans']);
assert.equal(setThemePackFonts(imported,'light',{content:'"Georgia"'}).chromeThemes.light.fonts.contentFace,undefined,'changing family cannot retain a mismatched face');

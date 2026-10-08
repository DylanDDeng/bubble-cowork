import type { SystemFontFace } from '../../shared/system-fonts';
import { isHexColor } from './color';
import { DEFAULT_PRESET_ID, findPreset, PRESET_ALIASES, presetsFor } from './theme-presets';
import {
  DEFAULT_UI_FONT_FAMILY,
  deriveThemeTokens,
  LEGACY_DEFAULT_UI_FONT_FAMILY,
  LOCAL_FACE_PREFIX,
  type FontOverrides,
} from './theme-tokens';
import type {
  AppearanceState,
  ThemeChoice,
  ThemeMode,
  ThemePreset,
  ThemeRecipe,
  ThemeSignals,
  ThemeTypefaces,
  ThemeVariant,
} from './theme-types';

export { DEFAULT_UI_FONT_FAMILY, LEGACY_DEFAULT_UI_FONT_FAMILY } from './theme-tokens';

/**
 * Appearance state: one preset + recipe per variant, the edits the settings
 * page makes to it, share strings, and applying the result to the document.
 */

const SHARE_PREFIX = 'aegis-theme-v1:';
/** Strings copied from earlier Aegis builds and from Codex use this format. */
const FOREIGN_SHARE_PREFIX = 'codex-theme-v1:';
const VARIANTS: readonly ThemeVariant[] = ['light', 'dark'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** A preset id the variant supports; unknown or unsupported ids fall back to the default. */
export function presetIdFor(value: unknown, variant: ThemeVariant): string {
  const raw = (text(value) ?? '').toLowerCase();
  const id = PRESET_ALIASES[raw] ?? raw;
  return findPreset(id)?.variants[variant] ? id : DEFAULT_PRESET_ID;
}

/** The recipe a preset defines for a variant (the default preset's when it has none). */
export function presetRecipe(presetId: string, variant: ThemeVariant): ThemeRecipe {
  const recipe = findPreset(presetIdFor(presetId, variant))?.variants[variant] ?? findPreset(DEFAULT_PRESET_ID)!.variants[variant]!;
  return cloneRecipe(recipe);
}

export function availablePresets(variant: ThemeVariant): ThemePreset[] {
  return presetsFor(variant);
}

function cloneRecipe(recipe: ThemeRecipe): ThemeRecipe {
  return { ...recipe, fonts: { ...recipe.fonts }, semanticColors: { ...recipe.semanticColors } };
}

/** A picked face only applies while its family is still the role's first font. */
function keptFace(face: unknown, family: string | null): SystemFontFace | null {
  if (!isRecord(face) || !family) return null;
  const { family: faceFamily, fullName, postscriptName } = face;
  if (![faceFamily, fullName, postscriptName].every((field) => typeof field === 'string' && field)) return null;
  const leading = family.split(',')[0].trim().replace(/^["']|["']$/g, '');
  if (leading.toLowerCase() !== String(faceFamily).toLowerCase()) return null;
  return {
    family: String(faceFamily),
    fullName: String(fullName),
    postscriptName: String(postscriptName),
    style: typeof face.style === 'string' ? face.style : 'Regular',
  };
}

function normalizeTypefaces(value: unknown): ThemeTypefaces {
  const fonts = isRecord(value) ? value : {};
  const result: ThemeTypefaces = { ui: text(fonts.ui), code: text(fonts.code) };
  if (typeof fonts.content === 'string') result.content = text(fonts.content);
  for (const role of ['ui', 'content', 'code'] as const) {
    const face = keptFace(fonts[`${role}Face`], text(fonts[role]));
    if (face) result[`${role}Face`] = face;
  }
  return result;
}

function normalizeSignals(value: unknown, fallback: ThemeSignals): ThemeSignals {
  const signals = isRecord(value) ? value : {};
  const pick = (key: keyof ThemeSignals) => (isHexColor(signals[key]) ? String(signals[key]).toLowerCase() : fallback[key]);
  return { diffAdded: pick('diffAdded'), diffRemoved: pick('diffRemoved'), skill: pick('skill') };
}

/** Fills every missing or invalid field from `fallback` (the variant's default preset unless given). */
export function normalizeRecipe(value: unknown, variant: ThemeVariant, fallback = presetRecipe(DEFAULT_PRESET_ID, variant)): ThemeRecipe {
  const input = isRecord(value) ? value : {};
  const color = (key: 'surface' | 'ink' | 'accent') => (isHexColor(input[key]) ? String(input[key]).toLowerCase() : fallback[key]);
  const contrast = typeof input.contrast === 'number' && Number.isFinite(input.contrast) ? input.contrast : fallback.contrast;
  return {
    surface: color('surface'),
    ink: color('ink'),
    accent: color('accent'),
    accentPreset: input.accentPreset === 'default' ? 'default' : input.accentPreset === 'custom' ? 'custom' : undefined,
    contrast: Math.round(Math.min(100, Math.max(0, contrast))),
    fonts: normalizeTypefaces(input.fonts),
    opaqueWindows: typeof input.opaqueWindows === 'boolean' ? input.opaqueWindows : fallback.opaqueWindows,
    semanticColors: normalizeSignals(input.semanticColors, fallback.semanticColors),
  };
}

export function normalizeAppearance(value: unknown): AppearanceState {
  const state = isRecord(value) ? value : {};
  const recipes = isRecord(state.chromeThemes) ? state.chromeThemes : {};
  const presets = isRecord(state.codeThemeIds) ? state.codeThemeIds : {};
  const result = { chromeThemes: {}, codeThemeIds: {} } as AppearanceState;
  for (const variant of VARIANTS) {
    result.codeThemeIds[variant] = presetIdFor(presets[variant], variant);
    result.chromeThemes[variant] = normalizeRecipe(recipes[variant], variant);
  }
  return result;
}

export const DEFAULT_APPEARANCE: AppearanceState = normalizeAppearance({
  chromeThemes: { light: presetRecipe(DEFAULT_PRESET_ID, 'light'), dark: presetRecipe(DEFAULT_PRESET_ID, 'dark') },
  codeThemeIds: { light: DEFAULT_PRESET_ID, dark: DEFAULT_PRESET_ID },
});

export function resolveThemeMode(mode: ThemeMode): ThemeVariant {
  if (mode !== 'system') return mode;
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function choiceFor(state: AppearanceState, variant: ThemeVariant): ThemeChoice {
  return {
    presetId: presetIdFor(state.codeThemeIds?.[variant], variant),
    recipe: normalizeRecipe(state.chromeThemes?.[variant], variant),
  };
}

function withVariant(state: AppearanceState, variant: ThemeVariant, recipe: ThemeRecipe, presetId?: string): AppearanceState {
  return {
    chromeThemes: { ...state.chromeThemes, [variant]: recipe },
    codeThemeIds: { ...state.codeThemeIds, [variant]: presetId ?? presetIdFor(state.codeThemeIds?.[variant], variant) },
  };
}

/** Merges a partial edit into one variant's recipe; fonts and signals merge key by key. */
export function patchRecipe(state: AppearanceState, variant: ThemeVariant, patch: Partial<ThemeRecipe>): AppearanceState {
  const current = choiceFor(state, variant).recipe;
  const merged = {
    ...current,
    ...patch,
    fonts: { ...current.fonts, ...patch.fonts },
    semanticColors: { ...current.semanticColors, ...patch.semanticColors },
  };
  return withVariant(state, variant, normalizeRecipe(merged, variant, current));
}

export function patchTypefaces(state: AppearanceState, variant: ThemeVariant, patch: Partial<ThemeTypefaces>): AppearanceState {
  return patchRecipe(state, variant, { fonts: { ...choiceFor(state, variant).recipe.fonts, ...patch } });
}

/** Switches a variant to a preset's colors, keeping the user's fonts. */
export function applyPreset(state: AppearanceState, variant: ThemeVariant, presetId: string): AppearanceState {
  const id = presetIdFor(presetId, variant);
  const current = choiceFor(state, variant).recipe;
  const next = presetRecipe(id, variant);
  return withVariant(state, variant, { ...next, fonts: current.fonts, accentPreset: current.accentPreset ?? next.accentPreset }, id);
}

export function resetVariant(state: AppearanceState, variant: ThemeVariant): AppearanceState {
  return withVariant(state, variant, presetRecipe(DEFAULT_PRESET_ID, variant), DEFAULT_PRESET_ID);
}

/** Moves the old app-wide font overrides into both variants, once. */
export function migrateLegacyFonts(state: AppearanceState, uiFont: string, codeFont: string): AppearanceState {
  const patch: Partial<ThemeTypefaces> = {};
  const ui = uiFont.trim();
  if (ui && ui !== DEFAULT_UI_FONT_FAMILY && ui !== LEGACY_DEFAULT_UI_FONT_FAMILY) patch.ui = ui;
  if (codeFont.trim()) patch.code = codeFont.trim();
  if (!Object.keys(patch).length) return state;
  return patchTypefaces(patchTypefaces(state, 'light', patch), 'dark', patch);
}

// ===== Share strings =====

export function exportTheme(variant: ThemeVariant, choice: ThemeChoice): string {
  return SHARE_PREFIX + JSON.stringify({ variant, preset: choice.presetId, recipe: choice.recipe });
}

function readPayload(body: string): Record<string, unknown> {
  let decoded = body.trim();
  if (decoded.startsWith('%7B') || decoded.startsWith('%7b')) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // Not URI-encoded after all.
    }
  }
  let payload: unknown;
  try {
    payload = JSON.parse(decoded);
  } catch {
    throw new Error('This theme string is not valid JSON.');
  }
  if (!isRecord(payload)) throw new Error('This theme string must describe an object.');
  return payload;
}

/** Reads a theme string from Aegis or Codex into a variant. */
export function parseTheme(value: string): { variant: ThemeVariant; choice: ThemeChoice } {
  const trimmed = value.trim();
  const ours = trimmed.startsWith(SHARE_PREFIX);
  if (!ours && !trimmed.startsWith(FOREIGN_SHARE_PREFIX)) {
    throw new Error(`Paste a theme string starting with ${SHARE_PREFIX} or ${FOREIGN_SHARE_PREFIX}`);
  }
  const payload = readPayload(trimmed.slice(ours ? SHARE_PREFIX.length : FOREIGN_SHARE_PREFIX.length));
  const variant = payload.variant === 'light' || payload.variant === 'dark' ? payload.variant : null;
  if (!variant) throw new Error('The theme string must be for light or dark.');
  const presetId = presetIdFor(ours ? payload.preset : payload.codeThemeId, variant);
  return { variant, choice: { presetId, recipe: normalizeRecipe(ours ? payload.recipe : payload.theme, variant, presetRecipe(presetId, variant)) } };
}

export function importTheme(state: AppearanceState, variant: ThemeVariant, value: string): AppearanceState {
  const parsed = parseTheme(value);
  if (parsed.variant !== variant) throw new Error(`This is a ${parsed.variant} theme; paste it into the ${parsed.variant} theme instead.`);
  return withVariant(state, variant, parsed.choice.recipe, parsed.choice.presetId);
}

// ===== Applying to the document =====

export function themeVariables(choice: ThemeChoice, variant: ThemeVariant, overrides: FontOverrides = {}): Record<string, string> {
  return deriveThemeTokens(choice.recipe, variant, overrides);
}

const registeredFaces = new Set<string>();

function registerLocalFace(face: SystemFontFace | undefined): void {
  if (!face || typeof FontFace === 'undefined' || registeredFaces.has(face.postscriptName)) return;
  registeredFaces.add(face.postscriptName);
  const font = new FontFace(LOCAL_FACE_PREFIX + face.postscriptName, `local(${JSON.stringify(face.postscriptName)}), local(${JSON.stringify(face.fullName)})`);
  document.fonts.add(font);
  font.load().catch(() => {
    document.fonts.delete(font);
    registeredFaces.delete(face.postscriptName);
  });
}

/** Fired on window after a different appearance lands, for parts that paint outside CSS (terminals). */
export const THEME_APPLIED_EVENT = 'aegis:theme-applied';

let lastApplied = '';
let lastSentToMain = '';

export function renderAppearance(input: { mode: ThemeMode; state: AppearanceState; uiFontFamily?: string; codeFontFamily?: string }): void {
  const variant = resolveThemeMode(input.mode);
  const choice = choiceFor(input.state, variant);
  const variables = themeVariables(choice, variant, { ui: input.uiFontFamily, code: input.codeFontFamily });
  const signature = JSON.stringify([input.mode, variant, variables]);
  if (signature === lastApplied) return;
  lastApplied = signature;

  for (const role of ['uiFace', 'contentFace', 'codeFace'] as const) registerLocalFace(choice.recipe.fonts[role]);
  const root = document.documentElement;
  // Jump straight to the new colors instead of animating every themed property.
  root.classList.add('no-transitions');
  root.classList.toggle('dark', variant === 'dark');
  root.dataset.themeMode = input.mode;
  root.dataset.themeVariant = variant;
  for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
  void root.offsetHeight;
  requestAnimationFrame(() => root.classList.remove('no-transitions'));
  window.dispatchEvent(new Event(THEME_APPLIED_EVENT));

  const background = variables['--bg-primary'];
  const forMain = `${input.mode}:${variant}:${background}`;
  if (forMain !== lastSentToMain && typeof window.electron?.setTheme === 'function') {
    lastSentToMain = forMain;
    void window.electron.setTheme(input.mode, { variant, background }).catch(() => undefined);
  }
}

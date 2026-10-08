import { contrastRatio, legibleOn, lighten, shade, withAlpha } from './color';
import type { ThemeRecipe, ThemeTypefaces, ThemeVariant } from './theme-types';

/**
 * Turns a recipe into the CSS variables the app reads.
 *
 * Layers are steps from the surface toward the ink (or away from it, for the
 * window base), taken in OKLCH so a step looks the same size on any hue.
 * Contrast scales every step and every translucent tier through one factor,
 * so the slider moves the whole hierarchy together.
 */

export const DEFAULT_UI_FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Helvetica Neue", Arial, sans-serif';
export const LEGACY_DEFAULT_UI_FONT_FAMILY =
  '"IBM Plex Serif Var", "IBM Plex Serif", ui-serif, Georgia, Cambria, "Times New Roman", Times, serif';
const MONO_FONT_FAMILY = '"JetBrains Mono", "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace';
const SERIF_FONT_FAMILY =
  'ui-serif, "New York", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, Cambria, "Times New Roman", Times, serif';

/** Prefix for @font-face aliases of user-picked installed faces. */
export const LOCAL_FACE_PREFIX = 'Aegis local ';

const SHADOWS: Record<ThemeVariant, { ring: string; popover: string; popoverLarge: string }> = {
  light: {
    ring: 'rgba(15, 18, 24, 0.06)',
    popover: '0 1px 2px rgba(15, 18, 24, 0.06), 0 8px 24px rgba(15, 18, 24, 0.1)',
    popoverLarge: '0 2px 6px rgba(15, 18, 24, 0.08), 0 18px 48px rgba(15, 18, 24, 0.16)',
  },
  dark: {
    ring: 'rgba(255, 255, 255, 0.08)',
    popover: '0 1px 2px rgba(0, 0, 0, 0.4), 0 10px 28px rgba(0, 0, 0, 0.45)',
    popoverLarge: '0 2px 8px rgba(0, 0, 0, 0.45), 0 22px 56px rgba(0, 0, 0, 0.55)',
  },
};

const WARNING: Record<ThemeVariant, string> = { light: '#b36b00', dark: '#f0b84a' };

/** Shifts a color's lightness until it reads at `ratio` against `background` (or gives up after a few steps). */
function readableAgainst(color: string, background: string, ratio = 4.5): string {
  const direction = contrastRatio(background, '#ffffff') > contrastRatio(background, '#000000') ? 1 : -1;
  let candidate = color;
  for (let step = 0; step < 16 && contrastRatio(candidate, background) < ratio; step += 1) {
    candidate = lighten(candidate, 0.03 * direction);
  }
  return candidate;
}

function faceFamily(family: string | null | undefined, face: ThemeTypefaces['uiFace'], fallback: string): string {
  const base = family?.trim() || fallback;
  return face ? `"${LOCAL_FACE_PREFIX}${face.postscriptName}", ${base}` : base;
}

export interface FontOverrides {
  /** Legacy app-wide font overrides; they win over the recipe when set. */
  ui?: string;
  code?: string;
}

export function deriveThemeTokens(recipe: ThemeRecipe, variant: ThemeVariant, overrides: FontOverrides = {}): Record<string, string> {
  const dark = variant === 'dark';
  const { surface, ink, accent } = recipe;
  const { diffAdded, diffRemoved, skill } = recipe.semanticColors;
  const depth = Math.min(1, Math.max(0, recipe.contrast / 100));
  const spread = 0.55 + 0.9 * depth;
  const towardInk = (amount: number) => shade(surface, ink, amount * spread);
  const paper = dark ? '#000000' : '#ffffff';
  const inkAt = (alpha: number) => withAlpha(ink, alpha);

  // Layers, from the window base up to floating surfaces.
  const canvas = dark ? shade(surface, paper, 0.12 * spread) : shade(surface, ink, Math.max(0, depth - 0.45) * 0.08);
  const shell = dark ? shade(canvas, paper, 0.25) : shade(canvas, ink, 0.05 * spread);
  const chrome = towardInk(dark ? 0.035 : 0.03);
  const panel = dark ? towardInk(0.03) : shade(surface, paper, 0.5);
  const raised = towardInk(dark ? 0.07 : 0.045);
  const raisedStrong = towardInk(dark ? 0.1 : 0.07);
  const popover = dark ? towardInk(0.06) : shade(panel, paper, 0.4);
  const bubble = towardInk(dark ? 0.12 : 0.06);

  const border = inkAt((dark ? 0.09 : 0.08) + 0.08 * depth);
  const borderSoft = inkAt((dark ? 0.05 : 0.04) + 0.04 * depth);
  const textSecondary = inkAt(0.68 + 0.14 * depth);
  const textMuted = inkAt(0.46 + 0.18 * depth);
  const accentText = readableAgainst(accent, surface);
  const accentSoft = withAlpha(accent, (dark ? 0.17 : 0.12) + 0.05 * depth);
  const skillText = readableAgainst(skill, surface);
  const warning = WARNING[variant];
  const shadows = SHADOWS[variant];

  const opaque = recipe.opaqueWindows;
  const fonts = recipe.fonts;
  const uiFont = overrides.ui?.trim() || faceFamily(fonts.ui, fonts.uiFace, DEFAULT_UI_FONT_FAMILY);

  return {
    // Surfaces
    '--bg-primary': canvas,
    '--bg-secondary': panel,
    '--bg-tertiary': raised,
    '--preview-surface': panel,
    '--app-chrome-bg': chrome,
    '--app-shell-background': shell,
    '--app-sidebar-surface': opaque ? chrome : `color-mix(in srgb, ${chrome} 74%, transparent)`,
    '--app-sidebar-backdrop-filter': opaque ? 'none' : 'blur(10px) saturate(140%)',
    '--panel-soft-divider': inkAt(dark ? 0.07 : 0.06),
    // Text
    '--text-primary': ink,
    '--text-secondary': textSecondary,
    '--text-muted': textMuted,
    // Accent, borders, status
    '--accent': accent,
    '--accent-hover': lighten(accent, dark ? 0.06 : -0.06),
    '--accent-light': accentSoft,
    '--accent-foreground': legibleOn(accent),
    '--border': border,
    '--border-focus': withAlpha(accent, 0.5),
    '--success': diffAdded,
    '--error': diffRemoved,
    '--warning': warning,
    '--tool-pending': warning,
    '--tool-running': accent,
    '--tool-success': diffAdded,
    '--tool-error': diffRemoved,
    // Code
    '--code-inline-bg': raised,
    '--code-inline-border': borderSoft,
    '--code-inline-text': textSecondary,
    '--code-block-bg': raisedStrong,
    '--code-block-border': border,
    '--code-block-text': ink,
    '--code-copy-hover': inkAt(0.08),
    '--code-token-comment': textMuted,
    '--code-token-keyword': skillText,
    '--code-token-string': readableAgainst(diffAdded, raisedStrong),
    '--code-token-function': accentText,
    '--code-token-number': readableAgainst(warning, raisedStrong),
    '--code-token-operator': textSecondary,
    '--code-token-variable': ink,
    // Message bubble and composer chips
    '--user-bubble-bg': bubble,
    '--user-bubble-text': ink,
    '--user-bubble-shadow': 'none',
    '--composer-chip-bg': inkAt(0.05 + 0.04 * depth),
    '--composer-chip-text': ink,
    '--composer-skill-chip-bg': withAlpha(skill, dark ? 0.16 : 0.1),
    '--composer-skill-chip-text': skillText,
    '--composer-mention-chip-bg': withAlpha(accent, dark ? 0.16 : 0.09),
    '--composer-mention-chip-border': withAlpha(accent, 0.22),
    '--composer-mention-chip-text': accentText,
    '--composer-link-chip-text': accentText,
    // Sidebar and file tree
    '--sidebar-item-hover': inkAt(dark ? 0.08 : 0.05),
    '--sidebar-item-active': inkAt(dark ? 0.13 : 0.085),
    '--tree-item-hover': inkAt(dark ? 0.07 : 0.05),
    '--tree-item-active': accentSoft,
    '--tree-item-border': borderSoft,
    '--tree-file-accent-fg': accentText,
    // Floating surfaces
    '--popover-bg': popover,
    '--popover-border': borderSoft,
    '--popover-ring': shadows.ring,
    '--popover-radius': '14px',
    '--popover-shadow': shadows.popover,
    '--popover-shadow-lg': shadows.popoverLarge,
    '--tooltip-bg': ink,
    '--tooltip-fg': surface,
    '--tooltip-fg-muted': withAlpha(surface, 0.66),
    // Type
    '--font-sans': uiFont,
    '--font-content': fonts.content?.trim() || fonts.contentFace ? faceFamily(fonts.content, fonts.contentFace, uiFont) : uiFont,
    '--font-mono': overrides.code?.trim() || faceFamily(fonts.code, fonts.codeFace, MONO_FONT_FAMILY),
    '--font-serif': SERIF_FONT_FAMILY,
  };
}

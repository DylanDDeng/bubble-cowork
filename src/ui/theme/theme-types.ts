import type { SystemFontFace } from '../../shared/system-fonts';

/** What the user picked: a fixed variant, or follow the system. */
export type ThemeMode = 'light' | 'dark' | 'system';
export type ThemeVariant = 'light' | 'dark';

/** Font families (CSS strings) and, optionally, the exact installed face for each role. */
export interface ThemeTypefaces {
  ui: string | null;
  code: string | null;
  content?: string | null;
  uiFace?: SystemFontFace;
  contentFace?: SystemFontFace;
  codeFace?: SystemFontFace;
}

/** Colors that carry meaning rather than brand: additions, removals, and skills. */
export interface ThemeSignals {
  diffAdded: string;
  diffRemoved: string;
  skill: string;
}

/**
 * The handful of inputs every appearance is computed from. Field names are
 * stored in user preferences and share strings, so they stay stable.
 */
export interface ThemeRecipe {
  /** Page background. */
  surface: string;
  /** Primary text. */
  ink: string;
  accent: string;
  /** 'default' follows the preset's accent; anything else is the user's own. */
  accentPreset?: 'default' | 'custom';
  /** 0–100: how far layers, borders and secondary text separate. */
  contrast: number;
  fonts: ThemeTypefaces;
  /** Solid sidebar instead of the translucent material. */
  opaqueWindows: boolean;
  semanticColors: ThemeSignals;
}

/** One variant's preset plus the recipe in use (which may have drifted from the preset). */
export interface ThemeChoice {
  presetId: string;
  recipe: ThemeRecipe;
}

/** Persisted appearance: an independent choice for light and for dark. */
export interface AppearanceState {
  chromeThemes: Record<ThemeVariant, ThemeRecipe>;
  codeThemeIds: Record<ThemeVariant, string>;
}

export interface ThemePreset {
  id: string;
  label: string;
  /** Brand themes evoke a product's look; editor themes come from code editor palettes. */
  family: 'aegis' | 'brand' | 'editor';
  variants: Partial<Record<ThemeVariant, ThemeRecipe>>;
}

export type ThemeMode = 'light' | 'dark' | 'system';
export type ThemeVariant = 'light' | 'dark';
export type WindowMaterial = 'opaque' | 'translucent';

export interface ThemeFonts {
  ui: string | null;
  code: string | null;
}

export interface ThemeSemanticColors {
  diffAdded: string;
  diffRemoved: string;
  skill: string;
}

export interface ChromeTheme {
  accent: string;
  contrast: number;
  fonts: ThemeFonts;
  ink: string;
  opaqueWindows: boolean;
  semanticColors: ThemeSemanticColors;
  surface: string;
}

export interface ThemePack {
  codeThemeId: string;
  theme: ChromeTheme;
}

export interface ThemeState {
  chromeThemes: Record<ThemeVariant, ChromeTheme>;
  codeThemeIds: Record<ThemeVariant, string>;
}

export interface CodeThemeOption {
  id: string;
  label: string;
  variants: readonly ThemeVariant[];
}

export interface ThemeSharePayload {
  codeThemeId: string;
  theme: ChromeTheme;
  variant: ThemeVariant;
}

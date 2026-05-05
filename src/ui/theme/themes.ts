import type {
  ChromeTheme,
  CodeThemeOption,
  ThemeFonts,
  ThemeMode,
  ThemeSemanticColors,
  ThemeSharePayload,
  ThemePack,
  ThemeState,
  ThemeVariant,
} from './theme-types';

type RgbColor = {
  red: number;
  green: number;
  blue: number;
};

type ThemeSeedPatch = Partial<
  Pick<ChromeTheme, 'accent' | 'contrast' | 'ink' | 'opaqueWindows' | 'surface'>
> & {
  fonts?: Partial<ThemeFonts>;
  semanticColors?: Partial<ThemeSemanticColors>;
};

const BLACK: RgbColor = { red: 0, green: 0, blue: 0 };
const WHITE: RgbColor = { red: 255, green: 255, blue: 255 };
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const THEME_SHARE_PREFIX = 'codex-theme-v1:';
const TRANSITION_CLASS = 'no-transitions';

const SURFACE_UNDER_BASE_ALPHA: Record<ThemeVariant, number> = {
  dark: 0.16,
  light: 0.04,
};

const SURFACE_UNDER_CONTRAST_STEP: Record<ThemeVariant, number> = {
  dark: 0.0015,
  light: 0.0012,
};

const PANEL_BASE_ALPHA: Record<ThemeVariant, number> = {
  dark: 0.03,
  light: 0.18,
};

const PANEL_CONTRAST_STEP: Record<ThemeVariant, number> = {
  dark: 0.03,
  light: 0.008,
};

const BASE_DISPLAY_FONT =
  'ui-serif, "New York", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, Cambria, "Times New Roman", Times, serif';
const BASE_UI_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif';
const BASE_MONO_FONT =
  '"JetBrains Mono", "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace';

export const CODE_THEME_OPTIONS: readonly CodeThemeOption[] = [
  { id: 'codex', label: 'Codex', variants: ['light', 'dark'] },
  { id: 'absolutely', label: 'Absolutely', variants: ['light', 'dark'] },
  { id: 'dp-code', label: 'Harbor', variants: ['light', 'dark'] },
  { id: 'linear', label: 'Linear', variants: ['light', 'dark'] },
  { id: 'notion', label: 'Notion', variants: ['light', 'dark'] },
  { id: 'github', label: 'GitHub', variants: ['light', 'dark'] },
  { id: 'catppuccin', label: 'Catppuccin', variants: ['light', 'dark'] },
  { id: 'everforest', label: 'Everforest', variants: ['light', 'dark'] },
  { id: 'rose-pine', label: 'Rose Pine', variants: ['light', 'dark'] },
  { id: 'tokyo-night', label: 'Tokyo Night', variants: ['dark'] },
  { id: 'raycast', label: 'Raycast', variants: ['light', 'dark'] },
  { id: 'vercel', label: 'Vercel', variants: ['light', 'dark'] },
] as const;

const THEME_SEED_CATALOG: Record<string, Partial<Record<ThemeVariant, ChromeTheme>>> = {
  codex: {
    dark: {
      accent: '#0169cc',
      contrast: 60,
      fonts: { code: null, ui: null },
      ink: '#fcfcfc',
      opaqueWindows: false,
      semanticColors: {
        diffAdded: '#00a240',
        diffRemoved: '#e02e2a',
        skill: '#b06dff',
      },
      surface: '#111111',
    },
    light: {
      accent: '#0169cc',
      contrast: 45,
      fonts: { code: null, ui: null },
      ink: '#0d0d0d',
      opaqueWindows: false,
      semanticColors: {
        diffAdded: '#00a240',
        diffRemoved: '#ba2623',
        skill: '#751ed9',
      },
      surface: '#ffffff',
    },
  },
  absolutely: {
    dark: {
      accent: '#cc7d5e',
      contrast: 60,
      fonts: { code: null, ui: null },
      ink: '#f9f9f7',
      opaqueWindows: false,
      semanticColors: {
        diffAdded: '#00c853',
        diffRemoved: '#ff5f38',
        skill: '#cc7d5e',
      },
      surface: '#2d2d2b',
    },
    light: {
      accent: '#cc7d5e',
      contrast: 45,
      fonts: { code: null, ui: null },
      ink: '#2d2d2b',
      opaqueWindows: false,
      semanticColors: {
        diffAdded: '#00c853',
        diffRemoved: '#ff5f38',
        skill: '#cc7d5e',
      },
      surface: '#f9f9f7',
    },
  },
  'dp-code': {
    dark: {
      accent: '#4fb0c6',
      contrast: 72,
      fonts: { code: null, ui: null },
      ink: '#eef4f7',
      opaqueWindows: false,
      semanticColors: {
        diffAdded: '#54c690',
        diffRemoved: '#f06a6f',
        skill: '#8f86ff',
      },
      surface: '#0f161b',
    },
    light: {
      accent: '#1f8aa0',
      contrast: 58,
      fonts: { code: null, ui: null },
      ink: '#1b2730',
      opaqueWindows: false,
      semanticColors: {
        diffAdded: '#1f9a63',
        diffRemoved: '#cf4c57',
        skill: '#6b63e8',
      },
      surface: '#f6fbfc',
    },
  },
  linear: {
    dark: {
      accent: '#606acc',
      contrast: 68,
      fonts: { code: null, ui: 'Inter' },
      ink: '#e3e4e6',
      opaqueWindows: true,
      semanticColors: {
        diffAdded: '#69c967',
        diffRemoved: '#ff7e78',
        skill: '#c2a1ff',
      },
      surface: '#0f0f11',
    },
    light: {
      accent: '#5566d9',
      contrast: 52,
      fonts: { code: null, ui: 'Inter' },
      ink: '#17181c',
      opaqueWindows: true,
      semanticColors: {
        diffAdded: '#00a240',
        diffRemoved: '#ba2623',
        skill: '#6a63ff',
      },
      surface: '#f8f8fb',
    },
  },
  notion: {
    dark: {
      accent: '#3183d8',
      contrast: 60,
      fonts: { code: null, ui: null },
      ink: '#d9d9d8',
      opaqueWindows: true,
      semanticColors: {
        diffAdded: '#4ec9b0',
        diffRemoved: '#fa423e',
        skill: '#3183d8',
      },
      surface: '#191919',
    },
    light: {
      accent: '#3183d8',
      contrast: 45,
      fonts: { code: null, ui: null },
      ink: '#37352f',
      opaqueWindows: true,
      semanticColors: {
        diffAdded: '#008000',
        diffRemoved: '#a31515',
        skill: '#0000ff',
      },
      surface: '#ffffff',
    },
  },
  github: {
    dark: {
      accent: '#58a6ff',
      contrast: 58,
      fonts: { code: null, ui: null },
      ink: '#f0f6fc',
      opaqueWindows: false,
      semanticColors: {
        diffAdded: '#3fb950',
        diffRemoved: '#f85149',
        skill: '#bc8cff',
      },
      surface: '#0d1117',
    },
    light: {
      accent: '#0969da',
      contrast: 44,
      fonts: { code: null, ui: null },
      ink: '#1f2328',
      opaqueWindows: false,
      semanticColors: {
        diffAdded: '#1a7f37',
        diffRemoved: '#cf222e',
        skill: '#8250df',
      },
      surface: '#ffffff',
    },
  },
  catppuccin: {
    dark: {
      accent: '#cba6f7',
      contrast: 60,
      fonts: { code: null, ui: null },
      ink: '#cdd6f4',
      opaqueWindows: false,
      semanticColors: {
        diffAdded: '#a6e3a1',
        diffRemoved: '#f38ba8',
        skill: '#cba6f7',
      },
      surface: '#1e1e2e',
    },
    light: {
      accent: '#8839ef',
      contrast: 45,
      fonts: { code: null, ui: null },
      ink: '#4c4f69',
      opaqueWindows: false,
      semanticColors: {
        diffAdded: '#40a02b',
        diffRemoved: '#d20f39',
        skill: '#8839ef',
      },
      surface: '#eff1f5',
    },
  },
  everforest: {
    dark: {
      accent: '#a7c080',
      contrast: 60,
      fonts: { code: null, ui: null },
      ink: '#d3c6aa',
      opaqueWindows: false,
      semanticColors: {
        diffAdded: '#a7c080',
        diffRemoved: '#e67e80',
        skill: '#d699b6',
      },
      surface: '#2d353b',
    },
    light: {
      accent: '#8da101',
      contrast: 44,
      fonts: { code: null, ui: null },
      ink: '#5c6a72',
      opaqueWindows: false,
      semanticColors: {
        diffAdded: '#6f894e',
        diffRemoved: '#c85552',
        skill: '#9d6fca',
      },
      surface: '#fdf6e3',
    },
  },
  'rose-pine': {
    dark: {
      accent: '#ea9a97',
      contrast: 60,
      fonts: { code: null, ui: null },
      ink: '#e0def4',
      opaqueWindows: false,
      semanticColors: {
        diffAdded: '#9ccfd8',
        diffRemoved: '#908caa',
        skill: '#c4a7e7',
      },
      surface: '#232136',
    },
    light: {
      accent: '#d7827e',
      contrast: 45,
      fonts: { code: null, ui: null },
      ink: '#575279',
      opaqueWindows: false,
      semanticColors: {
        diffAdded: '#56949f',
        diffRemoved: '#b4637a',
        skill: '#907aa9',
      },
      surface: '#faf4ed',
    },
  },
  'tokyo-night': {
    dark: {
      accent: '#7aa2f7',
      contrast: 70,
      fonts: { code: null, ui: null },
      ink: '#c0caf5',
      opaqueWindows: false,
      semanticColors: {
        diffAdded: '#9ece6a',
        diffRemoved: '#f7768e',
        skill: '#bb9af7',
      },
      surface: '#1a1b26',
    },
  },
  raycast: {
    dark: {
      accent: '#ff6363',
      contrast: 60,
      fonts: { code: '"JetBrains Mono"', ui: 'Inter' },
      ink: '#fefefe',
      opaqueWindows: false,
      semanticColors: {
        diffAdded: '#59d499',
        diffRemoved: '#ff6363',
        skill: '#cf2f98',
      },
      surface: '#101010',
    },
    light: {
      accent: '#ff6363',
      contrast: 45,
      fonts: { code: '"JetBrains Mono"', ui: 'Inter' },
      ink: '#030303',
      opaqueWindows: false,
      semanticColors: {
        diffAdded: '#006b4f',
        diffRemoved: '#b12424',
        skill: '#9a1b6e',
      },
      surface: '#ffffff',
    },
  },
  vercel: {
    dark: {
      accent: '#ffffff',
      contrast: 72,
      fonts: { code: '"Geist Mono"', ui: 'Geist' },
      ink: '#f5f5f5',
      opaqueWindows: true,
      semanticColors: {
        diffAdded: '#40c977',
        diffRemoved: '#ff7b72',
        skill: '#8b5cf6',
      },
      surface: '#000000',
    },
    light: {
      accent: '#111111',
      contrast: 55,
      fonts: { code: '"Geist Mono"', ui: 'Geist' },
      ink: '#171717',
      opaqueWindows: true,
      semanticColors: {
        diffAdded: '#159d6c',
        diffRemoved: '#d1435b',
        skill: '#6d28d9',
      },
      surface: '#ffffff',
    },
  },
};

export const DEFAULT_CHROME_THEME_BY_VARIANT: Record<ThemeVariant, ChromeTheme> = {
  dark: {
    accent: '#339cff',
    contrast: 60,
    fonts: { code: null, ui: null },
    ink: '#ffffff',
    opaqueWindows: false,
    semanticColors: {
      diffAdded: '#40c977',
      diffRemoved: '#fa423e',
      skill: '#ad7bf9',
    },
    surface: '#181818',
  },
  light: {
    accent: '#339cff',
    contrast: 45,
    fonts: { code: null, ui: null },
    ink: '#1a1c1f',
    opaqueWindows: false,
    semanticColors: {
      diffAdded: '#00a240',
      diffRemoved: '#ba2623',
      skill: '#924ff7',
    },
    surface: '#ffffff',
  },
};

export const DEFAULT_THEME_STATE: ThemeState = {
  chromeThemes: {
    dark: getCodeThemeSeed('codex', 'dark'),
    light: getCodeThemeSeed('codex', 'light'),
  },
  codeThemeIds: {
    dark: 'codex',
    light: 'codex',
  },
};

export function resolveThemeMode(themeMode: ThemeMode): ThemeVariant {
  if (themeMode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return themeMode;
}

export function getAvailableCodeThemes(variant: ThemeVariant): readonly CodeThemeOption[] {
  return CODE_THEME_OPTIONS.filter((option) => option.variants.includes(variant));
}

export function getCodeThemeSeed(codeThemeId: string, variant: ThemeVariant): ChromeTheme {
  const normalizedCodeThemeId = normalizeCodeThemeId(codeThemeId, variant);
  const seeded = THEME_SEED_CATALOG[normalizedCodeThemeId]?.[variant];
  return normalizeChromeTheme(seeded, variant);
}

export function normalizeThemeState(value: unknown): ThemeState {
  const state = isRecord(value) ? value : {};
  const chromeThemes = isRecord(state.chromeThemes) ? state.chromeThemes : {};
  const codeThemeIds = isRecord(state.codeThemeIds) ? state.codeThemeIds : {};

  return {
    chromeThemes: {
      dark: normalizeChromeTheme(chromeThemes.dark, 'dark'),
      light: normalizeChromeTheme(chromeThemes.light, 'light'),
    },
    codeThemeIds: {
      dark: normalizeCodeThemeId(codeThemeIds.dark, 'dark'),
      light: normalizeCodeThemeId(codeThemeIds.light, 'light'),
    },
  };
}

export function resolveThemePack(themeState: ThemeState, variant: ThemeVariant): ThemePack {
  return {
    codeThemeId: normalizeCodeThemeId(themeState.codeThemeIds[variant], variant),
    theme: normalizeChromeTheme(themeState.chromeThemes[variant], variant),
  };
}

export function updateThemePack(
  themeState: ThemeState,
  variant: ThemeVariant,
  patch: Partial<ChromeTheme>
): ThemeState {
  return {
    ...themeState,
    chromeThemes: {
      ...themeState.chromeThemes,
      [variant]: normalizeChromeTheme(
        mergeThemeSeedPatch(resolveThemePack(themeState, variant).theme, patch),
        variant
      ),
    },
  };
}

export function setThemePackFonts(
  themeState: ThemeState,
  variant: ThemeVariant,
  patch: Partial<ThemeFonts>
): ThemeState {
  return updateThemePack(themeState, variant, {
    fonts: {
      ...resolveThemePack(themeState, variant).theme.fonts,
      ...patch,
    },
  });
}

export function setThemeCodeThemeId(
  themeState: ThemeState,
  variant: ThemeVariant,
  codeThemeId: string
): ThemeState {
  const normalized = normalizeCodeThemeId(codeThemeId, variant);
  const seed = getCodeThemeSeed(normalized, variant);
  const previous = resolveThemePack(themeState, variant).theme;

  return {
    chromeThemes: {
      ...themeState.chromeThemes,
      [variant]: normalizeChromeTheme(
        mergeThemeSeedPatch(previous, {
          accent: seed.accent,
          contrast: seed.contrast,
          ink: seed.ink,
          opaqueWindows: seed.opaqueWindows,
          semanticColors: seed.semanticColors,
          surface: seed.surface,
        }),
        variant
      ),
    },
    codeThemeIds: {
      ...themeState.codeThemeIds,
      [variant]: normalized,
    },
  };
}

export function resetThemeVariant(themeState: ThemeState, variant: ThemeVariant): ThemeState {
  return {
    chromeThemes: {
      ...themeState.chromeThemes,
      [variant]: getCodeThemeSeed(DEFAULT_THEME_STATE.codeThemeIds[variant], variant),
    },
    codeThemeIds: {
      ...themeState.codeThemeIds,
      [variant]: DEFAULT_THEME_STATE.codeThemeIds[variant],
    },
  };
}

export function areThemePacksEqual(left: ThemePack, right: ThemePack): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createThemeShareString(variant: ThemeVariant, pack: ThemePack): string {
  return `${THEME_SHARE_PREFIX}${JSON.stringify({
    codeThemeId: pack.codeThemeId,
    theme: pack.theme,
    variant,
  })}`;
}

export function parseThemeShareString(value: string): ThemeSharePayload {
  const normalized = value.trim();
  if (!normalized.startsWith(THEME_SHARE_PREFIX)) {
    throw new Error('Theme share string must start with codex-theme-v1:');
  }

  const payloadText = normalized.slice(THEME_SHARE_PREFIX.length);
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    throw new Error('Theme share string does not contain valid JSON.');
  }

  if (!isRecord(payload)) {
    throw new Error('Theme share string must encode an object.');
  }

  const variant = payload.variant === 'dark' ? 'dark' : payload.variant === 'light' ? 'light' : null;
  if (!variant) {
    throw new Error('Theme share variant must be light or dark.');
  }

  return {
    codeThemeId: normalizeCodeThemeId(payload.codeThemeId, variant),
    theme: normalizeChromeTheme(payload.theme, variant),
    variant,
  };
}

export function importThemeShareString(
  themeState: ThemeState,
  targetVariant: ThemeVariant,
  value: string
): ThemeState {
  const payload = parseThemeShareString(value);
  if (payload.variant !== targetVariant) {
    throw new Error(`Expected a ${targetVariant} theme string, received ${payload.variant}.`);
  }

  return {
    chromeThemes: {
      ...themeState.chromeThemes,
      [targetVariant]: payload.theme,
    },
    codeThemeIds: {
      ...themeState.codeThemeIds,
      [targetVariant]: payload.codeThemeId,
    },
  };
}

export function applyThemePreferences({
  themeMode,
  themeState,
  uiFontFamily,
  chatCodeFontFamily,
}: {
  themeMode: ThemeMode;
  themeState: ThemeState;
  uiFontFamily: string;
  chatCodeFontFamily: string;
}) {
  const root = document.documentElement;
  const resolvedMode = resolveThemeMode(themeMode);
  const pack = resolveThemePack(themeState, resolvedMode);
  const variables = buildThemeVariables(pack, resolvedMode, uiFontFamily, chatCodeFontFamily);

  root.classList.add(TRANSITION_CLASS);
  root.classList.toggle('dark', resolvedMode === 'dark');
  root.dataset.themeMode = themeMode;
  root.dataset.themeVariant = resolvedMode;
  root.dataset.codeThemeId = pack.codeThemeId;
  root.dataset.windowMaterial = pack.theme.opaqueWindows ? 'opaque' : 'translucent';

  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value);
  }

  if (typeof window !== 'undefined' && typeof window.electron?.setTheme === 'function') {
    void window.electron.setTheme(themeMode).catch(() => undefined);
  }

  root.offsetHeight;
  requestAnimationFrame(() => {
    root.classList.remove(TRANSITION_CLASS);
  });
}

export function getThemePreviewPalette(themeState: ThemeState, variant: ThemeVariant): string[] {
  const pack = resolveThemePack(themeState, variant);
  return [pack.theme.surface, pack.theme.ink, pack.theme.accent, pack.theme.semanticColors.skill];
}

function buildThemeVariables(
  pack: ThemePack,
  variant: ThemeVariant,
  uiFontFamily: string,
  chatCodeFontFamily: string
): Record<string, string> {
  const theme = buildComputedTheme(pack.theme, variant);
  const controlBackground = variant === 'light'
    ? mixHex(pack.theme.surface, pack.theme.ink, 0.06 + theme.contrast * 0.05)
    : mixHex(pack.theme.surface, '#ffffff', 0.09 + theme.contrast * 0.04);
  const elevatedPrimary = variant === 'light'
    ? mixHex(pack.theme.surface, pack.theme.ink, 0.08 + theme.contrast * 0.08)
    : mixHex(pack.theme.surface, '#ffffff', 0.16 + theme.contrast * 0.12);
  const elevatedSecondary = variant === 'light'
    ? mixHex(pack.theme.surface, pack.theme.ink, 0.04 + theme.contrast * 0.05)
    : mixHex(pack.theme.surface, '#ffffff', 0.08 + theme.contrast * 0.08);
  const panel = buildPanelBackground(theme);
  const surfaceUnder = buildSurfaceUnder(pack.theme, theme.surface, theme.ink, variant);
  const accentLight = variant === 'light'
    ? formatRgba(parseHexColor(pack.theme.accent), 0.12 + theme.contrast * 0.03)
    : formatRgba(parseHexColor(pack.theme.accent), 0.16 + theme.contrast * 0.03);
  const border = formatRgba(theme.ink, variant === 'light' ? 0.08 + theme.contrast * 0.04 : 0.1 + theme.contrast * 0.04);
  const borderLight = formatRgba(theme.ink, variant === 'light' ? 0.04 + theme.contrast * 0.02 : 0.05 + theme.contrast * 0.02);
  const textSecondary = formatRgba(theme.ink, 0.72 + theme.contrast * 0.08);
  const textMuted = formatRgba(theme.ink, 0.48 + theme.contrast * 0.12);
  const popoverBackground = variant === 'light'
    ? formatOpaqueRgb(mixRgb(parseHexColor(panel), WHITE, 0.22))
    : formatOpaqueRgb(mixRgb(parseHexColor(panel), WHITE, 0.08));
  const accentForeground = getReadableTextColor(pack.theme.accent);
  const userBubbleBg = '#EBEBEB';
  const userBubbleText = '#111214';
  const uiFont = normalizeFontFamily(uiFontFamily) || normalizeFontFamily(pack.theme.fonts.ui) || BASE_UI_FONT;
  const monoFont =
    normalizeFontFamily(chatCodeFontFamily) ||
    normalizeFontFamily(pack.theme.fonts.code) ||
    BASE_MONO_FONT;
  const skillChipColor = parseHexColor(pack.theme.accent);
  const commandChipBackground = variant === 'light'
    ? formatRgba(parseHexColor(pack.theme.accent), 0.1)
    : formatRgba(theme.ink, 0.06 + theme.contrast * 0.03);
  const commandChipBorder = variant === 'light'
    ? formatRgba(parseHexColor(pack.theme.accent), 0.18)
    : formatRgba(theme.ink, 0.12 + theme.contrast * 0.03);
  const mentionChipBackground = variant === 'light'
    ? formatRgba(parseHexColor(pack.theme.accent), 0.08)
    : formatRgba(parseHexColor(pack.theme.accent), 0.14);
  const mentionChipBorder = variant === 'light'
    ? formatRgba(parseHexColor(pack.theme.accent), 0.12)
    : formatRgba(parseHexColor(pack.theme.accent), 0.2);
  const skillChipBackground = variant === 'light'
    ? formatRgba(skillChipColor, 0.1)
    : formatRgba(skillChipColor, 0.16);
  const skillChipBorder = variant === 'light'
    ? formatRgba(skillChipColor, 0.16)
    : formatRgba(skillChipColor, 0.22);
  const skillChipText = variant === 'light'
    ? mixHex(pack.theme.accent, pack.theme.ink, 0.28)
    : mixHex(pack.theme.accent, '#ffffff', 0.16);

  return {
    '--bg-primary': surfaceUnder,
    '--bg-secondary': panel,
    '--bg-tertiary': elevatedSecondary,
    '--text-primary': pack.theme.ink,
    '--text-secondary': textSecondary,
    '--text-muted': textMuted,
    '--accent': pack.theme.accent,
    '--accent-hover': mixHex(pack.theme.accent, variant === 'light' ? '#000000' : '#ffffff', 0.12),
    '--accent-light': accentLight,
    '--accent-foreground': accentForeground,
    '--success': pack.theme.semanticColors.diffAdded,
    '--error': pack.theme.semanticColors.diffRemoved,
    '--warning': variant === 'dark' ? '#f5b44a' : '#d97706',
    '--border': border,
    '--tool-pending': variant === 'dark' ? '#f5b44a' : '#d97706',
    '--tool-running': pack.theme.accent,
    '--tool-success': pack.theme.semanticColors.diffAdded,
    '--tool-error': pack.theme.semanticColors.diffRemoved,
    '--code-inline-bg': elevatedSecondary,
    '--code-inline-border': borderLight,
    '--code-inline-text': textSecondary,
    '--code-block-bg': elevatedPrimary,
    '--code-block-header-bg': elevatedPrimary,
    '--code-block-border': border,
    '--code-block-text': pack.theme.ink,
    '--code-copy-bg': variant === 'dark' ? 'rgba(255, 255, 255, 0.06)' : 'transparent',
    '--code-copy-hover': variant === 'dark' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(17, 24, 39, 0.05)',
    '--code-token-comment': textMuted,
    '--code-token-keyword': pack.theme.semanticColors.skill,
    '--code-token-string': pack.theme.semanticColors.diffAdded,
    '--code-token-function': pack.theme.accent,
    '--code-token-number': variant === 'dark' ? '#f6c177' : '#d97706',
    '--code-token-operator': textSecondary,
    '--code-token-variable': pack.theme.ink,
    '--user-bubble-bg': userBubbleBg,
    '--user-bubble-text': userBubbleText,
    '--user-bubble-border': 'transparent',
    '--user-bubble-shadow': 'none',
    '--tree-item-hover': variant === 'light' ? 'rgba(17, 24, 39, 0.05)' : 'rgba(255, 255, 255, 0.05)',
    '--tree-item-active': accentLight,
    '--tree-item-border': borderLight,
    '--tree-file-accent-bg': accentLight,
    '--tree-file-accent-border': border,
    '--tree-file-accent-fg': pack.theme.accent,
    '--tree-file-media-bg': variant === 'light'
      ? formatRgba(parseHexColor(pack.theme.semanticColors.skill), 0.08)
      : formatRgba(parseHexColor(pack.theme.semanticColors.skill), 0.12),
    '--tree-file-media-border': border,
    '--tree-file-media-fg': pack.theme.semanticColors.skill,
    '--tree-file-warm-bg': variant === 'light'
      ? 'rgba(251, 146, 60, 0.12)'
      : 'rgba(245, 158, 11, 0.12)',
    '--tree-file-warm-border': border,
    '--tree-file-warm-fg': variant === 'dark' ? '#f6c177' : '#dd6b20',
    '--tree-file-neutral-bg': elevatedSecondary,
    '--tree-file-neutral-border': border,
    '--tree-file-neutral-fg': textSecondary,
    '--preview-surface': panel,
    '--sidebar-item-hover': variant === 'light' ? 'rgba(17, 24, 39, 0.05)' : 'rgba(255, 255, 255, 0.08)',
    '--sidebar-item-active': variant === 'light' ? 'rgba(17, 24, 39, 0.08)' : 'rgba(255, 255, 255, 0.13)',
    '--sidebar-item-border': borderLight,
    '--popover-bg': popoverBackground,
    '--popover-border': borderLight,
    '--popover-ring': variant === 'light' ? 'rgba(255, 255, 255, 0.72)' : 'rgba(255, 255, 255, 0.04)',
    '--popover-radius': '14px',
    '--popover-shadow': variant === 'light'
      ? '0 0 0 1px rgba(17, 24, 39, 0.03), 0 1px 2px rgba(15, 18, 25, 0.04), 0 14px 36px -12px rgba(15, 18, 25, 0.18)'
      : '0 0 0 1px rgba(0, 0, 0, 0.4), 0 2px 4px rgba(0, 0, 0, 0.3), 0 18px 44px -12px rgba(0, 0, 0, 0.55)',
    '--popover-shadow-lg': variant === 'light'
      ? '0 0 0 1px rgba(17, 24, 39, 0.04), 0 2px 4px rgba(15, 18, 25, 0.05), 0 24px 56px -14px rgba(15, 18, 25, 0.22)'
      : '0 0 0 1px rgba(0, 0, 0, 0.45), 0 4px 8px rgba(0, 0, 0, 0.35), 0 28px 64px -14px rgba(0, 0, 0, 0.65)',
    '--app-shell-background': surfaceUnder,
    '--app-sidebar-surface': pack.theme.opaqueWindows
      ? surfaceUnder
      : variant === 'dark'
        ? `color-mix(in srgb, ${surfaceUnder} 72%, transparent)`
        : `color-mix(in srgb, ${surfaceUnder} 64%, transparent)`,
    '--app-sidebar-shadow': variant === 'dark'
      ? 'inset 0 1px 0 rgba(255,255,255,0.025)'
      : 'inset 0 1px 0 rgba(0,0,0,0.03)',
    '--app-sidebar-backdrop-filter': pack.theme.opaqueWindows ? 'none' : 'blur(8px) saturate(135%)',
    '--composer-chip-bg': commandChipBackground,
    '--composer-chip-border': commandChipBorder,
    '--composer-chip-text': pack.theme.ink,
    '--composer-skill-chip-bg': skillChipBackground,
    '--composer-skill-chip-border': skillChipBorder,
    '--composer-skill-chip-text': skillChipText,
    '--composer-mention-chip-bg': mentionChipBackground,
    '--composer-mention-chip-border': mentionChipBorder,
    '--composer-mention-chip-text': pack.theme.accent,
    '--font-sans': uiFont,
    '--font-mono': monoFont,
    '--font-serif': BASE_DISPLAY_FONT,
  };
}

function buildComputedTheme(theme: ChromeTheme, variant: ThemeVariant) {
  return {
    contrast: normalizeContrast(theme.contrast, variant),
    ink: parseHexColor(theme.ink),
    surface: parseHexColor(theme.surface),
    variant,
  };
}

function buildSurfaceUnder(
  theme: ChromeTheme,
  surface: RgbColor,
  ink: RgbColor,
  variant: ThemeVariant
): string {
  const baseline = DEFAULT_CHROME_THEME_BY_VARIANT[variant].contrast;
  const mixAmount =
    SURFACE_UNDER_BASE_ALPHA[variant] +
    (theme.contrast - baseline) * SURFACE_UNDER_CONTRAST_STEP[variant];
  return variant === 'light'
    ? mixHex(formatHex(surface), formatHex(ink), mixAmount)
    : mixHex(formatHex(surface), '#000000', mixAmount);
}

function buildPanelBackground(theme: ReturnType<typeof buildComputedTheme>): string {
  const anchor = theme.variant === 'light' ? WHITE : theme.ink;
  return mixHex(
    formatHex(theme.surface),
    formatHex(anchor),
    PANEL_BASE_ALPHA[theme.variant] + theme.contrast * PANEL_CONTRAST_STEP[theme.variant]
  );
}

function normalizeContrast(value: number, variant: ThemeVariant): number {
  const baseline = DEFAULT_CHROME_THEME_BY_VARIANT[variant].contrast;
  if (value <= baseline) {
    return value / 100;
  }
  return baseline / 100 + ((value - baseline) / 100) * 1.4;
}

function normalizeChromeTheme(value: unknown, variant: ThemeVariant): ChromeTheme {
  const fallback = DEFAULT_CHROME_THEME_BY_VARIANT[variant];
  const theme = isRecord(value) ? value : {};

  return {
    accent: normalizeHexColor(theme.accent) ?? fallback.accent,
    contrast: normalizeStoredContrast(theme.contrast, fallback.contrast),
    fonts: normalizeThemeFonts(theme.fonts),
    ink: normalizeHexColor(theme.ink) ?? fallback.ink,
    opaqueWindows:
      theme.opaqueWindows === true || theme.opaqueWindows === false
        ? theme.opaqueWindows
        : fallback.opaqueWindows,
    semanticColors: normalizeSemanticColors(theme.semanticColors, fallback.semanticColors),
    surface: normalizeHexColor(theme.surface) ?? fallback.surface,
  };
}

function normalizeThemeFonts(value: unknown): ThemeFonts {
  const fonts = isRecord(value) ? value : {};
  return {
    ui: normalizeFontFamily(typeof fonts.ui === 'string' ? fonts.ui : null),
    code: normalizeFontFamily(typeof fonts.code === 'string' ? fonts.code : null),
  };
}

function normalizeSemanticColors(
  value: unknown,
  fallback: ThemeSemanticColors
): ThemeSemanticColors {
  const semanticColors = isRecord(value) ? value : {};
  return {
    diffAdded: normalizeHexColor(semanticColors.diffAdded) ?? fallback.diffAdded,
    diffRemoved: normalizeHexColor(semanticColors.diffRemoved) ?? fallback.diffRemoved,
    skill: normalizeHexColor(semanticColors.skill) ?? fallback.skill,
  };
}

function normalizeCodeThemeId(value: unknown, variant: ThemeVariant): string {
  const codeThemeId =
    typeof value === 'string' ? value.trim().toLowerCase() : DEFAULT_THEME_STATE.codeThemeIds[variant];
  const available = getAvailableCodeThemes(variant).some((option) => option.id === codeThemeId);
  return available ? codeThemeId : DEFAULT_THEME_STATE.codeThemeIds[variant];
}

function normalizeStoredContrast(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return HEX_COLOR_RE.test(normalized) ? normalized.toLowerCase() : null;
}

function normalizeFontFamily(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function mergeThemeSeedPatch(theme: ChromeTheme, patch: Partial<ChromeTheme>): ChromeTheme {
  const nextPatch = patch as ThemeSeedPatch;
  return {
    ...theme,
    ...nextPatch,
    fonts: {
      ...theme.fonts,
      ...(nextPatch.fonts ?? {}),
    },
    semanticColors: {
      ...theme.semanticColors,
      ...(nextPatch.semanticColors ?? {}),
    },
  };
}

function parseHexColor(hex: string): RgbColor {
  const normalized = normalizeHexColor(hex);
  if (!normalized) {
    return { ...WHITE };
  }

  return {
    red: parseInt(normalized.slice(1, 3), 16),
    green: parseInt(normalized.slice(3, 5), 16),
    blue: parseInt(normalized.slice(5, 7), 16),
  };
}

function formatHex(color: RgbColor): string {
  return `#${toHex(color.red)}${toHex(color.green)}${toHex(color.blue)}`;
}

function toHex(value: number): string {
  return clampChannel(value).toString(16).padStart(2, '0');
}

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function mixHex(fromHex: string, toHex: string, amount: number): string {
  return formatHex(mixRgb(parseHexColor(fromHex), parseHexColor(toHex), amount));
}

function mixRgb(from: RgbColor, to: RgbColor, amount: number): RgbColor {
  const clamped = Math.max(0, Math.min(1, amount));
  return {
    red: from.red + (to.red - from.red) * clamped,
    green: from.green + (to.green - from.green) * clamped,
    blue: from.blue + (to.blue - from.blue) * clamped,
  };
}

function formatRgba(color: RgbColor, alpha: number): string {
  const clamped = Math.max(0, Math.min(1, alpha));
  return `rgba(${clampChannel(color.red)}, ${clampChannel(color.green)}, ${clampChannel(color.blue)}, ${clamped.toFixed(3)})`;
}

function formatOpaqueRgb(color: RgbColor): string {
  return `rgb(${clampChannel(color.red)}, ${clampChannel(color.green)}, ${clampChannel(color.blue)})`;
}

function getReadableTextColor(hex: string): string {
  const color = parseHexColor(hex);
  const luminance = (0.299 * color.red + 0.587 * color.green + 0.114 * color.blue) / 255;
  return luminance > 0.6 ? '#111111' : '#fcfcfc';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

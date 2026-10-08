import type { ThemePreset, ThemeRecipe, ThemeSignals, ThemeTypefaces, ThemeVariant } from './theme-types';

/**
 * Built-in looks. Each preset gives the base colors for the variants it
 * supports; everything else (layers, borders, states) is derived at runtime.
 */

const SIGNALS: Record<ThemeVariant, ThemeSignals> = {
  dark: { diffAdded: '#3fb950', diffRemoved: '#f85149', skill: '#a371f7' },
  light: { diffAdded: '#1a7f37', diffRemoved: '#cf222e', skill: '#8250df' },
};

const BASE_CONTRAST: Record<ThemeVariant, number> = { dark: 60, light: 45 };

interface Look {
  surface: string;
  ink: string;
  accent: string;
  contrast?: number;
  opaque?: boolean;
  fonts?: Partial<ThemeTypefaces>;
  signals?: Partial<ThemeSignals>;
}

function look(variant: ThemeVariant, spec: Look): ThemeRecipe {
  return {
    surface: spec.surface,
    ink: spec.ink,
    accent: spec.accent,
    accentPreset: 'default',
    contrast: spec.contrast ?? BASE_CONTRAST[variant],
    fonts: { ui: null, code: null, ...spec.fonts },
    opaqueWindows: spec.opaque ?? false,
    semanticColors: { ...SIGNALS[variant], ...spec.signals },
  };
}

function preset(id: string, label: string, family: ThemePreset['family'], dark?: Look, light?: Look): ThemePreset {
  return {
    id,
    label,
    family,
    variants: {
      ...(dark ? { dark: look('dark', dark) } : {}),
      ...(light ? { light: look('light', light) } : {}),
    },
  };
}

const INTER = '"Inter", -apple-system, BlinkMacSystemFont, sans-serif';

export const DEFAULT_PRESET_ID = 'aegis';

/** Old preset ids still found in saved preferences and share strings. */
export const PRESET_ALIASES: Record<string, string> = { codex: 'aegis', 'dp-code': 'harbor' };

export const THEME_PRESETS: readonly ThemePreset[] = [
  preset(
    'aegis',
    'Aegis',
    'aegis',
    { surface: '#121214', ink: '#f4f4f6', accent: '#3b82f6' },
    { surface: '#ffffff', ink: '#111113', accent: '#2563eb' }
  ),
  // Brand looks
  preset(
    'absolutely',
    'Absolutely',
    'brand',
    { surface: '#2d2d2b', ink: '#f9f9f7', accent: '#cc7d5e' },
    { surface: '#f9f9f7', ink: '#2d2d2b', accent: '#cc7d5e' }
  ),
  preset(
    'harbor',
    'Harbor',
    'brand',
    { surface: '#0f161b', ink: '#eef4f7', accent: '#4fb0c6', contrast: 70 },
    { surface: '#f6fbfc', ink: '#1b2730', accent: '#1f8aa0', contrast: 55 }
  ),
  preset(
    'linear',
    'Linear',
    'brand',
    { surface: '#0f0f11', ink: '#e3e4e6', accent: '#5e6ad2', opaque: true, fonts: { ui: INTER } },
    { surface: '#fcfcfd', ink: '#1b1b1f', accent: '#5e6ad2', opaque: true, fonts: { ui: INTER } }
  ),
  preset(
    'notion',
    'Notion',
    'brand',
    { surface: '#191919', ink: '#d9d9d8', accent: '#2383e2', opaque: true },
    { surface: '#ffffff', ink: '#37352f', accent: '#2383e2', opaque: true }
  ),
  preset(
    'raycast',
    'Raycast',
    'brand',
    { surface: '#101010', ink: '#fefefe', accent: '#ff6363', fonts: { ui: INTER, code: '"JetBrains Mono"' } },
    { surface: '#ffffff', ink: '#030303', accent: '#ff6363', fonts: { ui: INTER, code: '"JetBrains Mono"' } }
  ),
  preset(
    'vercel',
    'Vercel',
    'brand',
    { surface: '#000000', ink: '#ededed', accent: '#0070f3', contrast: 66, opaque: true, fonts: { ui: '"Geist"', code: '"Geist Mono"' } },
    { surface: '#ffffff', ink: '#171717', accent: '#0070f3', contrast: 50, opaque: true, fonts: { ui: '"Geist"', code: '"Geist Mono"' } }
  ),
  preset(
    'spotify',
    'Spotify',
    'brand',
    { surface: '#121212', ink: '#ffffff', accent: '#1ed760', opaque: true },
    { surface: '#ffffff', ink: '#191414', accent: '#1a9e48', opaque: true }
  ),
  preset(
    'arc',
    'Arc',
    'brand',
    { surface: '#242136', ink: '#f4f0ff', accent: '#b6a4ff', contrast: 55 },
    { surface: '#f0edfa', ink: '#29243d', accent: '#5145cd', contrast: 42 }
  ),
  preset(
    'sentry',
    'Sentry',
    'brand',
    { surface: '#2b2633', ink: '#ebe6f7', accent: '#8b6cff', signals: { skill: '#f2b712' } },
    { surface: '#fbfaff', ink: '#2b2233', accent: '#6c5fc7', signals: { skill: '#c4870b' } }
  ),
  preset(
    'og',
    'OG',
    'brand',
    { surface: '#343541', ink: '#ececf1', accent: '#10a37f', opaque: true, fonts: { ui: 'Arial, sans-serif', content: 'Arial, sans-serif' } },
    { surface: '#ffffff', ink: '#343541', accent: '#10a37f', opaque: true, fonts: { ui: 'Arial, sans-serif', content: 'Arial, sans-serif' } }
  ),
  preset(
    'xcode',
    'Xcode',
    'brand',
    { surface: '#1f1f24', ink: '#ffffff', accent: '#5482ff', fonts: { code: '"SF Mono", SFMono-Regular, Menlo, monospace' }, signals: { skill: '#fc5fa3' } },
    { surface: '#ffffff', ink: '#000000', accent: '#2f5cf6', fonts: { code: '"SF Mono", SFMono-Regular, Menlo, monospace' }, signals: { skill: '#ad3da4' } }
  ),
  preset(
    'matrix',
    'Matrix',
    'brand',
    { surface: '#040805', ink: '#b8ffca', accent: '#1eff5a', contrast: 66, opaque: true, fonts: { ui: 'ui-monospace, "SF Mono", Menlo, monospace' }, signals: { diffAdded: '#1eff5a', skill: '#7dffb0' } }
  ),
  preset(
    'proof',
    'Proof',
    'brand',
    { surface: '#1c1d1a', ink: '#e8e6df', accent: '#5fa883' },
    { surface: '#f5f3ed', ink: '#2f312d', accent: '#3d755d' }
  ),
  preset('lobster', 'Lobster', 'brand', { surface: '#111827', ink: '#e4e4e7', accent: '#ff5c5c', fonts: { ui: '"Satoshi", -apple-system, sans-serif' } }),
  preset('temple', 'Temple', 'brand', { surface: '#02120c', ink: '#c7e6da', accent: '#e4f222', signals: { skill: '#7ee0b8' } }),
  preset('oscurange', 'Oscurange', 'brand', { surface: '#0b0b0f', ink: '#e6e6e6', accent: '#f9b98c', signals: { skill: '#c8a2ff' } }),
  // Editor palettes
  preset(
    'github',
    'GitHub',
    'editor',
    { surface: '#0d1117', ink: '#e6edf3', accent: '#2f81f7', contrast: 58 },
    { surface: '#ffffff', ink: '#1f2328', accent: '#0969da', contrast: 44 }
  ),
  preset(
    'catppuccin',
    'Catppuccin',
    'editor',
    { surface: '#1e1e2e', ink: '#cdd6f4', accent: '#cba6f7', signals: { diffAdded: '#a6e3a1', diffRemoved: '#f38ba8', skill: '#f5c2e7' } },
    { surface: '#eff1f5', ink: '#4c4f69', accent: '#8839ef', signals: { diffAdded: '#40a02b', diffRemoved: '#d20f39', skill: '#ea76cb' } }
  ),
  preset(
    'everforest',
    'Everforest',
    'editor',
    { surface: '#2d353b', ink: '#d3c6aa', accent: '#a7c080', signals: { diffAdded: '#a7c080', diffRemoved: '#e67e80', skill: '#d699b6' } },
    { surface: '#fdf6e3', ink: '#5c6a72', accent: '#8da101', contrast: 44, signals: { diffAdded: '#8da101', diffRemoved: '#f85552', skill: '#df69ba' } }
  ),
  preset(
    'rose-pine',
    'Rosé Pine',
    'editor',
    { surface: '#232136', ink: '#e0def4', accent: '#ea9a97', signals: { diffAdded: '#9ccfd8', diffRemoved: '#eb6f92', skill: '#c4a7e7' } },
    { surface: '#faf4ed', ink: '#575279', accent: '#d7827e', signals: { diffAdded: '#286983', diffRemoved: '#b4637a', skill: '#907aa9' } }
  ),
  preset('tokyo-night', 'Tokyo Night', 'editor', {
    surface: '#1a1b26',
    ink: '#c0caf5',
    accent: '#7aa2f7',
    contrast: 68,
    signals: { diffAdded: '#9ece6a', diffRemoved: '#f7768e', skill: '#bb9af7' },
  }),
];

const BY_ID = new Map(THEME_PRESETS.map((entry) => [entry.id, entry]));

export function findPreset(id: string): ThemePreset | undefined {
  return BY_ID.get(id);
}

export function presetsFor(variant: ThemeVariant): ThemePreset[] {
  return THEME_PRESETS.filter((entry) => entry.variants[variant]);
}

import type { ColorThemeId, Theme } from '../types';

type ThemeVariables = Record<string, string>;
type ResolvedThemeMode = 'light' | 'dark';

export interface ColorThemeFamily {
  id: ColorThemeId;
  label: string;
  description: string;
  variants: Record<ResolvedThemeMode, ThemeVariables>;
}

const PAPER_LIGHT: ThemeVariables = {
  '--bg-primary': '#FFFFFF',
  '--bg-secondary': '#FFFFFF',
  '--bg-tertiary': '#F8F7F8',
  '--text-primary': '#111111',
  '--text-secondary': '#62646A',
  '--text-muted': '#989BA3',
  '--accent': '#111827',
  '--accent-hover': '#030712',
  '--accent-light': 'rgba(17, 24, 39, 0.08)',
  '--accent-foreground': '#F9FAFB',
  '--success': '#22c55e',
  '--error': '#ef4444',
  '--warning': '#f59e0b',
  '--border': '#E5E7EB',
  '--tool-pending': '#f59e0b',
  '--tool-running': '#6B7280',
  '--tool-success': '#22c55e',
  '--tool-error': '#ef4444',
  '--code-inline-bg': '#F0F0F2',
  '--code-inline-border': '#E3E3E7',
  '--code-inline-text': '#4B5563',
  '--code-block-bg': '#F3F3F5',
  '--code-block-header-bg': '#F3F3F5',
  '--code-block-border': '#E6E6EA',
  '--code-block-text': '#1F2937',
  '--code-copy-bg': 'transparent',
  '--code-copy-hover': 'rgba(17, 24, 39, 0.05)',
  '--code-token-comment': '#9CA3AF',
  '--code-token-keyword': '#C24D84',
  '--code-token-string': '#1F8C5B',
  '--code-token-function': '#6B46C1',
  '--code-token-number': '#D97706',
  '--code-token-operator': '#6B7280',
  '--code-token-variable': '#111827',
  '--user-bubble-bg': '#F6F5F4',
  '--user-bubble-border': '#E3E4E8',
  '--user-bubble-shadow': '0 1px 2px rgba(15, 23, 42, 0.04)',
};

const PAPER_DARK: ThemeVariables = {
  '--bg-primary': '#111214',
  '--bg-secondary': '#17181B',
  '--bg-tertiary': '#22242A',
  '--text-primary': '#F5F5F5',
  '--text-secondary': '#B2B5BB',
  '--text-muted': '#80838A',
  '--accent': '#E5E7EB',
  '--accent-hover': '#F5F5F5',
  '--accent-light': 'rgba(229, 231, 235, 0.12)',
  '--accent-foreground': '#111214',
  '--success': '#4ade80',
  '--error': '#f87171',
  '--warning': '#fbbf24',
  '--border': 'rgba(255, 255, 255, 0.12)',
  '--tool-pending': '#fbbf24',
  '--tool-running': '#9CA3AF',
  '--tool-success': '#4ade80',
  '--tool-error': '#f87171',
  '--code-inline-bg': '#303237',
  '--code-inline-border': '#41454D',
  '--code-inline-text': '#E5E7EB',
  '--code-block-bg': '#2A2D33',
  '--code-block-header-bg': '#2A2D33',
  '--code-block-border': '#3B4048',
  '--code-block-text': '#F3F4F6',
  '--code-copy-bg': 'rgba(255, 255, 255, 0.06)',
  '--code-copy-hover': 'rgba(255, 255, 255, 0.1)',
  '--code-token-comment': '#9CA3AF',
  '--code-token-keyword': '#F472B6',
  '--code-token-string': '#4ADE80',
  '--code-token-function': '#A78BFA',
  '--code-token-number': '#F59E0B',
  '--code-token-operator': '#CBD5E1',
  '--code-token-variable': '#F3F4F6',
  '--user-bubble-bg': '#1F2228',
  '--user-bubble-border': 'rgba(255, 255, 255, 0.07)',
  '--user-bubble-shadow': '0 1px 2px rgba(0, 0, 0, 0.2)',
};

const GRAPHITE_LIGHT: ThemeVariables = {
  ...PAPER_LIGHT,
  '--bg-primary': '#F5F7FB',
  '--bg-secondary': '#FFFFFF',
  '--bg-tertiary': '#EEF2F7',
  '--text-primary': '#0F172A',
  '--text-secondary': '#475467',
  '--text-muted': '#8A94A6',
  '--accent': '#1D4ED8',
  '--accent-hover': '#1E40AF',
  '--accent-light': 'rgba(29, 78, 216, 0.10)',
  '--accent-foreground': '#EFF6FF',
  '--border': '#D9E0EA',
  '--code-inline-bg': '#E9EEF6',
  '--code-inline-border': '#D6E0EE',
  '--code-inline-text': '#334155',
  '--code-block-bg': '#ECF1F8',
  '--code-block-header-bg': '#ECF1F8',
  '--code-block-border': '#D8E1EE',
  '--code-token-keyword': '#7C3AED',
  '--code-token-string': '#047857',
  '--code-token-function': '#1D4ED8',
  '--code-token-number': '#C2410C',
  '--user-bubble-bg': '#EEF3FA',
  '--user-bubble-border': '#D8E2EF',
};

const GRAPHITE_DARK: ThemeVariables = {
  ...PAPER_DARK,
  '--bg-primary': '#0F1117',
  '--bg-secondary': '#151925',
  '--bg-tertiary': '#1F2635',
  '--text-primary': '#EEF2FF',
  '--text-secondary': '#B5C0D6',
  '--text-muted': '#7D8BA5',
  '--accent': '#7AA2F7',
  '--accent-hover': '#9AB8FF',
  '--accent-light': 'rgba(122, 162, 247, 0.16)',
  '--accent-foreground': '#0F1117',
  '--border': 'rgba(148, 163, 184, 0.18)',
  '--code-inline-bg': '#1B2230',
  '--code-inline-border': '#2B3548',
  '--code-inline-text': '#D7E2F2',
  '--code-block-bg': '#171D29',
  '--code-block-header-bg': '#171D29',
  '--code-block-border': '#283245',
  '--code-token-comment': '#7D8BA5',
  '--code-token-keyword': '#C792EA',
  '--code-token-string': '#8BD49C',
  '--code-token-function': '#82AAFF',
  '--code-token-number': '#F7B267',
  '--code-token-operator': '#B6C2D9',
  '--user-bubble-bg': '#161C28',
  '--user-bubble-border': 'rgba(122, 162, 247, 0.08)',
  '--user-bubble-shadow': '0 1px 2px rgba(0, 0, 0, 0.28)',
};

const SEPIA_LIGHT: ThemeVariables = {
  ...PAPER_LIGHT,
  '--bg-primary': '#F7F1E7',
  '--bg-secondary': '#FFF9F0',
  '--bg-tertiary': '#EFE3D1',
  '--text-primary': '#3D2F22',
  '--text-secondary': '#6B5B4D',
  '--text-muted': '#9C8B78',
  '--accent': '#8A5A44',
  '--accent-hover': '#744938',
  '--accent-light': 'rgba(138, 90, 68, 0.12)',
  '--accent-foreground': '#FFF7ED',
  '--border': '#DDCBB7',
  '--code-inline-bg': '#F0E4D4',
  '--code-inline-border': '#E0CFB9',
  '--code-inline-text': '#5B4635',
  '--code-block-bg': '#F5EBDD',
  '--code-block-header-bg': '#F5EBDD',
  '--code-block-border': '#E2D3BE',
  '--code-token-keyword': '#A23E48',
  '--code-token-string': '#5C7C46',
  '--code-token-function': '#8C5E34',
  '--code-token-number': '#B45309',
  '--user-bubble-bg': '#F2E7D8',
  '--user-bubble-border': '#DECDB7',
};

const SEPIA_DARK: ThemeVariables = {
  ...PAPER_DARK,
  '--bg-primary': '#1A1511',
  '--bg-secondary': '#211B15',
  '--bg-tertiary': '#30261D',
  '--text-primary': '#F5EAD9',
  '--text-secondary': '#D0BBA1',
  '--text-muted': '#A18E78',
  '--accent': '#E2A96B',
  '--accent-hover': '#EDBC88',
  '--accent-light': 'rgba(226, 169, 107, 0.16)',
  '--accent-foreground': '#241B14',
  '--border': 'rgba(226, 169, 107, 0.18)',
  '--code-inline-bg': '#2A2118',
  '--code-inline-border': '#3B2F23',
  '--code-inline-text': '#E7D7C2',
  '--code-block-bg': '#241C15',
  '--code-block-header-bg': '#241C15',
  '--code-block-border': '#3A2D21',
  '--code-token-keyword': '#F38BA8',
  '--code-token-string': '#A6D189',
  '--code-token-function': '#E5C890',
  '--code-token-number': '#F6C177',
  '--code-token-operator': '#D6C6AE',
  '--user-bubble-bg': '#241C16',
  '--user-bubble-border': 'rgba(255, 236, 214, 0.08)',
};

const ROSE_LIGHT: ThemeVariables = {
  ...PAPER_LIGHT,
  '--bg-primary': '#FFF7FA',
  '--bg-secondary': '#FFFFFF',
  '--bg-tertiary': '#FCECF2',
  '--text-primary': '#2D1320',
  '--text-secondary': '#6C4255',
  '--text-muted': '#A07689',
  '--accent': '#B83280',
  '--accent-hover': '#97266D',
  '--accent-light': 'rgba(184, 50, 128, 0.12)',
  '--accent-foreground': '#FFF5FA',
  '--border': '#EBC8D8',
  '--code-inline-bg': '#F8E6EE',
  '--code-inline-border': '#EFCFDD',
  '--code-inline-text': '#6B3655',
  '--code-block-bg': '#FAEDF3',
  '--code-block-header-bg': '#FAEDF3',
  '--code-block-border': '#EFCFDD',
  '--code-token-keyword': '#B83280',
  '--code-token-string': '#2F855A',
  '--code-token-function': '#6B46C1',
  '--code-token-number': '#DD6B20',
  '--user-bubble-bg': '#FBEAF1',
  '--user-bubble-border': '#E8CAD7',
};

const ROSE_DARK: ThemeVariables = {
  ...PAPER_DARK,
  '--bg-primary': '#170F16',
  '--bg-secondary': '#211320',
  '--bg-tertiary': '#321A2F',
  '--text-primary': '#F9EAF1',
  '--text-secondary': '#D6B2C5',
  '--text-muted': '#A88497',
  '--accent': '#F472B6',
  '--accent-hover': '#F9A8D4',
  '--accent-light': 'rgba(244, 114, 182, 0.16)',
  '--accent-foreground': '#2A1122',
  '--border': 'rgba(244, 114, 182, 0.16)',
  '--code-inline-bg': '#291724',
  '--code-inline-border': '#3A2032',
  '--code-inline-text': '#F2D5E3',
  '--code-block-bg': '#23141F',
  '--code-block-header-bg': '#23141F',
  '--code-block-border': '#3B2234',
  '--code-token-keyword': '#FF8CC6',
  '--code-token-string': '#86EFAC',
  '--code-token-function': '#C4B5FD',
  '--code-token-number': '#FDBA74',
  '--code-token-operator': '#E7CAD8',
  '--user-bubble-bg': '#24151F',
  '--user-bubble-border': 'rgba(255, 255, 255, 0.08)',
};

export const DEFAULT_COLOR_THEME_ID: ColorThemeId = 'paper';

export const COLOR_THEME_FAMILIES: ColorThemeFamily[] = [
  {
    id: 'paper',
    label: 'Paper',
    description: 'Clean neutral workspace with soft contrast.',
    variants: {
      light: PAPER_LIGHT,
      dark: PAPER_DARK,
    },
  },
  {
    id: 'graphite',
    label: 'Graphite',
    description: 'Sharper editor-like contrast with cool slate tones.',
    variants: {
      light: GRAPHITE_LIGHT,
      dark: GRAPHITE_DARK,
    },
  },
  {
    id: 'sepia',
    label: 'Sepia',
    description: 'Warm document-centric palette for reading and writing.',
    variants: {
      light: SEPIA_LIGHT,
      dark: SEPIA_DARK,
    },
  },
  {
    id: 'rose',
    label: 'Rose Night',
    description: 'Berry-tinted palette with stronger accent color.',
    variants: {
      light: ROSE_LIGHT,
      dark: ROSE_DARK,
    },
  },
];

const STYLE_TAG_ID = 'cowork-theme-custom-css';
const THEME_VARIABLE_NAMES = Object.keys(PAPER_LIGHT);

export function resolveThemeMode(themeMode: Theme): ResolvedThemeMode {
  if (themeMode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return themeMode;
}

export function getColorThemeFamily(colorThemeId: ColorThemeId): ColorThemeFamily {
  return (
    COLOR_THEME_FAMILIES.find((theme) => theme.id === colorThemeId) ||
    COLOR_THEME_FAMILIES[0]
  );
}

export function getThemePreviewPalette(colorThemeId: ColorThemeId, themeMode: Theme): string[] {
  const resolvedMode = resolveThemeMode(themeMode);
  const variables = getColorThemeFamily(colorThemeId).variants[resolvedMode];
  return [
    variables['--bg-primary'],
    variables['--bg-tertiary'],
    variables['--accent'],
    variables['--text-primary'],
  ];
}

export function applyThemePreferences({
  themeMode,
  colorThemeId,
  customThemeCss,
}: {
  themeMode: Theme;
  colorThemeId: ColorThemeId;
  customThemeCss: string;
}) {
  const root = document.documentElement;
  const resolvedMode = resolveThemeMode(themeMode);
  const variables = getColorThemeFamily(colorThemeId).variants[resolvedMode];

  root.classList.toggle('dark', resolvedMode === 'dark');
  root.dataset.colorTheme = colorThemeId;
  root.dataset.themeMode = resolvedMode;

  for (const variableName of THEME_VARIABLE_NAMES) {
    const value = variables[variableName];
    if (value) {
      root.style.setProperty(variableName, value);
    } else {
      root.style.removeProperty(variableName);
    }
  }

  const normalizedCss = normalizeCustomThemeCss(customThemeCss);
  let styleTag = document.getElementById(STYLE_TAG_ID) as HTMLStyleElement | null;

  if (!normalizedCss) {
    styleTag?.remove();
    return;
  }

  if (!styleTag) {
    styleTag = document.createElement('style');
    styleTag.id = STYLE_TAG_ID;
    document.head.appendChild(styleTag);
  }

  styleTag.textContent = normalizedCss;
}

function normalizeCustomThemeCss(customThemeCss: string): string {
  const trimmed = customThemeCss.trim();
  if (!trimmed) {
    return '';
  }

  return trimmed.includes('{') ? trimmed : `:root {\n${trimmed}\n}`;
}

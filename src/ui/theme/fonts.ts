import type { FontSelection, FontSettingsPayload, FontSlot, ImportedFontFace } from '../types';

const FONT_STYLE_TAG_ID = 'cowork-font-faces';
type BuiltinFontOption = {
  id: string;
  label: string;
  cssFamily: string;
};

type BuiltinFontRegistry = Record<FontSlot, BuiltinFontOption[]>;

export const BUILTIN_FONT_OPTIONS: BuiltinFontRegistry = {
  ui: [
    {
      id: 'system-sans',
      label: 'System UI',
      cssFamily: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif`,
    },
    {
      id: 'avenir',
      label: 'Avenir Next',
      cssFamily: `"Avenir Next", "Segoe UI", Helvetica, Arial, sans-serif`,
    },
    {
      id: 'helvetica',
      label: 'Helvetica Neue',
      cssFamily: `"Helvetica Neue", Helvetica, Arial, sans-serif`,
    },
    {
      id: 'source-sans',
      label: 'Source Sans 3',
      cssFamily: `"Source Sans 3", "Segoe UI", Arial, sans-serif`,
    },
  ],
  display: [
    {
      id: 'editorial-serif',
      label: 'Editorial Serif',
      cssFamily: `ui-serif, "New York", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, Cambria, "Times New Roman", Times, serif`,
    },
    {
      id: 'georgia',
      label: 'Georgia',
      cssFamily: `Georgia, Cambria, "Times New Roman", Times, serif`,
    },
    {
      id: 'palatino',
      label: 'Palatino',
      cssFamily: `"Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif`,
    },
    {
      id: 'baskerville',
      label: 'Baskerville',
      cssFamily: `Baskerville, "Times New Roman", serif`,
    },
  ],
  mono: [
    {
      id: 'system-mono',
      label: 'System Mono',
      cssFamily: `"SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace`,
    },
    {
      id: 'jetbrains',
      label: 'JetBrains Mono',
      cssFamily: `"JetBrains Mono", "SF Mono", Menlo, monospace`,
    },
    {
      id: 'fira-code',
      label: 'Fira Code',
      cssFamily: `"Fira Code", "SF Mono", Menlo, monospace`,
    },
    {
      id: 'ibm-plex-mono',
      label: 'IBM Plex Mono',
      cssFamily: `"IBM Plex Mono", "SF Mono", Menlo, monospace`,
    },
  ],
};

const DEFAULT_FONT_SELECTIONS: FontSettingsPayload['selections'] = {
  ui: { source: 'builtin', id: 'system-sans' },
  display: { source: 'builtin', id: 'editorial-serif' },
  mono: { source: 'builtin', id: 'system-mono' },
};

function getBuiltinOption(slot: FontSlot, id: string): BuiltinFontOption | null {
  return BUILTIN_FONT_OPTIONS[slot].find((option) => option.id === id) || null;
}

function getImportedFont(importedFonts: ImportedFontFace[], id: string): ImportedFontFace | null {
  return importedFonts.find((font) => font.id === id) || null;
}

function resolveSelection(
  slot: FontSlot,
  selection: FontSelection | undefined,
  importedFonts: ImportedFontFace[]
): { cssFamily: string; label: string } {
  if (selection?.source === 'imported') {
    const importedFont = getImportedFont(importedFonts, selection.id);
    if (importedFont) {
      return { cssFamily: `"${importedFont.cssFamily}"`, label: importedFont.label };
    }
  }

  if (selection?.source === 'system' && typeof selection.id === 'string' && selection.id.trim()) {
    return { cssFamily: `"${selection.id}"`, label: selection.id.trim() };
  }

  const builtin = getBuiltinOption(slot, selection?.id || DEFAULT_FONT_SELECTIONS[slot].id) || BUILTIN_FONT_OPTIONS[slot][0];
  return { cssFamily: builtin.cssFamily, label: builtin.label };
}

export function applyFontPreferences({
  fontSelections,
  importedFonts,
}: {
  fontSelections: FontSettingsPayload['selections'];
  importedFonts: ImportedFontFace[];
}) {
  let fontFaceTag = document.getElementById(FONT_STYLE_TAG_ID) as HTMLStyleElement | null;
  if (!fontFaceTag) {
    fontFaceTag = document.createElement('style');
    fontFaceTag.id = FONT_STYLE_TAG_ID;
  }
  document.head.appendChild(fontFaceTag);

  fontFaceTag.textContent = importedFonts
    .map(
      (font) => `@font-face {
  font-family: "${font.cssFamily}";
  src: url("data:${font.mimeType};base64,${font.dataBase64}") format("${font.format}");
  font-weight: normal;
  font-style: normal;
  font-display: swap;
}`
    )
    .join('\n\n');

  const uiFont = resolveSelection('ui', fontSelections.ui, importedFonts);
  const displayFont = resolveSelection('display', fontSelections.display, importedFonts);
  const monoFont = resolveSelection('mono', fontSelections.mono, importedFonts);
  const root = document.documentElement;
  root.style.setProperty('--font-sans', uiFont.cssFamily);
  root.style.setProperty('--font-serif', displayFont.cssFamily);
  root.style.setProperty('--font-mono', monoFont.cssFamily);
}

export function getDefaultFontSelections(): FontSettingsPayload['selections'] {
  return { ...DEFAULT_FONT_SELECTIONS };
}

export function getFontPreviewLabel(slot: FontSlot, selection: FontSelection, importedFonts: ImportedFontFace[]): string {
  return resolveSelection(slot, selection, importedFonts).label;
}

export function getFontPreviewCssFamily(slot: FontSlot, selection: FontSelection, importedFonts: ImportedFontFace[]): string {
  return resolveSelection(slot, selection, importedFonts).cssFamily;
}

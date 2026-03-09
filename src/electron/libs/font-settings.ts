import { execFile } from 'child_process';
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { copyFile, readFile } from 'fs/promises';
import { basename, extname, join } from 'path';
import type { FontFormat, FontSelection, FontSettingsPayload, FontSlot, ImportedFontFace, SystemFontOption } from '../../shared/types';

type StoredImportedFont = Omit<ImportedFontFace, 'dataBase64'> & { fileName: string };
type FontSettingsFile = {
  version: 1;
  selections: Record<FontSlot, FontSelection>;
  importedFonts: StoredImportedFont[];
};

const FONT_SETTINGS_PATH = () => join(app.getPath('userData'), 'font-settings.json');
const FONT_FILES_DIR = () => join(app.getPath('userData'), 'fonts');

const DEFAULT_FONT_SELECTIONS: Record<FontSlot, FontSelection> = {
  ui: { source: 'builtin', id: 'system-sans' },
  display: { source: 'builtin', id: 'editorial-serif' },
  mono: { source: 'builtin', id: 'system-mono' },
};

const FONT_MIME_TYPES: Record<FontFormat, string> = {
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
};
let cachedSystemFonts: SystemFontOption[] | null = null;

function ensureFontDirectory() {
  const dir = FONT_FILES_DIR();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function createDefaultFontSettingsFile(): FontSettingsFile {
  return {
    version: 1,
    selections: { ...DEFAULT_FONT_SELECTIONS },
    importedFonts: [],
  };
}

function normalizeFontSelection(value: Partial<FontSelection> | undefined, importedIds: Set<string>, slot: FontSlot): FontSelection {
  if (value?.source === 'imported' && typeof value.id === 'string' && importedIds.has(value.id)) {
    return { source: 'imported', id: value.id };
  }

  if (value?.source === 'system' && typeof value.id === 'string' && value.id.trim()) {
    return { source: 'system', id: value.id.trim() };
  }

  if (value?.source === 'builtin' && typeof value.id === 'string' && value.id.trim()) {
    return { source: 'builtin', id: value.id.trim() };
  }

  return DEFAULT_FONT_SELECTIONS[slot];
}

function loadStoredFontSettings(): FontSettingsFile {
  const configPath = FONT_SETTINGS_PATH();
  if (!existsSync(configPath)) {
    return createDefaultFontSettingsFile();
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<FontSettingsFile>;
    const importedFonts = Array.isArray(parsed.importedFonts)
      ? parsed.importedFonts.filter((item): item is StoredImportedFont =>
          !!item &&
          typeof item.id === 'string' &&
          typeof item.label === 'string' &&
          typeof item.cssFamily === 'string' &&
          typeof item.fileName === 'string' &&
          typeof item.mimeType === 'string' &&
          (item.format === 'ttf' || item.format === 'otf' || item.format === 'woff' || item.format === 'woff2')
        )
      : [];
    const importedIds = new Set(importedFonts.map((item) => item.id));

    return {
      version: 1,
      selections: {
        ui: normalizeFontSelection(parsed.selections?.ui, importedIds, 'ui'),
        display: normalizeFontSelection(parsed.selections?.display, importedIds, 'display'),
        mono: normalizeFontSelection(parsed.selections?.mono, importedIds, 'mono'),
      },
      importedFonts,
    };
  } catch {
    return createDefaultFontSettingsFile();
  }
}

function saveStoredFontSettings(config: FontSettingsFile) {
  writeFileSync(FONT_SETTINGS_PATH(), JSON.stringify(config, null, 2), 'utf-8');
}

function getFontFormat(filePath: string): FontFormat | null {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case '.ttf':
      return 'ttf';
    case '.otf':
      return 'otf';
    case '.woff':
      return 'woff';
    case '.woff2':
      return 'woff2';
    default:
      return null;
  }
}

function sanitizeFontLabel(filePath: string): string {
  return basename(filePath, extname(filePath)).replace(/[_-]+/g, ' ').trim() || 'Custom Font';
}

function buildCssFamily(id: string): string {
  return `CoworkFont_${id}`;
}

async function hydrateImportedFonts(fonts: StoredImportedFont[]): Promise<ImportedFontFace[]> {
  const dir = FONT_FILES_DIR();
  const hydrated: ImportedFontFace[] = [];

  for (const font of fonts) {
    const absolutePath = join(dir, font.fileName);
    if (!existsSync(absolutePath)) {
      continue;
    }

    const dataBase64 = (await readFile(absolutePath)).toString('base64');
    hydrated.push({
      id: font.id,
      label: font.label,
      cssFamily: font.cssFamily,
      format: font.format,
      mimeType: font.mimeType,
      dataBase64,
    });
  }

  return hydrated;
}

export async function getFontSettings(): Promise<FontSettingsPayload> {
  const stored = loadStoredFontSettings();
  return {
    selections: stored.selections,
    importedFonts: await hydrateImportedFonts(stored.importedFonts),
  };
}

export async function saveFontSelections(selections: FontSettingsPayload['selections']): Promise<FontSettingsPayload> {
  const stored = loadStoredFontSettings();
  const importedIds = new Set(stored.importedFonts.map((font) => font.id));
  stored.selections = {
    ui: normalizeFontSelection(selections.ui, importedIds, 'ui'),
    display: normalizeFontSelection(selections.display, importedIds, 'display'),
    mono: normalizeFontSelection(selections.mono, importedIds, 'mono'),
  };
  saveStoredFontSettings(stored);
  return getFontSettings();
}

export async function importFontFile(filePath: string): Promise<FontSettingsPayload> {
  const format = getFontFormat(filePath);
  if (!format) {
    throw new Error('Unsupported font file. Use .ttf, .otf, .woff, or .woff2.');
  }

  const stored = loadStoredFontSettings();
  const fontsDir = ensureFontDirectory();
  const id = `font_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const fileName = `${id}.${format}`;
  await copyFile(filePath, join(fontsDir, fileName));

  stored.importedFonts.push({
    id,
    label: sanitizeFontLabel(filePath),
    cssFamily: buildCssFamily(id),
    fileName,
    format,
    mimeType: FONT_MIME_TYPES[format],
  });

  saveStoredFontSettings(stored);
  return getFontSettings();
}

export async function deleteImportedFont(id: string): Promise<FontSettingsPayload> {
  const stored = loadStoredFontSettings();
  const font = stored.importedFonts.find((item) => item.id === id);
  if (!font) {
    return getFontSettings();
  }

  stored.importedFonts = stored.importedFonts.filter((item) => item.id !== id);
  (Object.keys(stored.selections) as FontSlot[]).forEach((slot) => {
    const current = stored.selections[slot];
    if (current.source === 'imported' && current.id === id) {
      stored.selections[slot] = DEFAULT_FONT_SELECTIONS[slot];
    }
  });

  saveStoredFontSettings(stored);
  rmSync(join(FONT_FILES_DIR(), font.fileName), { force: true });
  return getFontSettings();
}

function execFileAsync(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

async function loadSystemFontsFromProfiler(): Promise<SystemFontOption[]> {
  const stdout = await execFileAsync('/usr/sbin/system_profiler', ['SPFontsDataType', '-json']);
  const parsed = JSON.parse(stdout) as {
    SPFontsDataType?: Array<{
      enabled?: string;
      valid?: string;
      typefaces?: Array<{ family?: string; fullname?: string; enabled?: string; valid?: string }>;
    }>;
  };

  const names = new Set<string>();

  for (const entry of parsed.SPFontsDataType || []) {
    if (entry.enabled === 'no' || entry.valid === 'no') {
      continue;
    }

    for (const face of entry.typefaces || []) {
      if (face.enabled === 'no' || face.valid === 'no') {
        continue;
      }
      const family = face.family?.trim() || face.fullname?.trim();
      if (family) {
        names.add(family);
      }
    }
  }

  return Array.from(names)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({
      id: name,
      label: name,
      cssFamily: `"${name}"`,
    }));
}

export async function listSystemFonts(): Promise<SystemFontOption[]> {
  if (cachedSystemFonts) {
    return cachedSystemFonts;
  }

  try {
    cachedSystemFonts = await loadSystemFontsFromProfiler();
    return cachedSystemFonts;
  } catch {
    cachedSystemFonts = [];
    return cachedSystemFonts;
  }
}

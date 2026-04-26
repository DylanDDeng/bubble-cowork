import { useMemo } from 'react';
import { Copy, Download, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { SettingsToggle } from './SettingsPrimitives';
import type { ChromeTheme, Theme, ThemePack, ThemeState, ThemeVariant } from '../../types';
import {
  CODE_THEME_OPTIONS,
  DEFAULT_THEME_STATE,
  createThemeShareString,
  getAvailableCodeThemes,
  getCodeThemeSeed,
  importThemeShareString,
  resolveThemePack,
} from '../../theme/themes';

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function ThemePackEditor({
  variant,
  mode,
  isActive,
  pack,
  themeState,
  onReset,
  onCodeThemeChange,
  onThemePatch,
  onFontPatch,
  onImportThemeString,
}: {
  variant: ThemeVariant;
  mode: Theme;
  isActive: boolean;
  pack: ThemePack;
  themeState: ThemeState;
  onReset: () => void;
  onCodeThemeChange: (codeThemeId: string) => void;
  onThemePatch: (patch: Partial<ChromeTheme>) => void;
  onFontPatch: (patch: Partial<ChromeTheme['fonts']>) => void;
  onImportThemeString: (nextThemeState: ThemeState) => void;
}) {
  const codeThemes = useMemo(() => getAvailableCodeThemes(variant), [variant]);
  const defaultTheme = resolveThemePack(DEFAULT_THEME_STATE, variant).theme;
  const title = variant === 'dark' ? 'Dark Theme' : 'Light Theme';
  const contextLabel = isActive
    ? mode === 'system'
      ? `System is currently using this ${variant} slot.`
      : 'This is the active theme right now.'
    : mode === 'system'
      ? `Used when your system switches to ${variant}.`
      : `Inactive while the app is locked to ${mode}.`;
  const isDefault = JSON.stringify(pack) === JSON.stringify(resolveThemePack(DEFAULT_THEME_STATE, variant));
  const previewTheme =
    CODE_THEME_OPTIONS.find((option) => option.id === pack.codeThemeId)?.label ?? pack.codeThemeId;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(createThemeShareString(variant, pack));
      toast.success(`${title} copied`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to copy theme');
    }
  };

  const handleImport = () => {
    const value = window.prompt(`Paste a ${variant} codex-theme-v1 string`);
    if (!value?.trim()) {
      return;
    }

    try {
      onImportThemeString(importThemeShareString(themeState, variant, value));
      toast.success(`${title} imported`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to import theme');
    }
  };

  return (
    <div className="overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-[13px] font-medium text-[var(--text-primary)]">{title}</h3>
            {!isDefault ? (
              <button
                type="button"
                onClick={onReset}
                className="rounded-[6px] px-1.5 py-0.5 text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
              >
                Reset
              </button>
            ) : null}
          </div>
          <div className="mt-1 text-[11px] text-[var(--text-muted)]">{contextLabel}</div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleImport}
            className="inline-flex h-7 items-center gap-1.5 rounded-[8px] border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          >
            <Download className="h-3.5 w-3.5" />
            Import
          </button>
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="inline-flex h-7 items-center gap-1.5 rounded-[8px] border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          >
            <Copy className="h-3.5 w-3.5" />
            Copy
          </button>
        </div>
      </div>

      <div className="divide-y divide-[var(--border)]">
        <ThemePackRow label="Code theme">
          <label className="flex min-w-[220px] items-center gap-2 rounded-[10px] border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5">
            <ThemeBadge theme={pack.theme} />
            <select
              value={pack.codeThemeId}
              onChange={(event) => onCodeThemeChange(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-[12px] font-medium text-[var(--text-primary)] outline-none"
              aria-label={`${title} code theme`}
            >
              {codeThemes.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <div className="hidden text-[11px] text-[var(--text-muted)] md:block">{previewTheme}</div>
        </ThemePackRow>

        <ThemePackRow label="Accent">
          <ColorControl
            value={pack.theme.accent}
            previewTheme={getCodeThemeSeed(pack.codeThemeId, variant)}
            onChange={(accent) => onThemePatch({ accent })}
            onReset={pack.theme.accent !== defaultTheme.accent ? () => onThemePatch({ accent: defaultTheme.accent }) : undefined}
          />
        </ThemePackRow>

        <ThemePackRow label="Background">
          <ColorControl
            value={pack.theme.surface}
            previewTheme={getCodeThemeSeed(pack.codeThemeId, variant)}
            onChange={(surface) => onThemePatch({ surface })}
            onReset={pack.theme.surface !== defaultTheme.surface ? () => onThemePatch({ surface: defaultTheme.surface }) : undefined}
          />
        </ThemePackRow>

        <ThemePackRow label="Foreground">
          <ColorControl
            value={pack.theme.ink}
            previewTheme={getCodeThemeSeed(pack.codeThemeId, variant)}
            onChange={(ink) => onThemePatch({ ink })}
            onReset={pack.theme.ink !== defaultTheme.ink ? () => onThemePatch({ ink: defaultTheme.ink }) : undefined}
          />
        </ThemePackRow>

        <ThemePackRow label="UI font">
          <input
            type="text"
            value={pack.theme.fonts.ui ?? ''}
            onChange={(event) => onFontPatch({ ui: event.target.value.trim() || null })}
            placeholder="System default"
            spellCheck={false}
            className="h-8 min-w-[220px] rounded-[10px] border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-right text-[12px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
          />
        </ThemePackRow>

        <ThemePackRow label="Code font">
          <input
            type="text"
            value={pack.theme.fonts.code ?? ''}
            onChange={(event) => onFontPatch({ code: event.target.value.trim() || null })}
            placeholder='"JetBrains Mono"'
            spellCheck={false}
            className="h-8 min-w-[220px] rounded-[10px] border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-right font-mono text-[12px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
          />
        </ThemePackRow>

        <ThemePackRow label="Translucent sidebar">
          <SettingsToggle
            checked={!pack.theme.opaqueWindows}
            onChange={(checked) => onThemePatch({ opaqueWindows: !checked })}
            ariaLabel={`${title} translucent sidebar`}
          />
        </ThemePackRow>

        <ThemePackRow label="Contrast">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={pack.theme.contrast}
              onChange={(event) => onThemePatch({ contrast: Number(event.target.value) })}
              className="h-1.5 w-[220px] cursor-pointer appearance-none rounded-full bg-[var(--bg-tertiary)]"
              style={{
                background: `linear-gradient(to right, var(--accent) 0%, var(--accent) ${pack.theme.contrast}%, var(--bg-tertiary) ${pack.theme.contrast}%, var(--bg-tertiary) 100%)`,
              }}
            />
            <span className="w-7 text-right font-mono text-[12px] text-[var(--text-secondary)]">
              {pack.theme.contrast}
            </span>
          </div>
        </ThemePackRow>
      </div>
    </div>
  );
}

function ThemePackRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3">
      <div className="text-[13px] font-medium text-[var(--text-primary)]">{label}</div>
      <div className="flex items-center justify-end gap-2">{children}</div>
    </div>
  );
}

function ThemeBadge({ theme }: { theme: ChromeTheme }) {
  return (
    <span
      aria-hidden
      className="inline-flex h-5 w-5 items-center justify-center rounded-[6px] border text-[10px] font-semibold"
      style={{
        backgroundColor: theme.surface,
        borderColor: mixColor(theme.surface, theme.ink, 0.16),
        color: theme.accent,
      }}
    >
      Aa
    </span>
  );
}

function ColorControl({
  value,
  previewTheme,
  onChange,
  onReset,
}: {
  value: string;
  previewTheme: ChromeTheme;
  onChange: (next: string) => void;
  onReset?: () => void;
}) {
  const normalized = HEX_COLOR_RE.test(value) ? value : previewTheme.accent;
  const textColor = getReadableTextColor(normalized);

  return (
    <div className="flex items-center gap-1.5">
      {onReset ? (
        <button
          type="button"
          onClick={onReset}
          className="inline-flex h-8 w-8 items-center justify-center rounded-[10px] border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          aria-label="Reset color"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      ) : null}
      <label
        className="flex h-8 min-w-[220px] items-center gap-2 rounded-[10px] border border-[var(--border)] px-2"
        style={{ backgroundColor: normalized, color: textColor }}
      >
        <input
          type="color"
          value={normalized}
          onChange={(event) => onChange(event.target.value)}
          className="h-5 w-5 cursor-pointer rounded border-none bg-transparent p-0"
          aria-label="Pick color"
        />
        <input
          type="text"
          value={value}
          onChange={(event) => {
            const next = event.target.value.trim();
            if (HEX_COLOR_RE.test(next)) {
              onChange(next.toLowerCase());
            } else if (next.length === 0) {
              onChange(defaultHex(previewTheme));
            }
          }}
          spellCheck={false}
          className="flex-1 bg-transparent text-[12px] uppercase outline-none placeholder:text-current/70"
          placeholder={defaultHex(previewTheme)}
          aria-label="Hex color"
        />
      </label>
    </div>
  );
}

function defaultHex(theme: ChromeTheme): string {
  return theme.accent;
}

function getReadableTextColor(hex: string): string {
  const color = parseHex(hex);
  if (!color) {
    return '#fcfcfc';
  }
  const luminance = (0.299 * color.r + 0.587 * color.g + 0.114 * color.b) / 255;
  return luminance > 0.6 ? '#111111' : '#fcfcfc';
}

function mixColor(fromHex: string, toHex: string, amount: number): string {
  const from = parseHex(fromHex);
  const to = parseHex(toHex);
  if (!from || !to) {
    return fromHex;
  }
  const clamped = Math.max(0, Math.min(1, amount));
  const r = Math.round(from.r + (to.r - from.r) * clamped);
  const g = Math.round(from.g + (to.g - from.g) * clamped);
  const b = Math.round(from.b + (to.b - from.b) * clamped);
  return `rgb(${r}, ${g}, ${b})`;
}

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  if (!HEX_COLOR_RE.test(hex)) {
    return null;
  }
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

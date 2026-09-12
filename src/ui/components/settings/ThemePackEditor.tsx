import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Dialog } from '@base-ui-components/react/dialog';
import { Popover } from '@base-ui-components/react/popover';
import { HexColorPicker } from 'react-colorful';
import { toast } from 'sonner';
import { PreferenceSelect } from './GeneralSettingsContent';
import { FontFamilySelect } from './FontFamilySelect';
import { SettingsToggle } from './SettingsPrimitives';
import type { ChromeTheme, Theme, ThemePack, ThemeState, ThemeVariant } from '../../types';
import { createThemeShareString, getAvailableCodeThemes, getCodeThemeSeed, importThemeShareString } from '../../theme/themes';
import * as DropdownMenu from '../ui/dropdown-menu';
import { Check, ChevronDown } from '../icons';
import './theme-pack-editor.css';

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function ThemePackEditor({ variant, pack, themeState, onReset, onCodeThemeChange, onThemePatch, onFontPatch, onImportThemeString }: {
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
  const [importOpen, setImportOpen] = useState(false);
  const [importValue, setImportValue] = useState('');
  const [importError, setImportError] = useState('');
  const codeThemes = useMemo(() => getAvailableCodeThemes(variant), [variant]);
  const title = variant === 'dark' ? 'Dark Theme' : 'Light Theme';
  const visibleTitle = variant === 'dark' ? 'Dark theme' : 'Light theme';
  const handleCopy = async () => {
    try { await navigator.clipboard.writeText(createThemeShareString(variant, pack)); toast.success(`${visibleTitle} copied`); }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Failed to copy theme'); }
  };
  const handleImport = () => {
    if (!importValue.trim()) return;
    try { onImportThemeString(importThemeShareString(themeState, variant, importValue)); setImportOpen(false); toast.success(`${visibleTitle} imported`); }
    catch (error) { setImportError(error instanceof Error ? error.message : 'Failed to import theme'); }
  };
  return <>
    <Dialog.Root open={importOpen} onOpenChange={setImportOpen}>
      <Dialog.Portal><Dialog.Backdrop className="fixed inset-0 z-[10000] bg-black/25" />
        <Dialog.Popup className="popover-surface fixed left-1/2 top-1/2 z-[10001] w-[440px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 p-5">
          <Dialog.Title className="mb-4 text-[16px] font-semibold">Import {visibleTitle}</Dialog.Title>
          <Dialog.Description className="sr-only">Paste a theme configuration to import.</Dialog.Description>
          <textarea aria-label="Theme configuration" value={importValue} onChange={e => { setImportValue(e.target.value); setImportError(''); }} placeholder="codex-theme-v1:…" rows={4} className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3 font-mono text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" />
          {importError && <p role="alert" className="mt-2 text-[12px] text-[var(--error)]">{importError}</p>}
          <div className="mt-4 flex justify-end gap-2"><Dialog.Close className="rounded-lg px-3 py-1.5 text-[13px]">Cancel</Dialog.Close>
            <button onClick={handleImport} disabled={!importValue.trim()} className="rounded-lg bg-[var(--text-primary)] px-3 py-1.5 text-[13px] text-[var(--bg-primary)] disabled:opacity-40">Import</button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
    <section data-settings-label={title} className="theme-pack-card" style={{ '--theme-preview-accent': pack.theme.accent, '--theme-preview-surface': pack.theme.surface } as CSSProperties}>
      <div className="theme-pack-header">
        <h3>{visibleTitle}</h3>
        <div className="theme-pack-header-controls">
          <button type="button" aria-label={`Import ${title}`} onClick={() => { setImportValue(''); setImportError(''); setImportOpen(true); }} className="theme-text-action">Import</button>
          <button type="button" aria-label={`Copy ${title}`} onClick={() => void handleCopy()} className="theme-text-action">Copy theme</button>
          <span aria-hidden="true" className="theme-preview-trigger" style={{ backgroundColor: pack.theme.surface, color: pack.theme.accent }}>Aa</span>
          <div className="theme-code-select"><DropdownMenu.Root>
            <DropdownMenu.Trigger asChild><button type="button" className="theme-select" aria-label={`${title} code theme`} data-preference-value={pack.codeThemeId}>
              <span className="truncate">{codeThemes.find(option => option.id === pack.codeThemeId)?.label}</span><ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
            </button></DropdownMenu.Trigger>
            <DropdownMenu.Portal><DropdownMenu.Content align="end" sideOffset={6} className="max-h-[min(360px,calc(100vh-24px))] w-[260px] overflow-y-auto">
              {codeThemes.map(option => { const seed = getCodeThemeSeed(option.id, variant); return <DropdownMenu.Item key={option.id} data-preference-option={option.id} onSelect={() => onCodeThemeChange(option.id)} className="gap-2 text-[13px]">
                <span aria-hidden="true" className="theme-menu-preview" style={{ background: seed.surface, color: seed.accent }}>Aa</span><span className="min-w-0 flex-1 truncate">{option.label}</span>
                {pack.codeThemeId === option.id && <Check className="h-3.5 w-3.5" />}
              </DropdownMenu.Item>; })}
              <DropdownMenu.Separator />
              <DropdownMenu.Item aria-label={`Reset ${title}`} onSelect={onReset}>Reset theme</DropdownMenu.Item>
            </DropdownMenu.Content></DropdownMenu.Portal>
          </DropdownMenu.Root></div>
        </div>
      </div>
      <ThemePackRow label="Accent">
        <div className="theme-accent-controls">
          <PreferenceSelect label={`${title} accent preset`} value={pack.theme.accentPreset ?? 'custom'} options={[{ value: 'default', label: 'Default' }, { value: 'custom', label: 'Custom' }]}
            onChange={value => onThemePatch(value === 'default' ? { accent: getCodeThemeSeed(pack.codeThemeId, variant).accent, accentPreset: 'default' } : { accentPreset: 'custom' })} />
          <ColorControl label={`${title} accent color`} value={pack.theme.accent} onChange={accent => onThemePatch({ accent, accentPreset: 'custom' })} />
        </div>
      </ThemePackRow>
      <ThemePackRow label="Background"><ColorControl label={`${title} background color`} value={pack.theme.surface} onChange={surface => onThemePatch({ surface })} /></ThemePackRow>
      <ThemePackRow label="Foreground"><ColorControl label={`${title} foreground color`} value={pack.theme.ink} onChange={ink => onThemePatch({ ink })} /></ThemePackRow>
      {(['ui', 'content', 'code'] as const).map(key => {
        const label = key === 'ui' ? 'UI font' : key === 'content' ? 'Content font' : 'Code font';
        const faceKey = `${key}Face` as const;
        return <ThemePackRow key={key} label={label}><FontFamilySelect label={`${title} ${label}`} value={pack.theme.fonts[key] ?? null} face={pack.theme.fonts[faceKey]} defaultLabel={key === 'content' ? 'Same as UI font' : 'System default'} onChange={(value, face) => onFontPatch({ [key]: value, [faceKey]: face })} /></ThemePackRow>;
      })}
      <ThemePackRow label="Translucent sidebar"><SettingsToggle checked={!pack.theme.opaqueWindows} onChange={checked => onThemePatch({ opaqueWindows: !checked })} ariaLabel={`${title} translucent sidebar`} /></ThemePackRow>
      <ThemePackRow label="Contrast">
        <div className="theme-contrast-control">
          <input aria-label={`${title} contrast`} type="range" min={0} max={100} step={1} value={pack.theme.contrast} onChange={event => onThemePatch({ contrast: Number(event.target.value) })} />
          <span>{pack.theme.contrast}</span>
        </div>
      </ThemePackRow>
    </section>
  </>;
}
function ThemePackRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="theme-pack-row"><div className="theme-pack-label">{label}</div><div className="theme-pack-control">{children}</div></div>;
}
function ColorControl({ label, value, onChange }: { label: string; value: string; onChange: (next: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const r = parseInt(value.slice(1, 3), 16), g = parseInt(value.slice(3, 5), 16), b = parseInt(value.slice(5, 7), 16);
  const textColor = (r * .2126 + g * .7152 + b * .0722) / 255 > .62 ? '#101010' : '#ffffff';
  return <div className="theme-color-control" style={{ backgroundColor: value, color: textColor }}>
    <Popover.Root onOpenChange={open => { if (!open) setDraft(null); }}>
      <Popover.Trigger type="button" className="theme-color-swatch" aria-label={`Pick ${label}`} style={{ borderColor: `color-mix(in srgb, ${textColor} 18%, ${value})` }} />
      <Popover.Portal><Popover.Positioner align="end" sideOffset={10} className="z-[9999]">
        <Popover.Popup aria-label={label} className="popover-surface theme-color-popover p-3"><HexColorPicker color={value} onChange={onChange} /></Popover.Popup>
      </Popover.Positioner></Popover.Portal>
    </Popover.Root>
    <input type="text" aria-label={label} value={(draft ?? value).toUpperCase()} spellCheck={false} onBlur={() => setDraft(null)}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === 'Escape') { setDraft(null); event.currentTarget.blur(); } }}
      onChange={event => { const next = '#' + event.target.value.toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 6); if (HEX_COLOR_RE.test(next)) { setDraft(null); onChange(next.toLowerCase()); } else setDraft(next); }} />
  </div>;
}

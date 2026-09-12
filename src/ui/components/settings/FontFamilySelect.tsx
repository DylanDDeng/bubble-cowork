import { useEffect, useRef, useState } from 'react';
import { Popover } from '@base-ui-components/react/popover';
import { Command } from 'cmdk';
import { Check, ChevronDown, Search } from '../icons';
import { PreferenceSelect } from './GeneralSettingsContent';
import type { SystemFontFace, SystemFontFamily } from '../../../shared/system-fonts';

let fontRequest: Promise<SystemFontFamily[]> | undefined;
function fonts() {
  return fontRequest ??= (typeof window.electron.getSystemFontFamilies === 'function'
    ? window.electron.getSystemFontFamilies()
    : typeof window.electron.getSystemFonts === 'function'
      ? window.electron.getSystemFonts().then(names => names.map(family => ({ family, faces: [] })))
      : Promise.reject(new Error('Restart the application to load installed fonts'))
  ).catch(error => { fontRequest = undefined; throw error; });
}
export function FontFamilySelect({ label, value, face, defaultLabel = 'System default', onChange }: {
  label: string; value: string | null; face?: SystemFontFace; defaultLabel?: string;
  onChange: (value: string | null, face?: SystemFontFace) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [families, setFamilies] = useState<SystemFontFamily[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [retry, setRetry] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let alive = true;
    setStatus('loading');
    void fonts().then(items => { if (alive) { setFamilies(items); setStatus('ready'); } })
      .catch(() => { if (alive) setStatus('error'); });
    return () => { alive = false; };
  }, [retry]);
  const display = value?.split(',')[0].trim().replace(/^["']|["']$/g, '') || defaultLabel;
  const family = value ? families.find(item => item.family.toLowerCase() === display.toLowerCase()) : undefined;
  const selectedFace = family?.faces.find(item => item.postscriptName === face?.postscriptName) ?? family?.faces[0] ?? face;
  const filtered = families.filter(item => item.family.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const select = (next: string | null, nextFace?: SystemFontFace) => { onChange(next, nextFace); setOpen(false); };
  const rowClass = 'flex min-h-7 cursor-default items-center gap-3 rounded-lg px-2 py-1 text-[13px] text-[var(--text-primary)] data-[selected=true]:bg-[var(--sidebar-item-hover)]';
  return <div className="theme-font-controls">
    <Popover.Root open={open} onOpenChange={next => { setOpen(next); if (next) setQuery(''); }}>
      <Popover.Trigger aria-label={label} className="theme-font-family theme-select">
        <span className="truncate">{display}</span><ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
      </Popover.Trigger>
      <Popover.Portal><Popover.Positioner align="end" sideOffset={6} className="z-[9999]">
        <Popover.Popup initialFocus={searchRef} aria-label={label} className="popover-surface w-[280px] max-w-[calc(100vw-24px)] p-1.5">
          <Command shouldFilter={false} label={label}>
            <div className="mb-1 flex items-center gap-2 px-2 py-1.5"><Search className="h-3.5 w-3.5 text-[var(--text-muted)]" />
              <Command.Input ref={searchRef} aria-label="Search fonts" placeholder="Search fonts…" value={query} onValueChange={setQuery} className="min-w-0 flex-1 bg-transparent text-[13px] outline-none" />
            </div>
            <Command.List className="max-h-[280px] overflow-y-auto">
              {defaultLabel.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) && <Command.Item value="__default" className={rowClass} onSelect={() => select(null)}>{defaultLabel}{!value && <Check className="ml-auto h-3.5 w-3.5" />}</Command.Item>}
              {value && !family && !query && <Command.Item value="__current" className={rowClass} onSelect={() => select(value, face)}>{display}<Check className="ml-auto h-3.5 w-3.5" /></Command.Item>}
              {filtered.map(item => <Command.Item key={item.family} value={item.family} className={rowClass} onSelect={() => select(JSON.stringify(item.family), item.faces[0])}>
                <span className="min-w-0 flex-1 truncate" style={{ fontFamily: JSON.stringify(item.family) }}>{item.family}</span>{display === item.family && <Check className="h-3.5 w-3.5" />}
              </Command.Item>)}
              {query.trim() && !families.some(item => item.family.toLowerCase() === query.trim().toLowerCase()) && <Command.Item value="__custom" className={rowClass} onSelect={() => select(query.trim())}>Use “{query.trim()}”</Command.Item>}
              {status === 'loading' && <div role="status" className="px-2 py-2 text-[12px] text-[var(--text-muted)]">Loading fonts…</div>}
              {status === 'error' && <Command.Item value="__retry" className={rowClass} onSelect={() => setRetry(n => n + 1)}>Could not load fonts · Retry</Command.Item>}
            </Command.List>
          </Command>
        </Popover.Popup>
      </Popover.Positioner></Popover.Portal>
    </Popover.Root>
    <div className="theme-font-style"><PreferenceSelect label={`${label} style`} value={selectedFace?.postscriptName ?? 'regular'} disabled={!family?.faces.length}
      options={family?.faces.length ? family.faces.map(item => ({ value: item.postscriptName, label: item.style })) : [{ value: selectedFace?.postscriptName ?? 'regular', label: selectedFace?.style ?? 'Regular' }]}
      onChange={name => onChange(value, family?.faces.find(item => item.postscriptName === name))} /></div>
  </div>;
}

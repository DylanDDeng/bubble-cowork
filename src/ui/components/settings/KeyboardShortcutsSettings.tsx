import { useEffect, useRef, useState } from 'react';
import { Keyboard, Plus, RotateCcw, Search, X } from '../icons';
import { confirmDialog } from '../ui/confirm-dialog';
import { saveAppPreferences, subscribeAppPreferences, useAppPreferences } from '../../store/useAppPreferences';
import { useAppStore } from '../../store/useAppStore';
import {
  SHORTCUT_COMMANDS, isMacPlatform, normalizeShortcutOverrides, shortcutBindings,
  shortcutConflict, shortcutFromEvent, shortcutIdentity, shortcutKeycaps, type ShortcutOverrides,
} from '../../../shared/keyboard-shortcuts';

function Keycaps({ binding }: { binding: string }) {
  return <span className="shortcut-keycaps">{shortcutKeycaps(binding).map((key, index) => <kbd key={index}>{key}</kbd>)}</span>;
}

export function KeyboardShortcutsSettings() {
  useEffect(subscribeAppPreferences, []);
  const overrides = useAppPreferences(state => state.keyboardShortcuts);
  const enterBehavior = useAppPreferences(state => state.enterBehavior);
  const [query, setQuery] = useState('');
  const [keystrokes, setKeystrokes] = useState(false);
  const [recording, setRecording] = useState<{ id: string; index: number } | null>(null);
  const [candidate, setCandidate] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const captureActive = !!recording || (keystrokes && searchFocused);
  useEffect(() => {
    void window.electron.setShortcutCaptureActive?.(captureActive);
    return () => { void window.electron.setShortcutCaptureActive?.(false); };
  }, [captureActive]);
  const searchRef = useRef<HTMLInputElement>(null);
  const captureRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (recording && !saving) captureRef.current?.focus(); }, [recording, saving]);

  const update = async (next: ShortcutOverrides) => {
    setSaving(true); setError('');
    try {
      await saveAppPreferences({ keyboardShortcuts: normalizeShortcutOverrides(next) });
      setRecording(null); setCandidate('');
    } catch { setError('Could not save keyboard shortcuts. Try again.'); }
    finally { setSaving(false); }
  };
  const start = (id: string, index: number) => { setRecording({ id, index }); setCandidate(''); setError(''); };
  const cancel = () => { setRecording(null); setCandidate(''); setError(''); };
  const conflict = recording && candidate ? shortcutConflict(candidate, recording.id, overrides) : null;
  const duplicate = recording && candidate && shortcutBindings(recording.id, overrides).some((b, i) => i !== recording.index && shortcutIdentity(b) === shortcutIdentity(candidate));
  const apply = () => {
    if (!recording || !candidate || conflict || duplicate || saving) return;
    const bindings = [...shortcutBindings(recording.id, overrides)];
    bindings[recording.index] = candidate;
    void update({ ...overrides, [recording.id]: bindings });
  };
  const reset = (id: string) => {
    const next = { ...overrides }; delete next[id];
    const command = SHORTCUT_COMMANDS.find(c => c.id === id)!;
    const collision = command.defaults.map(b => shortcutConflict(b, id, next)).find(Boolean);
    if (collision) { setError(`Default shortcut is used by “${collision}”. Remove that binding first.`); return; }
    void update(next);
  };
  const matches = (title: string, bindings: readonly string[], group: string) => {
    if (!query.trim()) return true;
    if (keystrokes) return bindings.some(b => shortcutIdentity(b) === shortcutIdentity(query));
    const text = `${title} ${group} ${bindings.map(b => `${b} ${shortcutKeycaps(b).join(' ')} ${shortcutKeycaps(b).join('')}`).join(' ')}`.toLowerCase();
    const words = query.toLowerCase().replace(/command|cmd|meta/g, isMacPlatform() ? '⌘' : 'ctrl').replace(/option/g, isMacPlatform() ? '⌥' : 'alt').replace(/\+/g, ' ').split(/\s+/).filter(Boolean);
    return words.every(word => text.includes(word));
  };
  const commands = SHORTCUT_COMMANDS.filter(c => matches(c.title, shortcutBindings(c.id, overrides), c.group));
  const editorRows = [
    { title: 'Send message', bindings: enterBehavior === 'enter' ? ['Enter', 'Mod+Enter'] : ['Mod+Enter'], conditional: enterBehavior === 'multiline' ? 'Enter for single-line messages' : '', settings: true },
    { title: 'Insert line break', bindings: enterBehavior === 'modifier' ? ['Enter', 'Shift+Enter'] : ['Shift+Enter'] },
    { title: 'Copy', bindings: ['Mod+KeyC'] }, { title: 'Cut', bindings: ['Mod+KeyX'] },
    { title: 'Paste', bindings: ['Mod+KeyV'] }, { title: 'Select all', bindings: ['Mod+KeyA'] },
    { title: 'Undo', bindings: ['Mod+KeyZ'] }, { title: 'Redo', bindings: [isMacPlatform() ? 'Mod+Shift+KeyZ' : 'Mod+KeyY'] },
  ].filter(row => matches(row.title, row.bindings, 'Editor'));

  return <div className="keyboard-shortcuts-settings">
    <div className="shortcut-search-bar" data-shortcut-capture>
      <div className="shortcut-search">
        <Search className="h-4 w-4 shrink-0" />
        <input ref={searchRef} aria-label="Search shortcuts" placeholder={keystrokes ? 'Press shortcut to search' : 'Search shortcuts'} value={keystrokes && query ? shortcutKeycaps(query).join(' ') : query}
          readOnly={keystrokes} onFocus={() => setSearchFocused(true)} onBlur={() => setSearchFocused(false)} onChange={e => setQuery(e.target.value)} onKeyDown={e => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (query) setQuery(''); else setKeystrokes(false); return; }
            if (!keystrokes) return;
            if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) return;
            e.preventDefault(); e.stopPropagation();
            const binding = shortcutFromEvent(e.nativeEvent, isMacPlatform(), true);
            if (binding) setQuery(binding);
          }} />
        {query && <button className="shortcut-icon-button" aria-label="Clear shortcut search" onClick={() => { setQuery(''); searchRef.current?.focus(); }}><X className="h-3.5 w-3.5" /></button>}
        <button className="shortcut-icon-button" aria-label="Search by keystrokes" title="Search by keystrokes" aria-pressed={keystrokes} onClick={() => { setKeystrokes(!keystrokes); setQuery(''); cancel(); searchRef.current?.focus(); }}><Keyboard className="h-4 w-4" /></button>
      </div>
    </div>
    {error && <p role="alert" className="shortcut-error">{error}</p>}
    {['Navigation', 'Conversation', 'Tabs'].map(group => {
      const rows = commands.filter(c => c.group === group);
      if (!rows.length) return null;
      return <section key={group} className="shortcut-group" aria-label={group}>
        <h2>{group}</h2>
        {rows.map(command => {
          const bindings = shortcutBindings(command.id, overrides);
          const editing = recording?.id === command.id;
          return <div key={command.id} className="shortcut-row" data-settings-label={command.title} data-settings-id={`shortcut:${command.id}`}>
            <span>{command.title}</span>
            <div className="shortcut-bindings">
              {bindings.map((binding, index) => <div className="shortcut-binding" key={index}>
                <button disabled={saving} className="shortcut-binding-button" aria-label={`Edit shortcut for ${command.title}${index ? ` ${index + 1}` : ''}`} onClick={() => start(command.id, index)}><Keycaps binding={binding} /></button>
                <button disabled={saving} className="shortcut-icon-button shortcut-row-action" aria-label={`Remove ${shortcutKeycaps(binding).join(' ')} for ${command.title}`} onClick={() => { cancel(); void update({ ...overrides, [command.id]: bindings.filter((_, i) => i !== index) }); }}><X className="h-3.5 w-3.5" /></button>
              </div>)}
              <div className="shortcut-binding">
                <button disabled={saving || bindings.length >= 8} className={`shortcut-icon-button ${bindings.length ? 'shortcut-row-action' : ''}`} aria-label={`Add shortcut for ${command.title}`} onClick={() => start(command.id, bindings.length)}>{bindings.length ? <Plus className="h-3.5 w-3.5" /> : <span>Unassigned</span>}</button>
                {overrides[command.id] && <button disabled={saving} className="shortcut-icon-button" title="Reset to default" aria-label={`Reset ${command.title}`} onClick={() => { cancel(); reset(command.id); }}><RotateCcw className="h-3.5 w-3.5" /></button>}
              </div>
              {editing && <div className="shortcut-capture" data-shortcut-capture data-shortcut-recording>
                <input ref={captureRef} aria-label={`Shortcut capture for ${command.title}`} aria-invalid={!!conflict || !!duplicate} aria-describedby={conflict || duplicate ? `shortcut-error-${command.id}` : undefined} readOnly disabled={saving} placeholder="Press shortcut" value={candidate ? shortcutKeycaps(candidate).join(' ') : ''} onKeyDown={e => {
                  if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) return;
                  e.preventDefault(); e.stopPropagation();
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === 'Escape') { cancel(); return; }
                  if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) { apply(); return; }
                  const binding = shortcutFromEvent(e.nativeEvent);
                  if (binding) { setCandidate(binding); setError(''); }
                  else if (!['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) setError(`Use ${isMacPlatform() ? 'Command or Control' : 'Control'} with another key.`);
                }} />
                <div className="flex justify-end gap-1"><button disabled={saving} className="settings-button" onClick={cancel}>Cancel</button><button disabled={saving || !candidate || !!conflict || !!duplicate} className="settings-button" onClick={apply}>Save</button></div>
                {(conflict || duplicate) && <p id={`shortcut-error-${command.id}`} role="alert" className="shortcut-error">{duplicate ? 'This shortcut is already assigned to this action.' : `Already used by “${conflict}”.`}</p>}
              </div>}
            </div>
          </div>;
        })}
      </section>;
    })}
    {!!editorRows.length && <section className="shortcut-group" aria-label="Editor"><h2>Editor</h2>{editorRows.map(row => <div className="shortcut-row" key={row.title} data-settings-label={row.title}>
      <span>{row.title}</span><div className="shortcut-bindings">{row.bindings.map(b => <Keycaps binding={b} key={b} />)}{row.conditional && <span className="text-[var(--text-muted)]">{row.conditional}</span>}{row.settings && <button className="shortcut-icon-button" aria-label="Configure message sending" onClick={() => useAppStore.getState().setActiveSettingsTab('general')}>Configure…</button>}</div>
    </div>)}</section>}
    {!commands.length && !editorRows.length && <p className="py-10 text-center text-[var(--text-muted)]">No matching shortcuts</p>}
    {Object.keys(overrides).length > 0 && <button disabled={saving} className="settings-button mt-5" onClick={async () => {
      cancel();
      if (await confirmDialog({ title: 'Reset all keyboard shortcuts?', description: 'This will discard all custom shortcuts and restore the defaults', confirmLabel: 'Reset all' })) void update({});
    }}>Reset all to defaults</button>}
  </div>;
}

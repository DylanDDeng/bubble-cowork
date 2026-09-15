/** App-owned shortcuts. Provider and OS keymaps are deliberately separate. */
export const SHORTCUT_COMMANDS = [
  { id: 'search', title: 'Search tasks and projects', group: 'Navigation', defaults: ['Mod+KeyK'] },
  { id: 'sidebar', title: 'Toggle sidebar', group: 'Navigation', defaults: ['Mod+KeyB'] },
  { id: 'activity', title: 'Toggle sidebar activity', group: 'Navigation', defaults: ['Mod+Alt+KeyU'] },
  { id: 'back', title: 'Go back', group: 'Navigation', defaults: ['Mod+BracketLeft'] },
  { id: 'forward', title: 'Go forward', group: 'Navigation', defaults: ['Mod+BracketRight'] },
  { id: 'settings', title: 'Open settings', group: 'Navigation', defaults: ['Mod+Comma'] },
  { id: 'newTask', title: 'New task', group: 'Conversation', defaults: ['Mod+KeyN'] },
  { id: 'find', title: 'Find in conversation', group: 'Conversation', defaults: ['Mod+KeyF'] },
  { id: 'newTab', title: 'New tab', group: 'Tabs', defaults: ['Mod+KeyT'] },
  { id: 'closeTab', title: 'Close tab', group: 'Tabs', defaults: ['Mod+KeyW'] },
  { id: 'nextTab', title: 'Next tab', group: 'Tabs', defaults: ['Ctrl+Tab'] },
  { id: 'previousTab', title: 'Previous tab', group: 'Tabs', defaults: ['Ctrl+Shift+Tab'] },
  ...Array.from({ length: 9 }, (_, i) => ({ id: `tab${i + 1}`, title: i === 8 ? 'Switch to last tab' : `Switch to tab ${i + 1}`, group: 'Tabs', defaults: [`Mod+Digit${i + 1}`] })),
] as const;
export type ShortcutOverrides = Record<string, string[]>;
export type ShortcutKeyEvent = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing'>;
export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
}
const codePattern = /^(Key[A-Z]|Digit[0-9]|BracketLeft|BracketRight|Comma|Period|Slash|Backslash|Semicolon|Quote|Backquote|Minus|Equal|Tab|Space|Enter|Backspace|Delete|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown|F(?:[1-9]|1[0-2]))$/;
export function normalizeShortcut(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parts = value.split('+');
  const code = parts.pop()!;
  if (!codePattern.test(code) || !parts.length || parts.some(p => !['Mod', 'Ctrl', 'Alt', 'Shift'].includes(p)) || new Set(parts).size !== parts.length) return null;
  // Unmodified and Option-only typing stays with the focused control.
  if (!parts.includes('Mod') && !parts.includes('Ctrl')) return null;
  return [...['Mod', 'Ctrl', 'Alt', 'Shift'].filter(p => parts.includes(p)), code].join('+');
}
export function normalizeShortcutOverrides(value: unknown): ShortcutOverrides {
  const result: ShortcutOverrides = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const command of SHORTCUT_COMMANDS) {
    const bindings = (value as Record<string, unknown>)[command.id];
    if (!Array.isArray(bindings)) continue;
    const valid = [...new Set(bindings.slice(0, 8).map(normalizeShortcut).filter((s): s is string => s !== null))];
    // Preserve an explicit empty list (disabled), but ignore corrupt entries.
    if (bindings.length && !valid.length) continue;
    if (JSON.stringify(valid) !== JSON.stringify(command.defaults)) result[command.id] = valid;
  }
  return result;
}
export function shortcutBindings(id: string, overrides: ShortcutOverrides = {}): readonly string[] {
  return overrides[id] ?? SHORTCUT_COMMANDS.find(c => c.id === id)?.defaults ?? [];
}
function eventCode(event: ShortcutKeyEvent): string {
  if (event.code) return event.code;
  if (/^[a-z]$/i.test(event.key)) return `Key${event.key.toUpperCase()}`;
  if (/^[0-9]$/.test(event.key)) return `Digit${event.key}`;
  return event.key;
}
/** Physical codes keep Option dead keys and non-US bracket keys stable. */
export function shortcutFromEvent(event: ShortcutKeyEvent, mac = isMacPlatform(), allowUnmodified = false): string | null {
  if (event.isComposing || event.key === 'Process') return null;
  if (!mac && event.metaKey) return null;
  const parts = [
    (mac ? event.metaKey : event.ctrlKey) && 'Mod',
    mac && event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', eventCode(event),
  ].filter(Boolean).join('+');
  return normalizeShortcut(parts) ?? (allowUnmodified && codePattern.test(eventCode(event)) ? parts : null);
}
export function shortcutIdentity(binding: string, mac = isMacPlatform()): string {
  if (mac) return binding;
  return [...new Set(binding.replace('Mod+', 'Ctrl+').split('+'))].join('+');
}
export function matchesShortcut(event: ShortcutKeyEvent, binding: string, mac = isMacPlatform()): boolean {
  const captured = shortcutFromEvent(event, mac);
  return !!captured && shortcutIdentity(captured, mac) === shortcutIdentity(binding, mac);
}
const keyLabels: Record<string, string> = { BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`', Minus: '−', Equal: '=', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Backspace: '⌫', Enter: '↵', Tab: 'Tab', Space: 'Space' };
export function shortcutKeycaps(binding: string, mac = isMacPlatform()): string[] {
  const parts = shortcutIdentity(binding, mac).split('+');
  const ordered = mac ? [...['Ctrl', 'Alt', 'Shift', 'Mod'].filter(p => parts.includes(p)), ...parts.filter(p => !['Ctrl', 'Alt', 'Shift', 'Mod'].includes(p))] : parts;
  return ordered.map(p => p === 'Mod' ? '⌘' : p === 'Ctrl' ? (mac ? '⌃' : 'Ctrl') : p === 'Alt' ? (mac ? '⌥' : 'Alt') : p === 'Shift' ? (mac ? '⇧' : 'Shift') : keyLabels[p] ?? p.replace(/^(Key|Digit)/, ''));
}
export function shortcutLabel(id: string, overrides: ShortcutOverrides = {}, mac = isMacPlatform()): string {
  return shortcutBindings(id, overrides).map(b => shortcutKeycaps(b, mac).join(mac ? '' : '+')).join(' / ');
}
const reserved = [
  ['Mod+KeyC', 'Copy'], ['Mod+KeyX', 'Cut'], ['Mod+KeyV', 'Paste'], ['Mod+Shift+KeyV', 'Paste as plain text'],
  ['Mod+KeyA', 'Select all'], ['Mod+KeyZ', 'Undo'], ['Mod+Shift+KeyZ', 'Redo'], ['Mod+KeyY', 'Redo'],
  ['Mod+Enter', 'Send message'], ['Mod+Shift+Enter', 'Send follow-up'], ['Mod+Backspace', 'Delete text or task'],
  ['Mod+KeyQ', 'Quit'], ['Mod+KeyH', 'Hide application'], ['Mod+Alt+KeyH', 'Hide other applications'], ['Mod+KeyM', 'Minimize'],
  ['Mod+KeyR', 'Reload'], ['Mod+Shift+KeyR', 'Force reload'], ['Mod+Alt+KeyI', 'Developer tools'], ['Ctrl+Shift+KeyI', 'Developer tools'],
  ['Mod+Equal', 'Zoom in'], ['Mod+Shift+Equal', 'Zoom in'], ['Mod+Minus', 'Zoom out'], ['Mod+Digit0', 'Reset zoom'],
] as const;
export function shortcutConflict(binding: string, commandId: string, overrides: ShortcutOverrides, mac = isMacPlatform()): string | null {
  const identity = shortcutIdentity(binding, mac);
  if (mac && binding === 'Mod+Ctrl+KeyF') return 'Full screen';
  const native = reserved.find(([key]) => shortcutIdentity(key, mac) === identity);
  if (native) return native[1];
  return SHORTCUT_COMMANDS.find(c => c.id !== commandId && shortcutBindings(c.id, overrides).some(b => shortcutIdentity(b, mac) === identity))?.title ?? null;
}

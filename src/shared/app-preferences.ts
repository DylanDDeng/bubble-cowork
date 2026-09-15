import { normalizeShortcutOverrides, type ShortcutOverrides } from './keyboard-shortcuts';

export type EnterBehavior = 'enter' | 'multiline' | 'modifier';
export interface AppPreferences {
  keyboardShortcuts: ShortcutOverrides;
  defaultEditor: string;
  terminalShell: string;
  preventSleep: boolean;
  enterBehavior: EnterBehavior;
  followUpBehavior: 'queue' | 'steer';
  showContextUsage: boolean;
  plainTextComposer: boolean;
  uiFontSize: number;
  codeFontSize: number;
  reduceMotion: 'system' | 'on' | 'off';
  fontSmoothing: boolean;
  pointerCursors: boolean;
  diffMarkers: 'color' | 'signs';
}

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
  keyboardShortcuts: {},
  defaultEditor: 'auto', terminalShell: 'system', preventSleep: false,
  enterBehavior: 'enter', followUpBehavior: 'queue', showContextUsage: true,
  plainTextComposer: false,
  uiFontSize: 13, codeFontSize: 12, reduceMotion: 'system',
  fontSmoothing: true, pointerCursors: true, diffMarkers: 'color',
};

export function normalizeAppPreferences(value: unknown): AppPreferences {
  const result = { ...DEFAULT_APP_PREFERENCES, keyboardShortcuts: {} };
  if (!value || typeof value !== 'object') return result;
  const input = value as Record<string, unknown>;
  result.keyboardShortcuts = normalizeShortcutOverrides(input.keyboardShortcuts);
  for (const key of ['preventSleep', 'showContextUsage', 'plainTextComposer', 'fontSmoothing', 'pointerCursors'] as const) {
    if (typeof input[key] === 'boolean') result[key] = input[key];
  }
  for (const key of ['defaultEditor', 'terminalShell'] as const) {
    if (typeof input[key] === 'string' && input[key].length > 0 && input[key].length <= 256) result[key] = input[key];
  }
  if (['enter', 'multiline', 'modifier'].includes(String(input.enterBehavior))) result.enterBehavior = input.enterBehavior as EnterBehavior;
  if (input.followUpBehavior === 'queue' || input.followUpBehavior === 'steer') result.followUpBehavior = input.followUpBehavior;
  for (const key of ['uiFontSize', 'codeFontSize'] as const) {
    const size = input[key];
    if (typeof size === 'number' && Number.isFinite(size)) result[key] = Math.max(10, Math.min(24, Math.round(size)));
  }
  if (input.reduceMotion === 'on' || input.reduceMotion === 'off') result.reduceMotion = input.reduceMotion;
  if (input.diffMarkers === 'signs') result.diffMarkers = 'signs';
  return result;
}

/** Shift+Enter inserts a newline; the configured modifier chord flips follow-up behavior. */
export function composerEnterAction(event: { key: string; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean; isComposing?: boolean }, text: string, behavior: EnterBehavior): { send: boolean; invert: boolean } {
  if (event.key !== 'Enter' || event.altKey || event.isComposing) return { send: false, invert: false };
  const modifier = event.metaKey || event.ctrlKey;
  if (event.shiftKey) return { send: modifier && behavior !== 'enter', invert: modifier && behavior !== 'enter' };
  const requiresModifier = behavior === 'modifier' || (behavior === 'multiline' && text.includes('\n'));
  return { send: modifier || !requiresModifier, invert: modifier && behavior === 'enter' };
}

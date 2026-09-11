export type EnterBehavior = 'enter' | 'multiline' | 'modifier';
export interface AppPreferences {
  defaultEditor: string;
  terminalShell: string;
  preventSleep: boolean;
  enterBehavior: EnterBehavior;
  followUpBehavior: 'queue' | 'steer';
  showContextUsage: boolean;
  plainTextComposer: boolean;
}

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
  defaultEditor: 'auto', terminalShell: 'system', preventSleep: false,
  enterBehavior: 'enter', followUpBehavior: 'queue', showContextUsage: true,
  plainTextComposer: false,
};

export function normalizeAppPreferences(value: unknown): AppPreferences {
  const result = { ...DEFAULT_APP_PREFERENCES };
  if (!value || typeof value !== 'object') return result;
  const input = value as Record<string, unknown>;
  for (const key of ['preventSleep', 'showContextUsage', 'plainTextComposer'] as const) {
    if (typeof input[key] === 'boolean') result[key] = input[key];
  }
  for (const key of ['defaultEditor', 'terminalShell'] as const) {
    if (typeof input[key] === 'string' && input[key].length > 0 && input[key].length <= 256) result[key] = input[key];
  }
  if (['enter', 'multiline', 'modifier'].includes(String(input.enterBehavior))) result.enterBehavior = input.enterBehavior as EnterBehavior;
  if (input.followUpBehavior === 'queue' || input.followUpBehavior === 'steer') result.followUpBehavior = input.followUpBehavior;
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

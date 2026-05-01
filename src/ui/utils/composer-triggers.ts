import { isComposerCapabilityStart } from './composer-capability-token';

export type ComposerTriggerKind = 'slash-command' | 'slash-model' | 'skill';

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

function clampCursor(text: string, cursorInput: number): number {
  if (!Number.isFinite(cursorInput)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursorInput)));
}

function tokenStartForCursor(text: string, cursor: number): number {
  let index = cursor - 1;
  while (index >= 0 && !/\s/.test(text[index] || '')) {
    index -= 1;
  }
  return index + 1;
}

export function detectComposerTrigger(
  text: string,
  cursorInput: number
): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const tokenStart = tokenStartForCursor(text, cursor);
  if (!isComposerCapabilityStart(text, tokenStart)) {
    return null;
  }

  const token = text.slice(tokenStart, cursor);
  if (token.startsWith('/')) {
    const commandMatch = /^\/(\S*)$/.exec(token);
    if (!commandMatch) {
      return null;
    }

    const query = (commandMatch[1] ?? '').toLowerCase();
    return {
      kind: query === 'model' ? 'slash-model' : 'slash-command',
      query,
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }

  if (!token.startsWith('$')) {
    return null;
  }

  const skillMatch = /^\$([^\s$@/]*)$/.exec(token);
  if (!skillMatch) {
    return null;
  }

  return {
    kind: 'skill',
    query: (skillMatch[1] ?? '').toLowerCase(),
    rangeStart: tokenStart,
    rangeEnd: cursor,
  };
}

export function replaceComposerTriggerText(
  text: string,
  trigger: ComposerTrigger,
  replacement: string
): { prompt: string; cursorIndex: number } {
  const nextPrompt = `${text.slice(0, trigger.rangeStart)}${replacement}${text.slice(trigger.rangeEnd)}`;
  return {
    prompt: nextPrompt,
    cursorIndex: trigger.rangeStart + replacement.length,
  };
}

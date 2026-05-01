export type ComposerCapabilityPrefix = '/' | '$';

export interface ComposerCapabilityToken {
  prefix: ComposerCapabilityPrefix;
  name: string;
  start: number;
  end: number;
  text: string;
  remainder: string;
}

function isWhitespace(value: string | undefined): boolean {
  return value === undefined || /\s/.test(value);
}

function consumeWhitespace(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && isWhitespace(text[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function readLeadingAgentMention(text: string, index: number): number | null {
  if (text[index] !== '@') {
    return null;
  }

  let cursor = index + 1;
  while (cursor < text.length && /[A-Za-z0-9_-]/.test(text[cursor] || '')) {
    cursor += 1;
  }

  if (cursor === index + 1) {
    return null;
  }

  if (cursor < text.length && !isWhitespace(text[cursor])) {
    return null;
  }

  return consumeWhitespace(text, cursor);
}

export function getComposerCapabilityStart(text: string): number {
  let cursor = consumeWhitespace(text, 0);

  while (cursor < text.length) {
    const nextCursor = readLeadingAgentMention(text, cursor);
    if (nextCursor === null) {
      break;
    }
    cursor = nextCursor;
  }

  return cursor;
}

export function isComposerCapabilityStart(text: string, index: number): boolean {
  return index === getComposerCapabilityStart(text);
}

export function parseComposerCapabilityToken(
  prompt: string,
  prefixes: ReadonlyArray<ComposerCapabilityPrefix> = ['/', '$']
): ComposerCapabilityToken | null {
  const start = getComposerCapabilityStart(prompt);
  const prefix = prompt[start] as ComposerCapabilityPrefix | undefined;
  if (!prefix || !prefixes.includes(prefix)) {
    return null;
  }

  const tokenRemainder = prompt.slice(start + 1);
  const firstWhitespaceIndex = tokenRemainder.search(/\s/);
  const name =
    firstWhitespaceIndex === -1
      ? tokenRemainder
      : tokenRemainder.slice(0, firstWhitespaceIndex);

  if (!name || /[$@/]/.test(name)) {
    return null;
  }

  const end = start + 1 + name.length;
  return {
    prefix,
    name,
    start,
    end,
    text: `${prefix}${name}`,
    remainder: prompt.slice(end).replace(/^\s+/, ''),
  };
}

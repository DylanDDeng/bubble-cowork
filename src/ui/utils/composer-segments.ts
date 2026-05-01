import { splitPromptIntoProjectFileSegments } from './project-file-mentions';
import { parseComposerCapabilityToken } from './composer-capability-token';

export type SlashSegmentKind = 'skill' | 'command' | 'plugin';

export interface SlashTokenInfo {
  kind: SlashSegmentKind;
  name: string;
  prefix: '/' | '$';
  start: number;
  end: number;
  text: string;
}

export interface SlashTokenContext {
  skillNames: Set<string>;
  commandNames: Set<string>;
  pluginNames: Set<string>;
}

export type PromptSegment =
  | { type: 'text'; text: string }
  | { type: 'mention'; path: string; text: string; start: number; end: number }
  | {
      type: 'slash';
      kind: SlashSegmentKind;
      name: string;
      prefix: '/' | '$';
      text: string;
      start: number;
      end: number;
    };

function normalizeSlashName(value: string): string {
  return value.replace(/^[/$]/, '').trim().toLowerCase();
}

export function createSlashTokenContext(
  skillNames: Iterable<string> | undefined,
  commandNames: Iterable<string> | undefined,
  pluginNames?: Iterable<string> | undefined
): SlashTokenContext {
  const toSet = (values: Iterable<string> | undefined): Set<string> => {
    const result = new Set<string>();
    if (!values) return result;
    for (const value of values) {
      const normalized = normalizeSlashName(value);
      if (normalized) {
        result.add(normalized);
      }
    }
    return result;
  };

  return {
    skillNames: toSet(skillNames),
    commandNames: toSet(commandNames),
    pluginNames: toSet(pluginNames),
  };
}

export function extractLeadingSlashToken(
  prompt: string,
  context: SlashTokenContext
): SlashTokenInfo | null {
  const token = parseComposerCapabilityToken(prompt);
  if (!token) {
    return null;
  }

  const normalized = token.name.toLowerCase();
  let kind: SlashSegmentKind | null = null;
  if (token.prefix === '$') {
    if (context.pluginNames.has(normalized)) {
      kind = 'plugin';
    } else if (context.skillNames.has(normalized)) {
      kind = 'skill';
    }
  } else {
    if (context.pluginNames.has(normalized)) {
      kind = 'plugin';
    } else if (context.skillNames.has(normalized)) {
      kind = 'skill';
    } else if (context.commandNames.has(normalized)) {
      kind = 'command';
    }
  }

  if (!kind) {
    return null;
  }

  return {
    kind,
    name: token.name,
    prefix: token.prefix,
    start: token.start,
    end: token.end,
    text: token.text,
  };
}

function appendProjectFileSegments(
  target: PromptSegment[],
  text: string,
  offset: number
): void {
  for (const segment of splitPromptIntoProjectFileSegments(text)) {
    if (segment.type === 'text') {
      target.push({ type: 'text', text: segment.text });
      continue;
    }

    target.push({
      type: 'mention',
      path: segment.path,
      text: segment.text,
      start: segment.start + offset,
      end: segment.end + offset,
    });
  }
}

export function splitPromptIntoComposerSegments(
  prompt: string,
  context?: SlashTokenContext
): PromptSegment[] {
  const slashToken = context ? extractLeadingSlashToken(prompt, context) : null;
  if (!slashToken) {
    return splitPromptIntoProjectFileSegments(prompt) as PromptSegment[];
  }

  const segments: PromptSegment[] = [];
  if (slashToken.start > 0) {
    appendProjectFileSegments(segments, prompt.slice(0, slashToken.start), 0);
  }

  segments.push({
    type: 'slash',
    kind: slashToken.kind,
    name: slashToken.name,
    prefix: slashToken.prefix,
    text: slashToken.text,
    start: slashToken.start,
    end: slashToken.end,
  });

  const remainderStart = slashToken.end;
  const remainder = prompt.slice(remainderStart);
  if (remainder.length === 0) {
    return segments;
  }

  appendProjectFileSegments(segments, remainder, remainderStart);

  return segments;
}

export function removeLeadingSlashTokenAdjacentToCursor(
  value: string,
  cursorIndex: number,
  key: 'Backspace' | 'Delete',
  context: SlashTokenContext
): { value: string; cursorIndex: number } | null {
  const token = extractLeadingSlashToken(value, context);
  if (!token) {
    return null;
  }

  if (key === 'Backspace' && cursorIndex === token.end) {
    const trailingWhitespaceMatch = value.slice(token.end).match(/^\s+/);
    const trailingLength = trailingWhitespaceMatch?.[0].length ?? 0;
    return {
      value: `${value.slice(0, token.start)}${value.slice(token.end + trailingLength)}`,
      cursorIndex: token.start,
    };
  }

  if (key === 'Delete' && cursorIndex === token.start) {
    const trailingWhitespaceMatch = value.slice(token.end).match(/^\s+/);
    const trailingLength = trailingWhitespaceMatch?.[0].length ?? 0;
    return {
      value: `${value.slice(0, token.start)}${value.slice(token.end + trailingLength)}`,
      cursorIndex: token.start,
    };
  }

  return null;
}

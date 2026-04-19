import {
  splitPromptIntoProjectFileSegments,
  type ProjectFilePromptSegment,
} from './project-file-mentions';

export type SlashSegmentKind = 'skill' | 'command';

export interface SlashTokenInfo {
  kind: SlashSegmentKind;
  name: string;
  start: number;
  end: number;
  text: string;
}

export interface SlashTokenContext {
  skillNames: Set<string>;
  commandNames: Set<string>;
}

export type PromptSegment =
  | { type: 'text'; text: string }
  | { type: 'mention'; path: string; text: string; start: number; end: number }
  | {
      type: 'slash';
      kind: SlashSegmentKind;
      name: string;
      text: string;
      start: number;
      end: number;
    };

function normalizeSlashName(value: string): string {
  return value.replace(/^\//, '').trim().toLowerCase();
}

export function createSlashTokenContext(
  skillNames: Iterable<string> | undefined,
  commandNames: Iterable<string> | undefined
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
  };
}

export function extractLeadingSlashToken(
  prompt: string,
  context: SlashTokenContext
): SlashTokenInfo | null {
  const leadingWhitespaceLength = prompt.match(/^\s*/)?.[0].length ?? 0;
  const afterWhitespace = prompt.slice(leadingWhitespaceLength);
  if (!afterWhitespace.startsWith('/')) {
    return null;
  }

  const spaceIndex = afterWhitespace.search(/\s/);
  const rawName =
    spaceIndex === -1 ? afterWhitespace.slice(1) : afterWhitespace.slice(1, spaceIndex);
  if (!rawName) {
    return null;
  }

  const normalized = rawName.toLowerCase();
  let kind: SlashSegmentKind | null = null;
  if (context.skillNames.has(normalized)) {
    kind = 'skill';
  } else if (context.commandNames.has(normalized)) {
    kind = 'command';
  }

  if (!kind) {
    return null;
  }

  const start = leadingWhitespaceLength;
  const end = start + 1 + rawName.length;
  return {
    kind,
    name: rawName,
    start,
    end,
    text: `/${rawName}`,
  };
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
    segments.push({ type: 'text', text: prompt.slice(0, slashToken.start) });
  }

  segments.push({
    type: 'slash',
    kind: slashToken.kind,
    name: slashToken.name,
    text: slashToken.text,
    start: slashToken.start,
    end: slashToken.end,
  });

  const remainderStart = slashToken.end;
  const remainder = prompt.slice(remainderStart);
  if (remainder.length === 0) {
    return segments;
  }

  const remainderSegments: ProjectFilePromptSegment[] =
    splitPromptIntoProjectFileSegments(remainder);
  for (const segment of remainderSegments) {
    if (segment.type === 'text') {
      segments.push({ type: 'text', text: segment.text });
      continue;
    }

    segments.push({
      type: 'mention',
      path: segment.path,
      text: segment.text,
      start: segment.start + remainderStart,
      end: segment.end + remainderStart,
    });
  }

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

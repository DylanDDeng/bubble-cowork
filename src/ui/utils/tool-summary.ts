function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function safeJsonStringify(value: unknown, space?: number): string {
  try {
    return JSON.stringify(
      value,
      (_key, v) => (typeof v === 'bigint' ? v.toString() : v),
      space
    );
  } catch {
    try {
      return String(value);
    } catch {
      return '[unserializable]';
    }
  }
}

function getStringField(input: unknown, key: string): string | null {
  if (!isRecord(input)) return null;
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

export function getToolSummary(name: string, input: unknown): string {
  switch (name) {
    case 'Bash':
      return getStringField(input, 'command') || '';
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'Delete':
      return (
        getStringField(input, 'file_path') ||
        getStringField(input, 'path') ||
        getStringField(input, 'filename') ||
        ''
      );
    case 'Glob':
    case 'Grep':
      return getStringField(input, 'pattern') || '';
    case 'AskUserQuestion': {
      if (!isRecord(input)) return '';
      const questions = input.questions;
      if (!Array.isArray(questions) || questions.length === 0) return '';
      const first = questions[0];
      if (!isRecord(first)) return '';
      return getStringField(first, 'question') || '';
    }
    case 'Task': {
      const desc = getStringField(input, 'description');
      if (desc) return desc;
      const prompt = getStringField(input, 'prompt');
      return prompt ? prompt.slice(0, 50) : '';
    }
    default: {
      const json = safeJsonStringify(input);
      return json.length > 80 ? json.slice(0, 80) : json;
    }
  }
}


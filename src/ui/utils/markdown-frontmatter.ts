import { parseDocument } from 'yaml';

export type MarkdownFrontmatterFieldKind =
  | 'array'
  | 'boolean'
  | 'null'
  | 'number'
  | 'object'
  | 'text';

export type MarkdownFrontmatterField = {
  key: string;
  value: string;
  kind: MarkdownFrontmatterFieldKind;
};

export type MarkdownFrontmatterModel = {
  raw: string;
  startLine: number;
  endLine: number;
  fields: MarkdownFrontmatterField[];
  parseError: string | null;
};

export type MarkdownDocumentParts = {
  frontmatter: MarkdownFrontmatterModel | null;
  body: string;
};

function normalizeLineEndings(value: string): string {
  return String(value || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function formatObjectValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatFieldValue(value: unknown): Pick<MarkdownFrontmatterField, 'kind' | 'value'> {
  if (Array.isArray(value)) {
    return {
      kind: 'array',
      value: value
        .map((item) => {
          if (item === null) return 'null';
          if (typeof item === 'object') return formatObjectValue(item);
          return String(item);
        })
        .join(', '),
    };
  }
  if (value === null || value === undefined) {
    return { kind: 'null', value: 'null' };
  }
  if (typeof value === 'boolean') {
    return { kind: 'boolean', value: value ? 'true' : 'false' };
  }
  if (typeof value === 'number') {
    return { kind: 'number', value: String(value) };
  }
  if (typeof value === 'object') {
    return { kind: 'object', value: formatObjectValue(value) };
  }
  return { kind: 'text', value: String(value) };
}

function parseFields(raw: string): {
  fields: MarkdownFrontmatterField[];
  parseError: string | null;
} {
  const document = parseDocument(raw, { prettyErrors: false });
  if (document.errors.length > 0) {
    return {
      fields: [],
      parseError: document.errors.map((error) => error.message).join('\n'),
    };
  }

  const value = document.toJS();
  if (value === null || value === undefined) {
    return { fields: [], parseError: null };
  }
  if (Array.isArray(value) || typeof value !== 'object') {
    return {
      fields: [],
      parseError: 'Front matter must be a YAML key-value mapping.',
    };
  }

  return {
    fields: Object.entries(value as Record<string, unknown>).map(([key, fieldValue]) => ({
      key,
      ...formatFieldValue(fieldValue),
    })),
    parseError: null,
  };
}

export function parseMarkdownDocument(content: string): MarkdownDocumentParts {
  const text = normalizeLineEndings(content);
  const lines = text.split('\n');

  if (lines[0]?.trim() !== '---') {
    return { frontmatter: null, body: text };
  }

  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (endIndex < 1) {
    return {
      frontmatter: {
        raw: lines.slice(1).join('\n'),
        startLine: 1,
        endLine: lines.length,
        fields: [],
        parseError: 'Missing closing front matter delimiter.',
      },
      body: '',
    };
  }

  const raw = lines.slice(1, endIndex).join('\n');
  const parsed = parseFields(raw);
  return {
    frontmatter: {
      raw,
      startLine: 1,
      endLine: endIndex + 1,
      ...parsed,
    },
    body: lines.slice(endIndex + 1).join('\n').replace(/^\n+/, ''),
  };
}

import { useMemo } from 'react';
import { MDContent } from '../render/markdown';

type MdxFrontmatterFieldKind = 'boolean' | 'array' | 'number' | 'text';
type MdxPreviewSegment =
  | {
      type: 'markdown';
      key: string;
      content: string;
    }
  | {
      type: 'placeholder';
      key: string;
      line: number;
      label: string;
      detail: string;
      status: 'missing' | 'disabled' | 'client' | 'error';
      source: string;
    };
type MdxPlaceholderStatus = Extract<MdxPreviewSegment, { type: 'placeholder' }>['status'];

export interface MdxFrontmatterField {
  key: string;
  value: string;
  kind: MdxFrontmatterFieldKind;
  line: number;
}

export interface MdxDocumentModel {
  frontmatter: {
    raw: string;
    startLine: number;
    endLine: number;
    fields: MdxFrontmatterField[];
    parseError: string | null;
  } | null;
  body: string;
  segments: MdxPreviewSegment[];
  issues: MdxPreviewSegment[];
}

const YAML_KEY_VALUE_RE = /^([A-Za-z0-9_.-]+):\s*(.*)$/;
const MDX_IMPORT_EXPORT_RE = /^\s*(?:import|export)\s+/;
const JSX_COMPONENT_RE = /^\s*<([A-Z][\w.]*)\b([^>]*)\/?>\s*$/;
const JSX_LOWER_RE = /^\s*<[a-z][\w-]*\b[^>]*>\s*$/;
const JSX_CLOSE_RE = /^\s*<\/([A-Za-z][\w.]*)>\s*$/;
const JSX_EXPR_RE = /^\s*\{[\s\S]*\}\s*$/;

function normalizeLineEndings(value: string): string {
  return String(value || '').replace(/\r\n/g, '\n');
}

function detectFieldKind(value: string): MdxFrontmatterFieldKind {
  const trimmed = value.trim();
  if (/^(true|false)$/i.test(trimmed)) return 'boolean';
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return 'number';
  if (/^\[[\s\S]*\]$/.test(trimmed)) return 'array';
  return 'text';
}

function stripYamlQuote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function formatYamlValue(value: string, kind: MdxFrontmatterFieldKind): string {
  const trimmed = value.trim();
  if (kind === 'boolean') {
    return trimmed.toLowerCase() === 'true' ? 'true' : 'false';
  }
  if (kind === 'number' && /^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return trimmed;
  }
  if (kind === 'array') {
    const items = trimmed
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => item.replace(/^['"]|['"]$/g, ''));
    return `[${items.map((item) => JSON.stringify(item)).join(', ')}]`;
  }
  if (!trimmed) return '""';
  if (/^(true|false|null|~|-?\d|\[|\{)/i.test(trimmed) || /[:#\n]/.test(trimmed)) {
    return JSON.stringify(trimmed);
  }
  return trimmed;
}

function splitMdxFrontmatter(content: string) {
  const text = normalizeLineEndings(content);
  const lines = text.split('\n');

  if (lines[0]?.trim() !== '---') {
    return {
      frontmatter: null,
      body: text,
      bodyStartLine: 1,
    };
  }

  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (endIndex < 1) {
    return {
      frontmatter: {
        raw: lines.slice(1).join('\n'),
        startLine: 1,
        endLine: lines.length,
        fields: [] as MdxFrontmatterField[],
        parseError: 'Missing closing frontmatter delimiter.',
      },
      body: '',
      bodyStartLine: lines.length + 1,
    };
  }

  const raw = lines.slice(1, endIndex).join('\n');
  return {
    frontmatter: {
      raw,
      startLine: 1,
      endLine: endIndex + 1,
      fields: parseFrontmatterFields(raw),
      parseError: null,
    },
    body: lines.slice(endIndex + 1).join('\n'),
    bodyStartLine: endIndex + 2,
  };
}

function parseFrontmatterFields(raw: string): MdxFrontmatterField[] {
  const fields: MdxFrontmatterField[] = [];
  const lines = raw.split('\n');

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const match = YAML_KEY_VALUE_RE.exec(line);
    if (!match) return;
    const value = match[2] ?? '';
    fields.push({
      key: match[1],
      value: stripYamlQuote(value),
      kind: detectFieldKind(value),
      line: index + 2,
    });
  });

  return fields;
}

function getPlaceholderStatus(source: string): MdxPlaceholderStatus {
  if (/error|throw/i.test(source)) return 'error';
  if (/client|browser|window\./i.test(source)) return 'client';
  if (/disabled|hidden|draft/i.test(source)) return 'disabled';
  return 'missing';
}

function isWrapperTag(label: string): boolean {
  return /^(Fragment|Layout|Page|Provider|Providers|Wrapper|MDXLayout)$/.test(label);
}

function flushMarkdownSegment(
  segments: MdxPreviewSegment[],
  buffer: string[],
  keyPrefix: string
) {
  const content = buffer.join('\n').trim();
  if (!content) {
    buffer.length = 0;
    return;
  }
  segments.push({
    type: 'markdown',
    key: `${keyPrefix}-${segments.length}`,
    content,
  });
  buffer.length = 0;
}

function buildMdxPreviewSegments(body: string, bodyStartLine: number): MdxPreviewSegment[] {
  const segments: MdxPreviewSegment[] = [];
  const markdownBuffer: string[] = [];
  const lines = normalizeLineEndings(body).split('\n');

  lines.forEach((line, index) => {
    const lineNo = bodyStartLine + index;
    const trimmed = line.trim();

    if (!trimmed) {
      markdownBuffer.push(line);
      return;
    }

    if (MDX_IMPORT_EXPORT_RE.test(trimmed)) {
      flushMarkdownSegment(segments, markdownBuffer, 'mdx-md');
      segments.push({
        type: 'placeholder',
        key: `mdx-runtime-${lineNo}`,
        line: lineNo,
        label: trimmed.startsWith('import') ? 'import' : 'export',
        detail: 'Runtime statement hidden from the document preview.',
        status: 'disabled',
        source: trimmed,
      });
      return;
    }

    const closeMatch = JSX_CLOSE_RE.exec(trimmed);
    if (closeMatch && isWrapperTag(closeMatch[1])) {
      return;
    }

    const componentMatch = JSX_COMPONENT_RE.exec(trimmed);
    if (componentMatch) {
      const label = componentMatch[1];
      if (isWrapperTag(label)) {
        return;
      }
      flushMarkdownSegment(segments, markdownBuffer, 'mdx-md');
      segments.push({
        type: 'placeholder',
        key: `mdx-component-${lineNo}`,
        line: lineNo,
        label,
        detail: 'MDX component cannot run inside this lightweight preview.',
        status: getPlaceholderStatus(trimmed),
        source: trimmed,
      });
      return;
    }

    if (JSX_EXPR_RE.test(trimmed) || JSX_LOWER_RE.test(trimmed)) {
      flushMarkdownSegment(segments, markdownBuffer, 'mdx-md');
      segments.push({
        type: 'placeholder',
        key: `mdx-expression-${lineNo}`,
        line: lineNo,
        label: JSX_EXPR_RE.test(trimmed) ? 'expression' : 'jsx',
        detail: 'Inline JSX is shown as a source placeholder.',
        status: getPlaceholderStatus(trimmed),
        source: trimmed,
      });
      return;
    }

    markdownBuffer.push(line);
  });

  flushMarkdownSegment(segments, markdownBuffer, 'mdx-md');
  return segments;
}

export function parseMdxDocument(content: string): MdxDocumentModel {
  const parts = splitMdxFrontmatter(content);
  const segments = buildMdxPreviewSegments(parts.body, parts.bodyStartLine);
  const issues = segments.filter((segment): segment is Extract<MdxPreviewSegment, { type: 'placeholder' }> =>
    segment.type === 'placeholder'
  );

  return {
    frontmatter: parts.frontmatter,
    body: parts.body,
    segments,
    issues,
  };
}

export function updateMdxFrontmatterField(
  content: string,
  key: string,
  value: string,
  kind: MdxFrontmatterFieldKind
): string {
  const normalized = normalizeLineEndings(content);
  const lines = normalized.split('\n');
  const nextLine = `${key}: ${formatYamlValue(value, kind)}`;

  if (lines[0]?.trim() !== '---') {
    return `---\n${nextLine}\n---\n\n${normalized.replace(/^\n+/, '')}`;
  }

  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (endIndex < 1) {
    return normalized;
  }

  for (let index = 1; index < endIndex; index += 1) {
    const match = YAML_KEY_VALUE_RE.exec(lines[index]);
    if (match?.[1] === key) {
      const nextLines = [...lines];
      nextLines[index] = nextLine;
      return nextLines.join('\n');
    }
  }

  const nextLines = [...lines];
  nextLines.splice(endIndex, 0, nextLine);
  return nextLines.join('\n');
}

function statusLabel(status: MdxPlaceholderStatus): string {
  if (status === 'client') return 'client-only';
  if (status === 'disabled') return 'disabled';
  if (status === 'error') return 'error';
  return 'missing';
}

export function ProjectMdxProperties({
  content,
  onChange,
  onRevealSource,
  compact = false,
}: {
  content: string;
  onChange: (next: string) => void;
  onRevealSource?: (line: number) => void;
  compact?: boolean;
}) {
  const model = useMemo(() => parseMdxDocument(content), [content]);
  const frontmatter = model.frontmatter;
  const fields = frontmatter?.fields ?? [];

  if (!frontmatter && compact) {
    return null;
  }

  return (
    <section className={`aegis-mdx-properties ${compact ? 'aegis-mdx-properties-compact' : ''}`}>
      <div className="aegis-mdx-properties-header">
        <span className="aegis-mdx-properties-title">Properties</span>
        {frontmatter ? (
          <span className="aegis-mdx-properties-count">{fields.length} fields</span>
        ) : (
          <span className="aegis-mdx-properties-count">no frontmatter</span>
        )}
      </div>

      {frontmatter?.parseError ? (
        <button
          type="button"
          className="aegis-mdx-properties-warning"
          onClick={() => onRevealSource?.(frontmatter.endLine)}
        >
          {frontmatter.parseError}
        </button>
      ) : null}

      {fields.length > 0 ? (
        <div className="aegis-mdx-properties-grid">
          {fields.slice(0, compact ? 6 : 12).map((field) => {
            const inputId = `mdx-prop-${field.line}-${field.key}`;
            return (
              <div key={`${field.key}-${field.line}`} className="aegis-mdx-property-row">
                <button
                  type="button"
                  className="aegis-mdx-property-key"
                  onClick={(event) => {
                    event.preventDefault();
                    onRevealSource?.(field.line);
                  }}
                  title={`Reveal ${field.key} at line ${field.line}`}
                >
                  {field.key}
                </button>
                {field.kind === 'boolean' ? (
                  <input
                    id={inputId}
                    type="checkbox"
                    aria-label={field.key}
                    checked={field.value.trim().toLowerCase() === 'true'}
                    onChange={(event) =>
                      onChange(updateMdxFrontmatterField(content, field.key, event.target.checked ? 'true' : 'false', field.kind))
                    }
                  />
                ) : (
                  <input
                    id={inputId}
                    type={field.kind === 'number' ? 'number' : 'text'}
                    aria-label={field.key}
                    value={field.kind === 'array' ? field.value.replace(/^\[|\]$/g, '') : field.value}
                    onChange={(event) =>
                      onChange(updateMdxFrontmatterField(content, field.key, event.target.value, field.kind))
                    }
                  />
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="aegis-mdx-properties-empty">No editable metadata in this file.</div>
      )}
    </section>
  );
}

function ProjectMdxPlaceholder({
  segment,
  onRevealSource,
}: {
  segment: Extract<MdxPreviewSegment, { type: 'placeholder' }>;
  onRevealSource?: (line: number) => void;
}) {
  return (
    <div className={`aegis-mdx-placeholder aegis-mdx-placeholder-${segment.status}`}>
      <div className="aegis-mdx-placeholder-main">
        <span className="aegis-mdx-placeholder-badge">{statusLabel(segment.status)}</span>
        <span className="aegis-mdx-placeholder-title">{segment.label}</span>
        <span className="aegis-mdx-placeholder-line">line {segment.line}</span>
      </div>
      <div className="aegis-mdx-placeholder-detail">{segment.detail}</div>
      <code>{segment.source}</code>
      {onRevealSource ? (
        <button
          type="button"
          className="aegis-mdx-placeholder-reveal"
          onClick={() => onRevealSource(segment.line)}
        >
          Reveal source
        </button>
      ) : null}
    </div>
  );
}

export function ProjectMdxPreview({
  content,
  onChange,
  onRevealSource,
  showProperties = true,
}: {
  content: string;
  onChange: (next: string) => void;
  onRevealSource?: (line: number) => void;
  showProperties?: boolean;
}) {
  const model = useMemo(() => parseMdxDocument(content), [content]);

  return (
    <div className="aegis-mdx-preview">
      {showProperties ? (
        <ProjectMdxProperties
          content={content}
          onChange={onChange}
          onRevealSource={onRevealSource}
        />
      ) : null}

      <div className="project-markdown-preview aegis-mdx-preview-body">
        {model.segments.length > 0 ? (
          model.segments.map((segment) =>
            segment.type === 'markdown' ? (
              <MDContent
                key={segment.key}
                content={segment.content}
                allowHtml={false}
                className="aegis-mdx-markdown-chunk"
              />
            ) : (
              <ProjectMdxPlaceholder
                key={segment.key}
                segment={segment}
                onRevealSource={onRevealSource}
              />
            )
          )
        ) : (
          <div className="aegis-mdx-preview-empty">Nothing to preview yet.</div>
        )}
      </div>
    </div>
  );
}

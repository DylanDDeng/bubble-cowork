import { useMemo, useState } from 'react';
import { MDContent } from '../render/markdown';
import {
  parseMarkdownDocument,
  type MarkdownFrontmatterField,
} from '../utils/markdown-frontmatter';
import { ChevronDown, ChevronUp } from './icons';

const DEFAULT_VISIBLE_FIELD_COUNT = 8;

function MetadataValue({ field }: { field: MarkdownFrontmatterField }) {
  return (
    <span className={`aegis-markdown-metadata-value kind-${field.kind}`}>
      {field.value}
    </span>
  );
}

function MarkdownMetadataCard({
  fields,
  parseError,
  raw,
}: {
  fields: MarkdownFrontmatterField[];
  parseError: string | null;
  raw: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasMore = fields.length > DEFAULT_VISIBLE_FIELD_COUNT;
  const visibleFields = expanded ? fields : fields.slice(0, DEFAULT_VISIBLE_FIELD_COUNT);

  return (
    <section
      className={`aegis-markdown-metadata-card${parseError ? ' is-invalid' : ''}`}
      aria-label="元数据"
      data-testid="markdown-metadata-card"
    >
      <div className="aegis-markdown-metadata-title">元数据</div>
      {parseError ? (
        <div className="aegis-markdown-metadata-error" role="status">
          <span>无法解析 front matter：{parseError}</span>
          {raw ? <pre>{raw}</pre> : null}
        </div>
      ) : (
        <div className="aegis-markdown-metadata-grid">
          {visibleFields.map((field) => (
            <div key={field.key} className="aegis-markdown-metadata-row">
              <span className="aegis-markdown-metadata-key" title={field.key}>
                {field.key}
              </span>
              <MetadataValue field={field} />
            </div>
          ))}
        </div>
      )}
      {!parseError && hasMore ? (
        <button
          type="button"
          className="aegis-markdown-metadata-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? '收起' : '显示更多'}
          {expanded ? (
            <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </button>
      ) : null}
    </section>
  );
}

export function ProjectMarkdownPreview({ content }: { content: string }) {
  const document = useMemo(() => parseMarkdownDocument(content), [content]);
  const frontmatter = document.frontmatter;

  if (!frontmatter) {
    return (
      <MDContent
        content={document.body}
        allowHtml={false}
        className="project-markdown-preview"
      />
    );
  }

  return (
    <div className="project-markdown-preview aegis-markdown-document-preview">
      {frontmatter.fields.length > 0 || frontmatter.parseError ? (
        <MarkdownMetadataCard
          fields={frontmatter.fields}
          parseError={frontmatter.parseError}
          raw={frontmatter.raw}
        />
      ) : null}
      <MDContent
        content={document.body}
        allowHtml={false}
        className="aegis-markdown-preview-body"
      />
    </div>
  );
}

import { isValidElement, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import type { Components } from 'react-markdown';
import { Check, Copy } from 'lucide-react';
import { ErrorBoundary } from '../components/ErrorBoundary';

interface MDContentProps {
  content: string;
  className?: string;
  allowHtml?: boolean;
}

function extractTextContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map((child) => extractTextContent(child)).join('');
  }

  if (node && typeof node === 'object' && 'props' in node) {
    const childNode = (node as { props?: { children?: ReactNode } }).props?.children;
    return extractTextContent(childNode ?? '');
  }

  return '';
}

function formatLanguageLabel(language: string): string {
  if (language.toLowerCase() === 'javascript') return 'JavaScript';
  if (language.toLowerCase() === 'typescript') return 'TypeScript';
  if (language.toLowerCase() === 'bash') return 'Bash';
  if (language.toLowerCase() === 'shell') return 'Shell';
  if (language.toLowerCase() === 'json') return 'JSON';
  if (language.toLowerCase() === 'diff') return 'Diff';
  return language.replace(/[-_]/g, ' ');
}

function shouldDisplayLanguageLabel(language?: string): boolean {
  if (!language) {
    return false;
  }

  const normalized = language.toLowerCase();
  return !['diff', 'text', 'plaintext'].includes(normalized);
}

function normalizeLanguage(language?: string): string | undefined {
  if (!language) {
    return undefined;
  }

  const normalized = language.toLowerCase();
  if (['diff', 'text', 'plaintext'].includes(normalized)) {
    return undefined;
  }

  return language;
}

function extractCodeChild(children: ReactNode): {
  className?: string;
  codeChildren: ReactNode;
} {
  const codeElement =
    isValidElement(children)
      ? children
      : Array.isArray(children) && children.length === 1 && isValidElement(children[0])
        ? children[0]
        : null;

  if (!codeElement) {
    return { codeChildren: children };
  }

  const props = codeElement.props as { className?: string; children?: ReactNode };
  return {
    className: props.className,
    codeChildren: props.children,
  };
}

function CodeBlock({
  language,
  className,
  children,
}: {
  language?: string;
  className?: string;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const rawCode = extractTextContent(children).replace(/\n$/, '');
  const showLanguageLabel = shouldDisplayLanguageLabel(language);
  const effectiveLanguage = normalizeLanguage(language);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(rawCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore clipboard failures
    }
  };

  return (
    <div className="md-code-block">
      <div className={`md-code-header${showLanguageLabel ? '' : ' is-compact'}`}>
        {showLanguageLabel ? (
          <span className="md-code-language">{formatLanguageLabel(language!)}</span>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={() => void handleCopy()}
          className={`md-code-copy${showLanguageLabel ? '' : ' is-floating'}`}
          title={copied ? 'Copied' : 'Copy code'}
          aria-label={copied ? 'Copied' : 'Copy code'}
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>

      <pre className="md-code-content">
        <code className={effectiveLanguage ? className : undefined}>{children}</code>
      </pre>
    </div>
  );
}

// 自定义组件映射
const components: Components = {
  h1: ({ children }) => (
    <h1 className="text-xl font-semibold mt-4 mb-2">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-lg font-semibold mt-3 mb-2">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-base font-semibold mt-2 mb-1">{children}</h3>
  ),
  p: ({ children }) => <p className="my-2">{children}</p>,
  ul: ({ children }) => <ul className="list-disc pl-6 my-2">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-6 my-2">{children}</ol>,
  li: ({ children }) => <li className="my-1">{children}</li>,
  a: ({ href, children }) => (
    <a
      href={href}
      className="text-[var(--accent)] hover:underline"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-[3px] border-[var(--border)] pl-4 my-2 text-[var(--text-secondary)]">
      {children}
    </blockquote>
  ),
  code: ({ className, children, ...props }) => {
    return (
      <code
        className="md-inline-code"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => {
    const { className, codeChildren } = extractCodeChild(children);
    const match = /language-([\w-]+)/.exec(className || '');

    return (
      <CodeBlock language={match?.[1]} className={className}>
        {codeChildren}
      </CodeBlock>
    );
  },
  table: ({ children }) => (
    <div className="overflow-x-auto my-3">
      <table className="w-full border-collapse">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-[var(--border)] bg-[var(--bg-tertiary)] px-3 py-2 text-left">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-[var(--border)] px-3 py-2">{children}</td>
  ),
};

export function MDContent({ content, className = '', allowHtml = false }: MDContentProps) {
  const disallowedElements = ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base'];

  // 配置 rehype-highlight 和 rehype-katex
  const rehypePlugins = useMemo(() => {
    const plugins: Parameters<typeof ReactMarkdown>[0]['rehypePlugins'] = allowHtml
      ? [rehypeRaw, rehypeKatex, [rehypeHighlight, { ignoreMissing: true }]]
      : [rehypeKatex, [rehypeHighlight, { ignoreMissing: true }]];
    return plugins;
  }, [allowHtml]);

  const fallback = (
    <div className="md-code-block">
      <pre className="md-code-content whitespace-pre-wrap break-words">{content}</pre>
    </div>
  );

  // 处理空内容
  if (!content || content.trim() === '') {
    return null;
  }

  return (
    <div className={`markdown-content ${className}`}>
      <ErrorBoundary fallback={fallback} resetKey={content}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={rehypePlugins}
          disallowedElements={disallowedElements}
          unwrapDisallowed={true}
          components={components}
        >
          {content}
        </ReactMarkdown>
      </ErrorBoundary>
    </div>
  );
}

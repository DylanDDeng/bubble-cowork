import { isValidElement, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeKatex from 'rehype-katex';
import type { Components } from 'react-markdown';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { HighlightedCode } from '../components/HighlightedCode';
import { useAppStore } from '../store/useAppStore';
import { isHtmlFilePath, openHtmlFileInBrowserTab } from '../utils/html-preview';

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

function looksLikeRevealablePath(value: string): boolean {
  const text = value.trim();
  if (!text || /[\r\n\t]/.test(text)) {
    return false;
  }

  return (
    text === '~' ||
    text.startsWith('~/') ||
    text.startsWith('~\\') ||
    /^\/(Users|home|tmp|var|etc|opt|private|Volumes|mnt)\//.test(text) ||
    /^[A-Za-z]:[\\/]/.test(text)
  );
}

function stripHashAndQuery(value: string): string {
  const queryIndex = value.indexOf('?');
  const hashIndex = value.indexOf('#');
  const cutPoints = [queryIndex, hashIndex].filter((index) => index >= 0);
  if (cutPoints.length === 0) return value;
  return value.slice(0, Math.min(...cutPoints));
}

function normalizeSlashPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/');
}

function stripLineSuffix(path: string): string {
  // Model answers often cite files as README.md:3 or src/App.tsx:120:8.
  // The preview API expects only the file path; line navigation can be layered
  // on later without treating the line suffix as part of the filename.
  return path.replace(/:(\d+)(?::\d+)?$/, '');
}

function getProjectFileHref(href: string | undefined, cwd: string | null): string | null {
  if (!href || !cwd) return null;

  const raw = href.trim();
  if (!raw || raw.startsWith('#')) return null;
  if (/^(?:https?|mailto|tel|javascript|data|blob):/i.test(raw)) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(raw) && !raw.toLowerCase().startsWith('file:')) {
    return null;
  }

  let path = raw;
  if (raw.toLowerCase().startsWith('file:')) {
    try {
      path = decodeURIComponent(new URL(raw).pathname);
    } catch {
      return null;
    }
  } else {
    path = stripHashAndQuery(raw);
    try {
      path = decodeURIComponent(path);
    } catch {
      // Keep the raw path if it contains a partial percent escape.
    }
  }

  path = stripLineSuffix(normalizeSlashPath(path.trim()));
  if (!path || path.includes('\0')) return null;

  const normalizedCwd = normalizeSlashPath(cwd).replace(/\/$/, '');
  if (path === normalizedCwd) return null;
  if (path.startsWith(`${normalizedCwd}/`)) {
    path = path.slice(normalizedCwd.length + 1);
  } else if (path.startsWith('/')) {
    return null;
  }

  path = path.replace(/^\.\//, '');
  return path && path !== '.' ? path : null;
}

function MarkdownAnchor({
  href,
  children,
}: {
  href?: string;
  children: ReactNode;
}) {
  const {
    activeSessionId,
    sessions,
    projectCwd,
    setBrowserPanelOpen,
    setProjectPanelView,
    setProjectTreeCollapsed,
  } = useAppStore();
  const cwd = (activeSessionId ? sessions[activeSessionId]?.cwd : null) || projectCwd || null;
  const projectFilePath = getProjectFileHref(href, cwd);

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!projectFilePath || !cwd) return;

    event.preventDefault();
    event.stopPropagation();

    if (isHtmlFilePath(projectFilePath)) {
      if (!activeSessionId) {
        toast.error('No active session for browser preview.');
        return;
      }

      openHtmlFileInBrowserTab({
        cwd,
        filePath: projectFilePath,
        sessionId: activeSessionId,
      })
        .then(() => {
          setBrowserPanelOpen(true);
          setProjectTreeCollapsed(true);
        })
        .catch((error) => {
          toast.error(`Failed to open in browser panel: ${error}`);
        });
      return;
    }

    setBrowserPanelOpen(false);
    setProjectPanelView('files');
    setProjectTreeCollapsed(false);

    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent('aegis:open-project-file', {
          detail: { cwd, path: projectFilePath },
        })
      );
    }, 0);
  };

  return (
    <a
      href={href}
      className="text-[var(--accent)] hover:underline"
      target={projectFilePath ? undefined : '_blank'}
      rel={projectFilePath ? undefined : 'noopener noreferrer'}
      onClick={handleClick}
      title={projectFilePath ? `Open ${projectFilePath}` : undefined}
    >
      {children}
    </a>
  );
}

function InlinePathCode({ text }: { text: string }) {
  const [revealing, setRevealing] = useState(false);

  const handleReveal = async () => {
    setRevealing(true);
    try {
      const result = await window.electron.revealPath(text);
      if (!result?.ok) {
        toast.error(result?.message || 'Failed to reveal path.');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to reveal path.');
    } finally {
      setRevealing(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleReveal()}
      disabled={revealing}
      className="md-inline-code md-inline-code-path"
      title={revealing ? 'Revealing...' : 'Reveal in file manager'}
      aria-label={revealing ? `Revealing ${text}` : `Reveal ${text} in file manager`}
    >
      {text}
    </button>
  );
}

function CodeBlock({
  language,
  children,
}: {
  language?: string;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const rawCode = extractTextContent(children).replace(/\n$/, '');
  const showLanguageLabel = shouldDisplayLanguageLabel(language);
  const languageLabel = showLanguageLabel ? formatLanguageLabel(language!) : 'Snippet';

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
      <div className="md-code-header">
        <div className="md-code-meta">
          <span className="md-code-language">{languageLabel}</span>
        </div>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="md-code-copy"
          title={copied ? 'Copied' : 'Copy code'}
          aria-label={copied ? 'Copied' : 'Copy code'}
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          <span className="md-code-copy-label">{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>

      <HighlightedCode code={rawCode} language={language} showLineNumbers={false} />
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
  a: ({ href, children }) => <MarkdownAnchor href={href}>{children}</MarkdownAnchor>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-[3px] border-[var(--border)] pl-4 my-2 text-[var(--text-secondary)]">
      {children}
    </blockquote>
  ),
  code: ({ className, children, ...props }) => {
    const text = extractTextContent(children);
    if (!className && looksLikeRevealablePath(text)) {
      return <InlinePathCode text={text} />;
    }

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
      <CodeBlock language={match?.[1]}>
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

  const rehypePlugins = useMemo(() => {
    const plugins: Parameters<typeof ReactMarkdown>[0]['rehypePlugins'] = allowHtml
      ? [rehypeRaw, rehypeKatex]
      : [rehypeKatex];
    return plugins;
  }, [allowHtml]);

  const fallback = (
    <div className="md-code-block">
      <HighlightedCode code={content} showLineNumbers={false} />
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

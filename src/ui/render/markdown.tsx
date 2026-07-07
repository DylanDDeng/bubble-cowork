import { isValidElement, memo, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeKatex from 'rehype-katex';
import type { Components } from 'react-markdown';
import {
  BrandFigma,
  BrandGithub,
  BrandGmail,
  BrandGoogleDrive,
  BrandNotion,
  BrandOpenai,
  BrandSlack,
  BrandTwitter,
  BrandVercel,
  BrandX,
  Check,
  Copy,
  type IconComponent,
} from '../components/icons';
import { toast } from 'sonner';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { FileTypeIcon } from '../components/FileTypeIcon';
import { HighlightedCode } from '../components/HighlightedCode';
import { useAppStore } from '../store/useAppStore';

interface MDContentProps {
  content: string;
  className?: string;
  allowHtml?: boolean;
}

interface ProjectFileLink {
  path: string;
  line?: number;
}

interface ExternalLinkApp {
  kind: string;
  label: string;
  Icon?: IconComponent;
  monogram?: string;
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
  if (language.toLowerCase() === 'plaintext') return 'text';
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

function extractLineHint(value: string): number | undefined {
  const match = /(?:#L|[?&#]line=)(\d+)/i.exec(value);
  if (!match) return undefined;

  const line = Number(match[1]);
  return Number.isInteger(line) && line > 0 ? line : undefined;
}

function normalizeSlashPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/');
}

function parseLineSuffix(path: string): ProjectFileLink {
  // Model answers often cite files as README.md:3 or src/App.tsx:120:8.
  // Keep the display line while preventing it from becoming part of the filename.
  const match = /:(\d+)(?::\d+)?$/.exec(path);
  if (!match) {
    return { path };
  }

  const line = Number(match[1]);
  return {
    path: path.slice(0, match.index ?? path.length),
    line: Number.isInteger(line) && line > 0 ? line : undefined,
  };
}

function getProjectFileLink(href: string | undefined, cwd: string | null): ProjectFileLink | null {
  if (!href || !cwd) return null;

  const raw = href.trim();
  if (!raw || raw.startsWith('#')) return null;
  if (/^(?:https?|mailto|tel|javascript|data|blob):/i.test(raw)) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(raw) && !raw.toLowerCase().startsWith('file:')) {
    return null;
  }

  const lineHint = extractLineHint(raw);
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

  const parsed = parseLineSuffix(normalizeSlashPath(path.trim()));
  path = parsed.path;
  if (!path || path.includes('\0')) return null;

  const normalizedCwd = normalizeSlashPath(cwd).replace(/\/$/, '');
  if (path === normalizedCwd) return null;
  if (path.startsWith(`${normalizedCwd}/`)) {
    path = path.slice(normalizedCwd.length + 1);
  } else if (path.startsWith('/')) {
    return null;
  }

  path = path.replace(/^\.\//, '');
  return path && path !== '.' ? { path, line: parsed.line ?? lineHint } : null;
}

function matchesHost(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function getExternalLinkApp(href: string | undefined): ExternalLinkApp | null {
  if (!href) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');

  if (matchesHost(host, 'github.com')) {
    return { kind: 'github', label: 'GitHub', Icon: BrandGithub };
  }
  if (matchesHost(host, 'figma.com')) {
    return { kind: 'figma', label: 'Figma', Icon: BrandFigma };
  }
  if (matchesHost(host, 'notion.so') || matchesHost(host, 'notion.site')) {
    return { kind: 'notion', label: 'Notion', Icon: BrandNotion };
  }
  if (matchesHost(host, 'linear.app')) {
    return { kind: 'linear', label: 'Linear', monogram: 'L' };
  }
  if (matchesHost(host, 'x.com')) {
    return { kind: 'x', label: 'X', Icon: BrandX };
  }
  if (matchesHost(host, 'twitter.com')) {
    return { kind: 'twitter', label: 'Twitter', Icon: BrandTwitter };
  }
  if (matchesHost(host, 'openai.com') || matchesHost(host, 'chatgpt.com')) {
    return { kind: 'openai', label: 'OpenAI', Icon: BrandOpenai };
  }
  if (matchesHost(host, 'slack.com')) {
    return { kind: 'slack', label: 'Slack', Icon: BrandSlack };
  }
  if (matchesHost(host, 'vercel.com') || matchesHost(host, 'vercel.app')) {
    return { kind: 'vercel', label: 'Vercel', Icon: BrandVercel };
  }
  if (host === 'mail.google.com' || matchesHost(host, 'gmail.com')) {
    return { kind: 'gmail', label: 'Gmail', Icon: BrandGmail };
  }
  if (host === 'drive.google.com' || host === 'docs.google.com') {
    return { kind: 'google-drive', label: 'Google Drive', Icon: BrandGoogleDrive };
  }

  return null;
}

function shouldShowLineSuffix(children: ReactNode, line: number | undefined): line is number {
  if (!line) return false;
  const text = extractTextContent(children);
  return !new RegExp(`(?:\\bline\\s*${line}\\b|#L${line}\\b|:${line}\\b)`, 'i').test(text);
}

function getInlineProjectFileCode(text: string): ProjectFileLink | null {
  const raw = text.trim();
  if (!raw || raw.length > 180 || /[\r\n\t]/.test(raw) || raw.includes('\0')) {
    return null;
  }
  if (/^(?:https?|mailto|tel|javascript|data|blob|file):/i.test(raw)) {
    return null;
  }

  const parsed = parseLineSuffix(normalizeSlashPath(raw));
  const path = parsed.path.replace(/^\.\//, '');
  if (!path || path === '.' || path.startsWith('/')) {
    return null;
  }

  const basename = path.split('/').filter(Boolean).pop() || path;
  if (!basename || /^\.[^.]+$/.test(basename)) {
    return null;
  }
  if (!/\.[A-Za-z0-9][A-Za-z0-9_-]{0,12}$/.test(basename)) {
    return null;
  }

  return { path, line: parsed.line };
}

function useProjectFileNavigation() {
  const {
    activeSessionId,
    sessions,
    projectCwd,
    openRightUtilityTab,
  } = useAppStore();
  const cwd = (activeSessionId ? sessions[activeSessionId]?.cwd : null) || projectCwd || null;

  const openProjectFile = (projectFile: ProjectFileLink) => {
    if (!cwd) return;

    // HTML chips open in the file panel showing source, like every other
    // file; the panel's open handler resolves partial paths via
    // resolveProjectTreeFile, and the rendered page is reachable from the
    // preview header's Open-with dropdown (browsers are in that list).
    openRightUtilityTab('files');

    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent('aegis:open-project-file', {
          detail: { cwd, path: projectFile.path, lineStart: projectFile.line },
        })
      );
    }, 0);
  };

  return { cwd, openProjectFile };
}

function MarkdownAnchor({
  href,
  children,
}: {
  href?: string;
  children: ReactNode;
}) {
  const { cwd, openProjectFile } = useProjectFileNavigation();
  const projectFile = getProjectFileLink(href, cwd);
  const externalLinkApp = projectFile ? null : getExternalLinkApp(href);

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!projectFile || !cwd) return;

    event.preventDefault();
    event.stopPropagation();
    openProjectFile(projectFile);
  };

  if (projectFile) {
    const showLine = shouldShowLineSuffix(children, projectFile.line);
    const title = projectFile.line
      ? `Open ${projectFile.path} at line ${projectFile.line}`
      : `Open ${projectFile.path}`;

    return (
      <a
        href={href}
        className="md-file-link"
        onClick={handleClick}
        title={title}
      >
        <FileTypeIcon
          name={projectFile.path}
          className="md-file-link-icon"
          fallbackClassName="md-file-link-fallback-icon"
        />
        <span className="md-link-label">{children}</span>
        {showLine && <span className="md-file-link-line">(line {projectFile.line})</span>}
      </a>
    );
  }

  if (externalLinkApp) {
    const Icon = externalLinkApp.Icon;

    return (
      <a
        href={href}
        className={`md-app-link md-app-link-${externalLinkApp.kind}`}
        target="_blank"
        rel="noopener noreferrer"
        title={`Open ${externalLinkApp.label}`}
      >
        {Icon ? (
          <Icon className="md-app-link-icon" aria-hidden="true" />
        ) : (
          <span className="md-app-link-monogram" aria-hidden="true">
            {externalLinkApp.monogram}
          </span>
        )}
        <span className="md-link-label">{children}</span>
      </a>
    );
  }

  return (
    <a
      href={href}
      className="text-[var(--accent)] hover:underline"
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleClick}
    >
      {children}
    </a>
  );
}

function InlineProjectFileCode({ projectFile }: { projectFile: ProjectFileLink }) {
  const { cwd, openProjectFile } = useProjectFileNavigation();
  const title = projectFile.line
    ? `Open ${projectFile.path} at line ${projectFile.line}`
    : `Open ${projectFile.path}`;
  const content = (
    <>
      <FileTypeIcon
        name={projectFile.path}
        className="md-inline-file-code-icon"
        fallbackClassName="md-inline-file-code-fallback-icon"
      />
      <span className="md-inline-file-code-label">{projectFile.path}</span>
      {projectFile.line ? (
        <span className="md-inline-file-code-line">(line {projectFile.line})</span>
      ) : null}
    </>
  );

  if (!cwd) {
    return (
      <span className="md-inline-file-code" title={projectFile.path}>
        {content}
      </span>
    );
  }

  return (
    <button
      type="button"
      className="md-inline-file-code"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openProjectFile(projectFile);
      }}
      title={title}
    >
      {content}
    </button>
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
  const languageLabel = showLanguageLabel ? formatLanguageLabel(language!) : 'text';

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

      <HighlightedCode code={rawCode} language={language} showLineNumbers />
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
    if (!className) {
      const projectFile = getInlineProjectFileCode(text);
      if (projectFile) {
        return <InlineProjectFileCode projectFile={projectFile} />;
      }
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

function MDContentImpl({ content, className = '', allowHtml = false }: MDContentProps) {
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

/**
 * Memoized markdown renderer (P2). Props are primitives, so the default
 * shallow comparison applies: a completed message's markdown never re-parses
 * when its parent re-renders during streaming — previously every flush
 * re-ran remark/rehype over the entire visible history. Only the block whose
 * `content` actually changed (the live streaming tail) re-parses.
 */
export const MDContent = memo(MDContentImpl);

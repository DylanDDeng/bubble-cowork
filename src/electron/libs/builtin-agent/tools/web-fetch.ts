import type { BuiltinToolRegistryEntry } from '../types';

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

type FetchFormat = 'markdown' | 'text' | 'html';

export function createWebFetchTool(): BuiltinToolRegistryEntry {
  return {
    name: 'web_fetch',
    readOnly: true,
    description: 'Fetch a specific URL directly and return its content as markdown, text, or HTML.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch content from' },
        format: {
          type: 'string',
          description: 'The format to return the content in. Defaults to markdown.',
          enum: ['markdown', 'text', 'html'],
        },
        timeout: {
          type: 'number',
          description: 'Optional timeout in seconds. Maximum is 120 seconds.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const rawUrl = typeof args.url === 'string' ? args.url.trim() : '';
      if (!rawUrl) {
        return { content: 'Error: url is required', isError: true, status: 'command_error' };
      }
      const parsed = parseHttpUrl(rawUrl);
      if (!parsed) {
        return { content: 'Error: URL must start with http:// or https://', isError: true, status: 'command_error' };
      }

      const format = parseFormat(args.format);
      const timeoutMs = parseTimeoutMs(args.timeout);
      const response = await fetchUrl(parsed.toString(), format, timeoutMs, ctx.abortSignal);
      if (response.isError) return response;

      const body = response.content;
      const contentType = response.metadata?.contentType || '';
      const output = await formatResponseBody(body, contentType, format);
      return {
        content: [`URL: ${parsed.toString()}`, `Content-Type: ${contentType || 'unknown'}`, '', output].join('\n'),
        status: 'success',
        metadata: {
          kind: 'web',
          url: parsed.toString(),
          contentType,
          format,
        },
      };
    },
  };
}

function parseHttpUrl(input: string): URL | null {
  try {
    const url = new URL(input);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

function parseFormat(value: unknown): FetchFormat {
  return value === 'text' || value === 'html' || value === 'markdown' ? value : 'markdown';
}

function parseTimeoutMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.round(value * 1000), MAX_TIMEOUT_MS);
}

function acceptHeader(format: FetchFormat): string {
  switch (format) {
    case 'markdown':
      return 'text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1';
    case 'text':
      return 'text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1';
    case 'html':
      return 'text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1';
  }
}

async function fetchUrl(
  url: string,
  format: FetchFormat,
  timeoutMs: number,
  parentSignal: AbortSignal
): Promise<{
  content: string;
  isError?: boolean;
  status?: 'success' | 'command_error';
  metadata?: { kind?: 'web'; contentType?: string; url?: string };
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);
  const abort = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abort();
  parentSignal.addEventListener('abort', abort, { once: true });

  try {
    const headers = {
      'User-Agent': BROWSER_USER_AGENT,
      Accept: acceptHeader(format),
      'Accept-Language': 'en-US,en;q=0.9',
    };
    let response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    if (response.status === 403 && response.headers.get('cf-mitigated') === 'challenge') {
      response = await fetch(url, {
        method: 'GET',
        headers: { ...headers, 'User-Agent': 'aegis' },
        signal: controller.signal,
      });
    }
    if (!response.ok) {
      return {
        content: `Error: Fetch failed with status ${response.status} ${response.statusText}`.trim(),
        isError: true,
        status: 'command_error',
        metadata: { kind: 'web', url },
      };
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength && Number.parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
      return {
        content: 'Error: Response too large (exceeds 5MB limit)',
        isError: true,
        status: 'command_error',
        metadata: { kind: 'web', url },
      };
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_RESPONSE_SIZE) {
      return {
        content: 'Error: Response too large (exceeds 5MB limit)',
        isError: true,
        status: 'command_error',
        metadata: { kind: 'web', url },
      };
    }

    const contentType = response.headers.get('content-type') || '';
    const mime = contentType.split(';')[0]?.trim().toLowerCase() || '';
    if (mime.startsWith('image/')) {
      return {
        content: `Image fetched successfully (${mime}, ${buffer.byteLength} bytes).`,
        status: 'success',
        metadata: { kind: 'web', contentType, url },
      };
    }

    return {
      content: new TextDecoder().decode(buffer),
      status: 'success',
      metadata: { kind: 'web', contentType, url },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: `Error: ${message}`,
      isError: true,
      status: 'command_error',
      metadata: { kind: 'web', url },
    };
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener('abort', abort);
  }
}

async function formatResponseBody(body: string, contentType: string, format: FetchFormat): Promise<string> {
  if (!contentType.includes('text/html')) return body;
  if (format === 'html') return body;

  const { JSDOM } = require('jsdom') as {
    JSDOM: new (html: string) => { window: { document: Document } };
  };
  const document = new JSDOM(body).window.document;
  document.querySelectorAll('script, style, noscript, iframe, object, embed, meta, link').forEach((node: Element) => {
    node.remove();
  });
  if (format === 'text') {
    return (document.body?.textContent || document.documentElement.textContent || '').replace(/\s+/g, ' ').trim();
  }
  return htmlDocumentToMarkdown(document);
}

function htmlDocumentToMarkdown(document: Document): string {
  const lines: string[] = [];
  const root = document.body || document.documentElement;
  for (const child of Array.from(root.childNodes)) {
    appendMarkdown(child, lines);
  }
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function appendMarkdown(node: Node, lines: string[]): void {
  if (node.nodeType === node.TEXT_NODE) {
    const text = normalizeInlineText(node.textContent || '');
    if (text) lines.push(text);
    return;
  }
  if (node.nodeType !== node.ELEMENT_NODE) return;

  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (tag === 'br') {
    lines.push('');
    return;
  }
  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1));
    const text = normalizeInlineText(element.textContent || '');
    if (text) lines.push(`${'#'.repeat(level)} ${text}`, '');
    return;
  }
  if (tag === 'p' || tag === 'section' || tag === 'article' || tag === 'main' || tag === 'header' || tag === 'footer') {
    const text = inlineMarkdown(element);
    if (text) lines.push(text, '');
    return;
  }
  if (tag === 'li') {
    const text = inlineMarkdown(element);
    if (text) lines.push(`- ${text}`);
    return;
  }
  if (tag === 'pre') {
    const text = element.textContent || '';
    if (text.trim()) lines.push('```', text.trimEnd(), '```', '');
    return;
  }
  if (tag === 'blockquote') {
    const text = normalizeInlineText(element.textContent || '');
    if (text) lines.push(...text.split('\n').map((line) => `> ${line}`), '');
    return;
  }
  if (tag === 'table') {
    const text = normalizeInlineText(element.textContent || '');
    if (text) lines.push(text, '');
    return;
  }

  for (const child of Array.from(element.childNodes)) {
    appendMarkdown(child, lines);
  }
}

function inlineMarkdown(element: Element): string {
  const pieces: string[] = [];
  for (const node of Array.from(element.childNodes)) {
    pieces.push(inlineNodeMarkdown(node));
  }
  return normalizeInlineText(pieces.join(''));
}

function inlineNodeMarkdown(node: Node): string {
  if (node.nodeType === node.TEXT_NODE) return node.textContent || '';
  if (node.nodeType !== node.ELEMENT_NODE) return '';
  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  const text = inlineMarkdown(element);
  if (!text) return '';
  if (tag === 'a') {
    const href = element.getAttribute('href');
    return href ? `[${text}](${href})` : text;
  }
  if (tag === 'strong' || tag === 'b') return `**${text}**`;
  if (tag === 'em' || tag === 'i') return `*${text}*`;
  if (tag === 'code') return `\`${text.replace(/`/g, '\\`')}\``;
  if (tag === 'br') return '\n';
  return text;
}

function normalizeInlineText(value: string): string {
  return value.replace(/[ \t\r\n]+/g, ' ').trim();
}

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

  if (format === 'text') {
    return htmlToText(body);
  }
  return htmlToMarkdown(body);
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(
    stripHtmlTags(addBlockBreaks(stripNonContentHtml(html))).replace(/\s+/g, ' ')
  ).trim();
}

function htmlToMarkdown(html: string): string {
  const codeBlocks: string[] = [];
  let working = stripNonContentHtml(html);

  working = working.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, inner: string) => {
    const index = codeBlocks.length;
    const code = decodeHtmlEntities(stripHtmlTags(inner)).trimEnd();
    codeBlocks.push(code);
    return `\n\n@@AEGIS_CODE_BLOCK_${index}@@\n\n`;
  });

  working = working.replace(/<br\s*\/?>/gi, '\n');
  working = working.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level: string, inner: string) => {
    const text = inlineHtmlToMarkdown(inner);
    return text ? `\n\n${'#'.repeat(Number(level))} ${text}\n\n` : '\n\n';
  });
  working = working.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_match, inner: string) => {
    const text = inlineHtmlToMarkdown(inner);
    return text ? `\n- ${text}\n` : '\n';
  });
  working = working.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_match, inner: string) => {
    const text = htmlToText(inner);
    if (!text) return '\n\n';
    return `\n\n${text.split('\n').map((line) => `> ${line}`).join('\n')}\n\n`;
  });
  working = addBlockBreaks(working);
  working = inlineHtmlToMarkdown(working);
  working = stripHtmlTags(working);
  working = decodeHtmlEntities(working);

  working = working.replace(/@@AEGIS_CODE_BLOCK_(\d+)@@/g, (_match, index: string) => {
    const code = codeBlocks[Number(index)] || '';
    return code ? `\n\n\`\`\`\n${code}\n\`\`\`\n\n` : '';
  });

  return cleanupMarkdown(working);
}

function stripNonContentHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!doctype[^>]*>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, ' ')
    .replace(/<embed\b[^>]*>[\s\S]*?<\/embed>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<meta\b[^>]*>/gi, ' ')
    .replace(/<link\b[^>]*>/gi, ' ');
}

function addBlockBreaks(html: string): string {
  return html
    .replace(/<\/?(?:article|aside|body|div|footer|form|header|hr|main|nav|ol|p|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi, '\n\n');
}

function inlineHtmlToMarkdown(html: string): string {
  let output = html;
  output = output.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_match, attrs: string, inner: string) => {
    const text = normalizeInlineText(decodeHtmlEntities(stripHtmlTags(inlineHtmlToMarkdown(inner))));
    const href = extractHtmlAttribute(attrs, 'href');
    return text && href ? `[${text}](${decodeHtmlEntities(href)})` : text;
  });
  output = output.replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, (_match, inner: string) => {
    const text = normalizeInlineText(decodeHtmlEntities(stripHtmlTags(inlineHtmlToMarkdown(inner))));
    return text ? `**${text}**` : '';
  });
  output = output.replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, (_match, inner: string) => {
    const text = normalizeInlineText(decodeHtmlEntities(stripHtmlTags(inlineHtmlToMarkdown(inner))));
    return text ? `*${text}*` : '';
  });
  output = output.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_match, inner: string) => {
    const text = decodeHtmlEntities(stripHtmlTags(inner)).replace(/\s+/g, ' ').trim();
    return text ? `\`${text.replace(/`/g, '\\`')}\`` : '';
  });
  return output;
}

function extractHtmlAttribute(attrs: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const match = pattern.exec(attrs);
  return match?.[1] || match?.[2] || match?.[3] || null;
}

function stripHtmlTags(value: string): string {
  return value.replace(/<[^>]+>/g, ' ');
}

function cleanupMarkdown(value: string): string {
  return value
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');
}

function normalizeInlineText(value: string): string {
  return value.replace(/[ \t\r\n]+/g, ' ').trim();
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: '&',
    apos: "'",
    cent: '¢',
    copy: '©',
    emdash: '—',
    endash: '–',
    gt: '>',
    hellip: '…',
    laquo: '«',
    ldquo: '“',
    lsaquo: '‹',
    lsquo: '‘',
    lt: '<',
    nbsp: ' ',
    quot: '"',
    raquo: '»',
    rdquo: '”',
    rsaquo: '›',
    rsquo: '’',
    reg: '®',
    trade: '™',
  };

  return value.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (entity, body: string) => {
    if (body[0] === '#') {
      const isHex = body[1]?.toLowerCase() === 'x';
      const codePoint = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    return namedEntities[body.toLowerCase()] || entity;
  });
}

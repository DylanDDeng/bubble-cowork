import { extractProjectFileMentions } from './project-file-mentions';

type ProjectFilePreview =
  | {
      kind: 'text' | 'markdown' | 'html';
      path: string;
      name: string;
      ext: string;
      size: number;
      text: string;
      editable?: boolean;
    }
  | {
      kind: 'image' | 'pdf' | 'pptx' | 'binary' | 'unsupported' | 'too_large' | 'error';
      path: string;
      name: string;
      ext: string;
      size?: number;
      maxBytes?: number;
      message?: string;
    };

const MAX_MENTION_FILES = 6;
const MAX_FILE_CHARS = 6000;

function normalizeIgnoredMentionPath(value: string): string {
  return value.trim().replace(/[.,!?;:]+$/g, '').toLowerCase();
}

function inferCodeFenceLanguage(ext: string): string {
  const normalized = ext.replace(/^\./, '').toLowerCase();
  const map: Record<string, string> = {
    ts: 'ts',
    tsx: 'tsx',
    js: 'js',
    jsx: 'jsx',
    json: 'json',
    md: 'md',
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    yml: 'yaml',
    yaml: 'yaml',
    xml: 'xml',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    sh: 'bash',
    sql: 'sql',
    toml: 'toml',
    ini: 'ini',
  };
  return map[normalized] || '';
}

function trimContextContent(text: string): string {
  const normalized = text.trim();
  if (normalized.length <= MAX_FILE_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_FILE_CHARS).trimEnd()}\n\n...[truncated]`;
}

function buildPreviewSection(mentionPath: string, preview: ProjectFilePreview): string {
  if (preview.kind === 'text' || preview.kind === 'markdown' || preview.kind === 'html') {
    const language = inferCodeFenceLanguage(preview.ext);
    const trimmed = trimContextContent(preview.text);
    return `File: ${mentionPath}\n\`\`\`${language}\n${trimmed}\n\`\`\``;
  }

  if (preview.kind === 'too_large') {
    return `File: ${mentionPath}\n[Skipped: file is too large to inline safely.]`;
  }

  if (preview.kind === 'image') {
    return `File: ${mentionPath}\n[Referenced image file: not inlined into text context.]`;
  }

  if (preview.kind === 'pdf' || preview.kind === 'pptx') {
    return `File: ${mentionPath}\n[Referenced ${preview.kind.toUpperCase()} file: not inlined into text context.]`;
  }

  if (preview.kind === 'binary' || preview.kind === 'unsupported') {
    return `File: ${mentionPath}\n[Referenced binary or unsupported file type: not inlined.]`;
  }

  return `File: ${mentionPath}\n[Failed to resolve file: ${preview.message || 'Unknown error'}]`;
}

export async function buildPromptWithProjectFileMentions(params: {
  cwd?: string | null;
  prompt: string;
  ignoredMentionPaths?: string[];
}): Promise<string> {
  const cwd = params.cwd?.trim();
  const prompt = params.prompt.trim();
  if (!cwd || !prompt) {
    return prompt;
  }

  const ignoredMentionPaths = new Set(
    (params.ignoredMentionPaths || []).map(normalizeIgnoredMentionPath).filter(Boolean)
  );
  const uniqueMentions = Array.from(
    new Map(
      extractProjectFileMentions(prompt)
        .filter((mention) => !ignoredMentionPaths.has(normalizeIgnoredMentionPath(mention.path)))
        .slice(0, MAX_MENTION_FILES)
        .map((mention) => [mention.path, mention])
    ).values()
  );

  if (uniqueMentions.length === 0) {
    return prompt;
  }

  const previews = await Promise.all(
    uniqueMentions.map(async (mention) => {
      try {
        const preview = (await window.electron.readProjectFilePreview(
          cwd,
          mention.path
        )) as ProjectFilePreview;
        return buildPreviewSection(mention.path, preview);
      } catch (error) {
        return `File: ${mention.path}\n[Failed to resolve file: ${String(error)}]`;
      }
    })
  );

  const contextBlock = previews.filter(Boolean).join('\n\n');
  if (!contextBlock) {
    return prompt;
  }

  return [
    'Referenced project files:',
    contextBlock,
    '',
    'User prompt:',
    prompt,
  ].join('\n');
}

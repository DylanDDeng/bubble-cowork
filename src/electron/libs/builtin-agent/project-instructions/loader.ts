import { existsSync, lstatSync, readFileSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, relative, resolve, sep } from 'path';
import type {
  ProjectInstructionDocument,
  ProjectInstructionOmission,
  ProjectInstructionSource,
  ProjectInstructionRenderLimits,
} from './types';

export const AEGIS_GLOBAL_INSTRUCTIONS_PATH = join(homedir(), '.aegis', 'AGENTS.md');
export const PROJECT_INSTRUCTIONS_FILENAME = 'AGENTS.md';

export const DEFAULT_PROJECT_INSTRUCTION_LIMITS: ProjectInstructionRenderLimits = {
  maxFileChars: 16_384,
  maxTotalChars: 32_768,
  maxDocuments: 8,
};

export interface LoadedInstructionDocument {
  document: ProjectInstructionDocument | null;
  omission?: ProjectInstructionOmission;
}

export function getProjectInstructionCandidatePath(directory: string): string {
  return join(directory, PROJECT_INSTRUCTIONS_FILENAME);
}

export function resolveProjectRoot(input: string): string {
  return resolve(input || process.cwd());
}

export function normalizeInstructionPath(value: string): string {
  return resolve(value);
}

export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && rel !== '..' && !rel.split(sep).includes('..'));
}

function truncateMiddle(value: string, maxChars: number): { content: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { content: value, truncated: false };
  }
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head - 96;
  return {
    content: [
      value.slice(0, head).trimEnd(),
      '',
      `[AGENTS.md truncated: omitted ${value.length - head - tail} chars]`,
      '',
      value.slice(-tail).trimStart(),
    ].join('\n'),
    truncated: true,
  };
}

function readInstructionText(filePath: string, maxFileChars: number): {
  content: string;
  bytes: number;
  truncated: boolean;
} {
  const buffer = readFileSync(filePath);
  if (buffer.includes(0)) {
    throw new Error('binary');
  }
  const raw = buffer.toString('utf-8').trim();
  const truncated = truncateMiddle(raw, maxFileChars);
  return {
    content: truncated.content,
    bytes: buffer.byteLength,
    truncated: truncated.truncated,
  };
}

function tryRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function loadInstructionDocument(input: {
  path: string;
  source: ProjectInstructionSource;
  scopePath: string;
  depth: number;
  projectRoot?: string;
  allowedRoot?: string;
  limits?: ProjectInstructionRenderLimits;
}): LoadedInstructionDocument {
  const limits = input.limits || DEFAULT_PROJECT_INSTRUCTION_LIMITS;
  const filePath = normalizeInstructionPath(input.path);
  const allowedRoot = input.allowedRoot ? normalizeInstructionPath(input.allowedRoot) : undefined;
  if (!existsSync(filePath)) {
    return { document: null };
  }

  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    return {
      document: null,
      omission: {
        path: filePath,
        reason: 'unreadable',
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    return {
      document: null,
      omission: { path: filePath, reason: 'unreadable', detail: 'not a regular file' },
    };
  }

  const realFile = tryRealpath(filePath);
  if (!realFile) {
    return {
      document: null,
      omission: { path: filePath, reason: 'unreadable', detail: 'failed to resolve real path' },
    };
  }
  if (allowedRoot) {
    const realAllowedRoot = tryRealpath(allowedRoot) || allowedRoot;
    if (!isPathInside(realAllowedRoot, realFile)) {
      return {
        document: null,
        omission: { path: filePath, reason: 'outside_scope', detail: `resolved outside ${realAllowedRoot}` },
      };
    }
  }

  try {
    const text = readInstructionText(realFile, limits.maxFileChars);
    if (!text.content.trim()) {
      return { document: null, omission: { path: filePath, reason: 'empty' } };
    }
    return {
      document: {
        source: input.source,
        path: filePath,
        scopePath: normalizeInstructionPath(input.scopePath),
        depth: input.depth,
        content: text.content,
        bytes: text.bytes,
        truncated: text.truncated,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      document: null,
      omission: {
        path: filePath,
        reason: message === 'binary' ? 'binary' : 'unreadable',
        detail: message === 'binary' ? 'file appears to be binary' : message,
      },
    };
  }
}

export function collectDirectoryChain(root: string, target: string): string[] {
  const resolvedRoot = resolveProjectRoot(root);
  const resolvedTarget = resolveProjectRoot(target);
  const targetDir = dirname(resolvedTarget);
  if (!isPathInside(resolvedRoot, targetDir)) {
    return [];
  }
  const rel = relative(resolvedRoot, targetDir);
  const parts = rel ? rel.split(sep).filter(Boolean) : [];
  const dirs = [resolvedRoot];
  let current = resolvedRoot;
  for (const part of parts) {
    current = join(current, part);
    dirs.push(current);
  }
  return dirs;
}

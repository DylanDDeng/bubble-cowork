import { createHash } from 'crypto';
import { promises as fsPromises } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import type { MemoryDocument, MemoryDocumentKind, MemoryWorkspace } from '../../shared/types';

const AEGIS_HOME = join(homedir(), '.aegis');
const ASSISTANT_ROOT = join(AEGIS_HOME, 'assistant');
const PROJECTS_ROOT = join(AEGIS_HOME, 'projects');

const ASSISTANT_DOC = {
  kind: 'assistant' as const,
  fileName: 'assistant.md',
  title: 'Assistant Memory',
  description: 'How the assistant should behave, communicate, and collaborate with you across all projects.',
  template: `# Assistant Memory

Use this file for the assistant's long-term persona, working style, and global rules.

## Guidance

- Describe how the assistant should generally communicate.
- Capture recurring rules that should apply in all projects.
- Keep instructions stable and high-signal.
`,
};

const USER_DOC = {
  kind: 'user' as const,
  fileName: 'user.md',
  title: 'User Memory',
  description: 'Stable facts and preferences about the user across future conversations.',
  template: `# User Memory

Use this file for stable user preferences, background, and long-term context.

## Manual Notes

- Add explicit user preferences here.
`,
};

const PROJECT_DOC = {
  kind: 'project' as const,
  fileName: 'project.md',
  title: 'Project Memory',
  description: 'Long-term context about the selected project, including conventions, decisions, and remembered facts.',
  template: (projectCwd: string) => `# Project Memory

Project: ${projectCwd}

Use this file for stable project context, conventions, decisions, and progress notes.

## Manual Notes

- Describe the project purpose, stack, and important conventions.
`,
};

async function ensureDir(dirPath: string): Promise<void> {
  await fsPromises.mkdir(dirPath, { recursive: true });
}

async function ensureFile(filePath: string, template: string): Promise<void> {
  try {
    await fsPromises.access(filePath);
  } catch {
    await ensureDir(dirname(filePath));
    await fsPromises.writeFile(filePath, template, 'utf8');
  }
}

function hashProjectPath(projectCwd: string): string {
  return createHash('sha256').update(projectCwd).digest('hex').slice(0, 16);
}

function getProjectMemoryDir(projectCwd: string): string {
  return join(PROJECTS_ROOT, hashProjectPath(projectCwd));
}

async function readDocument(
  filePath: string,
  kind: MemoryDocumentKind,
  title: string,
  description: string,
  scope: 'personal' | 'project',
  projectCwd?: string | null
): Promise<MemoryDocument> {
  const stat = await fsPromises.stat(filePath);
  const content = await fsPromises.readFile(filePath, 'utf8');
  return {
    kind,
    scope,
    title,
    description,
    path: filePath,
    content,
    exists: true,
    updatedAt: stat.mtimeMs,
    projectCwd: projectCwd || undefined,
  };
}

export async function ensureMemoryWorkspace(projectCwd?: string | null): Promise<void> {
  await ensureDir(AEGIS_HOME);
  await ensureDir(ASSISTANT_ROOT);
  await ensureFile(join(ASSISTANT_ROOT, ASSISTANT_DOC.fileName), ASSISTANT_DOC.template);
  await ensureFile(join(ASSISTANT_ROOT, USER_DOC.fileName), USER_DOC.template);

  if (projectCwd?.trim()) {
    const normalized = resolve(projectCwd.trim());
    const projectDir = getProjectMemoryDir(normalized);
    await ensureDir(projectDir);
    await ensureFile(join(projectDir, PROJECT_DOC.fileName), PROJECT_DOC.template(normalized));
  }
}

export async function getMemoryWorkspace(projectCwd?: string | null): Promise<MemoryWorkspace> {
  const normalizedProjectCwd = projectCwd?.trim() ? resolve(projectCwd.trim()) : null;
  await ensureMemoryWorkspace(normalizedProjectCwd);

  const assistantPath = join(ASSISTANT_ROOT, ASSISTANT_DOC.fileName);
  const userPath = join(ASSISTANT_ROOT, USER_DOC.fileName);
  const projectRoot = normalizedProjectCwd ? getProjectMemoryDir(normalizedProjectCwd) : null;
  const projectPath = projectRoot ? join(projectRoot, PROJECT_DOC.fileName) : null;

  const assistantDocument = await readDocument(
    assistantPath,
    ASSISTANT_DOC.kind,
    ASSISTANT_DOC.title,
    ASSISTANT_DOC.description,
    'personal'
  );
  const userDocument = await readDocument(
    userPath,
    USER_DOC.kind,
    USER_DOC.title,
    USER_DOC.description,
    'personal'
  );
  const projectDocument =
    projectPath && normalizedProjectCwd
      ? await readDocument(
          projectPath,
          PROJECT_DOC.kind,
          PROJECT_DOC.title,
          PROJECT_DOC.description,
          'project',
          normalizedProjectCwd
        )
      : null;

  return {
    rootPath: AEGIS_HOME,
    assistantRoot: ASSISTANT_ROOT,
    projectRoot,
    projectCwd: normalizedProjectCwd,
    assistantDocument,
    userDocument,
    projectDocument,
  };
}

export async function saveMemoryDocument(filePath: string, content: string): Promise<MemoryDocument> {
  const resolvedPath = resolve(filePath);
  const workspaceRoot = resolve(AEGIS_HOME);
  if (!resolvedPath.startsWith(workspaceRoot + '/') && resolvedPath !== workspaceRoot) {
    throw new Error('Memory document path is outside the Aegis memory workspace.');
  }

  await ensureDir(dirname(resolvedPath));
  await fsPromises.writeFile(resolvedPath, content, 'utf8');
  const stat = await fsPromises.stat(resolvedPath);

  const kind: MemoryDocumentKind =
    basename(resolvedPath) === ASSISTANT_DOC.fileName
      ? 'assistant'
      : basename(resolvedPath) === USER_DOC.fileName
        ? 'user'
        : 'project';
  const scope = kind === 'project' ? 'project' : 'personal';

  return {
    kind,
    scope,
    title: kind === 'assistant' ? ASSISTANT_DOC.title : kind === 'user' ? USER_DOC.title : PROJECT_DOC.title,
    description:
      kind === 'assistant'
        ? ASSISTANT_DOC.description
        : kind === 'user'
          ? USER_DOC.description
          : PROJECT_DOC.description,
    path: resolvedPath,
    content,
    exists: true,
    updatedAt: stat.mtimeMs,
  };
}

function trimSection(content: string, maxChars: number): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  // Keep the HEAD (title/structure) and TAIL (newest content).
  // Memory files are append-only, so the most recent entries are at the bottom.
  const headSize = Math.min(400, Math.floor(maxChars * 0.2));
  const tailSize = maxChars - headSize - 30;
  const omitted = trimmed.length - headSize - tailSize;
  return `${trimmed.slice(0, headSize).trimEnd()}\n\n...[${omitted} chars omitted — use remember_get to read the full content]...\n\n${trimmed.slice(-tailSize).trimStart()}`;
}

export async function buildMemoryContext(projectCwd?: string | null): Promise<string> {
  const workspace = await getMemoryWorkspace(projectCwd);

  // Only inject the assistant identity file into system prompt (stable, small).
  // User memory and project memory are accessed via remember_get/remember_search
  // MCP tools to avoid growing system prompt overhead.
  const assistantContent = trimSection(workspace.assistantDocument.content, 1800);
  if (!assistantContent) {
    return '';
  }

  return [
    'Aegis assistant identity:',
    assistantContent,
  ].join('\n');
}

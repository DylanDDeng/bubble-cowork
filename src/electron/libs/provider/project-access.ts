import { isAbsolute } from 'node:path';
import { isWithinProjectPath } from '../project-paths';
import { getSessionProjectSources } from '../session-store';

/** Only structured, absolute paths qualify. Commands and display text are not paths. */
export function projectContainsPaths(threadId: string, cwd: string, paths: unknown): boolean {
  if (!Array.isArray(paths) || paths.length === 0) return false;
  const roots = getSessionProjectSources(threadId, cwd);
  return paths.every(path => typeof path === 'string' && isAbsolute(path)
    && roots.some(root => isWithinProjectPath(path, root)));
}

/** Called after Bubble's native deny rules, hooks and Plan gate. */
export function isProjectFileApproval(
  threadId: string, cwd: string, mode: string | undefined, request: { type: string } & Record<string, unknown>
): boolean {
  if (mode === 'plan') return false;
  if (request.type === 'write' || request.type === 'edit') {
    return projectContainsPaths(threadId, cwd, [request.path]);
  }
  if (request.type !== 'patch' || !Array.isArray(request.files) || !request.files.length) return false;
  // Check both native representations, including delete and move destinations.
  return projectContainsPaths(threadId, cwd, request.paths)
    && projectContainsPaths(threadId, cwd, request.files.map(file => file?.path));
}

/** OpenCode asks about a directory separately from the operation performed in it. */
export function isProjectDirectoryApproval(
  threadId: string, cwd: string, permission: unknown, patterns: unknown
): boolean {
  if (permission !== 'external_directory' || !Array.isArray(patterns) || !patterns.length) return false;
  const paths = patterns.map(pattern => {
    if (typeof pattern !== 'string') return undefined;
    const path = pattern.replace(/[/\\]\*{1,2}$/, '');
    // Unknown glob syntax stays interactive. Never grant an ancestor or sibling.
    return /[*?\[\]{}!]/.test(path) ? undefined : path;
  });
  return projectContainsPaths(threadId, cwd, paths);
}

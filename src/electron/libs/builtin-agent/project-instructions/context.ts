import { existsSync, statSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';
import type {
  ProjectInstructionDocument,
  ProjectInstructionOmission,
  ProjectInstructionRenderLimits,
  ProjectInstructionSnapshot,
} from './types';
import {
  AEGIS_GLOBAL_INSTRUCTIONS_PATH,
  DEFAULT_PROJECT_INSTRUCTION_LIMITS,
  collectDirectoryChain,
  getProjectInstructionCandidatePath,
  isPathInside,
  loadInstructionDocument,
  normalizeInstructionPath,
  resolveProjectRoot,
} from './loader';
import { renderProjectInstructionsSnapshot } from './render';

const MAX_ACTIVE_PATHS = 80;

export interface ProjectInstructionContextOptions {
  projectRoot: string;
  cwd?: string;
  limits?: Partial<ProjectInstructionRenderLimits>;
  globalInstructionsPath?: string;
}

export class ProjectInstructionContext {
  private readonly projectRoot: string;
  private readonly globalInstructionsPath: string;
  private readonly limits: ProjectInstructionRenderLimits;
  private cwd: string;
  private activePaths = new Set<string>();

  constructor(options: ProjectInstructionContextOptions) {
    this.projectRoot = resolveProjectRoot(options.projectRoot);
    this.cwd = resolveProjectRoot(options.cwd || options.projectRoot);
    this.globalInstructionsPath = normalizeInstructionPath(
      options.globalInstructionsPath || AEGIS_GLOBAL_INSTRUCTIONS_PATH
    );
    this.limits = {
      ...DEFAULT_PROJECT_INSTRUCTION_LIMITS,
      ...(options.limits || {}),
    };
  }

  setCwd(cwd: string): void {
    this.cwd = resolveProjectRoot(cwd || this.projectRoot);
  }

  recordPath(path: string | undefined | null): void {
    const normalized = this.normalizeProjectPath(path);
    if (normalized) {
      this.activePaths.add(normalized);
      while (this.activePaths.size > MAX_ACTIVE_PATHS) {
        const oldest = this.activePaths.values().next().value as string | undefined;
        if (!oldest) break;
        this.activePaths.delete(oldest);
      }
    }
  }

  recordPaths(paths: Array<string | undefined | null>): void {
    for (const path of paths) {
      this.recordPath(path);
    }
  }

  render(): ProjectInstructionSnapshot {
    const documents: ProjectInstructionDocument[] = [];
    const omissions: ProjectInstructionOmission[] = [];

    const global = loadInstructionDocument({
      path: this.globalInstructionsPath,
      source: 'global',
      scopePath: dirname(this.globalInstructionsPath),
      depth: -1,
      allowedRoot: dirname(this.globalInstructionsPath),
      limits: this.limits,
    });
    if (global.document) documents.push(global.document);
    if (global.omission) omissions.push(global.omission);

    const directories = this.collectInstructionDirectories();
    for (const directory of directories) {
      const depth = this.projectDepth(directory);
      const loaded = loadInstructionDocument({
        path: getProjectInstructionCandidatePath(directory),
        source: 'project',
        scopePath: directory,
        depth,
        projectRoot: this.projectRoot,
        allowedRoot: this.projectRoot,
        limits: this.limits,
      });
      if (loaded.document) documents.push(loaded.document);
      if (loaded.omission) omissions.push(loaded.omission);
    }

    return renderProjectInstructionsSnapshot(documents, omissions, this.limits);
  }

  private normalizeProjectPath(path: string | undefined | null): string | null {
    const raw = typeof path === 'string' ? path.trim() : '';
    if (!raw) return null;
    const absolute = resolve(this.projectRoot, raw);
    if (!isPathInside(this.projectRoot, absolute)) {
      return null;
    }
    return absolute;
  }

  private collectInstructionDirectories(): string[] {
    const dirs = new Map<string, string>();
    const addDir = (directory: string) => {
      const normalized = resolve(directory);
      if (isPathInside(this.projectRoot, normalized)) {
        dirs.set(normalized, normalized);
      }
    };

    for (const directory of collectDirectoryChain(this.projectRoot, join(this.cwd, '.aegis-current-context'))) {
      addDir(directory);
    }

    for (const path of this.activePaths) {
      for (const directory of this.collectPathDirectories(path)) {
        addDir(directory);
      }
    }

    return [...dirs.values()].sort((left, right) => (
      this.projectDepth(left) - this.projectDepth(right) || left.localeCompare(right)
    ));
  }

  private collectPathDirectories(path: string): string[] {
    let targetDirectory = dirname(path);
    try {
      if (existsSync(path) && statSync(path).isDirectory()) {
        targetDirectory = path;
      }
    } catch {
      targetDirectory = dirname(path);
    }

    if (!isPathInside(this.projectRoot, targetDirectory)) {
      return [];
    }
    const rel = relative(this.projectRoot, targetDirectory);
    const parts = rel ? rel.split(sep).filter(Boolean) : [];
    const dirs = [this.projectRoot];
    let current = this.projectRoot;
    for (const part of parts) {
      current = join(current, part);
      dirs.push(current);
    }
    return dirs;
  }

  private projectDepth(directory: string): number {
    const rel = relative(this.projectRoot, directory);
    return rel ? rel.split(sep).filter(Boolean).length : 0;
  }
}

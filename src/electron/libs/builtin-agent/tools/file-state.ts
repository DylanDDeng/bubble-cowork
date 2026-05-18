import { createHash } from 'crypto';
import { isAbsolute, relative, resolve } from 'path';
import { readFile, stat } from 'fs/promises';

export type FileObservationSource = 'read' | 'write' | 'edit';

export interface FileVersion {
  hash: string;
  mtimeMs: number;
  size: number;
}

interface ObservedFileState extends FileVersion {
  source: FileObservationSource;
  observedAt: number;
}

export type FileFreshnessResult =
  | { ok: true; version: FileVersion }
  | { ok: false; reason: 'unobserved' | 'missing' | 'changed'; observed?: FileVersion; current?: FileVersion };

export class FileStateTracker {
  private readonly observed = new Map<string, ObservedFileState>();

  constructor(private readonly cwd: string) {}

  async observe(filePath: string, source: FileObservationSource, content?: string): Promise<FileVersion> {
    const absolute = this.resolvePath(filePath);
    const version = await this.computeVersion(absolute, content);
    this.observed.set(absolute, { ...version, source, observedAt: Date.now() });
    return version;
  }

  async checkFresh(filePath: string): Promise<FileFreshnessResult> {
    const absolute = this.resolvePath(filePath);
    const observed = this.observed.get(absolute);
    if (!observed) {
      return { ok: false, reason: 'unobserved' };
    }

    let current: FileVersion;
    try {
      current = await this.computeVersion(absolute);
    } catch {
      return { ok: false, reason: 'missing', observed };
    }

    if (current.hash === observed.hash && current.size === observed.size) {
      return { ok: true, version: current };
    }
    return { ok: false, reason: 'changed', observed, current };
  }

  private resolvePath(filePath: string): string {
    return resolve(this.cwd, filePath);
  }

  private async computeVersion(filePath: string, content?: string): Promise<FileVersion> {
    const [stats, bytes] = await Promise.all([
      stat(filePath),
      content === undefined ? readFile(filePath) : Promise.resolve(Buffer.from(content, 'utf-8')),
    ]);
    return {
      hash: createHash('sha256').update(bytes).digest('hex'),
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    };
  }
}

export function isWithinWorkspace(cwd: string, filePath: string): boolean {
  const rel = relative(resolve(cwd), filePath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

import { execFile } from 'child_process';
import { basename } from 'path';
import type { TerminalCliKind } from '../../shared/terminal';

export interface ProcessEntry {
  pid: number;
  command: string;
}

const MAX_TREE_SIZE = 256;

function run(file: string, args: string[], timeout: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? null : stdout)
    );
  });
}

/**
 * Parent → children index built from one `ps` listing, so every terminal's
 * tree can be walked in memory on a poll tick.
 */
export class ProcessTable {
  private constructor(private readonly children: Map<number, ProcessEntry[]>) {}

  static parse(listing: string): ProcessTable {
    const children = new Map<number, ProcessEntry[]>();
    for (const line of listing.split('\n')) {
      const fields = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (!fields) continue;
      const pid = Number(fields[1]);
      const parent = Number(fields[2]);
      if (!pid) continue;
      const siblings = children.get(parent) ?? [];
      siblings.push({ pid, command: fields[3] });
      children.set(parent, siblings);
    }
    return new ProcessTable(children);
  }

  /** Null where `ps` is unavailable (Windows) or fails. */
  static async read(): Promise<ProcessTable | null> {
    if (process.platform === 'win32') return null;
    const listing = await run('ps', ['-axo', 'pid=,ppid=,comm='], 1500);
    return listing === null ? null : ProcessTable.parse(listing);
  }

  descendants(root: number): ProcessEntry[] {
    const found: ProcessEntry[] = [];
    const visited = new Set<number>([root]);
    const queue = [root];
    while (queue.length && found.length < MAX_TREE_SIZE) {
      for (const child of this.children.get(queue.shift()!) ?? []) {
        if (visited.has(child.pid)) continue;
        visited.add(child.pid);
        found.push(child);
        queue.push(child.pid);
      }
    }
    return found;
  }
}

/** Child-by-child walk with `pgrep -P` when a full listing is unavailable. */
async function descendantsByPgrep(root: number): Promise<ProcessEntry[]> {
  const found: ProcessEntry[] = [];
  const queue = [root];
  const visited = new Set<number>([root]);
  while (queue.length && found.length < MAX_TREE_SIZE) {
    const listing = await run('pgrep', ['-P', String(queue.shift()!)], 1000);
    for (const pid of (listing ?? '').split(/\s+/).map(Number)) {
      if (!pid || visited.has(pid)) continue;
      visited.add(pid);
      const command = ((await run('ps', ['-p', String(pid), '-o', 'comm='], 1000)) ?? '').trim();
      found.push({ pid, command });
      queue.push(pid);
    }
  }
  return found;
}

export async function descendantsOf(root: number, table?: ProcessTable | null): Promise<ProcessEntry[]> {
  if (process.platform === 'win32') return [];
  return table ? table.descendants(root) : descendantsByPgrep(root);
}

/** Windows has no cheap tree listing; only ask whether the shell has any child. */
export async function hasChildProcessWindows(pid: number): Promise<boolean> {
  const script = `if (Get-CimInstance Win32_Process -Filter "ParentProcessId = ${pid}" -ErrorAction SilentlyContinue) { 'yes' }`;
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 1000);
  return out?.trim() === 'yes';
}

/** Which agent CLI a process is, judged by its executable name. */
export function agentCliForCommand(command: string): TerminalCliKind | null {
  const name = basename(command).toLowerCase();
  for (const kind of ['claude', 'codex', 'opencode'] as const) {
    if (name.includes(kind)) return kind;
  }
  return null;
}

/**
 * Ends a shell and everything it started: SIGTERM to the whole tree, then
 * SIGKILL to whatever is left after `graceMs`. Windows uses taskkill /T.
 */
export async function terminateTree(pid: number, killShell: (signal?: string) => void, graceMs = 1000): Promise<void> {
  if (process.platform === 'win32') {
    await run('taskkill', ['/pid', String(pid), '/T', '/F'], 5000);
    try {
      killShell();
    } catch {
      // Already gone.
    }
    return;
  }
  const tree = [...(await descendantsOf(pid, await ProcessTable.read())).map((entry) => entry.pid), pid];
  const signal = (name: NodeJS.Signals) => {
    for (const target of tree) {
      try {
        process.kill(target, name);
      } catch {
        // Exited already.
      }
    }
  };
  signal('SIGTERM');
  setTimeout(() => {
    signal('SIGKILL');
    try {
      killShell('SIGKILL');
    } catch {
      // Exited already.
    }
  }, graceMs).unref?.();
}

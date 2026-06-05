import { app } from 'electron';
import { createHash } from 'crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export const DEFAULT_HISTORY_BYTE_LIMIT = 1024 * 1024;
export const DEFAULT_HISTORY_LINE_LIMIT = 5000;

export type TerminalHistoryLimits = {
  byteLimit?: number;
  lineLimit?: number;
};

function getHistoryRoot(): string {
  const explicit = process.env.AEGIS_TERMINAL_HISTORY_DIR?.trim();
  if (explicit) return explicit;
  try {
    if (app?.getPath) {
      return join(app.getPath('userData'), 'terminal-history');
    }
  } catch {
    // Tests can import this module outside the Electron runtime.
  }
  return join(tmpdir(), 'aegis-terminal-history');
}

function ensureHistoryRoot(): string {
  const root = getHistoryRoot();
  if (existsSync(root)) {
    const stats = lstatSync(root);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Terminal history path is not a directory: ${root}`);
    }
  } else {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  return root;
}

function historyFileName(threadId: string, terminalId: string): string {
  const digest = createHash('sha256').update(`${threadId}\0${terminalId}`).digest('hex');
  return `${digest}.log`;
}

export function getTerminalHistoryPath(threadId: string, terminalId: string): string {
  return join(ensureHistoryRoot(), historyFileName(threadId, terminalId));
}

function trimToLineLimit(value: string, lineLimit: number): string {
  if (lineLimit <= 0) return '';
  const lines = value.split('\n');
  if (lines.length <= lineLimit) return value;
  return lines.slice(lines.length - lineLimit).join('\n');
}

function dropLeadingEscapeFragment(value: string): string {
  const firstEsc = value.indexOf('\x1b');
  if (firstEsc < 0) return value;
  const prefix = value.slice(0, firstEsc);
  if (/^[\x00-\x1f\x7f0-?;:!"#$%&'()*+,\-./\d\s]*$/.test(prefix)) {
    return value.slice(firstEsc);
  }
  return value;
}

function dropIncompleteLeadingControl(value: string): string {
  if (!value) return value;
  const embeddedHookIndex = value.indexOf('AEGIS_AGENT_EVENT=');
  if (embeddedHookIndex >= 0) {
    const beforeHook = value.slice(0, embeddedHookIndex);
    if (!beforeHook.includes('\n')) {
      const bel = value.indexOf('\x07', embeddedHookIndex);
      const st = value.indexOf('\x1b\\', embeddedHookIndex);
      const end =
        bel >= 0 && st >= 0 ? Math.min(bel + 1, st + 2) : bel >= 0 ? bel + 1 : st >= 0 ? st + 2 : -1;
      if (end >= 0) {
        return value.slice(end);
      }
    }
  }
  if (value.startsWith('\x1b]')) {
    const bel = value.indexOf('\x07');
    const st = value.indexOf('\x1b\\');
    const end =
      bel >= 0 && st >= 0 ? Math.min(bel + 1, st + 2) : bel >= 0 ? bel + 1 : st >= 0 ? st + 2 : -1;
    return end >= 0 ? value.slice(end) : '';
  }
  if (value.startsWith('\x1b[')) {
    const match = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(value);
    return match ? value : value.replace(/^\x1b\[[0-?]*[ -/]*/, '');
  }
  if (value.charCodeAt(0) === 0xfffd) {
    return value.slice(1);
  }
  return dropLeadingEscapeFragment(value);
}

export function capHistoryByLimits(value: string, limits: TerminalHistoryLimits = {}): string {
  const byteLimit = Math.max(0, limits.byteLimit ?? DEFAULT_HISTORY_BYTE_LIMIT);
  const lineLimit = Math.max(0, limits.lineLimit ?? DEFAULT_HISTORY_LINE_LIMIT);

  let output = trimToLineLimit(value, lineLimit);
  if (byteLimit === 0) return '';

  let buffer = Buffer.from(output, 'utf8');
  if (buffer.length > byteLimit) {
    buffer = buffer.subarray(buffer.length - byteLimit);
    output = buffer.toString('utf8');
    output = dropIncompleteLeadingControl(output);
  }

  return output;
}

export function readTerminalHistory(threadId: string, terminalId: string, limits?: TerminalHistoryLimits): string {
  const filePath = getTerminalHistoryPath(threadId, terminalId);
  if (!existsSync(filePath)) return '';
  try {
    return capHistoryByLimits(readFileSync(filePath, 'utf8'), limits);
  } catch {
    return '';
  }
}

export function writeTerminalHistory(
  threadId: string,
  terminalId: string,
  history: string,
  limits?: TerminalHistoryLimits
): string {
  const capped = capHistoryByLimits(history, limits);
  const filePath = getTerminalHistoryPath(threadId, terminalId);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, capped, { mode: 0o600 });
  renameSync(tempPath, filePath);
  return capped;
}

export function deleteTerminalHistory(threadId: string, terminalId?: string): void {
  if (!terminalId) {
    return;
  }
  const filePath = getTerminalHistoryPath(threadId, terminalId);
  try {
    rmSync(filePath, { force: true });
  } catch {
    // ignore missing history
  }
}

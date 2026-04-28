import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { promisify } from 'util';
import type {
  AgentProvider,
  AgentRunWorkspaceMode,
} from '../../shared/types';

const execFileAsync = promisify(execFile);

export interface BoardWorkflowConfig {
  path: string | null;
  defaultProvider?: AgentProvider;
  defaultModel?: string;
  workspaceMode?: AgentRunWorkspaceMode;
  beforeRunCommand?: string;
  validateCommand?: string;
  requireValidationPassed?: boolean;
}

export interface WorkflowCommandResult {
  ok: boolean;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  summary: string;
}

function normalizeScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function extractFrontMatter(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return normalized;
  }
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) {
    return normalized;
  }
  return normalized.slice(4, end);
}

function parseWorkflowContent(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  let section: string | null = null;

  for (const rawLine of extractFrontMatter(content).split('\n')) {
    const withoutComment = rawLine.replace(/\s+#.*$/, '');
    if (!withoutComment.trim()) continue;

    const topLevelSection = withoutComment.match(/^([A-Za-z0-9_-]+):\s*$/);
    if (topLevelSection) {
      section = topLevelSection[1].trim();
      continue;
    }

    const nested = withoutComment.match(/^\s+([A-Za-z0-9_-]+):\s*(.+)$/);
    if (nested && section) {
      values[`${section}.${nested[1].trim()}`] = normalizeScalar(nested[2]);
      continue;
    }

    const topLevelValue = withoutComment.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (topLevelValue) {
      values[topLevelValue[1].trim()] = normalizeScalar(topLevelValue[2]);
      section = null;
    }
  }

  return values;
}

function normalizeProvider(value?: string): AgentProvider | undefined {
  if (value === 'codex' || value === 'opencode' || value === 'claude') {
    return value;
  }
  return undefined;
}

function normalizeWorkspaceMode(value?: string): AgentRunWorkspaceMode | undefined {
  if (value === 'isolated' || value === 'current_cwd') {
    return value;
  }
  if (value === 'current' || value === 'cwd') {
    return 'current_cwd';
  }
  return undefined;
}

function normalizeBoolean(value?: string): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === 'yes' || normalized === '1') return true;
  if (normalized === 'false' || normalized === 'no' || normalized === '0') return false;
  return undefined;
}

export function loadBoardWorkflow(cwd: string): BoardWorkflowConfig {
  const workflowPath = findBoardWorkflowPath(cwd);
  if (!workflowPath) {
    return { path: null };
  }

  let values: Record<string, string>;
  try {
    values = parseWorkflowContent(readFileSync(workflowPath, 'utf8'));
  } catch {
    return { path: workflowPath };
  }
  return {
    path: workflowPath,
    defaultProvider: normalizeProvider(values['agent.default_provider']),
    defaultModel: values['agent.default_model'],
    workspaceMode: normalizeWorkspaceMode(values['workspace.mode']),
    beforeRunCommand: values['hooks.before_run'],
    validateCommand: values['hooks.validate'],
    requireValidationPassed: normalizeBoolean(values['review.require_validation_passed']),
  };
}

function findBoardWorkflowPath(cwd: string): string | null {
  let current = resolve(cwd);
  for (let depth = 0; depth < 8; depth += 1) {
    const workflowPath = join(current, '.aegis', 'WORKFLOW.md');
    if (existsSync(workflowPath)) {
      return workflowPath;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function summarizeCommandOutput(stdout: string, stderr: string): string {
  const combined = `${stdout}\n${stderr}`
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (combined.length === 0) {
    return 'Command produced no output';
  }
  return combined.slice(-3).join(' | ').slice(0, 280);
}

function getErrorExitCode(error: unknown): number | null {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'number' ? code : null;
  }
  return null;
}

function getErrorOutput(error: unknown, key: 'stdout' | 'stderr'): string {
  if (error && typeof error === 'object' && key in error) {
    return String((error as Record<string, unknown>)[key] ?? '');
  }
  return '';
}

export async function runWorkflowCommand(
  command: string,
  cwd: string,
  timeoutMs = 10 * 60 * 1000
): Promise<WorkflowCommandResult> {
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const { stdout, stderr } = await execFileAsync(shell, ['-lc', command], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      ok: true,
      command,
      stdout,
      stderr,
      exitCode: 0,
      summary: summarizeCommandOutput(stdout, stderr),
    };
  } catch (error) {
    const stdout = getErrorOutput(error, 'stdout');
    const stderr = getErrorOutput(error, 'stderr');
    return {
      ok: false,
      command,
      stdout,
      stderr,
      exitCode: getErrorExitCode(error),
      summary: summarizeCommandOutput(stdout, stderr),
    };
  }
}

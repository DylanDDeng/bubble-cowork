import { execFile } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { app } from 'electron';
import { join } from 'path';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import type { AgentRunWorkspaceMode } from '../../shared/types';

const execFileAsync = promisify(execFile);

export interface BoardRunWorkspace {
  mode: AgentRunWorkspaceMode;
  cwd: string;
  baseCwd: string;
  workspacePath?: string;
  branch?: string;
}

export interface PrepareBoardRunWorkspaceInput {
  baseCwd: string;
  taskId: string;
  taskTitle: string;
  mode: AgentRunWorkspaceMode;
}

function slugifyBranchPart(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42);
  return slug || 'task';
}

async function getGitRoot(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function createIsolatedWorktree(input: PrepareBoardRunWorkspaceInput): Promise<BoardRunWorkspace> {
  const gitRoot = await getGitRoot(input.baseCwd);
  const workspaceId = uuidv4().slice(0, 8);
  const taskSlug = `${slugifyBranchPart(input.taskTitle)}-${input.taskId.slice(0, 6)}`;
  const branch = `aegis/${taskSlug}-${workspaceId}`;
  const baseDir = join(app.getPath('userData'), 'board-workspaces');
  const workspacePath = join(baseDir, `${taskSlug}-${workspaceId}`);

  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true });
  }

  await execFileAsync('git', ['worktree', 'add', '-b', branch, workspacePath, 'HEAD'], {
    cwd: gitRoot,
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  });

  return {
    mode: 'isolated',
    cwd: workspacePath,
    baseCwd: input.baseCwd,
    workspacePath,
    branch,
  };
}

export async function prepareBoardRunWorkspace(
  input: PrepareBoardRunWorkspaceInput
): Promise<BoardRunWorkspace> {
  if (input.mode === 'current_cwd') {
    return {
      mode: 'current_cwd',
      cwd: input.baseCwd,
      baseCwd: input.baseCwd,
    };
  }

  return createIsolatedWorktree(input);
}

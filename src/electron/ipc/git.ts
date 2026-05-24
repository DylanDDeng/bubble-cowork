/**
 * Git 模块
 *
 * 所有 Git 相关的操作：状态、差异、分支、提交、同步等。
 */

import { ipcMainHandle } from '../util'
import { IPCHandlerContext } from './context'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { basename } from 'path'

const execFileAsync = promisify(execFile)

// --- Git Helper Functions ---

type GitChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflict'

const mapGitChangeStatus = (status: string): GitChangeStatus => {
  if (status === '??' || status === '!!') return 'untracked'
  if (status === 'A ' || status === 'AM') return 'added'
  if (status.startsWith('D')) return 'deleted'
  if (status.startsWith('R')) return 'renamed'
  if (status === 'UU' || status === 'AA' || status === 'DD') return 'conflict'
  return 'modified'
}

interface GitStatusEntry {
  path: string
  status: GitChangeStatus
  staged: boolean
}

function parseGitStatusEntries(porcelain: string): GitStatusEntry[] {
  const lines = porcelain.split('\n').filter((l) => l.trim())
  const entries: GitStatusEntry[] = []
  for (const line of lines) {
    const indexStatus = line[0]
    const worktreeStatus = line[1]
    const filePath = line.slice(3)
    if (indexStatus !== ' ' && indexStatus !== '?') {
      entries.push({
        path: filePath,
        status: mapGitChangeStatus(indexStatus + worktreeStatus),
        staged: true,
      })
    }
    if (worktreeStatus !== ' ' && worktreeStatus !== undefined) {
      const isUnmerged = indexStatus === 'U'
      entries.push({
        path: filePath,
        status: isUnmerged ? 'conflict' : mapGitChangeStatus(' ' + worktreeStatus),
        staged: false,
      })
    }
  }
  return entries
}

function parseGitNumstat(numstat: string): { additions: number; deletions: number; path: string }[] {
  const results: { additions: number; deletions: number; path: string }[] = []
  const lines = numstat.split('\n').filter((l) => l.trim())
  for (const line of lines) {
    const parts = line.split('\t')
    if (parts.length < 3) continue
    results.push({
      additions: parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0,
      deletions: parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0,
      path: parts[2],
    })
  }
  return results
}

function inferCommitTarget(diff: string): string {
  const parts = diff.split('\n')
  for (const line of parts.slice(0, 10)) {
    const p = line.replace(/^diff --git a\//, '').replace(/ b\/.*/, '')
    if (p && !p.startsWith('.')) return basename(p)
  }
  return 'changes'
}

function inferCommitType(subject: string): string {
  const lowered = subject.toLowerCase()
  if (lowered.startsWith('fix') || lowered.startsWith('bug')) return 'fix'
  if (lowered.startsWith('add') || lowered.startsWith('feat')) return 'feat'
  if (lowered.startsWith('refactor')) return 'refactor'
  if (lowered.startsWith('chore')) return 'chore'
  if (lowered.startsWith('style')) return 'style'
  if (lowered.startsWith('docs')) return 'docs'
  if (lowered.startsWith('test')) return 'test'
  return 'chore'
}

function trimCommitSubject(subject: string): string {
  const colonIdx = subject.indexOf(':')
  if (colonIdx > 0 && colonIdx < 20) {
    let suffix = subject.slice(colonIdx + 1).trim()
    suffix = suffix.charAt(0).toLowerCase() + suffix.slice(1)
    suffix = suffix.replace(/\.$/, '')
    if (suffix.length <= 72) return suffix
  }
  return subject.replace(/\.$/, '').slice(0, 72)
}

async function generateCommitMessageFromGitChanges(
  cwd: string,
  stagedOnly: boolean
): Promise<{ subject: string; body: string } | null> {
  const stagedArg = stagedOnly ? '--cached' : ''
  let diff = ''
  let stat = ''
  try {
    const { stdout: d } = await execFileAsync('git', ['diff', stagedArg, '--unified=3'], { cwd })
    diff = d
    const { stdout: s } = await execFileAsync('git', ['diff', stagedArg, '--stat'], { cwd })
    stat = s
  } catch {
    return null
  }

  if (!diff.trim()) {
    return { subject: 'chore: update project files', body: '' }
  }

  const target = inferCommitTarget(diff)
  const type = inferCommitType(diff)

  const statLines = stat.split('\n')
  const summary = statLines[statLines.length - 2] || ''
  const firstDiffLine = diff.split('\n')[0] || ''

  const subject = `${type}: update ${target}`
  const body = [firstDiffLine, summary].filter(Boolean).join('\n')

  return { subject: trimCommitSubject(subject), body }
}

// --- Registration ---

export function register(_ctx: IPCHandlerContext): void {
  ipcMainHandle('get-git-changes', async (_event, cwd: string) => {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd })
    return { entries: parseGitStatusEntries(stdout) }
  })

  ipcMainHandle('git-generate-commit-message', async (_event, cwd: string, stagedOnly: boolean) => {
    return generateCommitMessageFromGitChanges(cwd, stagedOnly)
  })

  ipcMainHandle('get-git-working-tree-summary', async (_event, cwd: string) => {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd })
    return { entries: parseGitStatusEntries(stdout) }
  })

  ipcMainHandle('get-git-overview', async (_event, cwd: string) => {
    const [branch, status, log] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }).then((r) => r.stdout.trim()),
      execFileAsync('git', ['status', '--short'], { cwd }).then((r) => r.stdout.trim()),
      execFileAsync('git', ['log', '--oneline', '-20'], { cwd }).then((r) => r.stdout.trim()),
    ])
    return { branch, status, log }
  })

  ipcMainHandle('get-git-diff', async (_event, cwd: string, stagedOnly?: boolean) => {
    const args = stagedOnly ? ['--cached'] : []
    const { stdout } = await execFileAsync('git', ['diff', ...args], { cwd })
    return { diff: stdout }
  })

  ipcMainHandle('get-git-branch', async (_event, cwd: string) => {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
    return stdout.trim()
  })

  ipcMainHandle('get-git-branches', async (_event, cwd: string) => {
    const { stdout } = await execFileAsync('git', ['branch', '-a'], { cwd })
    return stdout
      .split('\n')
      .map((l) => l.replace(/^\*?\s*/, '').replace('remotes/origin/', ''))
      .filter(Boolean)
  })

  ipcMainHandle('git-checkout-branch', async (_event, cwd: string, branch: string) => {
    const { stdout, stderr } = await execFileAsync('git', ['checkout', branch], { cwd })
    return { ok: true, message: stdout || stderr }
  })

  ipcMainHandle('get-git-history', async (_event, cwd: string, limit?: number) => {
    const { stdout } = await execFileAsync('git', ['log', '--oneline', `-${limit || 50}`], { cwd })
    return stdout.split('\n').filter(Boolean)
  })

  ipcMainHandle('git-stage-path', async (_event, cwd: string, filePath: string) => {
    await execFileAsync('git', ['add', filePath], { cwd })
    return { ok: true }
  })

  ipcMainHandle('git-unstage-path', async (_event, cwd: string, filePath: string) => {
    await execFileAsync('git', ['reset', 'HEAD', '--', filePath], { cwd })
    return { ok: true }
  })

  ipcMainHandle('git-discard-path', async (_event, cwd: string, filePath: string) => {
    await execFileAsync('git', ['checkout', '--', filePath], { cwd })
    return { ok: true }
  })

  ipcMainHandle('git-commit', async (_event, cwd: string, subject: string, body?: string) => {
    const args = ['commit', '-m', subject]
    if (body) args.push('-m', body)
    const { stdout, stderr } = await execFileAsync('git', args, { cwd })
    return { ok: true, message: stdout || stderr }
  })

  ipcMainHandle('git-push', async (_event, cwd: string) => {
    const { stdout, stderr } = await execFileAsync('git', ['push'], { cwd })
    return { ok: true, message: stdout || stderr }
  })

  ipcMainHandle('git-sync', async (_event, cwd: string) => {
    // pull --rebase then push
    const pull = await execFileAsync('git', ['pull', '--rebase'], { cwd })
    const push = await execFileAsync('git', ['push'], { cwd })
    return { ok: true, message: [pull.stdout, push.stdout].filter(Boolean).join('\n') }
  })

  ipcMainHandle('git-create-pr', async (_event, cwd: string, title: string, body?: string) => {
    try {
      const args = ['pr', 'create', '--title', title]
      if (body) args.push('--body', body)
      const { stdout } = await execFileAsync('gh', args, { cwd })
      return { ok: true, url: stdout.trim() }
    } catch (err: any) {
      return { ok: false, message: (err.stderr || err.message || 'Unknown error').trim() }
    }
  })
}

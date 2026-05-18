import type { BuiltinToolDefinition, BuiltinToolResult } from '../types';
import { analyzeBuiltinToolIntent, type BuiltinToolFamily, type BuiltinToolIntent } from './tool-intent';

type BuiltinTaskType =
  | 'implementation'
  | 'debugging'
  | 'code_review'
  | 'repo_orientation'
  | 'security_investigation'
  | 'product_discussion'
  | 'general';

interface GovernorBudget {
  softTotalSteps: number;
  softSearchSteps: number;
  softReadSteps: number;
  warningExactRepeats: number;
  warningFamilyRepeats: number;
}

interface ToolObservation {
  family: BuiltinToolFamily;
  signature?: string;
  familyKey?: string;
  progress: boolean;
  mutationVersion: number;
}

export interface GovernorDecision {
  blockedResult?: BuiltinToolResult;
}

const BUDGETS: Record<BuiltinTaskType, GovernorBudget> = {
  implementation: { softTotalSteps: 18, softSearchSteps: 8, softReadSteps: 6, warningExactRepeats: 1, warningFamilyRepeats: 3 },
  debugging: { softTotalSteps: 18, softSearchSteps: 8, softReadSteps: 7, warningExactRepeats: 1, warningFamilyRepeats: 3 },
  code_review: { softTotalSteps: 14, softSearchSteps: 6, softReadSteps: 8, warningExactRepeats: 2, warningFamilyRepeats: 3 },
  repo_orientation: { softTotalSteps: 12, softSearchSteps: 6, softReadSteps: 8, warningExactRepeats: 2, warningFamilyRepeats: 3 },
  security_investigation: { softTotalSteps: 14, softSearchSteps: 6, softReadSteps: 8, warningExactRepeats: 2, warningFamilyRepeats: 2 },
  product_discussion: { softTotalSteps: 10, softSearchSteps: 4, softReadSteps: 4, warningExactRepeats: 2, warningFamilyRepeats: 2 },
  general: { softTotalSteps: 18, softSearchSteps: 8, softReadSteps: 10, warningExactRepeats: 2, warningFamilyRepeats: 3 },
};

export class BuiltinExecutionGovernor {
  private readonly budget: GovernorBudget;
  private history: ToolObservation[] = [];
  private totalSteps = 0;
  private searchSteps = 0;
  private readSteps = 0;
  private mutationVersion = 0;
  private reminders: string[] = [];
  private warnedKeys = new Set<string>();
  private warnedFamilies = new Set<string>();
  private softTotalWarned = false;
  private softSearchWarned = false;
  private softReadWarned = false;

  constructor(taskType: BuiltinTaskType) {
    this.budget = BUDGETS[taskType] || BUDGETS.general;
    if (taskType === 'implementation' || taskType === 'debugging') {
      this.reminders.push(buildReminder(
        'For multi-step coding work, keep an explicit todo_write list current: create it before the first substantial edit, update the active item as work moves, and mark items completed as they finish.'
      ));
    }
    if (taskType === 'security_investigation') {
      this.reminders.push(buildReminder(
        'Security/configuration investigation workflow is active. First map config surfaces, then inspect the specific provider/runtime paths, and avoid repeated broad secret searches unless a new concrete path is being tested.'
      ));
    }
  }

  consumePendingReminders(): string[] {
    const next = [...this.reminders];
    this.reminders.length = 0;
    return next;
  }

  filterToolDefinitions<T extends BuiltinToolDefinition>(tools: T[]): T[] {
    return tools;
  }

  beforeToolCall(name: string, args: Record<string, unknown>): GovernorDecision {
    const intent = analyzeBuiltinToolIntent({ name, args });

    if (intent.family === 'read') {
      const signature = intent.read?.signature;
      if (signature && this.hasCurrentMutationObservation((entry) => entry.signature === signature)) {
        this.warnOnce(`read:${signature}`, 'This exact file range was already read since the last successful edit/write. If the content is still available and nothing changed, use the prior result; otherwise re-read only to recover context or verify a change.');
      }
    }

    if (intent.family === 'search') {
      const signature = intent.search?.signature;
      const familyKey = intent.search?.familyKey;
      if (signature && this.trailingNoProgressCount((entry) => entry.signature === signature) >= this.budget.warningExactRepeats) {
        this.warnOnce(`search:${signature}`, 'This search is very similar to one you already ran and it did not produce new evidence. Change the query/path, follow a concrete lead, or summarize the strongest findings.');
      }
      if (familyKey) {
        const noProgress = this.trailingNoProgressCount((entry) => entry.familyKey === familyKey);
        if (noProgress >= this.budget.warningFamilyRepeats && !this.warnedFamilies.has(familyKey)) {
          this.warnedFamilies.add(familyKey);
          this.reminders.push(buildReminder('Repeated searches in the same family are yielding little new evidence. Change hypothesis, narrow the path, follow a specific file lead, or summarize current findings instead of repeating variants.'));
        }
      }
    }

    this.totalSteps += 1;
    if (intent.family === 'search') this.searchSteps += 1;
    if (intent.family === 'read') this.readSteps += 1;
    this.maybeWarnOnSoftBudgets(intent.family);

    return {};
  }

  afterToolResult(name: string, args: Record<string, unknown>, result: BuiltinToolResult): void {
    const intent = analyzeBuiltinToolIntent({ name, args });
    const repeatedRead = intent.family === 'read'
      && !!intent.read?.signature
      && this.history.some((entry) => entry.mutationVersion === this.mutationVersion && entry.signature === intent.read?.signature);
    const progress = inferProgress(intent, result) && !repeatedRead;
    this.history.push({
      family: intent.family,
      signature: intent.search?.signature || intent.read?.signature,
      familyKey: intent.search?.familyKey || intent.read?.familyKey,
      progress,
      mutationVersion: this.mutationVersion,
    });
    if (isSuccessfulMutation(intent, result)) {
      this.mutationVersion += 1;
    }
  }

  private trailingNoProgressCount(predicate: (entry: ToolObservation) => boolean): number {
    let count = 0;
    for (let index = this.history.length - 1; index >= 0; index -= 1) {
      const entry = this.history[index];
      if (entry.mutationVersion !== this.mutationVersion) break;
      if (!predicate(entry)) break;
      if (entry.progress) break;
      count += 1;
    }
    return count;
  }

  private hasCurrentMutationObservation(predicate: (entry: ToolObservation) => boolean): boolean {
    return this.history.some((entry) => entry.mutationVersion === this.mutationVersion && predicate(entry));
  }

  private warnOnce(key: string, reason: string): void {
    if (this.warnedKeys.has(key)) return;
    this.warnedKeys.add(key);
    this.reminders.push(buildReminder(reason));
  }

  private maybeWarnOnSoftBudgets(family: BuiltinToolFamily): void {
    if (!this.softTotalWarned && this.totalSteps >= this.budget.softTotalSteps) {
      this.softTotalWarned = true;
      this.reminders.push(buildReminder('This task has already used many tool steps. Do not keep exploring by default; synthesize what you know unless a concrete missing gap remains.'));
    }
    if (family === 'search' && !this.softSearchWarned && this.searchSteps >= this.budget.softSearchSteps) {
      this.softSearchWarned = true;
      this.reminders.push(buildReminder('This task has already used many search steps. Stop broad searching unless you can point to a specific remaining evidence gap.'));
    }
    if (family === 'read' && !this.softReadWarned && this.readSteps >= this.budget.softReadSteps) {
      this.softReadWarned = true;
      this.reminders.push(buildReminder('This task has already used many file reads. Stop re-reading context unless a concrete edit requires one exact missing snippet.'));
    }
  }
}

export function classifyBuiltinAgentTask(prompt: string): BuiltinTaskType {
  const text = prompt.toLowerCase();
  if (/\b(security|secret|credential|api[_ -]?key|token|auth|vulnerability|漏洞|密钥)\b/.test(text)) return 'security_investigation';
  if (/\b(review|code review|审查|评审)\b/.test(text)) return 'code_review';
  if (/\b(debug|bug|fix|error|failing|trace|root cause|报错|修复|排查)\b/.test(text)) return 'debugging';
  if (/\b(implement|add|build|create|refactor|change|feature|实现|开发|改造|重构)\b/.test(text)) return 'implementation';
  if (/\b(what is this|overview|orientation|在干嘛|做什么|看下这个项目)\b/.test(text)) return 'repo_orientation';
  if (/\b(product|roadmap|方案|产品|规划)\b/.test(text)) return 'product_discussion';
  return 'general';
}

export function normalizeToolResultMetadata(
  name: string,
  args: Record<string, unknown>,
  result: BuiltinToolResult
): BuiltinToolResult {
  const intent = analyzeBuiltinToolIntent({ name, args });
  const metadata = {
    ...(result.metadata || {}),
    toolName: name,
    status: result.status || (result.isError ? 'command_error' : 'success'),
  };
  if (!metadata.kind) {
    metadata.kind =
      intent.family === 'search' ? 'search'
        : intent.family === 'read' ? 'read'
          : intent.family === 'write' ? 'write'
            : intent.family === 'edit' ? 'edit'
              : intent.family === 'web' ? 'web'
                : intent.family === 'shell' ? 'shell'
                  : metadata.kind;
  }
  if (intent.search) {
    metadata.pattern = metadata.pattern || intent.search.pattern;
    metadata.path = metadata.path || intent.search.path;
    metadata.searchSignature = metadata.searchSignature || intent.search.signature;
    metadata.searchFamily = metadata.searchFamily || intent.search.familyKey;
    if (result.status === 'no_match' && typeof metadata.matches !== 'number') {
      metadata.matches = 0;
    }
  }
  if (intent.read) {
    metadata.path = metadata.path || intent.read.path;
    metadata.readSignature = metadata.readSignature || intent.read.signature;
    metadata.readFamily = metadata.readFamily || intent.read.familyKey;
  }
  return { ...result, metadata };
}

function buildReminder(reason: string): string {
  return [
    '<system-reminder>',
    'Agent loop governor:',
    reason,
    '</system-reminder>',
  ].join('\n');
}

function isSuccessfulMutation(intent: BuiltinToolIntent, result: BuiltinToolResult): boolean {
  if (result.isError || result.status === 'blocked' || result.status === 'command_error' || result.status === 'timeout') {
    return false;
  }
  return intent.family === 'write' || intent.family === 'edit' || result.metadata?.kind === 'write' || result.metadata?.kind === 'edit';
}

function inferProgress(intent: BuiltinToolIntent, result: BuiltinToolResult): boolean {
  if (result.status === 'blocked' || result.status === 'timeout' || result.status === 'command_error') {
    return false;
  }
  if (intent.family === 'search') {
    if (typeof result.metadata?.matches === 'number') return result.metadata.matches > 0;
    const normalized = result.content.toLowerCase();
    return !normalized.includes('no matches found') && !normalized.includes('(no matches)') && !result.isError;
  }
  return !result.isError;
}

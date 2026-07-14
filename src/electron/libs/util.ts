import type { AgentProvider, ClaudeCompatibleProviderId, ClaudeReasoningEffort } from '../../shared/types';
import { getClaudeEnv, sanitizeOfficialClaudeEnv } from './claude-settings';
import { applyCompatibleProviderEnv } from './compatible-provider-config';
import {
  reconcileClaudeDisplayModel,
  toClaudeCodeRuntimeModel,
} from './claude-model-selection';
import { getRequiredClaudeCodeRuntime } from './claude-runtime';

type ClaudeSettingSource = 'user' | 'project' | 'local';
const CLAUDE_SETTING_SOURCES: ClaudeSettingSource[] = ['user', 'project', 'local'];
const OFFICIAL_CLAUDE_SETTING_SOURCES: ClaudeSettingSource[] = ['user', 'project', 'local'];
const DEFAULT_CLAUDE_REASONING_EFFORT: ClaudeReasoningEffort = 'high';
type ClaudeAgentSdkModule = typeof import('@anthropic-ai/claude-agent-sdk');

async function loadClaudeAgentSdk(): Promise<ClaudeAgentSdkModule> {
  const dynamicImport = new Function(
    'specifier',
    'return import(specifier);'
  ) as (specifier: string) => Promise<ClaudeAgentSdkModule>;
  return dynamicImport('@anthropic-ai/claude-agent-sdk');
}

/**
 * Fork an existing Claude Code session via the agent SDK. Returns the new
 * resumable session id (usable as `resume` in a subsequent query). `dir` scopes
 * the on-disk session lookup to the project directory (the original cwd).
 */
export async function forkClaudeAgentSession(
  sourceClaudeSessionId: string,
  dir?: string
): Promise<string> {
  const sdk = await loadClaudeAgentSdk();
  const result = await sdk.forkSession(sourceClaudeSessionId, dir ? { dir } : undefined);
  return result.sessionId;
}

// SDK 消息类型
interface SDKMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  message?: {
    content: Array<{ type: string; text?: string }>;
  };
}

function normalizeClaudeReasoningEffort(
  value?: string | null
): ClaudeReasoningEffort {
  switch ((value || '').trim().toLowerCase()) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return value!.trim().toLowerCase() as ClaudeReasoningEffort;
    default:
      return DEFAULT_CLAUDE_REASONING_EFFORT;
  }
}

function resolveExplicitMaxThinkingTokens(): number | null {
  const raw = process.env.CLAUDE_CODE_MAX_THINKING_TOKENS;
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
}

function buildClaudeThinkingOptions(params: {
  effort?: ClaudeReasoningEffort;
  compatibleProviderMatched: boolean;
}): {
  thinking?: { type: 'adaptive' | 'enabled'; budgetTokens?: number; display?: 'summarized' };
  effort?: ClaudeReasoningEffort;
} {
  if (params.compatibleProviderMatched) {
    return {};
  }

  const explicitMaxThinkingTokens = resolveExplicitMaxThinkingTokens();
  if (explicitMaxThinkingTokens) {
    return {
      thinking: {
        type: 'enabled',
        budgetTokens: explicitMaxThinkingTokens,
        display: 'summarized',
      },
    };
  }

  return {
    thinking: { type: 'adaptive', display: 'summarized' },
    effort: normalizeClaudeReasoningEffort(params.effort),
  };
}

export async function runClaudeOneShot(params: {
  prompt: string;
  cwd?: string;
  resumeSessionId?: string;
  model?: string;
  compatibleProviderId?: ClaudeCompatibleProviderId;
  betas?: string[];
  claudeReasoningEffort?: ClaudeReasoningEffort;
}): Promise<{ text: string; sessionId?: string; model?: string }> {
  const sdk = await loadClaudeAgentSdk();
  let env = {
    ...process.env,
    ...getClaudeEnv(),
  };
  const providerOverride = applyCompatibleProviderEnv(env, params.model, params.compatibleProviderId);
  env = providerOverride.matchedProviderId
    ? providerOverride.env
    : sanitizeOfficialClaudeEnv(providerOverride.env);
  const forcedModel = providerOverride.forcedModel || params.model;
  const runtimeModel = providerOverride.matchedProviderId
    ? forcedModel
    : toClaudeCodeRuntimeModel(forcedModel, params.betas);
  const thinkingOptions = buildClaudeThinkingOptions({
    effort: params.claudeReasoningEffort,
    compatibleProviderMatched: Boolean(providerOverride.matchedProviderId),
  });
  const { executable, executableArgs, env: runtimeEnv, pathToClaudeCodeExecutable } = getRequiredClaudeCodeRuntime();
  Object.assign(env, runtimeEnv);

  const result = sdk.query({
    prompt: params.prompt,
    options: {
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
      },
      maxTurns: 1,
      allowedTools: [],
      env,
      cwd: params.cwd || process.cwd(),
      resume: params.resumeSessionId,
      model: runtimeModel,
      ...thinkingOptions,
      settings: runtimeModel ? { model: runtimeModel } : undefined,
      betas: params.betas as Array<'context-1m-2025-08-07'> | undefined,
      executable: executable as unknown as 'node',
      executableArgs,
      pathToClaudeCodeExecutable,
      settingSources: providerOverride.matchedProviderId
        ? CLAUDE_SETTING_SOURCES
        : OFFICIAL_CLAUDE_SETTING_SOURCES,
    },
  });

  let text = '';
  let sessionId = params.resumeSessionId;
  let resolvedModel = forcedModel;

  for await (const message of result) {
    const msg = message as SDKMessage;
    if (msg.type === 'system' && msg.subtype === 'init') {
      sessionId = msg.session_id || sessionId;
      resolvedModel = reconcileClaudeDisplayModel(forcedModel, msg.model) || msg.model || resolvedModel;
      continue;
    }

    if (msg.type === 'assistant' && msg.message) {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text) {
          text += block.text;
        }
      }
    }
  }

  return {
    text: text.trim(),
    sessionId,
    model: resolvedModel,
  };
}

function generateSessionTitleLocally(prompt: string): string {
  const cleaned = prompt
    .replace(/\s+/g, ' ')
    .replace(/[`*_#>\-\[\]\(\)]/g, ' ')
    .trim();
  if (!cleaned) {
    return '';
  }

  const firstSentence = cleaned.split(/[.!?。！？\n]/, 1)[0]?.trim() || cleaned;
  const words = firstSentence
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 6);

  const title = words.join(' ').trim();
  return title.slice(0, 50);
}

// LLM 起分支名：让选定的 provider 用英文概括这次任务（kebab-case），
// 中文提示词也能得到可读的分支第三级。失败/超时静默返回 null，
// 调用方退回本地 slug/哈希——起名绝不能挡住任务启动。
// 调用方等在用户可见的操作上，兜底只是名字丑一点，超时宁短勿长。
const BRANCH_SLUG_TIMEOUT_MS = 4_000;

function sanitizeBranchSlug(text: string): string | null {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 6)
    .join('-')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug.length >= 3 ? slug : null;
}

export async function generateWorktreeBranchSlug(params: {
  prompt: string;
  cwd?: string;
  provider?: AgentProvider;
  model?: string;
  compatibleProviderId?: ClaudeCompatibleProviderId;
  betas?: string[];
  claudeReasoningEffort?: ClaudeReasoningEffort;
}): Promise<string | null> {
  const provider = params.provider || 'claude';
  const slugPrompt = `Summarize this task as a short English git branch name: 2-5 lowercase words joined by hyphens, no prefix, no quotes, letters and digits only.
Task: "${params.prompt.slice(0, 500)}"
Output only the branch name.`;

  const call = async (): Promise<string> => {
    if (provider === 'codex') {
      const { runCodexOneShot } = await import('./codex-runner');
      const result = await runCodexOneShot({
        prompt: slugPrompt,
        cwd: params.cwd,
        model: params.model,
        codexReasoningEffort: 'low',
      });
      return result.text;
    }
    if (provider === 'opencode') {
      const { runOpenCodeOneShot } = await import('./codex-runner');
      const result = await runOpenCodeOneShot({ prompt: slugPrompt, cwd: params.cwd, model: params.model });
      return result.text;
    }
    // claude 及走 Claude 协议的 provider（kimi/grok/pi 无 one-shot 助手，用 claude 兜底；
    // claude 不可用时 runClaudeOneShot 抛错 → 外层回退本地命名）
    const result = await runClaudeOneShot({
      prompt: slugPrompt,
      cwd: params.cwd,
      model: provider === 'claude' ? params.model : undefined,
      compatibleProviderId: provider === 'claude' ? params.compatibleProviderId : undefined,
      betas: provider === 'claude' ? params.betas : undefined,
      claudeReasoningEffort: params.claudeReasoningEffort,
    });
    return result.text;
  };

  try {
    const text = await Promise.race([
      call(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('branch naming timed out')), BRANCH_SLUG_TIMEOUT_MS)
      ),
    ]);
    // 模型可能带引号/前缀/多行，取最后一行再清洗
    const lastLine = text.trim().split('\n').filter(Boolean).pop() || '';
    return sanitizeBranchSlug(lastLine);
  } catch (error) {
    console.warn('[Worktree] branch naming fell back to local slug:', error);
    return null;
  }
}

export async function generateSessionTitle(
  prompt: string,
  cwd?: string,
  model?: string,
  compatibleProviderId?: ClaudeCompatibleProviderId,
  betas?: string[],
  provider: AgentProvider = 'claude',
  claudeReasoningEffort?: ClaudeReasoningEffort
): Promise<string> {
  if (provider !== 'claude') {
    return generateSessionTitleLocally(prompt);
  }

  try {
    const titlePrompt = `Based on this user request, generate a very short title (3-6 words, no quotes):
"${prompt.slice(0, 500)}"

Just output the title, nothing else.`;

    const result = await runClaudeOneShot({
      prompt: titlePrompt,
      cwd,
      model,
      compatibleProviderId,
      betas,
      claudeReasoningEffort,
    });
    return result.text.slice(0, 50);
  } catch (error) {
    console.error('Failed to generate title:', error);
    return generateSessionTitleLocally(prompt);
  }
}

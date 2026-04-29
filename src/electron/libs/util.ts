import type { AgentProvider, ClaudeCompatibleProviderId, ClaudeReasoningEffort } from '../../shared/types';
import { getClaudeEnv, sanitizeOfficialClaudeEnv } from './claude-settings';
import { applyCompatibleProviderEnv } from './compatible-provider-config';
import {
  reconcileClaudeDisplayModel,
  toClaudeCodeRuntimeModel,
} from './claude-model-selection';
import { getClaudeCodeRuntime } from './claude-runtime';

type ClaudeSettingSource = 'user' | 'project' | 'local';
const CLAUDE_SETTING_SOURCES: ClaudeSettingSource[] = ['user', 'project', 'local'];
const OFFICIAL_CLAUDE_SETTING_SOURCES: ClaudeSettingSource[] = ['project'];
const DEFAULT_CLAUDE_REASONING_EFFORT: ClaudeReasoningEffort = 'high';
type ClaudeAgentSdkModule = typeof import('@anthropic-ai/claude-agent-sdk');

async function loadClaudeAgentSdk(): Promise<ClaudeAgentSdkModule> {
  const dynamicImport = new Function(
    'specifier',
    'return import(specifier);'
  ) as (specifier: string) => Promise<ClaudeAgentSdkModule>;
  return dynamicImport('@anthropic-ai/claude-agent-sdk');
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
  const { executable, executableArgs, env: runtimeEnv, pathToClaudeCodeExecutable } = getClaudeCodeRuntime();
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

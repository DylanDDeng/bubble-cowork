import type { AgentProvider, ClaudeCompatibleProviderId } from '../../shared/types';
import { getClaudeEnv } from './claude-settings';
import { applyCompatibleProviderEnv } from './compatible-provider-config';
import { getClaudeCodeRuntime } from './claude-runtime';

type ClaudeSettingSource = 'user' | 'project' | 'local';
const CLAUDE_SETTING_SOURCES: ClaudeSettingSource[] = ['user', 'project', 'local'];
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

export async function runClaudeOneShot(params: {
  prompt: string;
  cwd?: string;
  resumeSessionId?: string;
  model?: string;
  compatibleProviderId?: ClaudeCompatibleProviderId;
  betas?: string[];
}): Promise<{ text: string; sessionId?: string; model?: string }> {
  const sdk = await loadClaudeAgentSdk();
  let env = {
    ...process.env,
    ...getClaudeEnv(),
  };
  const providerOverride = applyCompatibleProviderEnv(env, params.model, params.compatibleProviderId);
  env = providerOverride.env;
  const forcedModel = providerOverride.forcedModel || params.model;
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
      model: forcedModel,
      settings: forcedModel ? { model: forcedModel } : undefined,
      betas: params.betas as Array<'context-1m-2025-08-07'> | undefined,
      executable: executable as unknown as 'node',
      executableArgs,
      pathToClaudeCodeExecutable,
      settingSources: CLAUDE_SETTING_SOURCES,
    },
  });

  let text = '';
  let sessionId = params.resumeSessionId;
  let resolvedModel = forcedModel;

  for await (const message of result) {
    const msg = message as SDKMessage;
    if (msg.type === 'system' && msg.subtype === 'init') {
      sessionId = msg.session_id || sessionId;
      resolvedModel = msg.model || resolvedModel;
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
  provider: AgentProvider = 'claude'
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
    });
    return result.text.slice(0, 50);
  } catch (error) {
    console.error('Failed to generate title:', error);
    return generateSessionTitleLocally(prompt);
  }
}

import { query } from '@anthropic-ai/claude-agent-sdk';
import { getClaudeEnv, getClaudeSettings } from './claude-settings';
import { getClaudeCodeRuntime } from './claude-runtime';

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
  betas?: string[];
}): Promise<{ text: string; sessionId?: string; model?: string }> {
  const env = {
    ...process.env,
    ...getClaudeEnv(),
  };
  const settings = getClaudeSettings();
  if (settings?.apiKey && !env.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_API_KEY = settings.apiKey;
  }
  const { executable, executableArgs, env: runtimeEnv, pathToClaudeCodeExecutable } = getClaudeCodeRuntime();
  Object.assign(env, runtimeEnv);

  const result = query({
    prompt: params.prompt,
    options: {
      maxTurns: 1,
      allowedTools: [],
      env,
      cwd: params.cwd || process.cwd(),
      resume: params.resumeSessionId,
      model: params.model,
      settings: params.model ? { model: params.model } : undefined,
      betas: params.betas as Array<'context-1m-2025-08-07'> | undefined,
      executable: executable as unknown as 'node',
      executableArgs,
      pathToClaudeCodeExecutable,
      settingSources: ['user', 'project'],
    },
  });

  let text = '';
  let sessionId = params.resumeSessionId;
  let resolvedModel = params.model;

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

// 使用 Claude SDK 生成会话标题
export async function generateSessionTitle(prompt: string, cwd?: string): Promise<string> {
  try {
    const titlePrompt = `Based on this user request, generate a very short title (3-6 words, no quotes):
"${prompt.slice(0, 500)}"

Just output the title, nothing else.`;

    const result = await runClaudeOneShot({ prompt: titlePrompt, cwd });
    return result.text.slice(0, 50);
  } catch (error) {
    console.error('Failed to generate title:', error);
    return '';
  }
}

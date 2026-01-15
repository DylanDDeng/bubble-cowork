import { query } from '@anthropic-ai/claude-agent-sdk';
import { getClaudeEnv, getClaudeSettings } from './claude-settings';
import { getClaudeCodeRuntime } from './claude-runtime';

// SDK 消息类型
interface SDKMessage {
  type: string;
  message?: {
    content: Array<{ type: string; text?: string }>;
  };
}

// 使用 Claude SDK 生成会话标题
export async function generateSessionTitle(prompt: string): Promise<string> {
  const env = {
    ...process.env,
    ...getClaudeEnv(),
  };
  const settings = getClaudeSettings();
  if (settings?.apiKey && !env.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_API_KEY = settings.apiKey;
  }
  const model = env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
  const { executable, executableArgs, env: runtimeEnv, pathToClaudeCodeExecutable } = getClaudeCodeRuntime();
  Object.assign(env, runtimeEnv);

  try {
    const titlePrompt = `Based on this user request, generate a very short title (3-6 words, no quotes):
"${prompt.slice(0, 500)}"

Just output the title, nothing else.`;

    const result = query({
      prompt: titlePrompt,
      options: {
        model,
        maxTurns: 1,
        allowedTools: [],
        env,
        executable: executable as unknown as 'node',
        executableArgs,
        pathToClaudeCodeExecutable,
      },
    });

    let title = '';
    for await (const message of result) {
      const msg = message as SDKMessage;
      if (msg.type === 'assistant' && msg.message) {
        const content = msg.message.content;
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            title += block.text;
          }
        }
      }
    }

    return title.trim().slice(0, 50) || 'New Session';
  } catch (error) {
    console.error('Failed to generate title:', error);
    return 'New Session';
  }
}

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
export async function generateSessionTitle(prompt: string, cwd?: string): Promise<string> {
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

  try {
    const titlePrompt = `Based on this user request, generate a very short title (3-6 words, no quotes):
"${prompt.slice(0, 500)}"

Just output the title, nothing else.`;

    const result = query({
      prompt: titlePrompt,
      options: {
        maxTurns: 1,
        allowedTools: [],
        env,
        cwd: cwd || process.cwd(),
        executable: executable as unknown as 'node',
        executableArgs,
        pathToClaudeCodeExecutable,
        // 与 Runner 保持一致：优先读取 user/project 设置与 Skills
        settingSources: ['user', 'project'],
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

    return title.trim().slice(0, 50);
  } catch (error) {
    console.error('Failed to generate title:', error);
    return '';
  }
}

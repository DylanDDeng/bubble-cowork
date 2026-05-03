import type { ContentBlock, RunnerOptions, StreamMessage } from '../../types';
import { isDev } from '../../util';
import { createRuntimeTurnMemoryTracker } from '../agent-runtime';
import { runOpenCode } from '../codex-runner';
import { runClaude } from '../runner';
import type { AgentRuntime } from './types';

function shouldTraceRuntimeStages(): boolean {
  return isDev() || process.env.AEGIS_RUNTIME_TRACE === '1';
}

function logRuntimeStage(stage: string, detail?: Record<string, unknown>): void {
  if (!shouldTraceRuntimeStages()) return;
  if (detail) {
    console.log(`[Native Runtime] ${stage}`, detail);
    return;
  }
  console.log(`[Native Runtime] ${stage}`);
}

function extractAssistantText(message: Extract<StreamMessage, { type: 'assistant' }>): string {
  return (message.message.content as ContentBlock[])
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

function trackMemorySignals(
  tracker: ReturnType<typeof createRuntimeTurnMemoryTracker>,
  message: StreamMessage
): void {
  if (message.type === 'assistant') {
    const text = extractAssistantText(message);
    if (text) {
      tracker.setAssistantText(text);
    }
    for (const block of message.message.content as ContentBlock[]) {
      if (block.type === 'tool_use') {
        tracker.markMemoryWrite(block.name);
      }
    }
    return;
  }

  if (message.type === 'user') {
    for (const block of message.message.content as ContentBlock[]) {
      if (block.type === 'tool_result' && typeof block.content === 'string') {
        tracker.markMemoryWrite(block.content);
      }
    }
    return;
  }

  if (message.type === 'result') {
    tracker.finalizeTurn();
  }
}

function getProviderRunner(options: RunnerOptions): typeof runClaude {
  const provider = options.session.provider || 'claude';
  // Codex is now handled by ProviderService, not native runtime
  return provider === 'opencode'
    ? runOpenCode
    : runClaude;
}

function shouldUseRuntimeMemoryLoop(options: RunnerOptions): boolean {
  void options;
  return false;
}

export const nativeRuntime: AgentRuntime = {
  id: 'native',
  displayName: 'Native Loop Runtime',
  run: (options) => {
    const provider = options.session.provider || 'claude';
    const runner = getProviderRunner(options);
    const useMemoryLoop = shouldUseRuntimeMemoryLoop(options);

    logRuntimeStage('stage:init', {
      sessionId: options.session.id,
      provider,
      useMemoryLoop,
    });

    const tracker = useMemoryLoop
      ? createRuntimeTurnMemoryTracker({
          sessionId: options.session.id || `native-${provider}`,
          projectCwd: options.session.cwd,
        })
      : null;

    if (tracker) {
      tracker.beginTurn(options.prompt);
      logRuntimeStage('stage:memory-retrieval:start');
      logRuntimeStage('stage:memory-retrieval:end');
    }

    const handle = runner({
      ...options,
      onMessage: (message) => {
        if (tracker) {
          trackMemorySignals(tracker, message);
          if (message.type === 'result') {
            logRuntimeStage('stage:memory-writeback:end');
          }
        }
        options.onMessage(message);
      },
    });

    logRuntimeStage('stage:model-execution:start');

    return {
      abort: () => {
        logRuntimeStage('stage:abort', { sessionId: options.session.id });
        handle.abort();
      },
      send: (prompt, attachments, model) => {
        if (tracker) {
          logRuntimeStage('stage:memory-retrieval:start');
          tracker.beginTurn(prompt);
          logRuntimeStage('stage:memory-retrieval:end');
        }
        handle.send(prompt, attachments, model);
      },
    };
  },
};

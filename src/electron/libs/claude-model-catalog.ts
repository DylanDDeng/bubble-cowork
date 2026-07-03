import { homedir } from 'os';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { getClaudeEnv, sanitizeOfficialClaudeEnv } from './claude-settings';
import { getClaudeCodeRuntime } from './claude-runtime';

type ClaudeAgentSdkModule = typeof import('@anthropic-ai/claude-agent-sdk');

const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 25_000;

let cachedModels: { values: string[]; fetchedAt: number } | null = null;
let inflight: Promise<string[]> | null = null;

function loadClaudeAgentSdk(): Promise<ClaudeAgentSdkModule> {
  const dynamicImport = new Function('specifier', 'return import(specifier);') as (
    specifier: string
  ) => Promise<ClaudeAgentSdkModule>;
  return dynamicImport('@anthropic-ai/claude-agent-sdk');
}

/**
 * Ask the local Claude Code (via the Agent SDK control channel) which models
 * the signed-in account can use — the same source as the CLI's own /model
 * picker. The probe session gets the sanitized official env, so a third-party
 * ANTHROPIC_BASE_URL configured for Claude Code never shapes this list.
 *
 * Returns [] when Claude Code is missing or the probe fails; callers fall
 * back to the locally-recorded model candidates.
 */
export function getClaudeSupportedModels(force = false): Promise<string[]> {
  if (!force && cachedModels && Date.now() - cachedModels.fetchedAt < CATALOG_TTL_MS) {
    return Promise.resolve(cachedModels.values);
  }
  if (!inflight) {
    inflight = fetchSupportedModels()
      .then((values) => {
        if (values.length > 0) {
          cachedModels = { values, fetchedAt: Date.now() };
        }
        return values;
      })
      .catch((error) => {
        console.warn('[claude-model-catalog] supportedModels probe failed:', error);
        return cachedModels?.values ?? [];
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

async function fetchSupportedModels(): Promise<string[]> {
  const runtime = getClaudeCodeRuntime();
  if (!runtime.pathToClaudeCodeExecutable) {
    return [];
  }

  const sdk = await loadClaudeAgentSdk();
  const env = { ...sanitizeOfficialClaudeEnv(getClaudeEnv()), ...runtime.env };
  const abortController = new AbortController();

  // Streaming-input session that never sends a prompt: the control channel
  // (supportedModels) answers as soon as the CLI boots.
  const idlePrompt = (async function* (): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>((resolve) => {
      abortController.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  })();

  const query = sdk.query({
    prompt: idlePrompt,
    options: {
      cwd: homedir(),
      abortController,
      env,
      executable: runtime.executable as unknown as 'node',
      executableArgs: runtime.executableArgs,
      pathToClaudeCodeExecutable: runtime.pathToClaudeCodeExecutable,
      settingSources: [],
    },
  });

  try {
    const models = await Promise.race([
      query.supportedModels(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('supportedModels timed out')), CATALOG_TIMEOUT_MS);
      }),
    ]);

    const values = new Set<string>();
    for (const model of models) {
      if (typeof model.value === 'string' && model.value.trim()) {
        values.add(model.value.trim());
      }
      if (typeof model.resolvedModel === 'string' && model.resolvedModel.trim()) {
        values.add(model.resolvedModel.trim());
      }
    }
    return Array.from(values);
  } finally {
    abortController.abort();
  }
}

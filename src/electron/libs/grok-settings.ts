import { execFile } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import type { GrokModelConfig, GrokReasoningEffort } from '../../shared/types';
import { buildGrokEnv, GROK_HOME_DIR, resolveGrokBinary } from './grok-cli';

const EMPTY_GROK_MODEL_CONFIG: GrokModelConfig = {
  defaultModel: null,
  options: [],
  availableModels: [],
};

type GrokAvailableModel = GrokModelConfig['availableModels'][number];

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: 8000,
        maxBuffer: 4 * 1024 * 1024,
        env: buildGrokEnv(),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(`${stdout || ''}${stderr || ''}`.trim());
      }
    );
  });
}

function parseDefaultModel(output: string): string | null {
  const match = output.match(/^Default model:\s*(\S+)/m);
  return match?.[1]?.trim() || null;
}

const GROK_REASONING_EFFORTS: GrokReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
];

/**
 * Read a model's context window size and reasoning-effort tiers from
 * ~/.grok/models_cache.json, which the CLI populates from the model catalog
 * (context_window = 500000 for grok-4.6; reasoning_efforts lists the tiers the
 * model actually supports). `grok models` prints neither, so the cache is the
 * source of truth. Both fall back to null/empty on any miss.
 */
function readModelsCacheEntry(modelName: string): {
  contextWindow: number | null;
  reasoningEfforts: GrokReasoningEffort[];
} {
  try {
    const raw = readFileSync(path.join(GROK_HOME_DIR, 'models_cache.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      models?: Record<
        string,
        {
          info?: {
            context_window?: unknown;
            reasoning_efforts?: Array<{ value?: unknown }>;
          };
        }
      >;
    };
    const info = parsed.models?.[modelName]?.info;
    const contextWindow =
      typeof info?.context_window === 'number' && Number.isFinite(info.context_window) && info.context_window > 0
        ? info.context_window
        : null;
    const reasoningEfforts = (info?.reasoning_efforts ?? [])
      .map((entry) => entry?.value)
      .filter((value): value is GrokReasoningEffort =>
        typeof value === 'string' && (GROK_REASONING_EFFORTS as string[]).includes(value)
      );
    return { contextWindow, reasoningEfforts };
  } catch {
    return { contextWindow: null, reasoningEfforts: [] };
  }
}

function parseAvailableModels(output: string): string[] {
  const models: string[] = [];
  const inModelsSection = output.indexOf('Available models:');
  if (inModelsSection < 0) return models;
  const lines = output.slice(inModelsSection).split(/\r?\n/).slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    // Lines look like: "  * grok-build (default)" or "  grok-4"
    const match = line.match(/^\s*[*-]?\s*(\S+)/);
    if (match) {
      const name = match[1].trim();
      if (name && !models.includes(name)) {
        models.push(name);
      }
    }
  }
  return models;
}

export async function getGrokModelConfig(): Promise<GrokModelConfig> {
  const binary = await resolveGrokBinary();
  if (!binary) {
    return EMPTY_GROK_MODEL_CONFIG;
  }

  let output: string;
  try {
    output = await execFileText(binary, ['models']);
  } catch {
    return EMPTY_GROK_MODEL_CONFIG;
  }

  const defaultModel = parseDefaultModel(output);
  const modelNames = parseAvailableModels(output);

  // Ensure default model is in the list
  if (defaultModel && !modelNames.includes(defaultModel)) {
    modelNames.unshift(defaultModel);
  }

  if (modelNames.length === 0 && defaultModel) {
    modelNames.push(defaultModel);
  }

  const availableModels: GrokAvailableModel[] = modelNames.map((name) => {
    const entry = readModelsCacheEntry(name);
    return {
      name,
      label: name,
      provider: null,
      enabled: true,
      isDefault: defaultModel === name,
      maxContextSize: entry.contextWindow,
      capabilities: [],
      reasoningEfforts: entry.reasoningEfforts,
    };
  });

  return {
    defaultModel,
    options: availableModels.filter((model) => model.enabled).map((model) => model.name),
    availableModels,
  };
}

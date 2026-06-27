import { execFile } from 'child_process';
import type { GrokModelConfig } from '../../shared/types';
import { buildGrokEnv, resolveGrokBinary } from './grok-cli';

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

  const availableModels: GrokAvailableModel[] = modelNames.map((name) => ({
    name,
    label: name,
    provider: null,
    enabled: true,
    isDefault: defaultModel === name,
    maxContextSize: null,
    capabilities: [],
  }));

  return {
    defaultModel,
    options: availableModels.filter((model) => model.enabled).map((model) => model.name),
    availableModels,
  };
}

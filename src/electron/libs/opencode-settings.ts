import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { OpenCodeModelConfig } from '../../shared/types';
import { getOpenCodeServeManager } from './provider/opencode-serve-manager';

const OPENCODE_CONFIG_PATH = join(homedir(), '.config', 'opencode', 'opencode.json');
const OPENCODE_MODEL_VISIBILITY_PATH = () =>
  join(app.getPath('userData'), 'opencode-model-visibility.json');

type OpenCodeConfigFile = {
  model?: unknown;
  provider?: Record<
    string,
    {
      models?: Record<string, unknown>;
    }
  >;
};

type OpenCodeModelVisibilityConfig = {
  hiddenModels?: string[];
};

const OPENCODE_MODELS_CACHE_TTL_MS = 30_000;

let cachedServerModels:
  | {
      value: { models: string[]; defaultModel: string | null };
      fetchedAt: number;
    }
  | null = null;

function readOpencodeConfig(): OpenCodeConfigFile {
  try {
    if (!existsSync(OPENCODE_CONFIG_PATH)) {
      return {};
    }
    return JSON.parse(readFileSync(OPENCODE_CONFIG_PATH, 'utf-8')) as OpenCodeConfigFile;
  } catch (error) {
    console.warn('Failed to read OpenCode config:', error);
    return {};
  }
}

function readOpencodeModelVisibility(): OpenCodeModelVisibilityConfig {
  try {
    const visibilityPath = OPENCODE_MODEL_VISIBILITY_PATH();
    if (!existsSync(visibilityPath)) {
      return {};
    }

    return JSON.parse(readFileSync(visibilityPath, 'utf-8')) as OpenCodeModelVisibilityConfig;
  } catch (error) {
    console.warn('Failed to read OpenCode model visibility config:', error);
    return {};
  }
}

function writeOpencodeModelVisibility(hiddenModels: string[]): void {
  try {
    writeFileSync(
      OPENCODE_MODEL_VISIBILITY_PATH(),
      JSON.stringify({ hiddenModels }, null, 2),
      'utf-8'
    );
  } catch (error) {
    console.warn('Failed to save OpenCode model visibility config:', error);
  }
}

function getDetectedOpencodeModels(defaultModel: string | null): string[] {
  const config = readOpencodeConfig();
  const providerModels = Object.entries(config.provider || {}).flatMap(([providerId, providerConfig]) =>
    Object.keys(providerConfig?.models || {}).map((modelId) => `${providerId}/${modelId}`)
  );

  return Array.from(
    new Set(
      [defaultModel, ...providerModels]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value))
    )
  );
}

export function getOpencodeConfigPath(): string {
  return OPENCODE_CONFIG_PATH;
}

type ServerModels = { models: string[]; defaultModel: string | null };

/** Models from the OpenCode server (the 2.x CLI's `opencode models` prints nothing headless). */
async function getDetectedOpencodeModelsFromServer(): Promise<ServerModels> {
  if (
    cachedServerModels &&
    Date.now() - cachedServerModels.fetchedAt < OPENCODE_MODELS_CACHE_TTL_MS
  ) {
    return cachedServerModels.value;
  }

  try {
    const { models, defaultModel } = await getOpenCodeServeManager().loadModels(homedir());
    const value: ServerModels = {
      models: models
        .filter((model) => model.enabled !== false)
        .map((model) => `${model.providerID}/${model.modelID}`),
      defaultModel: defaultModel ? `${defaultModel.providerID}/${defaultModel.modelID}` : null,
    };
    cachedServerModels = { value, fetchedAt: Date.now() };
    return value;
  } catch (error) {
    console.warn('Failed to load OpenCode models from the server, falling back to config:', error);
    return { models: [], defaultModel: null };
  }
}

export async function getOpencodeModelConfig(): Promise<OpenCodeModelConfig> {
  const config = readOpencodeConfig();
  const server = await getDetectedOpencodeModelsFromServer();
  const cliModels = server.models;
  // 2.x writes `model` as an object; only the 1.x string form is readable here.
  const configModel = typeof config.model === 'string' ? config.model.trim() || null : null;
  const defaultModel = server.defaultModel ?? (cliModels.length > 0 ? null : configModel);
  const detectedModels =
    cliModels.length > 0
      ? Array.from(
          new Set(
            [defaultModel, ...cliModels]
              .map((value) => value?.trim())
              .filter((value): value is string => Boolean(value))
          )
        )
      : getDetectedOpencodeModels(defaultModel);
  const availableModels = detectedModels.map((name) => ({
    name,
    enabled: true,
    isDefault: defaultModel === name,
  }));
  const options = availableModels.map((model) => model.name);

  return { defaultModel, options, availableModels };
}

export async function saveOpencodeModelVisibility(enabledModels: string[]): Promise<OpenCodeModelConfig> {
  const nextEnabledModels = new Set(
    enabledModels.map((model) => model.trim()).filter((model) => model.length > 0)
  );
  const currentConfig = await getOpencodeModelConfig();
  const detectedModels = Array.from(
    new Set(
      [currentConfig.defaultModel, ...currentConfig.availableModels.map((model) => model.name)]
        .map((model) => model?.trim())
        .filter((model): model is string => Boolean(model))
    )
  );
  const hiddenModels = detectedModels.filter((model) => !nextEnabledModels.has(model));
  writeOpencodeModelVisibility(hiddenModels);

  const availableModels = detectedModels.map((name) => ({
    name,
    enabled: !hiddenModels.includes(name),
    isDefault: currentConfig.defaultModel === name,
  }));
  const options = availableModels.filter((model) => model.enabled).map((model) => model.name);

  return {
    defaultModel: currentConfig.defaultModel,
    options,
    availableModels,
  };
}

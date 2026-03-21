import { execFile } from 'child_process';
import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { OpenCodeModelConfig } from '../../shared/types';

const OPENCODE_CONFIG_PATH = join(homedir(), '.config', 'opencode', 'opencode.json');
const OPENCODE_MODEL_VISIBILITY_PATH = () =>
  join(app.getPath('userData'), 'opencode-model-visibility.json');

type OpenCodeConfigFile = {
  model?: string;
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

let cachedCliModels:
  | {
      models: string[];
      fetchedAt: number;
    }
  | null = null;

function execFileAsync(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

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

async function getDetectedOpencodeModelsFromCli(): Promise<string[]> {
  if (
    cachedCliModels &&
    Date.now() - cachedCliModels.fetchedAt < OPENCODE_MODELS_CACHE_TTL_MS
  ) {
    return cachedCliModels.models;
  }

  try {
    const { stdout } = await execFileAsync('opencode', ['models']);
    const models = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    cachedCliModels = {
      models,
      fetchedAt: Date.now(),
    };
    return models;
  } catch (error) {
    console.warn('Failed to load OpenCode models from CLI, falling back to config:', error);
    return [];
  }
}

export async function getOpencodeModelConfig(): Promise<OpenCodeModelConfig> {
  const config = readOpencodeConfig();
  const defaultModel = config.model?.trim() || null;
  const cliModels = await getDetectedOpencodeModelsFromCli();
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
  const hiddenModels = new Set(
    (readOpencodeModelVisibility().hiddenModels || [])
      .map((model) => model.trim())
      .filter((model) => model.length > 0)
  );
  const availableModels = detectedModels.map((name) => ({
    name,
    enabled: !hiddenModels.has(name),
    isDefault: defaultModel === name,
  }));
  const options = availableModels.filter((model) => model.enabled).map((model) => model.name);

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

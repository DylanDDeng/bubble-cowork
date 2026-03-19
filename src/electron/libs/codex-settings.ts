import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { CodexModelConfig } from '../../shared/types';

const CODEX_CONFIG_PATH = join(homedir(), '.codex', 'config.toml');
const CODEX_MODELS_CACHE_PATH = join(homedir(), '.codex', 'models_cache.json');
const CODEX_MODEL_VISIBILITY_PATH = () => join(app.getPath('userData'), 'codex-model-visibility.json');

type CodexCachedModel = {
  slug?: string;
  visibility?: string;
};

type CodexModelsCache = {
  models?: CodexCachedModel[];
};

type CodexModelVisibilityConfig = {
  hiddenModels?: string[];
};

function readCodexConfigText(): string {
  try {
    if (!existsSync(CODEX_CONFIG_PATH)) {
      return '';
    }
    return readFileSync(CODEX_CONFIG_PATH, 'utf-8');
  } catch (error) {
    console.warn('Failed to read Codex config:', error);
    return '';
  }
}

function readCodexModelsCache(): CodexModelsCache {
  try {
    if (!existsSync(CODEX_MODELS_CACHE_PATH)) {
      return {};
    }
    return JSON.parse(readFileSync(CODEX_MODELS_CACHE_PATH, 'utf-8')) as CodexModelsCache;
  } catch (error) {
    console.warn('Failed to read Codex models cache:', error);
    return {};
  }
}

function readCodexModelVisibility(): CodexModelVisibilityConfig {
  try {
    const visibilityPath = CODEX_MODEL_VISIBILITY_PATH();
    if (!existsSync(visibilityPath)) {
      return {};
    }

    return JSON.parse(readFileSync(visibilityPath, 'utf-8')) as CodexModelVisibilityConfig;
  } catch (error) {
    console.warn('Failed to read Codex model visibility config:', error);
    return {};
  }
}

function writeCodexModelVisibility(hiddenModels: string[]): void {
  try {
    writeFileSync(
      CODEX_MODEL_VISIBILITY_PATH(),
      JSON.stringify({ hiddenModels }, null, 2),
      'utf-8'
    );
  } catch (error) {
    console.warn('Failed to save Codex model visibility config:', error);
  }
}

function getDetectedCodexModels(defaultModel: string | null): string[] {
  const cache = readCodexModelsCache();
  return Array.from(
    new Set(
      [
        defaultModel,
        ...(cache.models || [])
          .filter((model) => model.visibility !== 'hidden')
          .map((model) => model.slug?.trim())
          .filter((slug): slug is string => Boolean(slug)),
      ].filter((value): value is string => Boolean(value))
    )
  );
}

export function getCodexModelConfig(): CodexModelConfig {
  const configText = readCodexConfigText();
  const defaultModelMatch = configText.match(/^model\s*=\s*"([^"]+)"/m);
  const defaultModel = defaultModelMatch?.[1]?.trim() || null;
  const detectedModels = getDetectedCodexModels(defaultModel);
  const hiddenModels = new Set(
    (readCodexModelVisibility().hiddenModels || [])
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

export function saveCodexModelVisibility(enabledModels: string[]): CodexModelConfig {
  const nextEnabledModels = new Set(
    enabledModels
      .map((model) => model.trim())
      .filter((model) => model.length > 0)
  );
  const detectedModels = getDetectedCodexModels(getCodexModelConfig().defaultModel);
  const hiddenModels = detectedModels.filter((model) => !nextEnabledModels.has(model));
  writeCodexModelVisibility(hiddenModels);
  return getCodexModelConfig();
}

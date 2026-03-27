import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type {
  CodexModelConfig,
  CodexReasoningEffort,
  CodexReasoningLevelOption,
} from '../../shared/types';

const CODEX_CONFIG_PATH = join(homedir(), '.codex', 'config.toml');
const CODEX_MODELS_CACHE_PATH = join(homedir(), '.codex', 'models_cache.json');
const CODEX_MODEL_VISIBILITY_PATH = () => join(app.getPath('userData'), 'codex-model-visibility.json');

type CodexCachedModel = {
  slug?: string;
  visibility?: string;
  default_reasoning_level?: string;
  supported_in_api?: boolean;
  priority?: number;
  upgrade?: unknown;
  supported_reasoning_levels?: Array<{
    effort?: string;
    description?: string;
  }>;
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

function normalizeCodexReasoningEffort(
  value?: string | null
): CodexReasoningEffort | null {
  switch ((value || '').trim().toLowerCase()) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return value!.trim().toLowerCase() as CodexReasoningEffort;
    default:
      return null;
  }
}

function normalizeSupportedReasoningLevels(
  levels?: CodexCachedModel['supported_reasoning_levels']
): CodexReasoningLevelOption[] {
  return (levels || [])
    .map((level) => {
      const effort = normalizeCodexReasoningEffort(level?.effort);
      if (!effort) {
        return null;
      }

      return {
        effort,
        description: level?.description?.trim() || effort,
      } satisfies CodexReasoningLevelOption;
    })
    .filter((level): level is CodexReasoningLevelOption => Boolean(level));
}

export function getCodexModelConfig(): CodexModelConfig {
  const configText = readCodexConfigText();
  const defaultModelMatch = configText.match(/^model\s*=\s*"([^"]+)"/m);
  const defaultModel = defaultModelMatch?.[1]?.trim() || null;
  const defaultReasoningEffortMatch = configText.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m);
  const defaultReasoningEffort = normalizeCodexReasoningEffort(defaultReasoningEffortMatch?.[1] || null);
  const cache = readCodexModelsCache();
  const detectedModels = getDetectedCodexModels(defaultModel);
  const hiddenModels = new Set(
    (readCodexModelVisibility().hiddenModels || [])
      .map((model) => model.trim())
      .filter((model) => model.length > 0)
  );
  const cachedModelsBySlug = new Map(
    (cache.models || [])
      .map((model) => [model.slug?.trim(), model] as const)
      .filter((entry): entry is [string, CodexCachedModel] => Boolean(entry[0]))
  );
  const availableModels = detectedModels.map((name) => {
    const cached = cachedModelsBySlug.get(name);
    return {
      name,
      enabled: !hiddenModels.has(name),
      isDefault: defaultModel === name,
      defaultReasoningEffort:
        normalizeCodexReasoningEffort(cached?.default_reasoning_level) || defaultReasoningEffort,
      supportedReasoningLevels: normalizeSupportedReasoningLevels(cached?.supported_reasoning_levels),
      supportsFastMode:
        cached?.supported_in_api === true &&
        typeof cached?.priority === 'number' &&
        cached.priority === 1 &&
        !cached?.upgrade,
    };
  });
  const options = availableModels.filter((model) => model.enabled).map((model) => model.name);

  return { defaultModel, defaultReasoningEffort, options, availableModels };
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

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { PiModelConfig } from '../../shared/types';
import { loadPiSdk, createPiAuthAndRegistry, resolvePiAgentDir, type PiModel } from './provider/pi-sdk-loader';

type PiAvailableModel = PiModelConfig['availableModels'][number];

const EMPTY_PI_MODEL_CONFIG: PiModelConfig = {
  defaultModel: null,
  options: [],
  availableModels: [],
};

// The provider ids that have a credential entry in auth.json (api key or oauth). Used as
// a robust fallback for deciding which built-in models to surface.
function loadAuthedPiProviders(): Set<string> {
  try {
    const authPath = join(resolvePiAgentDir(), 'auth.json');
    if (!existsSync(authPath)) {
      return new Set();
    }
    const parsed = JSON.parse(readFileSync(authPath, 'utf-8')) as Record<string, unknown>;
    return new Set(Object.keys(parsed).filter((key) => key.trim().length > 0));
  } catch (error) {
    console.warn('[pi-settings] Failed to read Pi auth.json:', error);
    return new Set();
  }
}

interface PiSettingsJson {
  defaultProvider?: string;
  defaultModel?: string;
}

function loadPiDefaultModel(): string | null {
  try {
    const settingsPath = join(resolvePiAgentDir(), 'settings.json');
    if (!existsSync(settingsPath)) {
      return null;
    }
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8')) as PiSettingsJson;
    const provider = parsed.defaultProvider?.trim();
    const model = parsed.defaultModel?.trim();
    if (provider && model) {
      return `${provider}/${model}`;
    }
    return model || null;
  } catch (error) {
    console.warn('Failed to read Pi settings.json:', error);
    return null;
  }
}

// The model identifier the app uses is "<provider>/<id>", matching what the Pi
// adapter's parsePiModel expects when resolving a model from the registry.
function formatPiModelId(model: PiModel): string | null {
  const provider = model.provider?.trim();
  const id = (model.id || model.name)?.trim();
  if (!id) return null;
  return provider ? `${provider}/${id}` : id;
}

export async function getPiModelConfig(): Promise<PiModelConfig> {
  let available: PiModel[] = [];
  try {
    const sdk = await loadPiSdk();
    // Bind to the user's real Pi agent dir (see resolvePiAgentDir) rather than any empty
    // per-session overlay injected via PI_CODING_AGENT_DIR.
    const { modelRegistry } = createPiAuthAndRegistry(sdk);
    // getAvailable() returns only models with valid credentials configured.
    const registry = modelRegistry as unknown as {
      getAvailable?: () => Promise<PiModel[]> | PiModel[];
      models?: PiModel[];
    };
    if (typeof registry.getAvailable === 'function') {
      available = (await registry.getAvailable()) || [];
    }

    // Fallback: if getAvailable() still comes back empty, derive the list from the full
    // built-in catalog filtered by the providers that actually have credentials.
    if (available.length === 0 && Array.isArray(registry.models) && registry.models.length > 0) {
      const authedProviders = loadAuthedPiProviders();
      if (authedProviders.size > 0) {
        available = registry.models.filter(
          (model) => model.provider && authedProviders.has(model.provider)
        );
      }
    }
  } catch (error) {
    console.warn('[pi-settings] Failed to load Pi model registry:', error);
    return EMPTY_PI_MODEL_CONFIG;
  }

  const defaultModel = loadPiDefaultModel();

  const modelsByName = new Map<string, PiAvailableModel>();
  for (const model of available) {
    const name = formatPiModelId(model);
    if (!name || modelsByName.has(name)) {
      continue;
    }
    modelsByName.set(name, {
      name,
      label: model.name?.trim() || name,
      provider: model.provider?.trim() || null,
      enabled: true,
      isDefault: false,
      maxContextSize: typeof model.contextWindow === 'number' ? model.contextWindow : null,
      capabilities: [],
    });
  }

  // Surface the configured default even if getAvailable() didn't include it, so the
  // picker can still show/select it.
  if (defaultModel && !modelsByName.has(defaultModel)) {
    modelsByName.set(defaultModel, {
      name: defaultModel,
      label: defaultModel,
      provider: null,
      enabled: true,
      isDefault: true,
      maxContextSize: null,
      capabilities: [],
    });
  }

  const normalizedModels = Array.from(modelsByName.values()).map((model) => ({
    ...model,
    isDefault: defaultModel === model.name,
  }));

  return {
    defaultModel,
    options: normalizedModels.filter((model) => model.enabled).map((model) => model.name),
    availableModels: normalizedModels,
  };
}

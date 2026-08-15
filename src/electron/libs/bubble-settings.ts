import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { BubbleModelConfig, BubbleProvidersConfig } from '../../shared/types';
import {
  getBubbleSdk,
  loadBubbleProviderCatalog,
  reloadBubbleSdkConfig,
  type BubbleModelInfo,
  type BubbleProviderProfile,
  type BubbleSdkInstance,
} from './provider/bubble-sdk-loader';

type BubbleAvailableModel = BubbleModelConfig['availableModels'][number];

const EMPTY_BUBBLE_MODEL_CONFIG: BubbleModelConfig = {
  defaultModel: null,
  options: [],
  availableModels: [],
};

// ── Model catalog: instant local read + background live refresh ────────────
//
// Live model discovery hits each provider's HTTP endpoint and can take ~5s
// per unreachable provider, so it must never block the picker. The picker's
// data is assembled from local sources only:
//   1. the SDK's builtin static catalog / the user's models.json
//      (registry.localModelsForProvider — no network),
//   2. the last successful live discovery, persisted on disk.
// refreshBubbleModelCatalog() re-runs live discovery in the background,
// persists the result, and reports whether anything changed so the caller
// can broadcast bubble.modelCatalogUpdated (the codex pattern).

function bubbleModelDiskCachePath(): string | null {
  try {
    return join(app.getPath('userData'), 'bubble-model-catalog-cache.json');
  } catch {
    return null; // non-Electron context (standalone probes/tests)
  }
}

function readBubbleModelDiskCache(cachePath: string | null): Record<string, BubbleModelInfo[]> {
  if (!cachePath || !existsSync(cachePath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf-8')) as {
      providers?: Record<string, BubbleModelInfo[]>;
    };
    return parsed.providers && typeof parsed.providers === 'object' ? parsed.providers : {};
  } catch {
    return {};
  }
}

function addModel(
  modelsByName: Map<string, BubbleAvailableModel>,
  providerId: string,
  model: BubbleModelInfo
): void {
  const name = formatBubbleModelId(providerId, model);
  if (!name || modelsByName.has(name)) {
    return;
  }
  modelsByName.set(name, {
    name,
    label: model.name?.trim() || name,
    provider: (model.providerId || providerId || '').trim() || null,
    enabled: true,
    isDefault: false,
    maxContextSize: typeof model.contextWindow === 'number' ? model.contextWindow : null,
    capabilities: [],
    // Thinking-level metadata straight from the SDK catalog: the composer's
    // Reasoning picker lists these per model, defaultReasoningLevel seeds it.
    reasoningLevels: (model.reasoningLevels || []).filter(
      (level) => typeof level === 'string' && level.trim().length > 0
    ),
    defaultReasoningLevel: model.defaultReasoningLevel?.trim() || null,
  });
}

type BubbleDiscoveryContext = {
  sdk: BubbleSdkInstance;
  defaultModel: string | null;
  configuredIds: string[];
  profiles: Map<string, BubbleProviderProfile>;
};

async function getBubbleDiscoveryContext(): Promise<BubbleDiscoveryContext> {
  const sdk = await getBubbleSdk();
  reloadBubbleSdkConfig(sdk);
  const config = sdk.getModelConfig();
  return {
    sdk,
    defaultModel: config.defaultModel?.trim() || null,
    configuredIds: config.providers.filter((provider) => provider.hasApiKey).map((p) => p.id),
    profiles: new Map<string, BubbleProviderProfile>(
      sdk.registry.getEnabled().map((profile) => [profile.id, profile])
    ),
  };
}

export async function getBubbleModelConfig(): Promise<BubbleModelConfig> {
  let defaultModel: string | null = null;
  const modelsByName = new Map<string, BubbleAvailableModel>();
  try {
    const context = await getBubbleDiscoveryContext();
    defaultModel = context.defaultModel;
    const diskCache = readBubbleModelDiskCache(bubbleModelDiskCachePath());
    for (const providerId of context.configuredIds) {
      const profile = context.profiles.get(providerId);
      if (!profile) {
        continue;
      }
      // Local catalog first (static builtin / models.json), then extras the
      // last live discovery found for this provider.
      let localModels: BubbleModelInfo[] = [];
      try {
        localModels = context.sdk.registry.localModelsForProvider(profile) || [];
      } catch {
        // unknown provider — disk-cached extras still apply
      }
      for (const model of localModels) {
        addModel(modelsByName, providerId, model);
      }
      for (const model of diskCache[providerId] || []) {
        addModel(modelsByName, providerId, model);
      }
    }
  } catch (error) {
    console.warn('[bubble-settings] Failed to load Bubble model config:', error);
    return EMPTY_BUBBLE_MODEL_CONFIG;
  }

  // Surface the configured default even if discovery didn't include it, so the
  // picker can still show/select it.
  if (defaultModel && !modelsByName.has(defaultModel)) {
    modelsByName.set(defaultModel, {
      name: defaultModel,
      label: defaultModel,
      provider: defaultModel.includes(':') ? defaultModel.split(':', 1)[0] : null,
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

let bubbleCatalogRefreshInflight: Promise<boolean> | null = null;

/**
 * Live per-provider model discovery, run in the background. Persists the
 * merged catalog to disk and resolves true when it changed (caller then
 * broadcasts bubble.modelCatalogUpdated). Deduped: concurrent callers share
 * one run. Never throws.
 */
export function refreshBubbleModelCatalog(): Promise<boolean> {
  if (!bubbleCatalogRefreshInflight) {
    bubbleCatalogRefreshInflight = runBubbleModelCatalogRefresh()
      .catch((error) => {
        console.warn('[bubble-settings] Background Bubble model discovery failed:', error);
        return false;
      })
      .finally(() => {
        bubbleCatalogRefreshInflight = null;
      });
  }
  return bubbleCatalogRefreshInflight;
}

async function runBubbleModelCatalogRefresh(): Promise<boolean> {
  const context = await getBubbleDiscoveryContext();
  // Parallel: several providers take ~5s to time out when their endpoint is
  // unreachable, and a sequential loop over ~16 providers took ~26s.
  const discovered = await Promise.all(
    context.configuredIds.map(async (providerId) => {
      const profile = context.profiles.get(providerId);
      if (!profile) {
        return null;
      }
      try {
        const models = (await context.sdk.registry.listModels(profile)) || [];
        return { providerId, models };
      } catch (error) {
        console.warn(`[bubble-settings] Failed to list Bubble models for "${providerId}":`, error);
        return null;
      }
    })
  );

  // Merge onto the previous cache: providers that failed this round keep
  // their last-known models; providers no longer configured are pruned.
  const previous = readBubbleModelDiskCache(bubbleModelDiskCachePath());
  const merged: Record<string, BubbleModelInfo[]> = {};
  for (const providerId of context.configuredIds) {
    if (previous[providerId]) {
      merged[providerId] = previous[providerId];
    }
  }
  let refreshedCount = 0;
  for (const entry of discovered) {
    if (entry && entry.models.length > 0) {
      merged[entry.providerId] = entry.models;
      refreshedCount += 1;
    }
  }
  if (refreshedCount === 0) {
    return false; // total discovery failure — keep the previous cache intact
  }
  if (JSON.stringify(previous) === JSON.stringify(merged)) {
    return false;
  }
  const cachePath = bubbleModelDiskCachePath();
  if (cachePath) {
    try {
      writeFileSync(cachePath, JSON.stringify({ updatedAt: Date.now(), providers: merged }));
    } catch (error) {
      console.warn('[bubble-settings] Failed to persist Bubble model catalog cache:', error);
    }
  }
  return true;
}

// The model identifier the app uses is "<provider>:<id>", matching Bubble's
// own encodeModel format that runTurn({ model }) resolves.
function formatBubbleModelId(providerId: string | undefined, model: BubbleModelInfo): string | null {
  const id = model.id?.trim();
  if (!id) {
    return null;
  }
  if (id.includes(':')) {
    return id;
  }
  const provider = (model.providerId || providerId || '').trim();
  return provider ? `${provider}:${id}` : id;
}

function hasStoredKey(profile: BubbleProviderProfile | undefined): boolean {
  return typeof profile?.apiKey === 'string' && profile.apiKey.trim().length > 0;
}

// The SDK catalog labels the two Moonshot endpoints in Chinese (国内/海外);
// the Aegis UI is English-only, so rename them here.
const PROVIDER_NAME_OVERRIDES: Record<string, string> = {
  'moonshot-cn': 'Moonshot (China)',
  'moonshot-intl': 'Moonshot (International)',
  'bailian-token-plan': 'Bailian Token Plan',
};

/**
 * Full stored key, fetched on demand when the user expands a provider's key
 * editor so the input can be prefilled (masked behind the password toggle).
 * Deliberately not part of getBubbleProvidersConfig — the bulk config only
 * carries a hasApiKey flag.
 */
export async function getBubbleProviderKey(providerId: string): Promise<string> {
  const sdk = await getBubbleSdk();
  reloadBubbleSdkConfig(sdk);
  const profile = sdk.registry.getConfigured().find((entry) => entry.id === providerId);
  return typeof profile?.apiKey === 'string' ? profile.apiKey : '';
}

/**
 * Settings-page view over Bubble's provider credentials. Everything goes
 * through the SDK registry, which reads/writes the same ~/.bubble/config.json
 * the Bubble CLI uses — no CLI required. Keys never leave the main process;
 * only a hasApiKey flag is reported.
 */
export async function getBubbleProvidersConfig(): Promise<BubbleProvidersConfig> {
  const sdk = await getBubbleSdk();
  reloadBubbleSdkConfig(sdk);
  const catalog = await loadBubbleProviderCatalog();
  const configured = new Map(sdk.registry.getConfigured().map((profile) => [profile.id, profile]));
  const defaultProviderId = sdk.registry.getDefault()?.id || null;

  const providers = catalog.BUILTIN_PROVIDERS.filter(
    (definition) => !definition.hidden && catalog.isUserVisibleProvider(definition.id)
  ).map((definition) => {
    const profile = configured.get(definition.id);
    return {
      id: definition.id,
      name: PROVIDER_NAME_OVERRIDES[definition.id] || definition.name || definition.id,
      baseURL: (typeof profile?.baseURL === 'string' && profile.baseURL) || definition.baseURL,
      hasApiKey: hasStoredKey(profile),
      enabled: profile ? profile.enabled !== false : false,
      isDefault: definition.id === defaultProviderId,
      configured: Boolean(profile),
    };
  });

  return { providers, defaultProviderId };
}

export async function setBubbleProviderKey(
  providerId: string,
  apiKey: string
): Promise<BubbleProvidersConfig> {
  const key = apiKey.trim();
  if (!key) {
    throw new Error('API key must not be empty.');
  }
  const sdk = await getBubbleSdk();
  if (!sdk.registry.addProvider(providerId, key)) {
    throw new Error(`Unknown Bubble provider "${providerId}".`);
  }
  return getBubbleProvidersConfig();
}

export async function removeBubbleProvider(providerId: string): Promise<BubbleProvidersConfig> {
  const sdk = await getBubbleSdk();
  sdk.registry.removeProvider(providerId);
  return getBubbleProvidersConfig();
}

export async function setBubbleDefaultProvider(providerId: string): Promise<BubbleProvidersConfig> {
  const sdk = await getBubbleSdk();
  sdk.registry.setDefault(providerId);
  return getBubbleProvidersConfig();
}

/**
 * Toggle a configured provider without touching its key. Disabled providers
 * are excluded from getModelConfig()/getEnabled(), so their models drop out
 * of the composer picker and the agent won't route to them.
 */
export async function setBubbleProviderEnabled(
  providerId: string,
  enabled: boolean
): Promise<BubbleProvidersConfig> {
  const sdk = await getBubbleSdk();
  const providers = sdk.userConfig.getProviders();
  const profile = providers.find((entry) => entry.id === providerId);
  if (!profile) {
    throw new Error(`Bubble provider "${providerId}" is not configured.`);
  }
  profile.enabled = enabled;
  sdk.userConfig.setProviders(providers);
  return getBubbleProvidersConfig();
}



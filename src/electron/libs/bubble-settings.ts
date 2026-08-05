import type { BubbleModelConfig, BubbleProvidersConfig } from '../../shared/types';
import {
  getBubbleSdk,
  loadBubbleProviderCatalog,
  type BubbleModelInfo,
  type BubbleProviderProfile,
} from './provider/bubble-sdk-loader';

type BubbleAvailableModel = BubbleModelConfig['availableModels'][number];

const EMPTY_BUBBLE_MODEL_CONFIG: BubbleModelConfig = {
  defaultModel: null,
  options: [],
  availableModels: [],
};

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
};

/**
 * Full stored key, fetched on demand when the user expands a provider's key
 * editor so the input can be prefilled (masked behind the password toggle).
 * Deliberately not part of getBubbleProvidersConfig — the bulk config only
 * carries a hasApiKey flag.
 */
export async function getBubbleProviderKey(providerId: string): Promise<string> {
  const sdk = await getBubbleSdk();
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

export async function getBubbleModelConfig(): Promise<BubbleModelConfig> {
  let defaultModel: string | null = null;
  const modelsByName = new Map<string, BubbleAvailableModel>();
  try {
    const sdk = await getBubbleSdk();
    const config = sdk.getModelConfig();
    defaultModel = config.defaultModel?.trim() || null;

    // The full per-provider catalog comes from the SDK's provider registry;
    // getModelConfig() itself only carries the provider list + default model.
    const profiles = new Map<string, BubbleProviderProfile>(
      sdk.registry.getEnabled().map((profile) => [profile.id, profile])
    );
    const configuredIds = config.providers
      .filter((provider) => provider.hasApiKey)
      .map((provider) => provider.id);
    for (const providerId of configuredIds) {
      const profile = profiles.get(providerId);
      if (!profile) {
        continue;
      }
      let models: BubbleModelInfo[] = [];
      try {
        models = (await sdk.registry.listModels(profile)) || [];
      } catch (error) {
        console.warn(`[bubble-settings] Failed to list Bubble models for "${providerId}":`, error);
        continue;
      }
      for (const model of models) {
        const name = formatBubbleModelId(providerId, model);
        if (!name || modelsByName.has(name)) {
          continue;
        }
        modelsByName.set(name, {
          name,
          label: model.name?.trim() || name,
          provider: (model.providerId || providerId || '').trim() || null,
          enabled: true,
          isDefault: false,
          maxContextSize: typeof model.contextWindow === 'number' ? model.contextWindow : null,
          capabilities: [],
        });
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

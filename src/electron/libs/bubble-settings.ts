import type { BubbleModelConfig } from '../../shared/types';
import {
  getBubbleSdk,
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

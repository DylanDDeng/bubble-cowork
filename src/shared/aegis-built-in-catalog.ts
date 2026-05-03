export interface AegisBuiltInProviderDefinition {
  id: string;
  name: string;
  baseUrl: string;
}

export interface AegisBuiltInModelDefinition {
  id: string;
  name: string;
  providerId: string;
  contextWindow?: number;
}

export const AEGIS_BUILT_IN_PROVIDERS: AegisBuiltInProviderDefinition[] = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
  { id: 'google', name: 'Google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { id: 'zhipuai', name: 'Zhipu AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'zhipuai-coding-plan', name: 'Zhipu AI Coding Plan', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' },
  { id: 'zai', name: 'Z.AI', baseUrl: 'https://api.z.ai/api/paas/v4' },
  { id: 'zai-coding-plan', name: 'Z.AI Coding Plan', baseUrl: 'https://api.z.ai/api/coding/paas/v4' },
  { id: 'moonshot-cn', name: 'Moonshot CN', baseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'moonshot-intl', name: 'Moonshot Intl', baseUrl: 'https://api.moonshot.ai/v1' },
  { id: 'kimi-for-coding', name: 'Kimi for Coding', baseUrl: 'https://api.kimi.com/coding/v1' },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
  { id: 'together', name: 'Together AI', baseUrl: 'https://api.together.xyz/v1' },
  { id: 'fireworks', name: 'Fireworks', baseUrl: 'https://api.fireworks.ai/inference/v1' },
  { id: 'local', name: 'Local', baseUrl: 'http://localhost:11434/v1' },
];

export const AEGIS_BUILT_IN_MODELS: AegisBuiltInModelDefinition[] = [
  { id: 'gpt-4o', name: 'gpt-4o', providerId: 'openai', contextWindow: 128000 },
  { id: 'gpt-4o-mini', name: 'gpt-4o-mini', providerId: 'openai', contextWindow: 128000 },
  { id: 'o1-preview', name: 'o1-preview', providerId: 'openai', contextWindow: 128000 },
  { id: 'o1-mini', name: 'o1-mini', providerId: 'openai', contextWindow: 128000 },
  { id: 'gpt-4-turbo', name: 'gpt-4-turbo', providerId: 'openai', contextWindow: 128000 },

  { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', providerId: 'deepseek', contextWindow: 1048576 },
  { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', providerId: 'deepseek', contextWindow: 1048576 },

  { id: 'gemini-2.5-pro-preview-03-25', name: 'gemini-2.5-pro-preview-03-25', providerId: 'google', contextWindow: 128000 },
  { id: 'gemini-2.0-flash-001', name: 'gemini-2.0-flash-001', providerId: 'google', contextWindow: 128000 },
  { id: 'gemini-1.5-pro-latest', name: 'gemini-1.5-pro-latest', providerId: 'google', contextWindow: 128000 },

  { id: 'glm-5.1', name: 'GLM-5.1', providerId: 'zhipuai', contextWindow: 200000 },
  { id: 'glm-4.7', name: 'GLM-4.7', providerId: 'zhipuai', contextWindow: 204800 },
  { id: 'glm-4.6', name: 'GLM-4.6', providerId: 'zhipuai', contextWindow: 204800 },
  { id: 'glm-5.1', name: 'GLM-5.1', providerId: 'zhipuai-coding-plan', contextWindow: 200000 },
  { id: 'glm-4.7', name: 'GLM-4.7', providerId: 'zhipuai-coding-plan', contextWindow: 204800 },
  { id: 'glm-4.6', name: 'GLM-4.6', providerId: 'zhipuai-coding-plan', contextWindow: 204800 },
  { id: 'glm-5.1', name: 'GLM-5.1', providerId: 'zai', contextWindow: 200000 },
  { id: 'glm-4.7', name: 'GLM-4.7', providerId: 'zai', contextWindow: 204800 },
  { id: 'glm-4.6', name: 'GLM-4.6', providerId: 'zai', contextWindow: 204800 },
  { id: 'glm-5-turbo', name: 'GLM-5-Turbo', providerId: 'zai-coding-plan', contextWindow: 200000 },
  { id: 'glm-4.7', name: 'GLM-4.7', providerId: 'zai-coding-plan', contextWindow: 204800 },
  { id: 'glm-4.6', name: 'GLM-4.6', providerId: 'zai-coding-plan', contextWindow: 200000 },

  { id: 'kimi-k2.6', name: 'Kimi K2.6', providerId: 'moonshot-cn', contextWindow: 256000 },
  { id: 'k2.6-code-preview', name: 'Kimi K2.6 Code Preview', providerId: 'moonshot-cn', contextWindow: 256000 },
  { id: 'kimi-k2.5', name: 'Kimi K2.5', providerId: 'moonshot-cn', contextWindow: 256000 },
  { id: 'kimi-k2-turbo-preview', name: 'Kimi K2 Turbo', providerId: 'moonshot-cn', contextWindow: 256000 },
  { id: 'kimi-k2-0905-preview', name: 'Kimi K2 0905', providerId: 'moonshot-cn', contextWindow: 256000 },
  { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking', providerId: 'moonshot-cn', contextWindow: 256000 },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', providerId: 'moonshot-intl', contextWindow: 256000 },
  { id: 'k2.6-code-preview', name: 'Kimi K2.6 Code Preview', providerId: 'moonshot-intl', contextWindow: 256000 },
  { id: 'kimi-k2.5', name: 'Kimi K2.5', providerId: 'moonshot-intl', contextWindow: 256000 },
  { id: 'kimi-k2-turbo-preview', name: 'Kimi K2 Turbo', providerId: 'moonshot-intl', contextWindow: 256000 },
  { id: 'kimi-k2-0905-preview', name: 'Kimi K2 0905', providerId: 'moonshot-intl', contextWindow: 256000 },
  { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking', providerId: 'moonshot-intl', contextWindow: 256000 },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', providerId: 'kimi-for-coding', contextWindow: 256000 },
  { id: 'k2.6-code-preview', name: 'Kimi K2.6 Code Preview', providerId: 'kimi-for-coding', contextWindow: 256000 },
  { id: 'kimi-k2-turbo-preview', name: 'Kimi K2 Turbo', providerId: 'kimi-for-coding', contextWindow: 256000 },
  { id: 'kimi-k2-0905-preview', name: 'Kimi K2 0905', providerId: 'kimi-for-coding', contextWindow: 256000 },
  { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking', providerId: 'kimi-for-coding', contextWindow: 256000 },

  { id: 'llama-3.3-70b-versatile', name: 'llama-3.3-70b-versatile', providerId: 'groq', contextWindow: 32768 },
  { id: 'mixtral-8x7b-32768', name: 'mixtral-8x7b-32768', providerId: 'groq', contextWindow: 32768 },
  { id: 'gemma-2-9b-it', name: 'gemma-2-9b-it', providerId: 'groq', contextWindow: 32768 },

  { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', name: 'Llama 3.3 70B Instruct Turbo', providerId: 'together', contextWindow: 32768 },
  { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen2.5 72B Instruct', providerId: 'together', contextWindow: 32768 },

  { id: 'accounts/fireworks/models/kimi-k2p6', name: 'Kimi K2.6', providerId: 'fireworks', contextWindow: 256000 },

  { id: 'llama3.1', name: 'llama3.1', providerId: 'local', contextWindow: 32768 },
  { id: 'qwen2.5', name: 'qwen2.5', providerId: 'local', contextWindow: 32768 },
  { id: 'deepseek-coder-v2', name: 'deepseek-coder-v2', providerId: 'local', contextWindow: 32768 },
];

export const AEGIS_BUILT_IN_DEFAULT_PROVIDER_ID = 'openai';
export const AEGIS_BUILT_IN_DEFAULT_MODEL_ID = 'gpt-4o';
export const AEGIS_BUILT_IN_DEFAULT_MODEL = `${AEGIS_BUILT_IN_DEFAULT_PROVIDER_ID}:${AEGIS_BUILT_IN_DEFAULT_MODEL_ID}`;

export function encodeAegisBuiltInModel(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

export function decodeAegisBuiltInModel(value: string): { providerId?: string; modelId: string } {
  if (value.includes(':')) {
    const [providerId, ...rest] = value.split(':');
    return { providerId, modelId: rest.join(':') };
  }
  return { modelId: value };
}

export function getAegisBuiltInProvider(providerId: string): AegisBuiltInProviderDefinition | undefined {
  return AEGIS_BUILT_IN_PROVIDERS.find((provider) => provider.id === providerId);
}

export function listAegisBuiltInModels(providerId: string): AegisBuiltInModelDefinition[] {
  return AEGIS_BUILT_IN_MODELS.filter((model) => model.providerId === providerId);
}

export function getAegisBuiltInModel(providerId: string, modelId: string): AegisBuiltInModelDefinition | undefined {
  return AEGIS_BUILT_IN_MODELS.find((model) => model.providerId === providerId && model.id === modelId);
}

export function resolveAegisBuiltInModel(value?: string | null, providerId?: string | null): {
  providerId: string;
  modelId: string;
  encoded: string;
} {
  const decoded = decodeAegisBuiltInModel((value || '').trim() || AEGIS_BUILT_IN_DEFAULT_MODEL);
  const explicitProviderId = decoded.providerId || providerId?.trim();
  const providerModel = explicitProviderId
    ? getAegisBuiltInModel(explicitProviderId, decoded.modelId)
    : undefined;
  const inferredModel = providerModel
    || AEGIS_BUILT_IN_MODELS.find((model) => model.id === decoded.modelId)
    || getAegisBuiltInModel(AEGIS_BUILT_IN_DEFAULT_PROVIDER_ID, AEGIS_BUILT_IN_DEFAULT_MODEL_ID);
  const resolvedProviderId = inferredModel?.providerId || AEGIS_BUILT_IN_DEFAULT_PROVIDER_ID;
  const resolvedModelId = inferredModel?.id || AEGIS_BUILT_IN_DEFAULT_MODEL_ID;
  return {
    providerId: resolvedProviderId,
    modelId: resolvedModelId,
    encoded: encodeAegisBuiltInModel(resolvedProviderId, resolvedModelId),
  };
}

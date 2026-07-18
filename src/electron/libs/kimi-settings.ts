import { execFile } from 'child_process';
import type { KimiModelConfig } from '../../shared/types';
import { buildKimiEnv, resolveKimiBinary } from './kimi-cli';

type KimiProviderListJson = {
  models?: Record<
    string,
    {
      provider?: string;
      model?: string;
      displayName?: string;
      maxContextSize?: number;
      capabilities?: unknown;
    }
  >;
};

type KimiAvailableModel = KimiModelConfig['availableModels'][number];

const EMPTY_KIMI_MODEL_CONFIG: KimiModelConfig = {
  defaultModel: null,
  options: [],
  availableModels: [],
};

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
        env: buildKimiEnv(),
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

function parseProviderListJson(output: string): KimiModelConfig['availableModels'] {
  const parsed = JSON.parse(output) as KimiProviderListJson;
  return Object.entries(parsed.models || {})
    .map<KimiAvailableModel | null>(([name, model]) => {
      const normalizedName = name.trim();
      if (!normalizedName) return null;
      const label = model.displayName?.trim() || normalizedName;
      const capabilities = Array.isArray(model.capabilities)
        ? model.capabilities.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : [];
      return {
        name: normalizedName,
        label,
        provider: model.provider?.trim() || null,
        enabled: true,
        isDefault: false,
        maxContextSize: typeof model.maxContextSize === 'number' ? model.maxContextSize : null,
        capabilities,
      };
    })
    .filter((model): model is KimiAvailableModel => Boolean(model));
}

/**
 * Enrich the CLI-derived model list with the kimi server's `GET /models`
 * metadata: `support_efforts` / `default_effort` (thinking tiers, k3-class)
 * and capabilities as a fallback. The CLI's `provider list --json` does not
 * carry effort metadata, so the server is the only source.
 */
export function mergeKimiServerModelMetadata(
  config: KimiModelConfig,
  serverItems: Array<Record<string, unknown>>
): KimiModelConfig {
  const byName = new Map<string, Record<string, unknown>>();
  for (const item of serverItems) {
    const name = typeof item.model === 'string' ? item.model : '';
    if (name) byName.set(name, item);
  }
  return {
    ...config,
    availableModels: config.availableModels.map((model) => {
      const server = byName.get(model.name);
      if (!server) return model;
      const supportEfforts = Array.isArray(server.support_efforts)
        ? server.support_efforts.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : [];
      const defaultEffort = typeof server.default_effort === 'string' ? server.default_effort : undefined;
      const capabilities = Array.isArray(server.capabilities)
        ? server.capabilities.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : [];
      return {
        ...model,
        ...(capabilities.length > 0 && !(model.capabilities && model.capabilities.length > 0)
          ? { capabilities }
          : {}),
        ...(supportEfforts.length > 0 ? { supportEfforts } : {}),
        ...(defaultEffort ? { defaultEffort } : {}),
      };
    }),
  };
}

export async function getKimiModelConfig(): Promise<KimiModelConfig> {
  const binary = await resolveKimiBinary();
  if (!binary) {
    return EMPTY_KIMI_MODEL_CONFIG;
  }

  const [jsonResult, listResult] = await Promise.allSettled([
    execFileText(binary, ['provider', 'list', '--json']),
    execFileText(binary, ['provider', 'list']),
  ]);

  const defaultModel =
    listResult.status === 'fulfilled'
      ? parseDefaultModel(listResult.value)
      : null;

  const availableModels =
    jsonResult.status === 'fulfilled'
      ? parseProviderListJson(jsonResult.value)
      : [];

  const modelsByName = new Map(availableModels.map((model) => [model.name, model]));
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

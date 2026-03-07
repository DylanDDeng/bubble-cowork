import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { CodexModelConfig } from '../../shared/types';

const CODEX_CONFIG_PATH = join(homedir(), '.codex', 'config.toml');
const CODEX_MODELS_CACHE_PATH = join(homedir(), '.codex', 'models_cache.json');

type CodexCachedModel = {
  slug?: string;
  visibility?: string;
};

type CodexModelsCache = {
  models?: CodexCachedModel[];
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

export function getCodexModelConfig(): CodexModelConfig {
  const configText = readCodexConfigText();
  const defaultModelMatch = configText.match(/^model\s*=\s*"([^"]+)"/m);
  const defaultModel = defaultModelMatch?.[1]?.trim() || null;

  const cache = readCodexModelsCache();
  const options = Array.from(
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

  return { defaultModel, options };
}

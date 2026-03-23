import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { MiniMaxTtsConfig } from '../../shared/types';

const CONFIG_PATH = () => join(app.getPath('userData'), 'minimax-tts.json');

const DEFAULT_CONFIG: MiniMaxTtsConfig = {
  apiKey: '',
};

function normalizeConfig(parsed?: Partial<MiniMaxTtsConfig> | null): MiniMaxTtsConfig {
  return {
    apiKey: typeof parsed?.apiKey === 'string' ? parsed.apiKey.trim() : '',
  };
}

export function loadMiniMaxTtsConfig(): MiniMaxTtsConfig {
  const filePath = CONFIG_PATH();
  if (!existsSync(filePath)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<MiniMaxTtsConfig>;
    return normalizeConfig(parsed);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveMiniMaxTtsConfig(config: MiniMaxTtsConfig): MiniMaxTtsConfig {
  const normalized = normalizeConfig(config);
  writeFileSync(CONFIG_PATH(), JSON.stringify(normalized, null, 2), 'utf-8');
  return normalized;
}

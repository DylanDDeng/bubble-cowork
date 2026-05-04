import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

export interface AegisSkillsConfig {
  disabled: string[];
  bundled: {
    enabled: boolean;
  };
}

const DEFAULT_CONFIG: AegisSkillsConfig = {
  disabled: [],
  bundled: { enabled: true },
};

function configPath(): string {
  return join(app.getPath('userData'), 'aegis-skills.json');
}

export function loadAegisSkillsConfig(): AegisSkillsConfig {
  const path = configPath();
  if (!existsSync(path)) return DEFAULT_CONFIG;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AegisSkillsConfig>;
    return {
      disabled: Array.isArray(parsed.disabled)
        ? parsed.disabled.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : [],
      bundled: {
        enabled: parsed.bundled?.enabled !== false,
      },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveAegisSkillsConfig(config: AegisSkillsConfig): AegisSkillsConfig {
  const normalized: AegisSkillsConfig = {
    disabled: Array.from(new Set(config.disabled.map((value) => value.trim()).filter(Boolean))).sort(),
    bundled: { enabled: config.bundled.enabled !== false },
  };
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
  return normalized;
}

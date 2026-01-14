import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

interface ClaudeSettings {
  env?: Record<string, string>;
  [key: string]: unknown;
}

let settings: ClaudeSettings | null = null;

// 加载 Claude Code 配置
export function loadClaudeSettings(): ClaudeSettings {
  if (settings !== null) {
    return settings;
  }

  try {
    if (existsSync(SETTINGS_PATH)) {
      const content = readFileSync(SETTINGS_PATH, 'utf-8');
      settings = JSON.parse(content);

      // 注入环境变量（仅当未设置时）
      if (settings?.env) {
        for (const [key, value] of Object.entries(settings.env)) {
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
      }
    } else {
      settings = {};
    }
  } catch (error) {
    console.warn('Failed to load Claude settings:', error);
    settings = {};
  }

  return settings!;
}

// 获取 Claude Code 环境变量
export function getClaudeEnv(): Record<string, string> {
  const s = loadClaudeSettings();
  return s.env || {};
}
